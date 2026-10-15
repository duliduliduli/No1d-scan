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
  -- Every header since genesis (headers are never pruned): powers all-time hashrate, block time and miner stats.
  -- Our own price samples every 3 minutes (CoinPaprika's free history is hourly for 24 h, daily beyond).
  create table if not exists price_ticks (ts integer primary key, usd real not null, volume_24h real, supply integer);
  -- Live State sweeps: holders over time, and the current rich list.
  create table if not exists holders (ts integer primary key, holders integer not null, supply integer not null, top10 integer not null, top100 integer not null, slots integer not null);
  create table if not exists rich_list (rank integer primary key, address text not null, balance integer not null, slots integer not null);
  create table if not exists headers (height integer primary key, hash text not null, ts integer not null, miner text, work real not null, slots integer);
  create index if not exists headers_hash on headers(hash);
  create index if not exists headers_ts on headers(ts);
`);
const q = {
  hashAt: db.prepare('select hash from blocks where height = ?'),
  byHeight: db.prepare('select details from blocks where height = ?'),
  heightOf: db.prepare('select height from blocks where hash = ?'),
  upsert: db.prepare('insert or replace into blocks (height, hash, details) values (?, ?, ?)'),
  hasStat: db.prepare('select 1 from stats where height = ?'),
  addStat: db.prepare('insert or replace into stats (height, ts, data) values (?, ?, ?)'),
  charts: db.prepare('select height, ts, data from stats order by height desc limit 500'),
  headerTop: db.prepare('select max(height) h, count(*) n from headers'),
  addTick: db.prepare('insert or replace into price_ticks (ts, usd, volume_24h, supply) values (?, ?, ?, ?)'),
  ticks: db.prepare(`select (ts / cast(:b as integer)) * cast(:b as integer) t, avg(usd) usd, max(usd) hi, min(usd) lo, avg(volume_24h) volume_24h, avg(supply) supply
    from price_ticks where ts >= :since group by ts / cast(:b as integer) order by t`),
  firstTick: db.prepare('select min(ts) t from price_ticks'),
  supplySeries: db.prepare(`select (ts / cast(:b as integer)) * cast(:b as integer) t, max(cast(json_extract(data, '$.circulating_supply_micronoid') as real)) supply
    from stats where ts >= :since group by ts / cast(:b as integer) order by t`),
  addHolders: db.prepare('insert or replace into holders (ts, holders, supply, top10, top100, slots) values (?, ?, ?, ?, ?, ?)'),
  holdersSeries: db.prepare('select ts t, holders, supply, top10, top100, slots from holders where ts >= ? order by ts'),
  lastHolders: db.prepare('select ts, holders, supply, top10, top100, slots from holders order by ts desc limit 1'),
  richList: db.prepare('select rank, address, balance, slots from rich_list order by rank limit ?'),
  richRank: db.prepare('select rank, balance from rich_list where address = ?'),
  putHeader: db.prepare('insert or replace into headers (height, hash, ts, miner, work, slots) values (?, ?, ?, ?, ?, ?)'),
  headerByHash: db.prepare('select height from headers where hash = ?'),
  recentWork: db.prepare('select count(*) n, min(ts) t0, max(ts) t1, sum(work) w from (select ts, work from headers order by height desc limit ?)'),
  tipWork: db.prepare('select work from headers order by height desc limit 1'),
  blocksSince: db.prepare('select count(*) n from headers where ts >= ?'),
  // One row per bucket: hashrate = work done / time it took; block time = time / blocks.
  // node:sqlite binds JS numbers as REAL, so the bucket is cast to integer for integer division.
  history: db.prepare(`select (ts / cast(:b as integer)) * cast(:b as integer) t, count(*) blocks, avg(work) work, max(slots) slots,
      case when max(ts) > min(ts) then sum(work) / (max(ts) - min(ts)) end hashrate,
      case when count(*) > 1 then (max(ts) - min(ts)) * 1.0 / (count(*) - 1) end block_time
    from headers where ts >= :since group by ts / cast(:b as integer) order by t`),
  minersSince: db.prepare('select miner, count(*) blocks, max(height) last from headers where ts >= ? group by miner order by blocks desc'),
  bodyStats: db.prepare(`select height, json_extract(details, '$.retained.reward_micronoid') reward, json_extract(details, '$.retained.total_fees_micronoid') fees,
      json_array_length(details, '$.retained.transactions') txs from blocks where height between ? and ?`),
  txs24h: db.prepare(`select sum(json_array_length(details, '$.retained.transactions')) n, count(*) blocks from blocks where json_extract(details, '$.header.timestamp') >= ?`),
};

// The node emits creation_id as a 64-bit integer (~9.2e18). JSON.parse would round it, making different
// slots look identical, so quote those numbers into strings before parsing.
const parseRpc = (text) => JSON.parse(text.replace(/"creation_id":\s*(\d{16,})/g, '"creation_id":"$1"'));

async function rpc(method, params = []) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(RPC_TOKEN && { authorization: `Bearer ${RPC_TOKEN}` }) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: `paranoid_${method}`, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = parseRpc(await res.text());
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

// JSON-RPC batch: [[method, params], ...] -> results in order. The node accepts batches up to ~2 MB.
async function rpcBatch(calls, timeoutMs = 30_000) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(RPC_TOKEN && { authorization: `Bearer ${RPC_TOKEN}` }) },
    body: JSON.stringify(calls.map(([m, params], id) => ({ jsonrpc: '2.0', id, method: `paranoid_${m}`, params }))),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = parseRpc(await res.text());
  if (!Array.isArray(body)) throw new Error(`batch: ${body?.error?.message || 'not supported'}`);
  const out = [];
  for (const r of body) { if (r.error) throw new Error(`batch: ${r.error.message}`); out[r.id] = r.result; }
  return out;
}

// Expected hashes per block. Targets are little-endian 256-bit (checked against live blocks: ~6.5 TH at height 221,614).
const workOf = (hex) => Number((1n << 256n) / (BigInt(`0x${hex.match(/../g).reverse().join('')}`) + 1n));

// Header history: walks forward from genesis, HEADER_BATCH x 200 headers per indexer pass, and re-reads the
// last RETAINED heights each pass so reorgs overwrite. The first run backfills the whole chain in minutes.
const HEADER_BATCH = Number(process.env.HEADER_BATCH || 25);
const history = { synced_to: -1, tip: 0 };
async function syncHeaders(tip) {
  const top = q.headerTop.get().h ?? -1;
  let h = Math.max(0, top - RETAINED + 1);
  for (let round = 0; round < HEADER_BATCH && h <= tip; round++) {
    const heights = Array.from({ length: Math.min(200, tip - h + 1) }, (_, i) => h + i);
    const rows = await rpcBatch(heights.map((x) => ['getBlockHeader', [x]]));
    db.exec('begin');
    try {
      for (const r of rows) if (r?.difficulty_target) q.putHeader.run(r.height, r.hash, r.timestamp, r.miner ?? null, workOf(r.difficulty_target), r.active_slot_count ?? null);
      db.exec('commit');
    } catch (e) { db.exec('rollback'); throw e; }
    h += heights.length;
  }
  Object.assign(history, { synced_to: q.headerTop.get().h ?? -1, tip });
}

// Current network numbers from the header history.
function networkStats() {
  const r = q.recentWork.get(120); // ~1 hour at the 30 s target
  const span = r.t1 - r.t0;
  return {
    hashrate: span > 0 ? r.w / span : null, // hashes per second
    avg_block_time: r.n > 1 ? span / (r.n - 1) : null,
    difficulty_work: q.tipWork.get()?.work ?? null, // expected hashes per block
    blocks_24h: q.blocksSince.get(Math.floor(Date.now() / 1000) - 86400).n,
    history,
  };
}

// One indexer pass. Re-checking the whole retained window by hash also handles reorgs:
// a replaced block has a new hash at the same height and gets overwritten.
const indexer = { tip: null, at: null, supply: null }; // last successful pass, exposed in /api/stats for uptime monitors
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
    indexer.supply = chain.circulating_supply_micronoid;
  }
  await syncHeaders(tip);
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

// NOID/USD from CoinPaprika (free, no key; aggregates SafeTrade and Cexius). Ticker every 3 min plus
// history hourly is ~16k calls/month, under the free plan's 20k. Market cap is computed from our own supply.
const PRICE_ID = process.env.PRICE_ID || 'noid-parano1d';
const price = { now: null, hourly: [], daily: [], markets: [] };
const paprika = async (p) => {
  const r = await fetch(`https://api.coinpaprika.com/v1${p}`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`price feed ${r.status}`);
  return r.json();
};
async function pollPrice() {
  const t = await paprika(`/tickers/${PRICE_ID}`);
  const u = t.quotes.USD;
  price.now = {
    usd: u.price, change_24h_pct: u.percent_change_24h, volume_24h_usd: u.volume_24h, updated: t.last_updated, source: 'CoinPaprika (SafeTrade, Cexius)',
    change: { '15m': u.percent_change_15m, '1h': u.percent_change_1h, '6h': u.percent_change_6h, '24h': u.percent_change_24h, '7d': u.percent_change_7d, '30d': u.percent_change_30d },
    volume_change_24h_pct: u.volume_24h_change_24h, ath_usd: u.ath_price, ath_date: u.ath_date, from_ath_pct: u.percent_from_price_ath, rank: t.rank,
  };
  q.addTick.run(Math.floor(Date.now() / 1000), u.price, u.volume_24h, Number(lastLive?.chain.circulating_supply_micronoid ?? indexer.supply ?? 0) || null);
}
async function pollMarkets() {
  const rows = await paprika(`/coins/${PRICE_ID}/markets`);
  price.markets = rows.map((m) => ({ exchange: m.exchange_name, pair: m.pair, usd: m.quotes?.USD?.price, volume_24h_usd: m.quotes?.USD?.volume_24h, share_pct: m.adjusted_volume_24h_share, url: m.market_url }))
    .sort((a, b) => (b.volume_24h_usd || 0) - (a.volume_24h_usd || 0));
}
async function pollPriceHistory() {
  const iso = (ms) => new Date(Date.now() - ms).toISOString().replace(/\.\d+Z$/, 'Z');
  const pts = (rows) => rows.map((r) => ({ t: Date.parse(r.timestamp) / 1000, usd: r.price }));
  // Free plan limits: hourly only for the last 24 h, daily up to ~180 days back (covers NOID's whole trading history).
  const [h, d] = await Promise.allSettled([
    paprika(`/tickers/${PRICE_ID}/historical?start=${iso(23 * 3600_000)}&interval=1h`),
    paprika(`/tickers/${PRICE_ID}/historical?start=${iso(180 * 86400_000).slice(0, 10)}&interval=1d`),
  ]);
  if (h.status === 'fulfilled') price.hourly = pts(h.value);
  if (d.status === 'fulfilled') price.daily = pts(d.value);
  if (h.status === 'rejected' && d.status === 'rejected') throw h.reason;
}

