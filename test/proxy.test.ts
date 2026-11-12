import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRuntime, dispatch } from '../src/server.js';
import { batchSupport } from '../src/rhdist.js';
import { json, rpcResult, startMock } from './support.js';

describe('tool proxy', () => {
  it('lists hosted tools when the server answers, and falls back when it does not', async () => {
    const hosted = await startMock((call, res) => {
      json(
        res,
        200,
        rpcResult(call.body, {
          tools: [
            {
              name: 'chat',
              description: 'hosted-schema-marker',
              inputSchema: { type: 'object', properties: { model: { type: 'string' } } },
            },
          ],
        }),
      );
    });
    try {
      process.env.IOI_MCP_URL = hosted.url;
      const runtime = createRuntime({ env: process.env });
      const listed = await dispatch(runtime, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const tools = (listed?.result as { tools?: Array<{ description: string }> } | undefined)?.tools;
      expect(tools?.[0]?.description).toBe('hosted-schema-marker');
    } finally {
      delete process.env.IOI_MCP_URL;
      await hosted.close();
    }

    const down = await startMock((_call, res) => {
      res.writeHead(404);
      res.end('missing');
    });
    try {
      process.env.IOI_MCP_URL = down.url;
      const runtime = createRuntime({ env: process.env });
      const listed = await dispatch(runtime, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
      const names = (listed?.result as { tools?: Array<{ name: string }> } | undefined)?.tools?.map(
        (tool) => tool.name,
      );
      expect(names).toEqual(['list_models', 'get_quote', 'chat', 'complete']);
    } finally {
      delete process.env.IOI_MCP_URL;
      await down.close();
    }
  });

  it('forwards a free tool call and does not sign', async () => {
    const hosted = await startMock((call, res) => {
      expect(call.headers.authorization).toBeUndefined();
      json(
        res,
        200,
        rpcResult(1, {
          content: [{ type: 'text', text: JSON.stringify({ data: [{ id: 'deepseek/deepseek-v4.1-flash' }] }) }],
        }),
      );
    });
    try {
      process.env.IOI_MCP_URL = hosted.url;
      const runtime = createRuntime({ env: process.env, signer: undefined });
      const response = await dispatch(runtime, {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'list_models', arguments: {} },
      });
      const result = response?.result as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.text).toContain('deepseek');
      expect(hosted.calls).toHaveLength(1);
      expect(hosted.calls[0]?.body.method).toBe('tools/call');
    } finally {
      delete process.env.IOI_MCP_URL;
      await hosted.close();
    }
  });

  it('speaks newline JSON-RPC on stdio', async () => {
    const hosted = await startMock((call, res) => {
      json(res, 200, rpcResult(call.body, { tools: [{ name: 'list_models', description: 'stdio', inputSchema: { type: 'object' } }] }));
    });
    const home = mkdtempSync(join(tmpdir(), 'ioi-stdio-'));
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, IOI_MCP_URL: hosted.url, X402_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const line = new Promise<string>((resolve, reject) => {
      let buf = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf('\n');
        if (nl >= 0) resolve(buf.slice(0, nl));
      });
      child.on('exit', (code) => reject(new Error(`exited ${code}: ${stderr}`)));
    });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
      })}\n`,
    );
    const raw = await line;
    child.stdin.end();
    const message = JSON.parse(raw) as { result: { serverInfo: { name: string }; protocolVersion: string } };
    expect(message.result.serverInfo.name).toBe('ioi-mcp');
    expect(message.result.protocolVersion).toBe('2025-06-18');
    expect(stderr).not.toMatch(/sk-canary|private key|0x[0-9a-fA-F]{64}/);
    await hosted.close();
    child.kill();
  });
});

describe('rh-x402 batch feature detect', () => {
  it('sees the 0.8.0 vendored channel client and not the PR 55 export', async () => {
    const support = await batchSupport();
    expect(support.vendored).toBe(true);
    expect(support.pr55).toBe(false);
  });
});
