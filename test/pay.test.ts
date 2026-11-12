import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BatchHooks } from '../src/batch.js';
import { loadRhDist } from '../src/rhdist.js';
import { createRuntime, dispatch } from '../src/server.js';
import { recordSpend } from '../src/spend.js';
import {
  FACILITATOR,
  PAYER,
  PAY_TO,
  RECEIVER_AUTH,
  USDC,
  batch,
  exact,
  fakeSigner,
  json,
  paymentRequired,
  rpcResult,
  startMock,
  upto,
} from './support.js';

const savedHome = process.env.X402_HOME;

afterEach(() => {
  if (savedHome === undefined) delete process.env.X402_HOME;
  else process.env.X402_HOME = savedHome;
  delete process.env.IOI_API_KEY;
  delete process.env.IOI_SCHEME;
  delete process.env.IOI_MAX_PER_CALL;
  delete process.env.IOI_DAILY_CAP;
  delete process.env.IOI_MAX_DEPOSIT;
  delete process.env.IOI_MCP_URL;
});

function resultOf<T>(response: { result?: unknown } | undefined): T {
  if (!response || response.result === undefined) throw new Error('missing tool result');
  return response.result as T;
}

function useHome(): string {
  const dir = join(tmpdir(), `ioi-pay-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ wallet: { backend: 'test', default: 'test' }, limits: { maxPerCall: '1', dailyCap: '5' } }),
  );
  process.env.X402_HOME = dir;
  return dir;
}

async function callChat(
  url: string,
  extra?: { scheme?: string; signer?: ReturnType<typeof fakeSigner>; hooks?: BatchHooks },
) {
  if (extra?.scheme) process.env.IOI_SCHEME = extra.scheme;
  const runtime = createRuntime({
    env: process.env,
    skipChainRead: true,
    ...(extra?.signer ? { signer: extra.signer } : {}),
    ...(extra?.hooks ? { hooks: extra.hooks } : {}),
  });
  runtime.config.mcpUrl = url;
  return dispatch(runtime, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'chat',
      arguments: { model: 'deepseek/deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 },
    },
  });
}

describe('402 sign retry', () => {
  it('signs upto and retries with _meta x402/payment, then returns the receipt', async () => {
    const signer = fakeSigner();
    const hosted = await startMock((call, res) => {
      const paid = call.body.params?._meta?.['x402/payment'];
      if (!paid) {
        json(res, 200, rpcResult(1, {
          isError: true,
          structuredContent: paymentRequired([upto(), exact()]),
          content: [{ type: 'text', text: JSON.stringify(paymentRequired([upto(), exact()])) }],
        }));
        return;
      }
      json(res, 200, rpcResult(2, {
        content: [{ type: 'text', text: '{"choices":[{"message":{"content":"hello"}}]}' }],
        _meta: {
          'x402/payment-response': {
            success: true,
            transaction: '0xabc',
            network: 'eip155:8453',
            payer: PAYER,
          },
        },
      }));
    });
    try {
      useHome();
      process.env.IOI_MCP_URL = hosted.url;
      const response = await callChat(hosted.url, { signer });
      const result = response?.result as {
        isError?: boolean;
        content: Array<{ text: string }>;
        _meta: { 'x402/payment-response': { transaction?: string; scheme?: string; payer?: string } };
      };
      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.text).toContain('hello');
      expect(result._meta['x402/payment-response'].transaction).toBe('0xabc');
      expect(result._meta['x402/payment-response'].scheme).toBe('upto');
      expect(signer.signs).toBe(1);
      const payment = hosted.calls[1]?.body.params?._meta?.['x402/payment'] as {
        accepted: { scheme: string };
        payload: { permit2Authorization: { from: string; witness: { facilitator: string } } };
      };
      expect(payment.accepted.scheme).toBe('upto');
      expect(payment.payload.permit2Authorization.from.toLowerCase()).toBe(PAYER);
      expect(payment.payload.permit2Authorization.witness.facilitator.toLowerCase()).toBe(FACILITATOR);
      expect(JSON.stringify(result)).not.toContain('0x' + '11'.repeat(32));
    } finally {
      await hosted.close();
    }
  });

  it('accepts an HTTP 402 with a PAYMENT-REQUIRED header and falls back to exact', async () => {
    const signer = fakeSigner();
    const required = paymentRequired([exact('2000')]);
    const header = Buffer.from(JSON.stringify(required), 'utf8').toString('base64');
    const hosted = await startMock((call, res) => {
      if (!call.body.params?._meta?.['x402/payment']) {
        json(res, 402, { error: 'payment_required' }, { 'payment-required': header });
        return;
      }
      json(res, 200, rpcResult(2, { content: [{ type: 'text', text: 'paid' }] }));
    });
    try {
      useHome();
      const response = await callChat(hosted.url, { signer });
      const result = response?.result as { content: Array<{ text: string }>; _meta: { 'x402/payment-response': { scheme: string } } };
      expect(result.content[0]?.text).toBe('paid');
      expect(result._meta['x402/payment-response'].scheme).toBe('exact');
      const payment = hosted.calls[1]?.body.params?._meta?.['x402/payment'] as {
        payload: { authorization: { value: string; from: string } };
      };
      expect(payment.payload.authorization.value).toBe('2000');
      expect(payment.payload.authorization.from.toLowerCase()).toBe(PAYER);
    } finally {
      await hosted.close();
    }
  });
});

describe('caps', () => {
  it('refuses a quote over the per-call cap before signing or retrying', async () => {
    const signer = fakeSigner();
    const hosted = await startMock((_call, res) => {
      json(res, 200, rpcResult(1, {
        isError: true,
        structuredContent: paymentRequired([upto('200000')]),
        content: [{ type: 'text', text: 'payment required' }],
      }));
    });
    try {
      useHome();
      process.env.IOI_MAX_PER_CALL = '0.05';
      const response = await callChat(hosted.url, { signer });
      const result = response?.result as { isError: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/exceeds max 0\.05/);
      expect(result.content[0]?.text).toMatch(/Nothing was signed/);
      expect(signer.signs).toBe(0);
      expect(hosted.calls).toHaveLength(1);
    } finally {
      await hosted.close();
    }
  });

  it('refuses when the daily cap is already spent', async () => {
    const signer = fakeSigner();
    const hosted = await startMock((_call, res) => {
      json(res, 200, rpcResult(1, {
        isError: true,
        structuredContent: paymentRequired([upto('10000')]),
        content: [{ type: 'text', text: 'payment required' }],
      }));
    });
    try {
      useHome();
      process.env.IOI_DAILY_CAP = '5';
      process.env.IOI_MAX_PER_CALL = '1';
      recordSpend({
        ts: new Date().toISOString(),
        asset: 'usdc',
        amount: '5',
        paid: true,
        scheme: 'upto',
        tool: 'chat',
      });
      const response = await callChat(hosted.url, { signer });
      const text = resultOf<{ content: Array<{ text: string }> }>(response).content[0]?.text ?? '';
      expect(text).toMatch(/daily cap/i);
      expect(signer.signs).toBe(0);
      expect(hosted.calls).toHaveLength(1);
    } finally {
      await hosted.close();
    }
  });

  it('refuses a batch deposit above the max deposit', async () => {
    const signer = fakeSigner();
    const hosted = await startMock((_call, res) => {
      json(res, 200, rpcResult(1, {
        isError: true,
        structuredContent: paymentRequired([batch('1000', { minDeposit: '50000' })]),
        content: [{ type: 'text', text: 'payment required' }],
      }));
    });
    try {
      useHome();
      process.env.IOI_SCHEME = 'batch-settlement';
      process.env.IOI_MAX_PER_CALL = '1';
      process.env.IOI_MAX_DEPOSIT = '0.01';
      const response = await callChat(hosted.url, { scheme: 'batch-settlement', signer });
      const text = resultOf<{ isError: boolean; content: Array<{ text: string }> }>(response).content[0]?.text ?? '';
      expect(text).toMatch(/max deposit 0\.01/);
      expect(text).toMatch(/Nothing was signed/);
      expect(signer.signs).toBe(0);
      expect(hosted.calls).toHaveLength(1);
    } finally {
      await hosted.close();
    }
  });
});

describe('api key', () => {
  it('sends Bearer auth and does not sign', async () => {
    const secret = 'sk-canary-test-secret-value';
    const signer = fakeSigner();
    const hosted = await startMock((call, res) => {
      expect(call.headers.authorization).toBe(`Bearer ${secret}`);
      expect(call.body.params?._meta).toBeUndefined();
      json(res, 200, rpcResult(1, { content: [{ type: 'text', text: 'keyed' }] }));
    });
    try {
      useHome();
      process.env.IOI_API_KEY = secret;
      const response = await callChat(hosted.url, { signer });
      const result = response?.result as { content: Array<{ text: string }>; _meta?: unknown };
      expect(result.content[0]?.text).toBe('keyed');
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(signer.signs).toBe(0);
    } finally {
      await hosted.close();
    }
  });
});

describe('batch-settlement', () => {
  it('reuses an open channel as a voucher and otherwise prefers upto', async () => {
    const signer = fakeSigner();
    let phase: 'voucher' | 'upto' = 'voucher';
    const hosted = await startMock((call, res) => {
      if (!call.body.params?._meta?.['x402/payment']) {
        json(res, 200, rpcResult(1, {
          isError: true,
          structuredContent: paymentRequired([batch(), upto()]),
          content: [{ type: 'text', text: 'pay' }],
        }));
        return;
      }
      json(res, 200, rpcResult(2, { content: [{ type: 'text', text: phase }] }));
    });
    try {
      const home = useHome();
      const channel = await loadRhDist<{
        channelSalt(option: { raw: { extra?: unknown } }): string;
      }>('core/channel.js');
      const flow = await loadRhDist<{
        slotFor(option: unknown, wallet: string, backend: string, salt: string): string;
      }>('core/channelflow.js');
      const store = await loadRhDist<{
        writeChannel(record: Record<string, unknown>): void;
      }>('core/channelstore.js');
      const x402 = await import('@roundhouseai/x402');
      const required = x402.parsePaymentRequired(paymentRequired([batch(), upto()]));
      const option = required.options.find((item) => item.scheme === 'batch-settlement');
      expect(option).toBeDefined();
      expect(channel && flow && store).toBeTruthy();
      const slot = flow!.slotFor(option!, 'test', 'test', channel!.channelSalt(option!));
      store!.writeChannel({
        version: 1,
        slot,
        channelId: `0x${'ab'.repeat(32)}`,
        config: {
          payer: PAYER,
          payerAuthorizer: PAYER,
          receiver: PAY_TO,
          receiverAuthorizer: RECEIVER_AUTH,
          token: USDC,
          withdrawDelay: 900,
          salt: `0x${'00'.repeat(32)}`,
        },
        network: 'eip155:8453',
        chain: 'eip155:8453',
        wallet: 'test',
        backend: 'test',
        url: 'mcp://tool/chat',
        asset: USDC,
        assetSymbol: 'usdc',
        decimals: 6,
        balance: '1000000',
        charged: '0',
        signedMax: '0',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      expect(home).toBe(process.env.X402_HOME);
      const first = await callChat(hosted.url, { signer });
      const voucherReceipt = resultOf<{
        _meta: { 'x402/payment-response': { scheme: string; channel?: { kind: string } } };
      }>(first)._meta['x402/payment-response'];
      expect(voucherReceipt.scheme).toBe('batch-settlement');
      expect(voucherReceipt.channel?.kind).toBe('voucher');
      const voucherPay = hosted.calls[1]?.body.params?._meta?.['x402/payment'] as { payload: { type: string } };
      expect(voucherPay.payload.type).toBe('voucher');
      expect(signer.signs).toBe(1);

      store!.writeChannel({
        version: 1,
        slot,
        channelId: `0x${'ab'.repeat(32)}`,
        config: {
          payer: PAYER,
          payerAuthorizer: PAYER,
          receiver: PAY_TO,
          receiverAuthorizer: RECEIVER_AUTH,
          token: USDC,
          withdrawDelay: 900,
          salt: `0x${'00'.repeat(32)}`,
        },
        network: 'eip155:8453',
        chain: 'eip155:8453',
        wallet: 'test',
        backend: 'test',
        url: 'mcp://tool/chat',
        asset: USDC,
        assetSymbol: 'usdc',
        decimals: 6,
        balance: '0',
        charged: '0',
        signedMax: '0',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      phase = 'upto';
      const before = signer.signs;
      const second = await callChat(hosted.url, { signer });
      const scheme = resultOf<{ _meta: { 'x402/payment-response': { scheme: string } } }>(second)._meta[
        'x402/payment-response'
      ].scheme;
      expect(scheme).toBe('upto');
      expect(signer.signs).toBe(before + 1);
    } finally {
      await hosted.close();
    }
  });

  it('uses createEvmBatchPayment when that export is injected, and the vendored signer otherwise', async () => {
    const signer = fakeSigner();
    const hosted = await startMock((call, res) => {
      if (!call.body.params?._meta) {
        json(res, 200, rpcResult(1, {
          isError: true,
          structuredContent: paymentRequired([batch()]),
          content: [{ type: 'text', text: 'pay' }],
        }));
        return;
      }
      json(res, 200, rpcResult(2, { content: [{ type: 'text', text: 'ok' }] }));
    });
    try {
      useHome();
      process.env.IOI_MAX_PER_CALL = '1';
      process.env.IOI_MAX_DEPOSIT = '1';
      const response = await callChat(hosted.url, {
        scheme: 'batch-settlement',
        signer,
        hooks: {
          createEvmBatchPayment: async () => ({ payload: { type: 'voucher', via: 'pr55' } }),
        },
      });
      expect(resultOf<{ isError?: boolean }>(response).isError).toBeUndefined();
      expect(signer.signs).toBe(0);
      const payment = hosted.calls[1]?.body.params?._meta?.['x402/payment'] as { payload: { via?: string } };
      expect(payment.payload.via).toBe('pr55');
    } finally {
      await hosted.close();
    }
  });
});
