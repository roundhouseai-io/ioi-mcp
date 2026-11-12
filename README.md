# ioi MCP

[MCP](https://modelcontextprotocol.io) server for [ioi.md](https://www.ioi.md): pay-per-call open-model inference. One hosted endpoint, USDC on Base over [x402](https://www.x402.org/), or a `sk-canary-…` API key.

- **Remote:** `https://www.ioi.md/mcp` (stateless streamable HTTP, POST only)
- **Local:** [`@roundhouseai/ioi-mcp`](https://www.npmjs.com/package/@roundhouseai/ioi-mcp) (`ioi-mcp`), a stdio server that proxies those tools and signs x402 from the wallet you already set up with [`rh-x402`](https://www.npmjs.com/package/@roundhouseai/x402)
- **Docs:** [ioi.md/skill.md](https://www.ioi.md/skill.md) · [llms-install.md](./llms-install.md) · [server.json](./server.json)

Claude Desktop, Cursor, and Claude Code do not sign x402 payments themselves. Point them at the **local package** if the wallet should pay per call. Point them at the **remote URL** if you pass an API key, or if the host knows how to attach `_meta["x402/payment"]`.

## Tools

| Tool | Pay? | What it does |
| --- | --- | --- |
| `list_models` | free | Model ids, context windows, and prices (micro-USD per 1M tokens) |
| `get_quote` | free | USDC ceiling for a chat or completion. Nothing is signed |
| `chat` | paid | OpenAI-shaped chat completion |
| `complete` | paid | OpenAI-shaped text completion |

Set `max_tokens`. Without it, an `upto` quote assumes 4,096 output tokens and an `exact` quote assumes 512. The facilitator minimum on `upto` and `exact` is 0.001 USDC. When `https://www.ioi.md/mcp` is up, `tools/list` is taken from that server so the schemas stay the hosted ones. The table above is the fallback.

## Quick install

### Local wallet (Claude Code, Claude Desktop, Cursor)

The wallet is the one `rh-x402` already uses (`~/.x402`, or `X402_HOME`). If you have not created it:

```bash
npx @roundhouseai/x402 setup --path ows --max-per-call 0.05 --daily-cap 5 --telemetry off --yes
```

Fund the address it prints with a little USDC on Base. Then:

```bash
claude mcp add ioi -- npx -y @roundhouseai/ioi-mcp
```

Cursor, or Claude Desktop `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ioi": {
      "command": "npx",
      "args": ["-y", "@roundhouseai/ioi-mcp"]
    }
  }
}
```

### API key, no wallet

Create a key at [ioi.md/app/keys](https://www.ioi.md/login?next=/app/keys). It starts with `sk-canary-`. Put it in the environment yourself. Do not paste it into chat.

```bash
claude mcp add ioi --env IOI_API_KEY=sk-canary-… -- npx -y @roundhouseai/ioi-mcp
```

With a key set, every call sends `Authorization: Bearer` and nothing is signed.

### Remote URL

```bash
claude mcp add --transport http ioi https://www.ioi.md/mcp
```

With a key:

```bash
claude mcp add --transport http ioi https://www.ioi.md/mcp \
  --header "Authorization: Bearer sk-canary-…"
```

Cursor:

```json
{
  "mcpServers": {
    "ioi": { "url": "https://www.ioi.md/mcp" }
  }
}
```

Use `https://www.ioi.md` exactly. `https://ioi.md` redirects, and many clients drop `Authorization` on a redirect.

## How a paid call works

1. The local server calls the hosted tool with no payment.
2. The host answers with payment requirements: an MCP tool error whose `structuredContent` is an x402 `PaymentRequired`, or HTTP 402 with a `PAYMENT-REQUIRED` header.
3. This process picks a scheme, checks the caps, signs with the rh-x402 wallet, and retries the same call with `_meta["x402/payment"]`.
4. The tool result carries the receipt in `_meta["x402/payment-response"]` (transaction hash when the host settled on-chain, or the channel id and voucher when the payment was `batch-settlement`).

Schemes, in the order they are used:

- **`upto`** (default when the quote offers it). You sign a ceiling. ioi settles once, for the tokens actually used, never above the ceiling, and at least 0.001 USDC.
- **`exact`**. You pay the whole quote. Used when the quote has no `upto`, or when `IOI_SCHEME=exact`.
- **`batch-settlement`**. A channel on Base. The first call deposits USDC (the quote's `minDeposit`, default 0.05, times a small multiplier) and a voucher. Later calls are vouchers against that escrow, with no per-request 0.001 floor. This client opens a channel only when `IOI_SCHEME=batch-settlement` (or `defaults.scheme` in the rh-x402 config). If `~/.x402/channels` already has a channel that covers the quote, that channel is reused as a voucher without a new deposit. Signing goes through [`@roundhouseai/x402`](https://github.com/roundhouseai-io/x402) 0.8.0. The official `@x402/evm` `BatchSettlementEvmScheme` path lands in [x402#55](https://github.com/roundhouseai-io/x402/pull/55); this package calls `createEvmBatchPayment` when the installed build exports it. Until you bump the dependency to that release, the 0.8.0 channel client signs instead.

Network is Base (`eip155:8453`), asset USDC. Keys never leave the rh-x402 signer. This process does not print them.

## Spend caps

A quote over a cap is refused. The tool result is an MCP error and nothing is signed.

| Cap | Env | Default |
| --- | --- | --- |
| Per call | `IOI_MAX_PER_CALL` | `0.05` USDC, or `limits.maxPerCall` if you set it in rh-x402 |
| Per UTC day | `IOI_DAILY_CAP` | `5` USDC, or `limits.dailyCap` if you set it |
| Batch deposit | `IOI_MAX_DEPOSIT` | `1` USDC, or `channels.maxDeposit` when that rh-x402 setting exists |

The daily figure includes spend this package recorded in `~/.x402/ioi-mcp.jsonl` and spend already in the rh-x402 ledger. A voucher on an open channel does not count again. A deposit counts the deposit. `upto` and `exact` count the signed ceiling, which is the most that call can settle.

`IOI_SCHEME` forces `upto`, `exact`, or `batch-settlement`. `IOI_MCP_URL` overrides the hosted endpoint. `IOI_TIMEOUT_SECONDS` defaults to 120.

## Publishing

Do not publish from a branch push. The workflow [`.github/workflows/publish.yml`](./.github/workflows/publish.yml) runs only on a `v*` tag.

1. Confirm `package.json` `version`, `mcpName`, and `server.json` `version` / `packages[0].version` are the same. `mcpName` must stay `io.github.roundhouseai-io/ioi-mcp`.
2. When [x402#55](https://github.com/roundhouseai-io/x402/pull/55) is on npm, bump `@roundhouseai/x402` to that version. `createEvmBatchPayment` is picked up by feature detection. The vendored 0.8.0 signer remains the fallback.
3. Add a repository secret `NPM_TOKEN` (npm automation token that can publish `@roundhouseai/ioi-mcp`). The `@roundhouseai` scope already exists.
4. Merge to `main`. Tag and push: `git tag v0.1.0 && git push origin v0.1.0`.
5. The workflow publishes the npm package (`npm publish --access public`), then `mcp-publisher login github-oidc` and `mcp-publisher publish`. OIDC needs `id-token: write`, which the workflow sets. The registry name `io.github.roundhouseai-io/ioi-mcp` is granted because the workflow runs in the `roundhouseai-io` org. npm must succeed first: the registry checks that the published package's `mcpName` matches `server.json`.

To publish by hand, from a checkout of the tag, with `NPM_TOKEN` and a local `mcp-publisher`:

```bash
npm ci && npm test && npm run build
npm publish --access public
./mcp-publisher login github-oidc
./mcp-publisher publish
```

## Development

```bash
npm ci
npm test
npm run lint && npm run typecheck && npm run build
```

Node 20.10 or newer. Tests mock the hosted server. A live `list_models` call runs only when `https://www.ioi.md/mcp` answers; otherwise that test is skipped. A paid live call runs only when `TEST_EVM_PRIVATE_KEY` is set (a `0x` key with Base USDC). It is capped at $0.05 per call and $0.20 for the day, and it is skipped when the host is not deployed.

## License

[MIT](./LICENSE)
