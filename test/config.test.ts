import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadIoiConfig } from '../src/config.js';

const previous = process.env.X402_HOME;

afterEach(() => {
  if (previous === undefined) delete process.env.X402_HOME;
  else process.env.X402_HOME = previous;
  delete process.env.IOI_MAX_PER_CALL;
  delete process.env.IOI_DAILY_CAP;
  delete process.env.IOI_MAX_DEPOSIT;
  delete process.env.IOI_SCHEME;
});

describe('loadIoiConfig', () => {
  it('uses the inference defaults when rh-x402 limits were not set by the user', () => {
    const dir = join(tmpdir(), `ioi-cfg-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    process.env.X402_HOME = dir;
    const config = loadIoiConfig(process.env);
    expect(config.maxPerCall).toBe('0.05');
    expect(config.dailyCap).toBe('5');
    expect(config.maxDeposit).toBe('1');
    expect(config.scheme).toBeUndefined();
    expect(config.apiKey).toBeUndefined();
    expect(config.timeoutSeconds).toBe(120);
  });

  it('reuses a limit the user saved in the rh-x402 config, and lets env win', () => {
    const dir = join(tmpdir(), `ioi-cfg-user-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        limits: { maxPerCall: '0.02', dailyCap: '2' },
        channels: { maxDeposit: '0.25' },
        defaults: { scheme: 'exact' },
      }),
    );
    process.env.X402_HOME = dir;
    const fromFile = loadIoiConfig(process.env);
    expect(fromFile.maxPerCall).toBe('0.02');
    expect(fromFile.dailyCap).toBe('2');
    expect(fromFile.maxDeposit).toBe('0.25');
    expect(fromFile.scheme).toBe('exact');

    process.env.IOI_MAX_PER_CALL = '0.01';
    process.env.IOI_SCHEME = 'upto';
    const fromEnv = loadIoiConfig(process.env);
    expect(fromEnv.maxPerCall).toBe('0.01');
    expect(fromEnv.scheme).toBe('upto');
  });

  it('rejects a cap that is not a decimal amount', () => {
    process.env.IOI_MAX_PER_CALL = 'lots';
    expect(() => loadIoiConfig(process.env)).toThrow(/IOI_MAX_PER_CALL/);
  });
});
