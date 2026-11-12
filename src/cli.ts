#!/usr/bin/env node
import { runStdio } from './server.js';

runStdio().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : 'failed to start';
  process.stderr.write(`ioi-mcp: ${message}\n`);
  process.exit(1);
});