// Network map: countries of peers connected to our node right now. The node has no peer-list RPC, so we read
// established TCP connections on the P2P port from /proc/net (world-readable). Only country codes and counts
// leave the server; peer IPs stay in this process's memory.
const P2P_PORT = Number(process.env.P2P_PORT || 9600);
const geo = new Map(); // ip -> ISO country code
const seen = new Map(); // country -> last time a peer was there (for the 24 h view)
const network = { node_country: null, peers: [], countries_24h: [], updated: null };
function hexIp(h) {
  const b = Buffer.from(h, 'hex');
  for (let i = 0; i < b.length; i += 4) b.subarray(i, i + 4).reverse(); // /proc/net stores 32-bit words little-endian
  if (b.length === 4) return [...b].join('.');
  if (b.subarray(0, 10).every((x) => x === 0) && b[10] === 255 && b[11] === 255) return [...b.subarray(12)].join('.');
  return b.toString('hex').match(/.{4}/g).join(':');
}
const isPublic = (ip) => !/^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip)
  && !/^(0000:){7}000[01]$|^f[cde]/.test(ip);
// Lines of /proc/net/tcp{,6} -> public remote IPs of ESTABLISHED connections on the P2P port (either side).
function peerIps(text) {
  const ips = new Set();
  for (const line of text.split('\n')) {
    const [, local, remote, st] = line.trim().split(/\s+/);
    if (st !== '01' || !remote?.includes(':')) continue;
    const [rh, rp] = remote.split(':');
    if (parseInt(local.split(':')[1], 16) !== P2P_PORT && parseInt(rp, 16) !== P2P_PORT) continue;
    const ip = hexIp(rh);
    if (isPublic(ip)) ips.add(ip);
  }
  return [...ips];
}
const countryOf = async (ip = '') => {
  const r = await fetch(`https://api.country.is/${ip}`, { signal: AbortSignal.timeout(8_000) });
  return r.ok ? (await r.json()).country : null;
};
async function pollNetwork() {
  network.node_country ??= await countryOf().catch(() => null);
  const text = ['/proc/net/tcp', '/proc/net/tcp6'].map((f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
  const counts = {};
  for (const ip of peerIps(text)) {
    if (!geo.has(ip)) geo.set(ip, await countryOf(ip).catch(() => null));
    const c = geo.get(ip);
    if (c) { counts[c] = (counts[c] || 0) + 1; seen.set(c, Date.now()); }
  }
  for (const [c, t] of seen) if (t < Date.now() - 86400_000) seen.delete(c);
  network.peers = Object.entries(counts).map(([country, count]) => ({ country, count })).sort((a, b) => b.count - a.count);
  network.countries_24h = [...seen.keys()];
  network.updated = Date.now();
}

// Live State sweep: every funded slot via batched getSlot (~2 min for 2^24 slots on the node), aggregated by owner.
// Yields the holders count, concentration and the rich list. Runs in the background; pauses briefly between batches.
const HOLDERS_EVERY_MS = Number(process.env.HOLDERS_EVERY_MS || 7200_000);
const sweep = { running: false, at: null, ms: null, progress: null, error: null };
async function sweepHolders() {
  if (sweep.running) return;
  sweep.running = true;
  const t0 = Date.now();
  try {
    const { log_slots } = await rpc('getStateInfo');
    const capacity = 2 ** Number(log_slots);
    const owners = new Map();
    const BATCH = Number(process.env.SWEEP_BATCH || 5000);
    for (let i = 0; i < capacity; i += BATCH) {
      const rows = await rpcBatch(Array.from({ length: Math.min(BATCH, capacity - i) }, (_, k) => ['getSlot', [i + k]]), 120_000);
      for (const s of rows) {
        if (!s || s.empty || !s.owner) continue;
        const o = owners.get(s.owner) || { balance: 0, slots: 0 };
        o.balance += Number(s.value); o.slots += 1;
        owners.set(s.owner, o);
      }
      sweep.progress = (i + BATCH) / capacity;
      await new Promise((r) => setTimeout(r, 2)); // let queued web requests through
    }
    const list = [...owners].map(([address, o]) => ({ address, ...o })).sort((a, b) => b.balance - a.balance);
    const supply = list.reduce((s, r) => s + r.balance, 0);
    const sum = (n) => list.slice(0, n).reduce((s, r) => s + r.balance, 0);
    db.exec('begin');
    try {
      db.exec('delete from rich_list');
      const ins = db.prepare('insert into rich_list (rank, address, balance, slots) values (?, ?, ?, ?)');
      list.slice(0, 500).forEach((r, i) => ins.run(i + 1, r.address, r.balance, r.slots));
      q.addHolders.run(Math.floor(Date.now() / 1000), list.length, supply, sum(10), sum(100), list.reduce((s, r) => s + r.slots, 0));
      db.exec('commit');
    } catch (e) { db.exec('rollback'); throw e; }
    Object.assign(sweep, { at: Date.now(), ms: Date.now() - t0, progress: 1, error: null });
    console.log(`holders sweep: ${list.length} holders in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  } catch (e) { sweep.error = e.message; throw e; } finally { sweep.running = false; }
}

const bill = require('./billing.js')(db, rpc, () => price.now?.usd);

const WINDOWS = { '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400, all: 1e10 };

const routes = {
  async stats() {
    const [chain, state, node, peers, mining] = await Promise.all([
      rpc('getChainInfo'), rpc('getStateInfo'), rpc('getNodeStatus'), rpc('getPeerCount'), rpc('getMiningInfo'),
    ]);
    return { chain, state, node, peers, mining, indexer, network: networkStats(), txs_24h: q.txs24h.get(Math.floor(Date.now() / 1000) - 86400), price: price.now, donate: process.env.DONATE_ADDRESS || null, ai: ai.enabled };
  },

  async blocks(_, params) {
    const tip = await rpc('blockCount');
    const before = RE.height.test(params.get('before') || '') ? Math.min(Number(params.get('before')), tip) : tip;
    const limit = Math.min(Math.max(Number(params.get('limit')) || 20, 1), 50);
    const heights = [];
    for (let h = before; h >= 0 && heights.length < limit; h--) heights.push(h);
    const headers = await Promise.all(heights.map((h) => rpc('getBlockHeader', [h])));
    // Tx count, reward and fees exist only for bodies this explorer captured.
    const body = new Map(q.bodyStats.all(heights.at(-1) ?? 0, heights[0] ?? 0).map((r) => [r.height, r]));
    return { tip, blocks: headers.filter(Boolean).map((b) => {
      const x = body.get(b.height);
      return { ...b, txs: x?.txs ?? null, reward_micronoid: x?.reward ?? null, total_fees_micronoid: x?.fees ?? null, indexed: !!x };
    }) };
  },

  async block(id) {
    if (RE.height.test(id)) return blockByHeight(Number(id));
    if (RE.hash.test(id)) {
      const row = q.heightOf.get(id) ?? q.headerByHash.get(id);
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
    return { address: addr, balance_micronoid: balance.toString(), rank: q.richRank.get(addr)?.rank ?? null, slots, activity };
  },

  async txs(_, params) {
    return rpc('getRecentTransactions', [Math.max(Number(params.get('page')) || 1, 1), 25, null]);
  },

  async network() {
    return network;
  },

  // Who mined blocks in a window (24h, 7d, 30d, all), from the full header history.
  async miners(_, params) {
    const since = Math.floor(Date.now() / 1000) - (WINDOWS[params.get('window')] ?? WINDOWS['24h']);
    const rows = q.minersSince.all(since);
    const total = rows.reduce((s, r) => s + r.blocks, 0);
    return { window: params.get('window') || '24h', blocks: total, miner_count: rows.length, miners: rows.slice(0, 15).map((r) => ({ ...r, share: r.blocks / total })) };
  },

  // Time series for charts: hashrate, block time, difficulty, active slots per bucket.
  async history(_, params) {
    const w = params.get('window') || '24h';
    const now = Math.floor(Date.now() / 1000);
    const bucket = { '24h': 3600, '7d': 3 * 3600, '30d': 86400, all: 86400 }[w] ?? 3600;
    return { window: w, bucket, points: q.history.all({ b: bucket, since: now - (WINDOWS[w] ?? WINDOWS['24h']) }), sync: history };
  },

  async mempool() {
    const [info, f11, f12, f22] = await Promise.all([
      rpc('getMempoolInfo'), rpc('estimateFeeDetailed', [1, 1]), rpc('estimateFeeDetailed', [1, 2]), rpc('estimateFeeDetailed', [2, 2]),
    ]);
    const txs = info?.txs ?? [];
    return {
      size: info?.size ?? txs.length, fee_floor: info?.fee_floor ?? null,
      total_fees_micronoid: txs.reduce((s, t) => s + Number(t.fee_micronoid || 0), 0),
      txs: txs.slice(0, 100),
      // Minimum accepted fee for common shapes (inputs -> outputs); NOID fees are rule-based, not an auction.
      fees: [{ shape: '1 → 1', ...f11 }, { shape: '1 → 2 (typical payment)', ...f12 }, { shape: '2 → 2', ...f22 }].map((f) => ({ shape: f.shape, fee_micronoid: f.fee_micronoid, burn_slots: f.net_new_slots })),
    };
  },

  // Price/market cap/volume series. Our own 3-minute ticks give full detail; before our first tick, CoinPaprika's
  // daily history fills in. Points are bucketed so a window never exceeds ~600 points.
  async price(_, params) {
    if (!price.now) return null;
    const w = params.get('window') || '24h';
    const now = Math.floor(Date.now() / 1000);
    const bucket = { '24h': 180, '7d': 900, '30d': 3600, all: 21600 }[w] ?? 180;
    const since = now - (WINDOWS[w] ?? WINDOWS['24h']);
    const ticks = q.ticks.all({ b: bucket, since }).map((p) => ({ t: p.t, usd: p.usd, hi: p.hi, lo: p.lo, volume_24h_usd: p.volume_24h, market_cap_usd: p.supply ? (p.supply / 1e6) * p.usd : null }));
    const first = q.firstTick.get().t ?? now;
    // Before our own 3-minute samples exist, fill the window with CoinPaprika's hourly (last 24 h) and daily history,
    // so a 7-day chart is a week long from day one rather than two points stretched across the width.
    const hourlyStart = price.hourly[0]?.t ?? Infinity;
    const fill = (rows) => rows.map((p) => ({ t: p.t, usd: p.usd, hi: null, lo: null, volume_24h_usd: null, market_cap_usd: null }));
    const points = [
      ...fill(price.daily.filter((p) => p.t >= since && p.t < Math.min(hourlyStart, first))),
      ...fill(price.hourly.filter((p) => p.t >= since && p.t < first)),
      ...ticks,
    ].sort((a, b) => a.t - b.t);
    return { window: w, bucket, points, now: price.now, markets: price.markets, ticks_since: first };
  },

  async holders(_, params) {
    const w = params.get('window') || '30d';
    const since = Math.floor(Date.now() / 1000) - (WINDOWS[w] ?? WINDOWS['30d']);
    return { window: w, latest: q.lastHolders.get() ?? null, points: q.holdersSeries.all(since), sweep: { at: sweep.at, took_ms: sweep.ms, running: sweep.running, progress: sweep.progress, error: sweep.error, every_ms: HOLDERS_EVERY_MS } };
  },

  async richlist(_, params) {
    const n = Math.min(Math.max(Number(params.get('limit')) || 50, 1), 500);
    const latest = q.lastHolders.get();
    return { updated: latest?.ts ?? null, supply: latest?.supply ?? null, holders: latest?.holders ?? null, rows: q.richList.all(n).map((r) => ({ ...r, share: latest?.supply ? r.balance / latest.supply : null })) };
  },

  async supply(_, params) {
    const w = params.get('window') || '30d';
    const now = Math.floor(Date.now() / 1000);
    const bucket = { '24h': 900, '7d': 3600, '30d': 21600, all: 86400 }[w] ?? 21600;
    return { window: w, points: q.supplySeries.all({ b: bucket, since: now - (WINDOWS[w] ?? WINDOWS['30d']) }) };
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
      if (q.heightOf.get(s) || q.headerByHash.get(s)) return { type: 'block', id: s };
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
// Icons and the link-preview image; a fixed list, so no request path ever reaches the filesystem.
const STATIC = {
  '/favicon.ico': 'image/x-icon', '/favicon-32.png': 'image/png', '/apple-touch-icon.png': 'image/png',
  '/icon-192.png': 'image/png', '/icon-512.png': 'image/png', '/og.png': 'image/png', '/site.webmanifest': 'application/manifest+json',
};

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
    if (STATIC[url.pathname]) {
      res.writeHead(200, { 'content-type': STATIC[url.pathname], 'cache-control': 'public, max-age=86400' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', url.pathname)));
    }
    if (!url.pathname.startsWith('/api/')) return req.method === 'GET' ? send(200, fs.readFileSync(INDEX)) : send(405, { error: 'GET only' });
    if (req.method === 'OPTIONS') return send(204, '', { 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type, x-api-key' });

    // Behind Cloudflare the real client IP is in cf-connecting-ip; lock the droplet firewall to Cloudflare IPs so it cannot be spoofed.
    const ip = process.env.TRUST_PROXY ? req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : req.socket.remoteAddress;
    const givenKey = req.headers['x-api-key'] || url.searchParams.get('key');
    const acct = bill.account(givenKey);
    const ownPage = req.headers['sec-fetch-site'] === 'same-origin' || /^https?:\/\/([^/]+)/.exec(req.headers.referer || '')?.[1] === req.headers.host;
    // A wrong key must fail loudly for scripts; our own pages just drop a stale saved key.
    if (givenKey && !acct && !ownPage) return send(401, { error: 'unknown API key. Check the x-api-key header; create a key free at /account.' });
    const paid = acct?.credits > 0;
    const who = paid ? acct.id : ip;
    const n = (hits.get(who) || 0) + 1;
    hits.set(who, n);
    const limit = paid ? PAID_RATE_LIMIT : RATE_LIMIT;
    res.setHeader('x-tier', paid ? 'paid' : 'free');
    res.setHeader('x-ratelimit-limit', limit);
    res.setHeader('x-ratelimit-remaining', Math.max(limit - n, 0));
    if (acct) res.setHeader('x-credits-remaining', acct.credits);
    if (n > limit) return send(429, { error: `rate limited: ${limit} requests per minute on the ${paid ? 'paid' : 'free'} tier` }, { 'retry-after': 60 });

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
    const mp = await rpc('getMempoolInfo').catch(() => null);
    const mempool = mp && { size: mp.size ?? mp.txs?.length ?? 0, fee_floor: mp.fee_floor ?? null, total_fees_micronoid: (mp.txs ?? []).reduce((s, t) => s + Number(t.fee_micronoid || 0), 0) };
    lastLive = { chain, peers, mining, state, node: { synced: node.synced, sync_stage: node.sync_stage }, header, mempool, network: networkStats(), price: price.now, at: Date.now() };
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
  const every = (fn, ms) => { const run = () => fn().catch((e) => console.error('price:', e.message)); run(); setInterval(run, ms); };
  every(pollPrice, 180_000);
  every(pollPriceHistory, 3600_000);
  every(pollMarkets, 3600_000);
  every(sweepHolders, HOLDERS_EVERY_MS);
  every(pollNetwork, 60_000);
  server.listen(Number(process.env.PORT || 8080), process.env.HOST || '127.0.0.1', () =>
    console.log(`noid-scan on http://${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 8080}`));
}

module.exports = { server, tick, db, price, peerIps, workOf, parseRpc, sweepHolders, pollPrice: () => pollPrice() };
