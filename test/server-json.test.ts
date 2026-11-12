import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { MCP_NAME, VERSION } from '../src/version.js';

const require = createRequire(import.meta.url);
const Ajv = require('ajv') as new (opts?: object) => {
  compile: (schema: object) => ((data: unknown) => boolean) & { errors: unknown };
};
const addFormats = require('ajv-formats') as (ajv: InstanceType<typeof Ajv>) => void;

describe('server.json', () => {
  const server = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8')) as {
    name: string;
    version: string;
    description: string;
    remotes: Array<{ type: string; url: string; headers?: Array<{ name: string; isRequired?: boolean; isSecret?: boolean }> }>;
    packages: Array<{ registryType: string; identifier: string; version: string; transport: { type: string } }>;
  };
  const pkg = require('../package.json') as { name: string; version: string; mcpName: string };

  it('matches the package name, mcpName, and version', () => {
    expect(server.name).toBe(MCP_NAME);
    expect(server.name).toBe(pkg.mcpName);
    expect(pkg.name).toBe('@roundhouseai/ioi-mcp');
    expect(server.version).toBe(VERSION);
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0]?.version).toBe(pkg.version);
    expect(server.packages[0]?.identifier).toBe(pkg.name);
    expect(server.description.length).toBeGreaterThan(0);
    expect(server.description.length).toBeLessThanOrEqual(100);
  });

  it('offers the hosted streamable HTTP remote and the npm stdio package', () => {
    expect(server.remotes[0]).toMatchObject({
      type: 'streamable-http',
      url: 'https://www.ioi.md/mcp',
    });
    const header = server.remotes[0]?.headers?.[0];
    expect(header?.name).toBe('Authorization');
    expect(header?.isRequired).toBe(false);
    expect(header?.isSecret).toBe(true);
    expect(server.packages[0]?.registryType).toBe('npm');
    expect(server.packages[0]?.transport.type).toBe('stdio');
  });

  it('validates against the official MCP registry schema', () => {
    const schema = JSON.parse(readFileSync(new URL('./fixtures/server.schema.json', import.meta.url), 'utf8')) as object;
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const ok = validate(server);
    expect(validate.errors).toBeNull();
    expect(ok).toBe(true);
  });
});
