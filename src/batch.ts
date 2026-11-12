import {
  findChain,
  parseUnits,
  formatUnits,
  type PaymentOption,
  type PaymentPayloadContext,
  type PaymentRequired,
  type SignerBackend,
} from '@roundhouseai/x402';
import type { IoiConfig } from './config.js';
import { signEip2612IfNeeded } from './permit.js';
import { loadRhDist } from './rhdist.js';
import type { SignedQuote } from './signed.js';

/**
 * TODO(rh-x402#55): when `@roundhouseai/x402` publishes
 * https://github.com/roundhouseai-io/x402/pull/55, `createEvmBatchPayment`
 * becomes the signer (it delegates to `@x402/evm` `BatchSettlementEvmScheme`
 * and still uses `SignerBackend`, so no key is read here). 0.8.0 does not
 * export it. This file feature-detects that function and otherwise signs with
 * the channel client already in the 0.8.0 tarball. Bump the dependency and
 * delete the vendored branch once the release is on npm.
 */

interface Doc {
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  domain: { name: string; version?: string; chainId: number; verifyingContract: string };
  message: Record<string, unknown>;
}

interface ChannelConfig {
  payer: string;
  payerAuthorizer: string;
  receiver: string;
  receiverAuthorizer: string;
  token: string;
  withdrawDelay: number;
  salt: string;
}

export interface ChannelPlan {
  kind: 'voucher' | 'deposit';
  maxClaimable: bigint;
  perCallAtomic: bigint;
  exposureAtomic: bigint;
  deposit?: bigint;
}

interface ChannelMod {
  planChannelPayment(input: {
    option: PaymentOption;
    state: { charged: string; balance: string; signedMax: string } | undefined;
    depositFlag?: bigint;
    capAtomic?: bigint;
  }): ChannelPlan;
  announcedMinDeposit(option: PaymentOption): bigint | undefined;
  channelSalt(option: PaymentOption): string;
  buildChannelConfig(option: PaymentOption, payer: string): ChannelConfig;
  computeChannelId(config: ChannelConfig, chainId: number): string;
  voucherDocument(channelId: string, maxClaimable: bigint, chainId: number): Doc;
  depositMethodOf(option: PaymentOption): 'eip3009' | 'permit2';
  eip3009DepositDocument(input: {
    option: PaymentOption;
    payer: string;
    config: ChannelConfig;
    channelId: string;
    amount: bigint;
    now: number;
  }): { document: Doc; salt: string; validBefore: number };
  permit2DepositDocument(input: {
    option: PaymentOption;
    payer: string;
    config: ChannelConfig;
    channelId: string;
    amount: bigint;
    now: number;
  }): { document: Doc; nonce: string; deadline: string };
  voucherPayload(
    config: ChannelConfig,
    voucher: { channelId: string; maxClaimableAmount: string; signature: string },
  ): Record<string, unknown>;
  depositPayload(
    config: ChannelConfig,
    voucher: { channelId: string; maxClaimableAmount: string; signature: string },
    amount: bigint,
    authorization: Record<string, unknown>,
  ): Record<string, unknown>;
}

interface ChannelRecord {
  version: 1;
  slot: string;
  channelId: string;
  balance: string;
  charged: string;
  signedMax: string;
  pendingDeposit?: { amount: string; until: number };
}

interface FlowMod {
  slotFor(option: PaymentOption, wallet: string, backend: string, salt: string): string;
  prepareChannel(input: {
    slot: string;
    config: ChannelConfig;
    channelId: string;
    option: PaymentOption;
    wallet: string;
    backend: string;
    url: string;
    nowSeconds: number;
    read?: (channelId: string) => Promise<{ balance: bigint; totalClaimed: bigint }>;
  }): Promise<ChannelRecord | undefined>;
  recordSigned(
    existing: ChannelRecord | undefined,
    base: Record<string, unknown>,
    voucher: { maxClaimable: bigint; signature: string },
    deposit: { amount: bigint; until: number } | undefined,
    nowIso: string,
  ): ChannelRecord;
  recordChannelResponse(
    slot: string,
    sent: {
      kind: 'voucher' | 'deposit';
      channelId: string;
      maxClaimable: bigint;
      deposit: bigint | undefined;
      request: bigint;
      depositUntil: number | undefined;
    },
    settlement: Record<string, unknown> | undefined,
    httpOk: boolean,
    nowIso: string,
  ): unknown;
  repairFromPaymentRequired(slot: string, raw: unknown): boolean;
  onChainReader(rpcUrl: string): (channelId: string) => Promise<{ balance: bigint; totalClaimed: bigint }>;
  lockChannel(slot: string): Promise<() => void>;
}

