import {
  assertSupportedVersion,
  formatUnits,
  parsePaymentRequired,
  parseUnits,
  resolveSigner,
  runGates,
  selectOption,
  type PaymentOption,
  type PaymentRequired,
  type SignerBackend,
} from '@roundhouseai/x402';
import {
  assertDepositAllowed,
  minDepositOf,
  noteChannelResult,
  previewBatchPlan,
  repairChannel,
  type BatchHooks,
  type ChannelPlan,
} from './batch.js';
import type { IoiConfig } from './config.js';
import { postHosted, type HostedOutcome } from './hosted.js';
import { batchSupport } from './rhdist.js';
import { redact } from './redact.js';
import { signQuote } from './sign.js';
import { recordSpend, spentAtomic } from './spend.js';
import { toolError, type ToolResult } from './tools.js';

export interface Runtime {
  config: IoiConfig;
  fetchImpl?: typeof fetch;
  signer?: SignerBackend;
  skipChainRead?: boolean;
  now?: () => number;
  hooks?: BatchHooks;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function fail(config: IoiConfig, err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : 'payment failed';
  const text = message.includes('Nothing was signed') ? message : `${message} Nothing was signed.`;
  return toolError(redact(text, [config.apiKey]));
}

function remainingDaily(option: PaymentOption, config: IoiConfig, now: number): bigint {
  const cap = parseUnits(config.dailyCap, option.decimals);
  const spent = spentAtomic(option.assetSymbol, option.decimals, now);
  return spent >= cap ? 0n : cap - spent;
}

export function assertCaps(
  option: PaymentOption,
  plan: ChannelPlan | undefined,
  config: IoiConfig,
  now: number,
  minDeposit: bigint | undefined,
): void {
  runGates({
    option,
    url: config.mcpUrl,
    allowPayTo: config.rh.allowlist.payTo,
    allowDomains: config.rh.allowlist.domains,
    maxPerCall: config.maxPerCall,
    remainingDailyAtomic: remainingDaily(option, config, now),
    ...(plan ? { perCallAtomic: plan.perCallAtomic, exposureAtomic: plan.exposureAtomic } : {}),
  });
  if (plan) assertDepositAllowed(plan, option, config, minDeposit);
}

async function choose(
  required: PaymentRequired,
  config: IoiConfig,
): Promise<{ option: PaymentOption; plan?: ChannelPlan }> {
  const chains = [config.chain];
  if (config.scheme) {
    const option = selectOption(required, {
      scheme: config.scheme,
      chains,
      preferChain: config.chain,
    });
    if (option.scheme === 'batch-settlement') {
      const support = await batchSupport();
      if (!support.pr55 && !support.vendored) {
        throw new Error(
          'batch-settlement is not in this @roundhouseai/x402 build. TODO: bump @roundhouseai/x402 to the release that includes https://github.com/roundhouseai-io/x402/pull/55.',
        );
      }
      return { option, plan: await previewBatchPlan(option, config) };
    }
    return { option };
  }

  const support = await batchSupport();
  if (support.pr55 || support.vendored) {
    try {
      const batch = selectOption(required, {
        scheme: 'batch-settlement',
        chains,
        preferChain: config.chain,
      });
      const plan = await previewBatchPlan(batch, config);
      // An open channel that can cover the quote is a voucher: no new deposit.
      // A fresh channel stays opt-in via IOI_SCHEME, matching rh-x402.
      if (plan.kind === 'voucher') return { option: batch, plan };
    } catch {
      // Batch is optional unless IOI_SCHEME forces it. Fall through to upto/exact.
    }
  }

  return {
    option: selectOption(required, { chains, preferChain: config.chain }),
  };
}

async function loadSigner(runtime: Runtime): Promise<SignerBackend> {
  if (runtime.signer) return runtime.signer;
  if (runtime.config.configError) {
    throw new Error(`${runtime.config.configError} Nothing was signed.`);
  }
  return resolveSigner(runtime.config.rh);
}

function mergeReceipt(local: Record<string, unknown>, hosted: unknown): Record<string, unknown> {
  const remote = isRecord(hosted) ? hosted : {};
  return { ...local, ...remote, success: remote.success !== false };
}

function hostedSettlement(result: ToolResult | undefined): Record<string, unknown> | undefined {
  const meta = result?._meta?.['x402/payment-response'];
  return isRecord(meta) ? meta : undefined;
}

/**
 * Call one hosted tool. A payment-required result is capped, signed with the
 * rh-x402 wallet, and retried once with `_meta["x402/payment"]`. `IOI_API_KEY`
 * sends Bearer auth and never signs.
 */
export async function callTool(
  runtime: Runtime,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const { config } = runtime;
  const timeoutMs = config.timeoutSeconds * 1000;
  const first = await postHosted({
    url: config.mcpUrl,
    method: 'tools/call',
    params: { name, arguments: args },
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    timeoutMs,
    ...(runtime.fetchImpl ? { fetchImpl: runtime.fetchImpl } : {}),
    id: 1,
  });
  if (first.error && !first.paymentRequired) return fail(config, new Error(first.error));
  if (!first.paymentRequired) return first.result ?? toolError('empty tool result');
  if (config.apiKey) {
    return toolError(
      'hosted MCP still requires payment while IOI_API_KEY is set. The key was sent as Bearer auth and nothing was signed.',
    );
  }

  const now = runtime.now?.() ?? Date.now();
  try {
    const required = parsePaymentRequired(first.paymentRequired);
    assertSupportedVersion(required.x402Version);
    const { option, plan } = await choose(required, config);
    const min = option.scheme === 'batch-settlement' ? await minDepositOf(option) : undefined;
    assertCaps(option, plan, config, now, min);
    const signer = await loadSigner(runtime);
    const signed = await signQuote({
      required,
      option,
      signer,
      config,
      ...(plan ? { plan } : {}),
      nowMs: now,
      skipChainRead: runtime.skipChainRead === true,
      ...(runtime.hooks ? { hooks: runtime.hooks } : {}),
      guard: (next) => assertCaps(option, next, config, now, min),
    });
    if (signed.exposureAtomic > 0n) {
      recordSpend({
        ts: new Date(now).toISOString(),
        asset: signed.asset,
        amount: formatUnits(signed.exposureAtomic, signed.decimals),
        paid: true,
        scheme: option.scheme,
        tool: name,
      });
    }
    const second = await retry(runtime, name, args, signed.payload);
    if (second.paymentRequired) {
      if (signed.channelSent) await repairChannel(signed.channelSent, second.paymentRequired);
      return toolError(
        'the hosted server did not accept the signed payment. Nothing further was signed. ' +
          (typeof (second.paymentRequired as { error?: unknown }).error === 'string'
            ? String((second.paymentRequired as { error: string }).error)
            : 'See the payment requirements and try once more later.'),
      );
    }
    if (second.error && !second.result) return fail(config, new Error(second.error));
    const result = second.result ?? toolError('empty tool result');
    if (signed.channelSent) {
      await noteChannelResult(signed.channelSent, hostedSettlement(result), result.isError !== true, now);
    }
    const meta = {
      ...result._meta,
      'x402/payment-response': mergeReceipt(signed.receipt, result._meta?.['x402/payment-response']),
    };
    return { ...result, _meta: meta };
  } catch (err) {
    return fail(config, err);
  }
}

async function retry(
  runtime: Runtime,
  name: string,
  args: Record<string, unknown>,
  payment: Record<string, unknown>,
): Promise<HostedOutcome> {
  return postHosted({
    url: runtime.config.mcpUrl,
    method: 'tools/call',
    params: { name, arguments: args, _meta: { 'x402/payment': payment } },
    timeoutMs: runtime.config.timeoutSeconds * 1000,
    ...(runtime.fetchImpl ? { fetchImpl: runtime.fetchImpl } : {}),
    id: 2,
  });
}
