// NOID explorer: indexer + JSON API + static UI in one zero-dependency process.
// Headers and tx pointers are permanent on the node, so we proxy those live and only
// persist what the node prunes (block bodies, ~42-block window) plus chart snapshots.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { randomBytes, randomInt } = require('node:crypto');

const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:9601';
const RPC_TOKEN = process.env.RPC_TOKEN || '';
const RETAINED = 42;
const RATE_LIMIT = Number(process.env.RATE_LIMIT || 120); // requests per IP per minute
const CACHE_MS = Number(process.env.CACHE_MS ?? 5000); // API responses are reused this long; blocks change ~once a minute
// Paid API keys, bought in NOID. Set PAY_ADDRESS (watch-only: the server never holds keys) to enable.
const PAY = process.env.PAY_ADDRESS && {
  address: process.env.PAY_ADDRESS,
  price_micronoid: Math.round(Number(process.env.KEY_PRICE_NOID || 25) * 1e6),
  days: Number(process.env.KEY_DAYS || 30),
  rate_limit: Number(process.env.PAID_RATE_LIMIT || 3000),
};

const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'noid.db'));
db.exec(`
  pragma journal_mode = wal;
  create table if not exists blocks (height integer primary key, hash text not null, details text not null);
  create index if not exists blocks_hash on blocks(hash);
  create table if not exists stats (height integer primary key, ts integer, data text not null);
  create table if not exists orders (id text primary key, amount integer unique not null, created integer not null, paid_slot text unique, key text unique, expires integer);
`);
const q = {
  hashAt: db.prepare('select hash from blocks where height = ?'),
  byHeight: db.prepare('select details from blocks where height = ?'),
  heightOf: db.prepare('select height from blocks where hash = ?'),
  upsert: db.prepare('insert or replace into blocks (height, hash, details) values (?, ?, ?)'),
  hasStat: db.prepare('select 1 from stats where height = ?'),
  addStat: db.prepare('insert or replace into stats (height, ts, data) values (?, ?, ?)'),
  charts: db.prepare('select height, ts, data from stats order by height desc limit 500'),
  newOrder: db.prepare('insert into orders (id, amount, created) values (?, ?, ?)'),
  order: db.prepare('select id, amount, created, key, expires from orders where id = ?'),
  pending: db.prepare('select count(*) n from orders where paid_slot is null'),
  expireOrders: db.prepare('delete from orders where paid_slot is null and created < ?'),
  unpaidByAmount: db.prepare('select id from orders where amount = ? and paid_slot is null'),
  markPaid: db.prepare('update orders set paid_slot = ?, key = ?, expires = ? where id = ?'),
  keyExpiry: db.prepare('select expires from orders where key = ?'),
};

async function rpc(method, params = []) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(RPC_TOKEN && { authorization: `Bearer ${RPC_TOKEN}` }) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: `paranoid_${method}`, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

// One indexer pass. Re-checking the whole retained window by hash also handles reorgs:
// a replaced block has a new hash at the same height and gets overwritten.
const indexer = { tip: null, at: null }; // last successful pass, exposed in /api/stats for uptime monitors
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
  if (PAY) await settleOrders();
  Object.assign(indexer, { tip, at: Date.now() });
}

// Match incoming slots on the pay address to pending orders by exact amount. creation_id is unique per
// slot, so a slot can only ever pay one order.
async function settleOrders() {
  q.expireOrders.run(Date.now() - 24 * 3600_000);
  for (const slot of await rpc('getSlotsByOwner', [PAY.address])) {
    const order = q.unpaidByAmount.get(Number(slot.value));
    if (!order) continue;
    try {
      q.markPaid.run(String(slot.creation_id), randomBytes(16).toString('hex'), Date.now() + PAY.days * 86400_000, order.id);
    } catch {} // slot already used for another order
  }
}