interface StoreMod {
  readChannel(slot: string): ChannelRecord | undefined;
  lockChannel(slot: string): Promise<() => void>;
}

interface RpcMod {
  rpcUrlFor(chain: { network: string; rpcUrl: string }, overrides: Record<string, string>): string;
}

interface EipMod {
  wrapPaymentPayload(
    option: PaymentOption,
    payload: Record<string, unknown>,
    context: PaymentPayloadContext,
  ): Record<string, unknown>;
}

export interface BatchHooks {
  /** Injected in tests. Production loads PR #55 when the install has it. */
  createEvmBatchPayment?: (input: Record<string, unknown>) => Promise<
    { payload: Record<string, unknown>; extensions?: Record<string, unknown> } | undefined
  >;
}

async function mods(): Promise<{ channel: ChannelMod; flow: FlowMod; store: StoreMod; eip: EipMod }> {
  const channel = await loadRhDist<ChannelMod>('core/channel.js');
  const flow = await loadRhDist<FlowMod>('core/channelflow.js');
  const store = await loadRhDist<StoreMod>('core/channelstore.js');
  const eip = await loadRhDist<EipMod>('core/eip3009.js');
  if (!channel?.planChannelPayment || !flow?.slotFor || !store?.readChannel || !eip?.wrapPaymentPayload) {
    throw new Error(
      'this @roundhouseai/x402 build has no batch-settlement client. Nothing was signed. ' +
        'TODO: bump @roundhouseai/x402 to the release that includes https://github.com/roundhouseai-io/x402/pull/55.',
    );
  }
  return { channel, flow, store, eip };
}

export async function previewBatchPlan(
  option: PaymentOption,
  config: IoiConfig,
): Promise<ChannelPlan> {
  const { channel, flow, store } = await mods();
  const wallet = config.rh.wallet.default ?? '';
  const backend = config.rh.wallet.backend;
  const rec = store.readChannel(flow.slotFor(option, wallet, backend, channel.channelSalt(option)));
  return channel.planChannelPayment({
    option,
    state: rec,
    capAtomic: parseUnits(config.maxPerCall, option.decimals),
  });
}

export function assertDepositAllowed(plan: ChannelPlan, option: PaymentOption, config: IoiConfig, min: bigint | undefined): void {
  if (plan.kind !== 'deposit' || plan.deposit === undefined) return;
  const cap = parseUnits(config.maxDeposit, option.decimals);
  if (plan.deposit > cap) {
    throw new Error(
      `refusing to sign: batch-settlement deposit ${formatUnits(plan.deposit, option.decimals)} ${option.assetSymbol} exceeds max deposit ${config.maxDeposit}. Nothing was signed.`,
    );
  }
  if (min !== undefined && plan.deposit < min) {
    throw new Error(
      `refusing to sign: the quote's minDeposit is ${formatUnits(min, option.decimals)} ${option.assetSymbol}, above the per-call cap ${config.maxPerCall}. Nothing was signed.`,
    );
  }
}

export async function minDepositOf(option: PaymentOption): Promise<bigint | undefined> {
  const channel = await loadRhDist<ChannelMod>('core/channel.js');
  return channel?.announcedMinDeposit(option);
}

export interface SignBatchInput {
  required: PaymentRequired;
  option: PaymentOption;
  signer: SignerBackend;
  config: IoiConfig;
  plan: ChannelPlan;
  nowMs: number;
  skipChainRead: boolean;
  hooks?: BatchHooks;
  guard: (plan: ChannelPlan) => void;
}

