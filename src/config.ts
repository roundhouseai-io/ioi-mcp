import {
  DEFAULT_CONFIG,
  loadConfig,
  type X402Config,
} from '@roundhouseai/x402';
import {
  DEFAULT_DAILY_CAP,
  DEFAULT_MAX_DEPOSIT,
  DEFAULT_MAX_PER_CALL,
  DEFAULT_MCP_URL,
} from './version.js';

export interface IoiConfig {
  mcpUrl: string;
  /** Set means Bearer auth, and this process does not sign. */
  apiKey?: string;
  maxPerCall: string;
  dailyCap: string;
  maxDeposit: string;
  /** Force `exact`, `upto`, or `batch-settlement`. Absent prefers upto, then exact. */
  scheme?: string;
  chain: string;
  timeoutSeconds: number;
  rh: X402Config;
  /** rh-x402 config could not be read. Free tools still work. */
  configError?: string;
}

interface Loaded {
  config: X402Config;
  origins?: Record<string, string>;
}

function trimmed(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  const text = value.trim();
  return text === '' ? undefined : text;
}

function amount(value: string, name: string): string {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`${name} must be a decimal amount of USDC, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Wallet and limits come from rh-x402 (`~/.x402/config.json`, overridable with
 * `X402_HOME`). A limit the user actually set wins. The built-in rh-x402
 * per-call default is $1, which is looser than a pay-per-call inference tool
 * should assume, so an unset per-call cap falls back to $0.05.
 */
export function loadIoiConfig(env: NodeJS.ProcessEnv = process.env): IoiConfig {
  let loaded: Loaded | undefined;
  let configError: string | undefined;
  try {
    loaded = loadConfig() as Loaded;
  } catch (err) {
    configError = err instanceof Error ? err.message : 'could not read rh-x402 config';
  }
  const rh = loaded?.config ?? DEFAULT_CONFIG;
  const origins = loaded?.origins ?? {};

  const userMax = origins['limits.maxPerCall'];
  const maxFromRh =
    userMax === 'user' || userMax === 'project' || userMax === 'flag'
      ? rh.limits.maxPerCall
      : undefined;
  const userDaily = origins['limits.dailyCap'];
  const dailyFromRh =
    userDaily === 'user' || userDaily === 'project' || userDaily === 'flag'
      ? rh.limits.dailyCap
      : undefined;

  const channels = (rh as { channels?: { maxDeposit?: string } }).channels;
  const schemeFromRh = (rh.defaults as { scheme?: string }).scheme;

  const apiKey = trimmed(env, 'IOI_API_KEY');
  return {
    mcpUrl: trimmed(env, 'IOI_MCP_URL') ?? DEFAULT_MCP_URL,
    ...(apiKey ? { apiKey } : {}),
    maxPerCall: amount(
      trimmed(env, 'IOI_MAX_PER_CALL') ?? maxFromRh ?? DEFAULT_MAX_PER_CALL,
      'IOI_MAX_PER_CALL',
    ),
    dailyCap: amount(
      trimmed(env, 'IOI_DAILY_CAP') ?? dailyFromRh ?? DEFAULT_DAILY_CAP,
      'IOI_DAILY_CAP',
    ),
    maxDeposit: amount(
      trimmed(env, 'IOI_MAX_DEPOSIT') ?? channels?.maxDeposit ?? DEFAULT_MAX_DEPOSIT,
      'IOI_MAX_DEPOSIT',
    ),
    ...(trimmed(env, 'IOI_SCHEME') ?? schemeFromRh
      ? { scheme: (trimmed(env, 'IOI_SCHEME') ?? schemeFromRh)! }
      : {}),
    chain: rh.defaults.chain || 'base',
    timeoutSeconds: positiveInt(trimmed(env, 'IOI_TIMEOUT_SECONDS'), timeoutSeconds(rh, origins)),
    rh,
    ...(configError ? { configError } : {}),
  };
}

function timeoutSeconds(rh: X402Config, origins: Record<string, string>): number {
  const origin = origins['defaults.timeout'];
  if (origin === 'user' || origin === 'project' || origin === 'flag') return rh.defaults.timeout;
  return 120;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback > 0 ? fallback : 120;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error('IOI_TIMEOUT_SECONDS must be a positive integer');
  }
  return n;
}
