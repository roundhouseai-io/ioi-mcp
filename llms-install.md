# ioi — install for MCP hosts

Pay-per-call open-model inference. Two transports. Use the local package when the host cannot sign x402.

## Remote

- **URL:** `https://www.ioi.md/mcp`
- **Transport:** streamable HTTP, stateless, POST only. Do not follow a redirect to `https://ioi.md`; `Authorization` is dropped.
- **Auth (pick one):**
  1. Header `Authorization: Bearer sk-canary-…` (key from https://www.ioi.md/login?next=/app/keys). No x402 signature.
  2. x402 on the tool call. Unpaid `tools/call` for `chat` or `complete` returns a tool error with `PaymentRequired` in `structuredContent` (and the same JSON in `content[0].text`), or HTTP 402 with `PAYMENT-REQUIRED`. Retry the same call with `_meta["x402/payment"]`. The receipt comes back in `_meta["x402/payment-response"]`.
- **Free tools:** `list_models`, `get_quote`. Paid tools: `chat`, `complete`.
- **Asset:** USDC on Base, `eip155:8453`. Prefer `upto` (ceiling, settled for tokens used). `exact` pays the whole quote. `batch-settlement` is a channel and is opt-in.

## Claude Code — local signer

```bash
claude mcp add ioi -- npx -y @roundhouseai/ioi-mcp
```

Wallet: existing `rh-x402` config (`npx @roundhouseai/x402 setup` if there is none). Caps default to $0.05/call and $5/day. Override with `IOI_MAX_PER_CALL`, `IOI_DAILY_CAP`, `IOI_MAX_DEPOSIT`. `IOI_API_KEY` skips signing. Never paste a private key or API key into the chat; set the env var outside it.

## Claude Code — remote

```bash
claude mcp add --transport http ioi https://www.ioi.md/mcp
claude mcp add --transport http ioi https://www.ioi.md/mcp --header "Authorization: Bearer sk-canary-…"
```

## Cursor / Claude Desktop JSON

Local:

```json
{
  "mcpServers": {
    "ioi": {
      "command": "npx",
      "args": ["-y", "@roundhouseai/ioi-mcp"],
      "env": { "IOI_MAX_PER_CALL": "0.05", "IOI_DAILY_CAP": "5" }
    }
  }
}
```

Remote:

```json
{
  "mcpServers": {
    "ioi": {
      "url": "https://www.ioi.md/mcp",
      "headers": { "Authorization": "Bearer sk-canary-…" }
    }
  }
}
```

Omit `headers` only when the host will sign x402 itself.

## Registry

`server.json` name: `io.github.roundhouseai-io/ioi-mcp`. npm package `@roundhouseai/ioi-mcp`, bin `ioi-mcp`. `package.json` `mcpName` matches the registry name.

## Docs

- Human: https://www.ioi.md/skill.md
- Models: https://www.ioi.md/v1/models
- Health: https://www.ioi.md/api/health (`x402.ready` must be true before signing)
