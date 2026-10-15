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
const PAID_RATE_LIMIT = Number(process.env.PAID_RATE_LIMIT || 3000); // per account with credits
const CACHE_MS = Number(process.env.CACHE_MS ?? 5000); // API responses are reused this long; blocks change ~once a minute

const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'noid.db'));
db.exec(`
  pragma journal_mode = wal;
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
  await bill.settleNoid();
  Object.assign(indexer, { tip, at: Date.now() });
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

const bill = require('./billing.js')(db, rpc);

const routes = {
  async stats() {
    const [chain, state, node, peers, mining] = await Promise.all([
      rpc('getChainInfo'), rpc('getStateInfo'), rpc('getNodeStatus'), rpc('getPeerCount'), rpc('getMiningInfo'),
    ]);
    return { chain, state, node, peers, mining, indexer, donate: process.env.DONATE_ADDRESS || null, ai: ai.enabled };
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

const ai = require('./chat.js')(routes);

// shortcut: in-memory per-IP limiter, resets on restart and is per-process; move to the reverse proxy if you run several instances.
const hits = new Map();
setInterval(() => hits.clear(), 60_000).unref();

// Short-lived response cache keyed by URL. Bounded by request rate x CACHE_MS; expired entries are swept.
const cache = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of cache) if (v.until < now) cache.delete(k); }, 10_000).unref();

const INDEX = path.join(__dirname, 'public', 'index.html');

function readBody(req) {
  return new Promise((ok, fail) => {
    let s = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { s += c; if (s.length > 64_000) { fail(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } });
    req.on('end', () => ok(s));
    req.on('error', fail);
  });
}
const parseJson = (s) => { try { return JSON.parse(s || '{}') ?? {}; } catch { throw Object.assign(new Error('invalid JSON body'), { status: 400 }); } };

async function handle(req, res) {
  const send = (status, body, extra = {}) => {
    const json = typeof body !== 'string' && !Buffer.isBuffer(body);
    res.writeHead(status, { 'content-type': json ? 'application/json' : 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff', 'access-control-allow-origin': '*', ...extra });
    res.end(json ? JSON.stringify(body) : body);
  };
  try {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/api/')) return req.method === 'GET' ? send(200, fs.readFileSync(INDEX)) : send(405, { error: 'GET only' });
    if (req.method === 'OPTIONS') return send(204, '', { 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type, x-api-key' });

    // Behind Cloudflare the real client IP is in cf-connecting-ip; lock the droplet firewall to Cloudflare IPs so it cannot be spoofed.
    const ip = process.env.TRUST_PROXY ? req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : req.socket.remoteAddress;
    const acct = bill.account(req.headers['x-api-key'] || url.searchParams.get('key'));
    const paid = acct?.credits > 0;
    const who = paid ? acct.id : ip;
    const n = (hits.get(who) || 0) + 1;
    hits.set(who, n);
    if (n > (paid ? PAID_RATE_LIMIT : RATE_LIMIT)) return send(429, { error: 'rate limited' });
    res.setHeader('x-tier', paid ? 'paid' : 'free');

    const [, , name, id = ''] = url.pathname.split('/');
    // Account, payment and chat routes: never cached, may take a JSON body.
    if (name === 'stripe-webhook' && req.method === 'POST') return send(200, bill.stripeWebhook(await readBody(req), req.headers['stripe-signature']));
    if (name === 'chat' && req.method === 'POST') {
      const body = parseJson(await readBody(req));
      const charge = bill.chargeChat(acct, ip);
      try {
        return send(200, { ...(await ai.ask(body.messages)), paid: charge.paid, free_left: charge.free_left, credits: acct && bill.account(req.headers['x-api-key'] || url.searchParams.get('key'))?.credits }, { 'cache-control': 'no-store' });
      } catch (e) {
        charge.refund();
        throw e;
      }
    }
    const billRoute = bill.routes[`${req.method} ${name}`];
    if (billRoute) {
      const out = await billRoute(acct, req.method === 'POST' ? parseJson(await readBody(req)) : null, decodeURIComponent(id), ip);
      return out == null ? send(404, { error: 'not found' }) : send(200, out, { 'cache-control': 'no-store' });
    }
    if (req.method !== 'GET') return send(405, { error: 'GET only' });

    // Our own pages may call the API without a key; scripts and other sites need one (free from /account).
    // shortcut: Sec-Fetch-Site/Referer can be faked by a script, so this is a soft gate; the per-IP rate limit still applies.
    const ownPage = req.headers['sec-fetch-site'] === 'same-origin' || /^https?:\/\/([^/]+)/.exec(req.headers.referer || '')?.[1] === req.headers.host;
    if (!acct && !ownPage && name !== 'stats') return send(401, { error: 'API key required. Create one free at /account and send it as the x-api-key header.' });
    if (url.pathname === '/api/live') return live(req, res);
    if (acct) bill.countRequest(acct);
    const hit = cache.get(req.url);
    if (hit && hit.until > Date.now()) return send(200, hit.body, { 'cache-control': `private, max-age=${CACHE_MS / 1000 | 0}`, vary: 'sec-fetch-site, x-api-key', 'x-cache': 'HIT' });

    const route = Object.hasOwn(routes, name) && routes[name];
    if (!route) return send(404, { error: 'unknown endpoint' });
    const out = await route(decodeURIComponent(id), url.searchParams);
    if (out == null) return send(404, { error: 'not found' });
    if (CACHE_MS > 0) cache.set(req.url, { until: Date.now() + CACHE_MS, body: out });
    send(200, out, { 'cache-control': `private, max-age=${CACHE_MS / 1000 | 0}`, vary: 'sec-fetch-site, x-api-key', 'x-cache': 'MISS' });
  } catch (e) {
    send(e.status || (e instanceof URIError ? 400 : 502), { error: e.message });
  }
}

// Live feed: one shared poll of the node every LIVE_MS while anyone is watching, pushed to every open page (SSE).
// Cost is flat in the number of viewers.
const LIVE_MS = Number(process.env.LIVE_MS || 2000);
const listeners = new Set();
let liveOn = false, lastLive = null;
async function livePoll() {
  try {
    const [chain, peers, mining, state, node] = await Promise.all([
      rpc('getChainInfo'), rpc('getPeerCount'), rpc('getMiningInfo'), rpc('getStateInfo'), rpc('getNodeStatus'),
    ]);
    const header = lastLive?.chain.height === chain.height ? lastLive.header : await rpc('getBlockHeader', [chain.height]);
    lastLive = { chain, peers, mining, state, node: { synced: node.synced, sync_stage: node.sync_stage }, header, at: Date.now() };
    for (const res of listeners) res.write(`data: ${JSON.stringify(lastLive)}\n\n`);
  } catch (e) {
    for (const res of listeners) res.write(`event: down\ndata: ${JSON.stringify(e.message)}\n\n`);
  }
  if (listeners.size) setTimeout(livePoll, LIVE_MS); else liveOn = false;
}
function live(req, res) {
  if (listeners.size >= 1000) return res.writeHead(503).end();
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no', 'access-control-allow-origin': '*' });
  res.write('retry: 3000\n\n');
  if (lastLive) res.write(`data: ${JSON.stringify(lastLive)}\n\n`);
  listeners.add(res);
  const drop = () => listeners.delete(res);
  req.on('close', drop);
  res.on('error', drop);
  if (!liveOn) { liveOn = true; livePoll(); }
}

const server = http.createServer(handle);

if (require.main === module) {
  const loop = () => tick().catch((e) => console.error('indexer:', e.message)).finally(() => setTimeout(loop, 10_000));
  loop();
  server.listen(Number(process.env.PORT || 8080), process.env.HOST || '127.0.0.1', () =>
    console.log(`noid-scan on http://${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 8080}`));
}

module.exports = { server, tick, db };
