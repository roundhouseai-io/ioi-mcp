import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readRecords, spentToday, type LedgerRecord } from '@roundhouseai/x402';

export interface SpendRow {
  ts: string;
  asset: string;
  amount: string;
  paid: boolean;
  scheme: string;
  tool: string;
}

/** Same root rh-x402 uses. `X402_HOME` keeps tests off the real wallet files. */
export function x402Home(): string {
  const home = process.env.X402_HOME;
  return home && home.length > 0 ? home : join(homedir(), '.x402');
}

function spendFile(): string {
  return join(x402Home(), 'ioi-mcp.jsonl');
}

function readOurRows(): SpendRow[] {
  const file = spendFile();
  if (!existsSync(file)) return [];
  const rows: SpendRow[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const parsed: unknown = JSON.parse(line);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'paid' in parsed &&
      'amount' in parsed &&
      'asset' in parsed &&
      'ts' in parsed
    ) {
      rows.push(parsed as SpendRow);
    }
  }
  return rows;
}

/**
 * USDC already counted today: this process's file plus the rh-x402 ledger, so a
 * cap set for the CLI also covers MCP calls and the other way around.
 */
export function spentAtomic(asset: string, decimals: number, now = Date.now()): bigint {
  let rh = 0n;
  try {
    rh = spentToday(readRecords(), asset, decimals, now);
  } catch (err) {
    throw new Error(
      `could not read the rh-x402 ledger (${err instanceof Error ? err.message : 'unreadable'}). Nothing was signed.`,
    );
  }
  const ours = readOurRows().map(
    (row) =>
      ({
        ts: row.ts,
        payment: { paid: row.paid, amount: row.amount, asset: row.asset },
      }) as LedgerRecord,
  );
  return rh + spentToday(ours, asset, decimals, now);
}

export function recordSpend(row: SpendRow): void {
  const file = spendFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
}
