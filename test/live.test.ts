import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SignerBackend } from '@roundhouseai/x402';
import { createRuntime, dispatch } from '../src/server.js';
import { DEFAULT_MCP_URL } from '../src/version.js';

async function hostedUp(): Promise<boolean> {
  try {
    const response = await fetch(DEFAULT_MCP_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'ioi-mcp-test', version: '0.1.0' },
        },
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 404 || response.status >= 500) return false;
    const text = await response.text();
    return text.includes('jsonrpc') || text.includes('protocolVersion');
  } catch {
    return false;
  }
}

const savedHome = process.env.X402_HOME;

afterEach(() => {
  if (savedHome === undefined) delete process.env.X402_HOME;
  else process.env.X402_HOME = savedHome;
  delete process.env.IOI_MAX_PER_CALL;
  delete process.env.IOI_DAILY_CAP;
});

describe('live hosted MCP', () => {
  it('list_models when https://www.ioi.md/mcp is deployed', async (ctx) => {
    if (!(await hostedUp())) {
      ctx.skip();
      return;
    }
    const home = mkdtempSync(join(tmpdir(), 'ioi-live-'));
    process.env.X402_HOME = home;
    delete process.env.IOI_API_KEY;
    const runtime = createRuntime({ env: process.env });
    const response = await dispatch(runtime, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_models', arguments: {} },
    });
    const result = response?.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text.length).toBeGreaterThan(0);
  });

  it('pays for a tiny chat when TEST_EVM_PRIVATE_KEY is set', async (ctx) => {
    const key = process.env.TEST_EVM_PRIVATE_KEY;
    if (!key) {
      ctx.skip();
      return;
    }
    if (!(await hostedUp())) {
      ctx.skip();
      return;
    }
    const { privateKeyToAccount } = await import('viem/accounts');
    const account = privateKeyToAccount(key as `0x${string}`);
    const signer: SignerBackend = {
      backend: 'test-evm',
      wallet: 'test-evm',
      capabilities: async () => ({
        typedData: true,
        policies: false,
        balances: false,
        accounts: true,
        declared: true,
      }),
      getAccounts: async () => [{ id: 'test-evm', address: account.address }],
      getAddress: async () => account.address,
      signTypedData: async (typed) => {
        const message: Record<string, unknown> = {};
        for (const [field, value] of Object.entries(typed.message)) {
          const type = typed.types[typed.primaryType]?.find((item) => item.name === field)?.type;
          message[field] =
            typeof value === 'string' && /^\d+$/.test(value) && type?.startsWith('uint')
              ? BigInt(value)
              : value;
        }
        return account.signTypedData({
          domain: typed.domain,
          types: typed.types,
          primaryType: typed.primaryType,
          message,
        } as never);
      },
    };
    const home = mkdtempSync(join(tmpdir(), 'ioi-live-pay-'));
    process.env.X402_HOME = home;
    delete process.env.IOI_API_KEY;
    process.env.IOI_MAX_PER_CALL = '0.05';
    process.env.IOI_DAILY_CAP = '0.20';
    const runtime = createRuntime({ env: process.env, signer, skipChainRead: true });
    const response = await dispatch(runtime, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'chat',
        arguments: {
          model: 'deepseek/deepseek-v4.1-flash',
          messages: [{ role: 'user', content: 'Say hi' }],
          max_tokens: 16,
        },
      },
    });
    const result = response?.result as {
      isError?: boolean;
      content: Array<{ text: string }>;
      _meta?: { 'x402/payment-response'?: { transaction?: string; scheme?: string } };
    };
    const text = result.content.map((part) => part.text).join('\n').split(key).join('[redacted]');
    expect(text).not.toContain(key);
    expect(result.isError).not.toBe(true);
    expect(result._meta?.['x402/payment-response']?.scheme).toMatch(/upto|exact|batch-settlement/);
  });
});
