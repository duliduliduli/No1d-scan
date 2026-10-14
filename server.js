// NOID explorer: indexer + JSON API + static UI in one zero-dependency process.
// Headers and tx pointers are permanent on the node, so we proxy those live and only
// persist what the node prunes (block bodies, ~42-block window) plus chart snapshots.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:9601';
const RPC_TOKEN = process.env.RPC_TOKEN || '';
const RETAINED = 42;
const RATE_LIMIT = Number(process.env.RATE_LIMIT || 120); // requests per IP per minute

const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'noid.db'));
db.exec(`
  create table if not exists blocks (height integer primary key, hash text not null, details text not null);
  create index if not exists blocks_hash on blocks(hash);
  create table if not exists stats (height integer primary key, ts integer, data text not null);
`);
const q = {
  hashAt: db.prepare('select hash from blocks where height = ?'),
  byHeight: db.prepare('select details from blocks where height = ?'),
  heightOf: db.prepare('select height from blocks where hash = ?'),
  upsert: db.prepare('insert or replace into blocks (height, hash, details) values (?, ?, ?)'),
  hasStat: db.prepare('select 1 from stats where height = ?'),
  addStat: db.prepare('insert or replace into stats (height, ts, data) values (?, ?, ?)'),
  charts: db.prepare('select height, ts, data from stats order by height desc limit 500'),
};

async function rpc(method, params = []) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(RPC_TOKEN && { authorization: `Bearer ${RPC_TOKEN}` }) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: `paranoid_${method}`, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

// One indexer pass. Re-checking the whole retained window by hash also handles reorgs:
// a replaced block has a new hash at the same height and gets overwritten.
async function tick() {
  const tip = await rpc('blockCount');
  for (let h = Math.max(0, tip - RETAINED + 1); h <= tip; h++) {
    const hash = await rpc('getBlockHash', [h]);
    if (!hash || q.hashAt.get(h)?.hash === hash) continue;
    const details = await rpc('getBlockDetails', [h]);
    if (details) q.upsert.run(h, hash, JSON.stringify(details));
  }
  if (!q.hasStat.get(tip)) {
    const [chain, peers, mining, header] = await Promise.all([
      rpc('getChainInfo'), rpc('getPeerCount'), rpc('getMiningInfo'), rpc('getBlockHeader', [tip]),
    ]);
    const data = {
      active_slot_count: chain.active_slot_count,
      circulating_supply_micronoid: chain.circulating_supply_micronoid,
      difficulty_bits: mining.difficulty_bits,
      peers,
    };
    q.addStat.run(tip, header?.timestamp ?? null, JSON.stringify(data));
  }
}

// Input validation at the public boundary.
const RE = {
  height: /^\d{1,12}$/,
  hash: /^[0-9a-f]{64}$/,
  address: /^o1[02-9ac-hj-np-z]{6,120}$/, // bech32m charset
};

// shortcut: field name for the per-tx list in `retained` is not documented, so match by content; pin it once seen on a live node.
function findTx(retained, txid) {
  for (const v of Object.values(retained || {})) {
    if (Array.isArray(v)) {
      const hit = v.find((t) => JSON.stringify(t).includes(txid));
      if (hit) return hit;
    }
  }
  return null;
}

async function blockByHeight(h) {
  const live = await rpc('getBlockDetails', [h]);
  if (!live) return null;
  const stored = q.byHeight.get(h);
  const archived = stored && JSON.parse(stored.details);
  const retained = live.retained ?? (archived?.header?.hash === live.header.hash ? archived.retained : null);
  return { header: live.header, retained, archived: !live.retained && !!retained };
}

