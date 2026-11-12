import { requirementsFromHeaders } from '@roundhouseai/x402';
import { VERSION } from './version.js';
import type { ToolResult } from './tools.js';

export interface HostedOutcome {
  status: number;
  paymentRequired?: unknown;
  result?: ToolResult;
  error?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function isPayment(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Array.isArray(value.accepts);
}

function paymentFromTool(result: ToolResult): unknown | undefined {
  if (result.isError !== true) return undefined;
  if (isPayment(result.structuredContent)) return result.structuredContent;
  const text = result.content[0]?.text;
  if (typeof text !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isPayment(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseSse(text: string): unknown {
  const data: string[] = [];
  for (const block of text.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
  }
  const last = data.filter((line) => line !== '' && line !== '[DONE]').at(-1);
  if (!last) return undefined;
  return JSON.parse(last) as unknown;
}

function asToolResult(value: unknown): ToolResult | undefined {
  if (!isRecord(value)) return undefined;
  const content = Array.isArray(value.content) ? value.content : [];
  const textContent = content
    .filter((item): item is { type: 'text'; text: string } => isRecord(item) && item.type === 'text')
    .map((item) => ({ ...item, type: 'text' as const, text: String(item.text ?? '') }));
  const result: ToolResult = {
    content:
      textContent.length > 0
        ? textContent
        : [{ type: 'text', text: JSON.stringify(value.structuredContent ?? value) }],
    ...(value.structuredContent !== undefined ? { structuredContent: value.structuredContent } : {}),
    ...(value.isError === true ? { isError: true } : {}),
    ...(isRecord(value._meta) ? { _meta: value._meta } : {}),
  };
  return result;
}

export interface HostedRequest {
  url: string;
  method: string;
  params: Record<string, unknown>;
  apiKey?: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  id?: number;
}

/** Stateless streamable-HTTP POST. Redirects are refused so Authorization is not dropped. */
export async function postHosted(req: HostedRequest): Promise<HostedOutcome> {
  const fetchImpl = req.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-06-18',
    'user-agent': `ioi-mcp/${VERSION}`,
  };
  if (req.apiKey) {
    headers.authorization = req.apiKey.toLowerCase().startsWith('bearer ')
      ? req.apiKey
      : `Bearer ${req.apiKey}`;
  }
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: req.id ?? 1,
    method: req.method,
    params: req.params,
  });

  let response: Response;
  try {
    response = await fetchImpl(req.url, {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(req.timeoutMs),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'request failed';
    return { status: 0, error: `could not reach ${req.url}: ${message}` };
  }

  if (response.status >= 300 && response.status < 400) {
    return {
      status: response.status,
      error: `hosted MCP redirected (${response.status}). Refusing to follow so Authorization is not dropped.`,
    };
  }

  const raw = await response.text();
  const headerMap: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headerMap[key.toLowerCase()] = value;
  });

  let parsed: unknown;
  const type = headerMap['content-type'] ?? '';
  if (raw.trim() !== '') {
    try {
      parsed = type.includes('text/event-stream') ? parseSse(raw) : (JSON.parse(raw) as unknown);
    } catch {
      parsed = undefined;
    }
  }

  if (response.status === 402) {
    const fromHeader = requirementsFromHeaders(headerMap);
    const bodyPayment = isPayment(parsed)
      ? parsed
      : isRecord(parsed) && isPayment(parsed.result)
        ? parsed.result
        : isRecord(parsed) && isRecord(parsed.error) && isPayment(parsed.error.data)
          ? parsed.error.data
          : undefined;
    const payment = fromHeader ?? bodyPayment ?? parsed;
    if (payment !== undefined) return { status: 402, paymentRequired: payment };
    return { status: 402, error: 'hosted MCP returned HTTP 402 without payment requirements' };
  }

  if (!isRecord(parsed)) {
    return {
      status: response.status,
      error: `hosted MCP returned HTTP ${response.status} with no JSON-RPC body`,
    };
  }
  if (parsed.error !== undefined) {
    const message = isRecord(parsed.error) ? String(parsed.error.message ?? 'hosted error') : 'hosted error';
    return { status: response.status, error: message };
  }
  const result = asToolResult(parsed.result);
  if (!result) {
    return { status: response.status, error: 'hosted MCP response had no result' };
  }
  const payment = paymentFromTool(result);
  if (payment) return { status: response.status, paymentRequired: payment, result };
  if (response.status >= 400) {
    return { status: response.status, error: `hosted MCP returned HTTP ${response.status}`, result };
  }
  return { status: response.status, result };
}
