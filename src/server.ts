import { createInterface } from 'node:readline';
import { loadIoiConfig, type IoiConfig } from './config.js';
import { postHosted } from './hosted.js';
import { callTool, type Runtime } from './pay.js';
import { redact } from './redact.js';
import { STATIC_TOOLS, toolError } from './tools.js';
import { VERSION } from './version.js';
import type { SignerBackend } from '@roundhouseai/x402';
import type { BatchHooks } from './batch.js';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface ServerOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  signer?: SignerBackend;
  skipChainRead?: boolean;
  now?: () => number;
  hooks?: BatchHooks;
  config?: IoiConfig;
}

export function createRuntime(opts: ServerOptions = {}): Runtime {
  const env = opts.env ?? process.env;
  const config = opts.config ?? loadIoiConfig(env);
  return {
    config,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.signer ? { signer: opts.signer } : {}),
    skipChainRead: opts.skipChainRead === true,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.hooks ? { hooks: opts.hooks } : {}),
  };
}

function reply(id: string | number | null, result: unknown) {
  return { jsonrpc: '2.0' as const, id, result };
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: '2.0' as const, id, error: { code, message } };
}

async function listTools(runtime: Runtime, params: Record<string, unknown>): Promise<unknown> {
  const listed = await postHosted({
    url: runtime.config.mcpUrl,
    method: 'tools/list',
    params,
    ...(runtime.config.apiKey ? { apiKey: runtime.config.apiKey } : {}),
    timeoutMs: Math.min(runtime.config.timeoutSeconds * 1000, 8_000),
    ...(runtime.fetchImpl ? { fetchImpl: runtime.fetchImpl } : {}),
    id: 1,
  });
  const tools = listed.result?.structuredContent;
  // tools/list result is the JSON-RPC result itself, which asToolResult wraps
  // into content text when there is no content array. Read the raw list off
  // the text when the hosted server returned `{ tools: [...] }`.
  const fromText = parseTools(listed.result?.content[0]?.text);
  if (fromText) return { tools: fromText };
  if (Array.isArray(tools)) return { tools };
  return { tools: STATIC_TOOLS };
}

function parseTools(text: string | undefined): unknown[] | undefined {
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && 'tools' in parsed) {
      const tools = (parsed as { tools: unknown }).tools;
      if (Array.isArray(tools) && tools.length > 0) return tools;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function dispatch(
  runtime: Runtime,
  req: RpcRequest,
): Promise<Record<string, unknown> | undefined> {
  const id = req.id ?? null;
  const notify = req.id === undefined || req.id === null;
  const params = req.params ?? {};
  switch (req.method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return reply(id, {
        protocolVersion: PROTOCOLS.includes(requested) ? requested : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'ioi-mcp', version: VERSION },
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return undefined;
    case 'ping':
      return notify ? undefined : reply(id, {});
    case 'tools/list':
      try {
        return reply(id, await listTools(runtime, params));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'tools/list failed';
        process.stderr.write(`ioi-mcp: ${redact(message, [runtime.config.apiKey])}\n`);
        return reply(id, { tools: STATIC_TOOLS });
      }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args =
        typeof params.arguments === 'object' && params.arguments !== null
          ? (params.arguments as Record<string, unknown>)
          : {};
      if (name === '') return reply(id, toolError('tools/call is missing a name'));
      const result = await callTool(runtime, name, args);
      return reply(id, result);
    }
    case 'resources/list':
      return reply(id, { resources: [] });
    case 'prompts/list':
      return reply(id, { prompts: [] });
    default:
      if (notify) return undefined;
      return rpcError(id, -32601, `method not found: ${String(req.method)}`);
  }
}

export async function runStdio(opts: ServerOptions = {}): Promise<void> {
  const runtime = createRuntime(opts);
  const rl = createInterface({ input: process.stdin });
  let chain = Promise.resolve();
  for await (const line of rl) {
    const text = line.trim();
    if (text === '') continue;
    chain = chain.then(async () => {
      let req: RpcRequest;
      try {
        req = JSON.parse(text) as RpcRequest;
      } catch {
        process.stdout.write(`${JSON.stringify(rpcError(null, -32700, 'parse error'))}\n`);
        return;
      }
      try {
        const response = await dispatch(runtime, req);
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'request failed';
        process.stdout.write(
          `${JSON.stringify(rpcError(req.id ?? null, -32603, redact(message, [runtime.config.apiKey])))}\n`,
        );
      }
    });
    await chain;
  }
}
