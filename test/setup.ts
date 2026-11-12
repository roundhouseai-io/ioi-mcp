import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'ioi-mcp-home-'));
process.env.X402_HOME = home;
delete process.env.IOI_API_KEY;
delete process.env.IOI_SCHEME;
delete process.env.IOI_MAX_PER_CALL;
delete process.env.IOI_DAILY_CAP;
delete process.env.IOI_MAX_DEPOSIT;
delete process.env.IOI_MCP_URL;
delete process.env.IOI_TIMEOUT_SECONDS;
