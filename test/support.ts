import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SignerBackend } from '@roundhouseai/x402';

export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const PAY_TO = '0x2222222222222222222222222222222222222222';
export const FACILITATOR = '0x4444444444444444444444444444444444444444';
export const RECEIVER_AUTH = '0x3333333333333333333333333333333333333333';
export const PAYER = '0x1111111111111111111111111111111111111111';

export interface Captured {
  headers: IncomingHttpHeaders;
  body: {
    method?: string;
    params?: {
      name?: string;
      arguments?: Record<string, unknown>;
      _meta?: Record<string, unknown>;
    };
  };
}

export function paymentRequired(accepts: unknown[], error = 'Payment required') {
  return {
    x402Version: 2,
    error,
    resource: { url: 'mcp://tool/chat', description: 'chat', mimeType: 'application/json' },
    accepts,
  };
}

export function upto(amount = '1000') {
  return {
    scheme: 'upto',
    network: 'eip155:8453',
    amount,
    asset: USDC,
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { name: 'USD Coin', version: '2', facilitatorAddress: FACILITATOR },
  };
}

export function exact(amount = '1000') {
  return {
    scheme: 'exact',
    network: 'eip155:8453',
    amount,
    asset: USDC,
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { name: 'USD Coin', version: '2' },
  };
}

export function batch(amount = '1000', extra: Record<string, unknown> = {}) {
  return {
    scheme: 'batch-settlement',
    network: 'eip155:8453',
    amount,
    asset: USDC,
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: 'USD Coin', version: '2', receiverAuthorizer: RECEIVER_AUTH, ...extra },
  };
}

export function fakeSigner(opts?: { onSign?: () => void }): SignerBackend & { signs: number } {
  const signer = {
    backend: 'test',
    wallet: 'test',
    signs: 0,
    capabilities: async () => ({
      typedData: true,
      policies: false,
      balances: false,
      accounts: true,
      declared: true,
    }),
    getAccounts: async () => [{ id: 'test', address: PAYER }],
    getAddress: async () => PAYER,
    signTypedData: async () => {
      signer.signs += 1;
      opts?.onSign?.();
      return `0x${'11'.repeat(65)}`;
    },
  };
  return signer;
}

export async function startMock(
  onRequest: (captured: Captured, respond: ServerResponse) => void,
): Promise<{ url: string; calls: Captured[]; close: () => Promise<void> }> {
  const calls: Captured[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw === '' ? {} : (JSON.parse(raw) as Captured['body']);
      const captured = { headers: req.headers, body };
      calls.push(captured);
      onRequest(captured, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    calls,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const raw = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers });
  res.end(raw);
}

export function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}
