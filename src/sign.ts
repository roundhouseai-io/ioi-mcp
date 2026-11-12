import {
  buildAuthorization,
  buildPaymentPayload,
  type PaymentOption,
  type PaymentPayloadContext,
  type PaymentRequired,
  type SignerBackend,
} from '@roundhouseai/x402';
import { signBatch, type BatchHooks, type ChannelPlan } from './batch.js';
import type { IoiConfig } from './config.js';
import { permitModules, signEip2612IfNeeded } from './permit.js';
import type { SignedQuote } from './signed.js';

export interface SignInput {
  required: PaymentRequired;
  option: PaymentOption;
  signer: SignerBackend;
  config: IoiConfig;
  plan?: ChannelPlan;
  nowMs?: number;
  skipChainRead?: boolean;
  hooks?: BatchHooks;
  guard?: (plan: ChannelPlan) => void;
}

/**
 * Sign one selected payment option with the rh-x402 wallet.
 * Exact uses the public `buildAuthorization` / `buildPaymentPayload` API.
 * Upto uses the Permit2 builder shipped in the same package. Batch uses
 * {@link signBatch}, which feature-detects PR #55.
 */
export async function signQuote(input: SignInput): Promise<SignedQuote> {
  const nowMs = input.nowMs ?? Date.now();
  if (input.option.scheme === 'batch-settlement') {
    if (!input.plan) throw new Error('batch-settlement has no channel plan. Nothing was signed.');
    return signBatch({
      required: input.required,
      option: input.option,
      signer: input.signer,
      config: input.config,
      plan: input.plan,
      nowMs,
      skipChainRead: input.skipChainRead === true,
      ...(input.hooks ? { hooks: input.hooks } : {}),
      guard: input.guard ?? (() => undefined),
    });
  }
  if (input.option.family !== 'evm') {
    throw new Error(
      `refusing ${input.option.network}: ioi-mcp pays EVM USDC from the rh-x402 wallet. Nothing was signed.`,
    );
  }
  const from = await input.signer.getAddress(input.option.chain);
  const nowSeconds = Math.floor(nowMs / 1000);
  if (input.option.scheme === 'upto') return signUpto(input, from, nowSeconds);
  if (input.option.scheme !== 'exact') {
    throw new Error(`unsupported scheme ${input.option.scheme}. Nothing was signed.`);
  }
  const built = buildAuthorization({ option: input.option, from, now: nowSeconds });
  const signature = await input.signer.signTypedData(built.typedData);
  const context: PaymentPayloadContext = {
    x402Version: input.required.x402Version,
    resource: input.required.resource,
    extensions: input.required.extensions,
  };
  return {
    payload: buildPaymentPayload(input.option, built.typedData, signature, context) as unknown as Record<
      string,
      unknown
    >,
    exposureAtomic: input.option.amountAtomic,
    asset: input.option.assetSymbol,
    decimals: input.option.decimals,
    receipt: receipt(input.option, from),
  };
}

async function signUpto(input: SignInput, from: string, nowSeconds: number): Promise<SignedQuote> {
  const { permit, eip } = await permitModules();
  const built = permit.buildUptoPermit2({ option: input.option, from, now: nowSeconds });
  const signature = await input.signer.signTypedData(built.typedData);
  const deadline = String(built.authorization.deadline ?? '');
  const extensions = await signEip2612IfNeeded({
    option: input.option,
    signer: input.signer,
    from,
    extensions: input.required.extensions,
    amount: input.option.amountAtomic,
    deadline,
    rpc: input.config.rh.rpc,
  });
  const payload = eip.wrapPaymentPayload(
    input.option,
    { signature, permit2Authorization: built.authorization },
    {
      x402Version: input.required.x402Version,
      resource: input.required.resource,
      extensions,
    },
  );
  return {
    payload,
    exposureAtomic: input.option.amountAtomic,
    asset: input.option.assetSymbol,
    decimals: input.option.decimals,
    receipt: receipt(input.option, from),
  };
}

function receipt(option: PaymentOption, from: string): Record<string, unknown> {
  return {
    success: true,
    scheme: option.scheme,
    network: option.network,
    payer: from,
    amount: option.amount,
    asset: option.assetSymbol,
  };
}