const routes = {
  async stats() {
    const [chain, state, node, peers, mining] = await Promise.all([
      rpc('getChainInfo'), rpc('getStateInfo'), rpc('getNodeStatus'), rpc('getPeerCount'), rpc('getMiningInfo'),
    ]);
    return { chain, state, node, peers, mining, donate: process.env.DONATE_ADDRESS || null };
  },

  async blocks(_, params) {
    const tip = await rpc('blockCount');
    const before = RE.height.test(params.get('before') || '') ? Math.min(Number(params.get('before')), tip) : tip;
    const limit = Math.min(Math.max(Number(params.get('limit')) || 20, 1), 50);
    const heights = [];
    for (let h = before; h >= 0 && heights.length < limit; h--) heights.push(h);
    const headers = await Promise.all(heights.map((h) => rpc('getBlockHeader', [h])));
    return { tip, blocks: headers.filter(Boolean).map((b) => ({ ...b, indexed: !!q.hashAt.get(b.height) })) };
  },

  async block(id) {
    if (RE.height.test(id)) return blockByHeight(Number(id));
    if (RE.hash.test(id)) {
      const row = q.heightOf.get(id);
      return row ? blockByHeight(row.height) : null;
    }
    throw Object.assign(new Error('expected a height or 64-char hex hash'), { status: 400 });
  },

  async tx(id) {
    if (!RE.hash.test(id)) throw Object.assign(new Error('expected a 64-char hex txid'), { status: 400 });
    const ptr = await rpc('getTx', [id]);
    if (!ptr) return null;
    const block = await blockByHeight(ptr.height);
    return { ...ptr, details: findTx(block?.retained, id) };
  },

  async address(addr, params) {
    if (!RE.address.test(addr)) throw Object.assign(new Error('expected an o1… address'), { status: 400 });
    const page = Math.max(Number(params.get('page')) || 1, 1);
    const [slots, activity] = await Promise.all([
      rpc('getSlotsByOwner', [addr]), rpc('getRecentTransactions', [page, 32, addr]),
    ]);
    const balance = slots.reduce((sum, s) => sum + BigInt(s.value ?? 0), 0n);
    return { address: addr, balance_micronoid: balance.toString(), slots, activity };
  },

  async txs(_, params) {
    return rpc('getRecentTransactions', [Math.max(Number(params.get('page')) || 1, 1), 25, null]);
  },

  async charts() {
    return q.charts.all().reverse().map((r) => ({ height: r.height, ts: r.ts, ...JSON.parse(r.data) }));
  },

  async search(_, params) {
    const s = (params.get('q') || '').trim().toLowerCase();
    if (RE.height.test(s)) return { type: 'block', id: s };
    if (RE.address.test(s)) return { type: 'address', id: s };
    if (RE.hash.test(s)) {
      if (await rpc('getTx', [s])) return { type: 'tx', id: s };
      if (q.heightOf.get(s)) return { type: 'block', id: s };
    }
    return null;
  },
};

// shortcut: in-memory per-IP limiter, resets on restart and is per-process; move to the reverse proxy if you run several instances.
const hits = new Map();
setInterval(() => hits.clear(), 60_000).unref();

const INDEX = path.join(__dirname, 'public', 'index.html');

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const send = (status, body, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type, 'access-control-allow-origin': '*' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  if (req.method !== 'GET') return send(405, { error: 'GET only' });
  if (!url.pathname.startsWith('/api/')) return send(200, fs.readFileSync(INDEX), 'text/html; charset=utf-8');

  const ip = process.env.TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : req.socket.remoteAddress;
  const n = (hits.get(ip) || 0) + 1;
  hits.set(ip, n);
  if (n > RATE_LIMIT) return send(429, { error: 'rate limited' });

  const [, , name, id = ''] = url.pathname.split('/');
  const route = Object.hasOwn(routes, name) && routes[name];
  if (!route) return send(404, { error: 'unknown endpoint' });
  try {
    const out = await route(decodeURIComponent(id), url.searchParams);
    out == null ? send(404, { error: 'not found' }) : send(200, out);
  } catch (e) {
    send(e.status || 502, { error: e.message });
  }
}

const server = http.createServer(handle);

if (require.main === module) {
  const loop = () => tick().catch((e) => console.error('indexer:', e.message)).finally(() => setTimeout(loop, 10_000));
  loop();
  server.listen(Number(process.env.PORT || 8080), process.env.HOST || '127.0.0.1', () =>
    console.log(`noid-scan on http://${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 8080}`));
}

module.exports = { server, tick, db };
