// noid-scan MCP server — read-only chain data for AI agents.
//
// A zero-dependency Model Context Protocol server (stdio transport) that exposes the
// NOID Scan explorer API (https://parano1d-scan.com/api) as typed tools. An agent that
// speaks MCP — Claude, Cursor, any bot — can query the Parano1d chain directly: blocks,
// transactions, addresses, tokens, prices, mempool. Nothing here spends, signs, or holds
// keys: every tool is a read, and the API is free.
//
// Usage:
//   node mcp-server.mjs [--port N]        # run over stdio (default)
//   NO1D_API_BASE=http://127.0.0.1:8098  # point at your own explorer
//   NO1D_API_KEY=nk_...                  # optional key; the free tier works without one
//
// Requires Node >= 22 (global fetch). Zero npm dependencies.

const BASE = process.env.NO1D_API_BASE || 'https://parano1d-scan.com';
const KEY = process.env.NO1D_API_KEY || '';
const NAME = 'noid-scan';
const VERSION = '0.1.0';
const PROTOCOL = '2024-11-05';

const TOOLS = [
  {
    name: 'chain_overview',
    description: 'Current Parano1d chain state: tip height, NOID price and market cap, hashrate, difficulty, peers, supply, block time. One call for everything an agent needs to know now.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'block',
    description: 'One Parano1d block by height or 64-hex hash. Returns the header, difficulty, reward, miner, and transactions while retained.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'block height or 64-hex hash' } },
      required: ['id'], additionalProperties: false,
    },
  },
  {
    name: 'blocks',
    description: 'Recent Parano1d blocks, newest first. Supports the block-list filters: q (height, hash prefix or miner o1…), window (1h, 24h, 7d, 30d), min_txs and max_txs.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'height, hash prefix or miner address' },
        before: { type: 'integer', description: 'page back from this height' },
        limit: { type: 'integer', description: 'max rows (default 24, max 50)' },
        window: { type: 'string', enum: ['1h', '24h', '7d', '30d'] },
        min_txs: { type: 'integer' }, max_txs: { type: 'integer' },
      }, additionalProperties: false,
    },
  },
  {
    name: 'transaction',
    description: 'A Parano1d transaction by 64-hex txid: block, position, fee, inputs and outputs (or explanation of a failed lookup).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '64-hex txid' } },
      required: ['id'], additionalProperties: false,
    },
  },
  {
    name: 'address',
    description: 'A Parano1d o1… address: NOID balance in micronoid, unspent slots, token holdings, recent activity. Use this for wallet questions.',
    inputSchema: {
      type: 'object',
      properties: { address: { type: 'string', description: 'o1… address' } },
      required: ['address'], additionalProperties: false,
    },
  },
  {
    name: 'tokens',
    description: 'The live Parano1d token screener: native tokens with price (NOID and USD from the same feed as the market panel), 24h change, liquidity, market cap, volume, makers. Sort by volume, mcap, price, change, txns, newest.',
    inputSchema: {
      type: 'object',
      properties: {
        sort: { type: 'string', enum: ['volume', 'mcap', 'price', 'change', 'txns', 'newest'], description: 'sort key (default volume)' },
        limit: { type: 'integer', description: 'max rows (default 24, max 64)' },
        ids: { type: 'string', description: 'comma-separated 64-hex asset ids to fetch exactly' },
      }, additionalProperties: false,
    },
  },
  {
    name: 'token',
    description: 'One Parano1d token by its 64-hex asset id: name, ticker, supply, reserve, price, price history, launchpad status, trades, and whether the trade card is live.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '64-hex asset id' } },
      required: ['id'], additionalProperties: false,
    },
  },
  {
    name: 'mempool',
    description: 'The node mempool: pending transactions waiting for the next block.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'search',
    description: 'Resolve one query across the chain: a height, a 64-hex hash (block or txid), or an o1… address.',
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string', description: 'height, hash or address' } },
      required: ['q'], additionalProperties: false,
    },
  },
  {
    name: 'mining',
    description: 'Current mining picture: hashrate, difficulty, block reward schedule and the next halving. The numbers an agent needs to reason about NOID supply and miner economics.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

async function api(path, params) {
  const u = new URL(`${BASE}/api/${path}`);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  const headers = KEY ? { 'x-api-key': KEY } : {};
  const r = await fetch(u, { headers });
  const body = await r.json().catch(async () => ({ _raw: await r.text().catch(() => '') }));
  if (!r.ok) throw new Error(`${r.status}: ${body?.error || JSON.stringify(body).slice(0, 300)}`);
  return body;
}

// path -> array of [tool name, api path, param picker]. Query params are passed straight through.
async function callTool(name, args) {
  const a = args || {};
  switch (name) {
    case 'chain_overview': return api('stats');
    case 'block': {
      if (!a.id) throw new Error('block needs an id: height or 64-hex hash');
      return api(`block/${encodeURIComponent(a.id)}`);
    }
    case 'blocks': return api('blocks', { q: a.q, before: a.before, limit: a.limit, window: a.window, min_txs: a.min_txs, max_txs: a.max_txs });
    case 'transaction': {
      if (!a.id) throw new Error('transaction needs a 64-hex id');
      return api(`tx/${encodeURIComponent(a.id)}`);
    }
    case 'address': {
      if (!/^o1[02-9ac-hj-np-z]{6,120}$/.test(a.address || '')) throw new Error('address must be an o1… address');
      return api(`address/${encodeURIComponent(a.address)}`);
    }
    case 'tokens': return api('tokens', { sort: a.sort, limit: a.limit, ids: a.ids });
    case 'token': {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(a.id || '')) throw new Error('token needs its 64-hex asset id');
      return api(`token/${encodeURIComponent(a.id)}`);
    }
    case 'mempool': return api('mempool');
    case 'search': {
      if (!a.q) throw new Error('search needs a query');
      return api('search', { q: a.q });
    }
    case 'mining': return api('stats');
    default: throw new Error(`no such tool: ${name}`);
  }
}

// MCP request -> response object (or null for notifications). Pure, so tests can drive it.
async function handle(msg) {
  if (msg === null || typeof msg !== 'object' || typeof msg.method !== 'string') return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'invalid request' } };
  const { id, method, params } = msg;
  try {
    switch (method) {
      case 'initialize':
        return { jsonrpc: '2.0', id, result: { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: NAME, version: VERSION } } };
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null; // notifications have no response
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
      case 'tools/call': {
        const text = await callTool(params?.name, params?.arguments);
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(text, null, 2) }] } };
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
    }
  } catch (e) {
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true } };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdin.setEncoding('utf8');
  let buf = '';
  process.stdin.on('data', async (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const resp = await handle(msg);
      if (resp) process.stdout.write(JSON.stringify(resp) + '\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

export { handle, TOOLS, callTool, api };