// Input validation at the public boundary.
const RE = {
  height: /^\d{1,12}$/,
  hash: /^[0-9a-f]{64}$/,
  address: /^o1[02-9ac-hj-np-z]{6,120}$/, // bech32m charset
};

// shortcut: per-tx list name inside `retained` still unverified (only genesis seen, whose body is null); match by content until a synced node shows it.
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
    return { chain, state, node, peers, mining, indexer, donate: process.env.DONATE_ADDRESS || null, pay: PAY && { price_noid: PAY.price_micronoid / 1e6, days: PAY.days, rate_limit: PAY.rate_limit, free_rate_limit: RATE_LIMIT } };
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

  async pay(id) {
    if (!PAY) return null;
    if (id === 'new') {
      if (q.pending.get().n >= 1000) throw Object.assign(new Error('too many pending orders, try later'), { status: 503 });
      for (let i = 0; i < 5; i++) {
        const order = randomBytes(6).toString('hex');
        try { q.newOrder.run(order, PAY.price_micronoid + randomInt(1, 10_000), Date.now()); } catch { continue; } // amount taken
        return routes.pay(order);
      }
      throw new Error('could not allocate an order amount');
    }
    const o = q.order.get(id);
    return o && { ...o, address: PAY.address, amount_noid: (o.amount / 1e6).toFixed(6), paid: !!o.key };
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

// Short-lived response cache keyed by URL. Bounded by request rate x CACHE_MS; expired entries are swept.
const cache = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of cache) if (v.until < now) cache.delete(k); }, 10_000).unref();

const INDEX = path.join(__dirname, 'public', 'index.html');

async function handle(req, res) {
  const send = (status, body, extra = {}) => {
    const json = typeof body !== 'string' && !Buffer.isBuffer(body);
    res.writeHead(status, { 'content-type': json ? 'application/json' : 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff', 'access-control-allow-origin': '*', ...extra });
    res.end(json ? JSON.stringify(body) : body);
  };
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method !== 'GET') return send(405, { error: 'GET only' });
    if (!url.pathname.startsWith('/api/')) return send(200, fs.readFileSync(INDEX));

    // Behind Cloudflare the real client IP is in cf-connecting-ip; lock the droplet firewall to Cloudflare IPs so it cannot be spoofed.
    const ip = process.env.TRUST_PROXY ? req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : req.socket.remoteAddress;
    const key = req.headers['x-api-key'] || url.searchParams.get('key');
    const paid = key && q.keyExpiry.get(key)?.expires > Date.now();
    const n = (hits.get(paid ? key : ip) || 0) + 1;
    hits.set(paid ? key : ip, n);
    if (n > (paid ? PAY.rate_limit : RATE_LIMIT)) return send(429, { error: 'rate limited' });
    res.setHeader('x-tier', paid ? 'paid' : 'free');

    if (url.pathname.startsWith('/api/pay/')) res.setHeader('cache-control', 'no-store');
    const hit = !url.pathname.startsWith('/api/pay/') && cache.get(req.url);
    if (hit && hit.until > Date.now()) return send(200, hit.body, { 'cache-control': `public, max-age=${CACHE_MS / 1000 | 0}`, 'x-cache': 'HIT' });

    const [, , name, id = ''] = url.pathname.split('/');
    const route = Object.hasOwn(routes, name) && routes[name];
    if (!route) return send(404, { error: 'unknown endpoint' });
    const out = await route(decodeURIComponent(id), url.searchParams);
    if (out == null) return send(404, { error: 'not found' });
    if (name === 'pay') return send(200, out);
    if (CACHE_MS > 0) cache.set(req.url, { until: Date.now() + CACHE_MS, body: out });
    send(200, out, { 'cache-control': `public, max-age=${CACHE_MS / 1000 | 0}`, 'x-cache': 'MISS' });
  } catch (e) {
    send(e.status || (e instanceof URIError ? 400 : 502), { error: e.message });
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