export async function signBatch(input: SignBatchInput): Promise<SignedQuote> {
  const { channel, flow, store, eip } = await mods();
  const from = await input.signer.getAddress(input.option.chain);
  const slot = flow.slotFor(
    input.option,
    input.signer.wallet,
    input.signer.backend,
    channel.channelSalt(input.option),
  );
  const release = await (store.lockChannel ?? flow.lockChannel)(slot);
  try {
    const pr55 = input.hooks?.createEvmBatchPayment;
    if (pr55) {
      const signed = await signWithPr55(pr55, input, from, slot, eip);
      if (signed) return signed;
    }
    return await signVendored(input, from, slot, channel, flow, eip);
  } finally {
    release();
  }
}

async function signWithPr55(
  create: NonNullable<BatchHooks['createEvmBatchPayment']>,
  input: SignBatchInput,
  from: string,
  slot: string,
  eip: EipMod,
): Promise<SignedQuote | undefined> {
  const extra = input.option.raw.extra;
  const result = await create({
    signer: input.signer,
    payer: from,
    slot,
    x402Version: input.required.x402Version,
    requirements: {
      scheme: input.option.scheme,
      network: input.option.network,
      amount: input.option.amountAtomic.toString(),
      asset: input.option.asset,
      payTo: input.option.payTo,
      maxTimeoutSeconds: input.option.maxTimeoutSeconds,
      extra: typeof extra === 'object' && extra !== null ? extra : {},
    },
    depositMultiplier: 5,
    voucherOnly: input.plan.kind === 'voucher',
    ...(input.plan.kind === 'deposit' && input.plan.deposit !== undefined
      ? { depositAtomic: input.plan.deposit }
      : {}),
    maxAmountPerPayment: input.option.amountAtomic.toString(),
  });
  if (!result) return undefined;
  const context: PaymentPayloadContext = {
    x402Version: input.required.x402Version,
    resource: input.required.resource,
    extensions: result.extensions ?? input.required.extensions,
  };
  return quoteFrom(input, from, eip.wrapPaymentPayload(input.option, result.payload, context), {
    kind: input.plan.kind,
    maxClaimable: input.plan.maxClaimable.toString(),
  });
}

