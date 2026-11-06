# noid-scan MCP server

A **read-only** Model Context Protocol server that gives any AI agent — Claude, Cursor,
your own bot — direct access to the Parano1d (NOID) chain through the NOID Scan explorer
API. No local node, no API key, no wallet: every tool is a read, and the API is free.

```
npx noid-scan  # or: node mcp-server.mjs
```

## What an agent gets

| Tool | What it answers |
|---|---|
| `chain_overview` | tip height, NOID price/mcap, hashrate, difficulty, peers, supply — one call for "what is happening right now" |
| `block` | one block by height or hash: header, difficulty, reward, miner, txs |
| `blocks` | recent blocks with filters (height/hash/miner search, window, min/max txs) |
| `transaction` | a tx by txid: block, position, fee, inputs and outputs |
| `address` | an o1… address: NOID balance, unspent slots, token holdings, activity |
| `tokens` | the live token screener: price in NOID and USD, 24h change, liquidity, mcap, volume |
| `token` | one token by asset id: supply, reserve, price history, trades, launchpad status |
| `mempool` | pending transactions |
| `search` | resolve a height, hash or address |
| `mining` | hashrate, difficulty, reward schedule, next halving |

## Configure

| Env | Default | Meaning |
|---|---|---|
| `NO1D_API_BASE` | `https://parano1d-scan.com` | Explorer to query (point it at your own deploy) |
| `NO1D_API_KEY` | – | Optional free key (`/api/account` or /account) for the 3000 req/min rate |

## Client setup

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "noid": { "command": "node", "args": ["/path/to/noid-scan/mcp-server.mjs"] }
  }
}
```

Claude Code:

```
claude mcp add noid -- node /path/to/noid-scan/mcp-server.mjs
```

## Safety

- Read-only by design: the tool list contains no write, wallet or admin action.
- The server never sees a private key, never signs, and never spends.
- All traffic is plain HTTPS GETs to the explorer API.
- `tools/call` errors return as `isError` content — a bad query never crashes the server.