async function signVendored(
  input: SignBatchInput,
  from: string,
  slot: string,
  channel: ChannelMod,
  flow: FlowMod,
  eip: EipMod,
): Promise<SignedQuote> {
  const nowSeconds = Math.floor(input.nowMs / 1000);
  const nowIso = new Date(input.nowMs).toISOString();
  const config = channel.buildChannelConfig(input.option, from);
  const channelId = channel.computeChannelId(config, input.option.chainId);
  const read = input.skipChainRead ? undefined : await chainReader(input.option, input.config);
  const rec = await flow.prepareChannel({
    slot,
    config,
    channelId,
    option: input.option,
    wallet: input.signer.wallet,
    backend: input.signer.backend,
    url: input.config.mcpUrl,
    nowSeconds,
    ...(read ? { read } : {}),
  });
  const plan = channel.planChannelPayment({
    option: input.option,
    state: rec,
    capAtomic: parseUnits(input.config.maxPerCall, input.option.decimals),
  });
  input.guard(plan);

  const base = {
    version: 1 as const,
    slot,
    channelId,
    config,
    network: input.option.network,
    chain: input.option.chain,
    wallet: input.signer.wallet,
    backend: input.signer.backend,
    url: input.config.mcpUrl,
    asset: input.option.asset,
    assetSymbol: input.option.assetSymbol,
    decimals: input.option.decimals,
  };
  const voucherDoc = channel.voucherDocument(channelId, plan.maxClaimable, input.option.chainId);
  let extensions = input.required.extensions;
  let inner: Record<string, unknown>;
  let until: number | undefined;

  if (plan.kind === 'voucher') {
    const signature = await input.signer.signTypedData(voucherDoc);
    flow.recordSigned(rec, base, { maxClaimable: plan.maxClaimable, signature }, undefined, nowIso);
    inner = channel.voucherPayload(config, {
      channelId,
      maxClaimableAmount: plan.maxClaimable.toString(),
      signature,
    });
  } else {
    const deposit = plan.deposit ?? 0n;
    let authorization: Record<string, unknown>;
    if (channel.depositMethodOf(input.option) === 'eip3009') {
      const dep = channel.eip3009DepositDocument({
        option: input.option,
        payer: from,
        config,
        channelId,
        amount: deposit,
        now: nowSeconds,
      });
      const depositSignature = await input.signer.signTypedData(dep.document);
      until = dep.validBefore;
      authorization = {
        erc3009Authorization: {
          validAfter: '0',
          validBefore: String(dep.validBefore),
          salt: dep.salt,
          signature: depositSignature,
        },
      };
    } else {
      const dep = channel.permit2DepositDocument({
        option: input.option,
        payer: from,
        config,
        channelId,
        amount: deposit,
        now: nowSeconds,
      });
      const depositSignature = await input.signer.signTypedData(dep.document);
      until = Number(dep.deadline);
      authorization = {
        permit2Authorization: {
          from,
          permitted: { token: input.option.asset, amount: deposit.toString() },
          spender: dep.document.message.spender,
          nonce: dep.nonce,
          deadline: dep.deadline,
          witness: { channelId },
          signature: depositSignature,
        },
      };
      extensions = await signEip2612IfNeeded({
        option: { ...input.option, amountAtomic: deposit },
        signer: input.signer,
        from,
        extensions,
        amount: deposit,
        deadline: dep.deadline,
        rpc: input.config.rh.rpc,
      });
    }
    const signature = await input.signer.signTypedData(voucherDoc);
    flow.recordSigned(
      rec,
      base,
      { maxClaimable: plan.maxClaimable, signature },
      { amount: deposit, until: until ?? nowSeconds },
      nowIso,
    );
    inner = channel.depositPayload(
      config,
      { channelId, maxClaimableAmount: plan.maxClaimable.toString(), signature },
      deposit,
      authorization,
    );
  }

  const context: PaymentPayloadContext = {
    x402Version: input.required.x402Version,
    resource: input.required.resource,
    extensions,
  };
  const signed = quoteFrom(input, from, eip.wrapPaymentPayload(input.option, inner, context), {
    kind: plan.kind,
    id: channelId,
    maxClaimable: plan.maxClaimable.toString(),
    ...(plan.deposit !== undefined ? { deposit: plan.deposit.toString() } : {}),
  });
  signed.channelSent = {
    slot,
    kind: plan.kind,
    channelId,
    maxClaimable: plan.maxClaimable,
    deposit: plan.kind === 'deposit' ? plan.deposit : undefined,
    request: input.option.amountAtomic,
    depositUntil: until,
  };
  signed.exposureAtomic = plan.exposureAtomic;
  return signed;
}

function quoteFrom(
  input: SignBatchInput,
  from: string,
  payload: Record<string, unknown>,
  channel: Record<string, unknown>,
): SignedQuote {
  return {
    payload,
    exposureAtomic: input.plan.exposureAtomic,
    asset: input.option.assetSymbol,
    decimals: input.option.decimals,
    receipt: {
      success: true,
      scheme: 'batch-settlement',
      network: input.option.network,
      payer: from,
      amount: input.option.amount,
      asset: input.option.assetSymbol,
      channel,
    },
  };
}

async function chainReader(
  option: PaymentOption,
  config: IoiConfig,
): Promise<((channelId: string) => Promise<{ balance: bigint; totalClaimed: bigint }>) | undefined> {
  const chain = findChain(option.chain);
  const rpc = await loadRhDist<RpcMod>('core/rpc.js');
  const flow = await loadRhDist<FlowMod>('core/channelflow.js');
  if (!chain || !rpc || !flow) return undefined;
  return flow.onChainReader(rpc.rpcUrlFor(chain, config.rh.rpc));
}

export async function noteChannelResult(
  sent: NonNullable<SignedQuote['channelSent']>,
  settlement: Record<string, unknown> | undefined,
  httpOk: boolean,
  nowMs: number,
): Promise<void> {
  const flow = await loadRhDist<FlowMod>('core/channelflow.js');
  if (!flow) return;
  const { slot, ...rest } = sent;
  flow.recordChannelResponse(slot, rest, settlement, httpOk, new Date(nowMs).toISOString());
}

export async function repairChannel(sent: NonNullable<SignedQuote['channelSent']>, raw: unknown): Promise<boolean> {
  const flow = await loadRhDist<FlowMod>('core/channelflow.js');
  if (!flow) return false;
  return flow.repairFromPaymentRequired(sent.slot, raw);
}
