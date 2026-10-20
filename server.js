// NOID explorer: indexer + JSON API + static UI in one zero-dependency process.
// Headers and tx pointers are permanent on the node, so we proxy those live and only
// persist what the node prunes (block bodies, ~42-block window) plus chart snapshots.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { zstdCompressSync, zstdDecompressSync } = require('node:zlib');

const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:9601';
const RPC_TOKEN = process.env.RPC_TOKEN || '';
const RETAINED = 42;
const RATE_LIMIT = Number(process.env.RATE_LIMIT || 120); // requests per IP per minute
const PAID_RATE_LIMIT = Number(process.env.PAID_RATE_LIMIT || 3000); // per account with credits
const CACHE_MS = Number(process.env.CACHE_MS ?? 5000); // API responses are reused this long; blocks change ~once a minute

const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'noid.db'));
db.exec(`
  pragma journal_mode = wal;
  -- Sorting/grouping big queries (miners or history over 7d+) needs temp space. The service runs with
  -- ProtectSystem=strict, so /tmp is read-only and a temp file fails with "disk I/O error". Keep it in memory.
  pragma temp_store = memory;
  create table if not exists stats (height integer primary key, ts integer, data text not null);
  -- Our own price samples every 3 minutes (CoinPaprika's free history is hourly for 24 h, daily beyond).
  create table if not exists price_ticks (ts integer primary key, usd real not null, volume_24h real, supply integer);
  -- Live State sweeps: holders over time, and the current rich list.
  create table if not exists holders (ts integer primary key, holders integer not null, supply integer not null, top10 integer not null, top100 integer not null, slots integer not null);
  create table if not exists rich_list (rank integer primary key, address text not null, balance integer not null, slots integer not null);
`);
try { db.exec('alter table stats add column hash text'); } catch {} // which block the snapshot was taken at

const info = (database, table) => database.prepare(`select name, type from pragma_table_info('${table}')`).all();
// Hashes are 32 raw bytes. Block JSON is zstd. Reward, fees, tx count and time are real columns so lists
// never decompress a body. Orphans are written before a replace or a tip rollback. Gaps are heights whose
// body the node has already pruned and we never stored.
function createArchiveTables(database) {
  database.exec(`
    create table blocks (
      height integer primary key, hash blob not null, blob blob, first_seen integer not null,
      ts integer, reward text, fees text, txs integer, cold text);
    create index blocks_hash on blocks(hash);
    create table headers (
      height integer primary key, hash blob not null, ts integer not null, miner text, work real not null, slots integer,
      first_seen integer, prev_hash blob, state_root blob, tx_root blob, nonce blob, difficulty_target blob, log_slots integer);
    create index headers_hash on headers(hash);
    create index headers_ts on headers(ts);
  `);
}
function ensureAux(database) {
  database.exec(`
    create table if not exists orphans (
      id integer primary key, height integer not null, hash blob not null, kind text not null,
      blob blob, first_seen integer, replaced_at integer not null, reason text not null, cold text);
    create index if not exists orphans_height on orphans(height);
    create index if not exists orphans_hash on orphans(hash);
    create table if not exists gaps (
      height integer not null, kind text not null, first_seen integer not null, tries integer not null default 0, last_error text,
      primary key (height, kind));
    create table if not exists reorgs (
      id integer primary key, tip_before integer, tip_after integer, at integer not null, depth integer not null);
    create table if not exists meta (k text primary key, v text not null);
    create table if not exists tx_index (
      txid blob primary key, height integer not null, position integer, fee text, burned text, coinbase integer);
    create index if not exists tx_index_height on tx_index(height);
    create table if not exists addr_tx (
      address text not null, txid blob not null, height integer not null, dir text not null, amount text not null);
    create index if not exists addr_tx_addr on addr_tx(address, height);
    create table if not exists miner_payouts (
      height integer not null, miner text, payout text not null, amount text, primary key (height, payout));
  `);
}
function rebuildBlocks(database) {
  const rows = database.prepare('select height, hash, details from blocks').all();
  database.exec(`create table blocks_new (
    height integer primary key, hash blob not null, blob blob, first_seen integer not null,
    ts integer, reward text, fees text, txs integer, cold text)`);
  const ins = database.prepare('insert into blocks_new (height, hash, blob, first_seen, ts, reward, fees, txs, cold) values (?, ?, ?, ?, ?, ?, ?, ?, null)');
  const now = Date.now();
  for (const r of rows) {
    let details = {};
    try { details = JSON.parse(r.details); } catch {}
    const txs = Array.isArray(details.retained?.transactions) ? details.retained.transactions.length : (details.retained ? 0 : null);
    ins.run(r.height, Buffer.from(String(r.hash), 'hex'), zstdCompressSync(Buffer.from(r.details)), now, details.header?.timestamp ?? null,
      details.retained?.reward_micronoid ?? null, details.retained?.total_fees_micronoid ?? null, txs);
  }
  database.exec('drop index if exists blocks_hash; drop table blocks; alter table blocks_new rename to blocks; create index blocks_hash on blocks(hash)');
}
function rebuildHeaders(database) {
  const rows = database.prepare('select height, hash, ts, miner, work, slots from headers').all();
  database.exec(`create table headers_new (
    height integer primary key, hash blob not null, ts integer not null, miner text, work real not null, slots integer,
    first_seen integer, prev_hash blob, state_root blob, tx_root blob, nonce blob, difficulty_target blob, log_slots integer)`);
  const ins = database.prepare(`insert into headers_new (height, hash, ts, miner, work, slots, first_seen) values (?, ?, ?, ?, ?, ?, ?)`);
  for (const r of rows) ins.run(r.height, Buffer.from(String(r.hash), 'hex'), r.ts, r.miner, r.work, r.slots, r.ts ? r.ts * 1000 : Date.now());
  database.exec('drop index if exists headers_hash; drop index if exists headers_ts; drop table headers; alter table headers_new rename to headers; create index headers_hash on headers(hash); create index headers_ts on headers(ts)');
}
function migrateDb(database) {
  const blocks = info(database, 'blocks');
  const headers = info(database, 'headers');
  database.exec('begin');
  try {
    if (!blocks.length && !headers.length) createArchiveTables(database);
    else {
      if (blocks.some((c) => c.name === 'details') || (blocks.find((c) => c.name === 'hash')?.type || '').toUpperCase() === 'TEXT') rebuildBlocks(database);
      const nowHeaders = info(database, 'headers');
      if (!nowHeaders.length) database.exec(`create table headers (
        height integer primary key, hash blob not null, ts integer not null, miner text, work real not null, slots integer,
        first_seen integer, prev_hash blob, state_root blob, tx_root blob, nonce blob, difficulty_target blob, log_slots integer);
        create index headers_hash on headers(hash); create index headers_ts on headers(ts)`);
      else if ((nowHeaders.find((c) => c.name === 'hash')?.type || '').toUpperCase() === 'TEXT') rebuildHeaders(database);
    }
    ensureAux(database);
    database.exec('commit');
  } catch (e) { database.exec('rollback'); throw e; }
}
migrateDb(db);

const hexOf = (v) => (v == null ? null : (typeof v === 'string' ? v.toLowerCase() : Buffer.from(v).toString('hex')));
const hashBuf = (hex) => Buffer.from(String(hex).toLowerCase(), 'hex');
const sameHash = (stored, hex) => stored != null && hexOf(stored) === String(hex).toLowerCase();
const optBytes = (hex) => {
  if (hex == null || hex === '') return null;
  const s = String(hex).toLowerCase().replace(/^0x/, '');
  return /^[0-9a-f]+$/.test(s) && s.length % 2 === 0 ? Buffer.from(s, 'hex') : null;
};
const compressJson = (text) => zstdCompressSync(Buffer.from(text));
const numCol = (v) => (v == null ? null : String(v));

const q = {
  hashAt: db.prepare('select hash, blob, cold, first_seen from blocks where height = ?'),
  byHeight: db.prepare('select hash, blob, cold, first_seen from blocks where height = ?'),
  heightOf: db.prepare('select height from blocks where hash = ?'),
  upsert: db.prepare('insert or replace into blocks (height, hash, blob, first_seen, ts, reward, fees, txs, cold) values (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  hasStat: db.prepare('select 1 from stats where height = ? and hash is ?'),
  addStat: db.prepare('insert or replace into stats (height, ts, data, hash) values (?, ?, ?, ?)'),
  topBlock: db.prepare('select max(height) h from blocks'),
  charts: db.prepare('select height, ts, data from stats order by height desc limit 500'),
  headerTop: db.prepare('select max(height) h, count(*) n from headers'),
  headerAt: db.prepare('select height, hash, first_seen, ts, miner from headers where height = ?'),
  // Lowest height missing below the top (0 if genesis is missing), for refilling holes.
  firstGap: db.prepare(`select case when not exists (select 1 from headers where height = 0) then 0
    else (select min(a.height) + 1 from headers a where not exists (select 1 from headers b where b.height = a.height + 1)) end h`),
  addTick: db.prepare('insert or replace into price_ticks (ts, usd, volume_24h, supply) values (?, ?, ?, ?)'),
  ticks: db.prepare(`select (ts / cast(:b as integer)) * cast(:b as integer) t, avg(usd) usd, max(usd) hi, min(usd) lo, avg(volume_24h) volume_24h, avg(supply) supply
    from price_ticks where ts >= :since group by ts / cast(:b as integer) order by t`),
  firstTick: db.prepare('select min(ts) t from price_ticks'),
  tickRange: db.prepare('select ts, usd from price_ticks where ts >= ? order by ts'),
  supplySeries: db.prepare(`select (ts / cast(:b as integer)) * cast(:b as integer) t, max(cast(json_extract(data, '$.circulating_supply_micronoid') as real)) supply
    from stats where ts >= :since group by ts / cast(:b as integer) order by t`),
  addHolders: db.prepare('insert or replace into holders (ts, holders, supply, top10, top100, slots) values (?, ?, ?, ?, ?, ?)'),
  holdersSeries: db.prepare('select ts t, holders, supply, top10, top100, slots from holders where ts >= ? order by ts'),
  lastHolders: db.prepare('select ts, holders, supply, top10, top100, slots from holders order by ts desc limit 1'),
  richList: db.prepare('select rank, address, balance, slots from rich_list order by rank limit ?'),
  richRank: db.prepare('select rank, balance from rich_list where address = ?'),
  putHeader: db.prepare(`insert or replace into headers
    (height, hash, ts, miner, work, slots, first_seen, prev_hash, state_root, tx_root, nonce, difficulty_target, log_slots)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  headerByHash: db.prepare('select height from headers where hash = ?'),
  recentWork: db.prepare('select count(*) n, min(ts) t0, max(ts) t1, sum(work) w from (select ts, work from headers order by height desc limit ?)'),
  tipWork: db.prepare('select work from headers order by height desc limit 1'),
  blocksSince: db.prepare('select count(*) n from headers where ts >= ?'),
  spanSince: db.prepare('select count(*) n, min(ts) t0, max(ts) t1 from headers where ts >= ?'),
  spanLast: db.prepare('select count(*) n, min(ts) t0, max(ts) t1 from (select ts from headers order by height desc limit ?)'),
  minHeaderTs: db.prepare('select min(ts) t from headers'),
  // One row per bucket: hashrate = work done / time it took; block time = time / blocks.
  // node:sqlite binds JS numbers as REAL, so the bucket is cast to integer for integer division.
  history: db.prepare(`select (ts / cast(:b as integer)) * cast(:b as integer) t, count(*) blocks, avg(work) work, max(slots) slots,
      case when max(ts) > min(ts) then sum(work) / (max(ts) - min(ts)) end hashrate,
      case when count(*) > 1 then (max(ts) - min(ts)) * 1.0 / (count(*) - 1) end block_time
    from headers where ts >= :since group by ts / cast(:b as integer) order by t`),
  minersSince: db.prepare('select miner, count(*) blocks, max(height) last from headers where ts >= ? group by miner order by blocks desc'),
  bodyStats: db.prepare(`select height, lower(hex(hash)) hash, reward, fees, txs from blocks where height between ? and ?`),
  txs24h: db.prepare('select sum(txs) n, count(*) blocks from blocks where ts >= ?'),
  addOrphan: db.prepare('insert into orphans (height, hash, kind, blob, first_seen, replaced_at, reason, cold) values (?, ?, ?, ?, ?, ?, ?, ?)'),
  orphansAt: db.prepare('select height, hash, kind, reason, first_seen, replaced_at from orphans where height = ? order by id'),
  orphanByHash: db.prepare('select id, height, hash, kind, blob, cold, first_seen, replaced_at, reason from orphans where hash = ? order by id desc limit 1'),
  blocksAbove: db.prepare('select height, hash, blob, cold, first_seen from blocks where height > ?'),
  headersAbove: db.prepare('select height, hash, first_seen from headers where height > ?'),
  recentOrphans: db.prepare('select height, hash, kind, reason, first_seen, replaced_at from orphans order by id desc limit ?'),
  orphanCount: db.prepare('select count(*) n from orphans'),
  addGap: db.prepare('insert or ignore into gaps (height, kind, first_seen, tries) values (?, ?, ?, 0)'),
  clearGap: db.prepare('delete from gaps where height = ? and kind = ?'),
  gapFail: db.prepare('update gaps set tries = tries + 1, last_error = ? where height = ? and kind = ?'),
  nextGaps: db.prepare('select height, kind, tries from gaps order by tries, height limit ?'),
  gapCount: db.prepare('select count(*) n from gaps'),
  gapsAll: db.prepare('select height, kind, first_seen, tries, last_error from gaps order by height limit ?'),
  gapsKind: db.prepare('select height, kind, first_seen, tries, last_error from gaps where kind = ? order by height limit ?'),
  addReorg: db.prepare('insert into reorgs (tip_before, tip_after, at, depth) values (?, ?, ?, ?)'),
  reorgCount: db.prepare('select count(*) n from reorgs'),
  meta: db.prepare('select v from meta where k = ?'),
  setMeta: db.prepare('insert or replace into meta (k, v) values (?, ?)'),
  delTxHeight: db.prepare('delete from tx_index where height = ?'),
  delAddrHeight: db.prepare('delete from addr_tx where height = ?'),
  delPayout: db.prepare('delete from miner_payouts where height = ?'),
  putTx: db.prepare('insert or replace into tx_index (txid, height, position, fee, burned, coinbase) values (?, ?, ?, ?, ?, ?)'),
  putAddr: db.prepare('insert into addr_tx (address, txid, height, dir, amount) values (?, ?, ?, ?, ?)'),
  putPayout: db.prepare('insert or replace into miner_payouts (height, miner, payout, amount) values (?, ?, ?, ?)'),
  addrTotals: db.prepare(`select
    coalesce(sum(case when dir = 'in' then cast(amount as integer) end), 0) sent,
    coalesce(sum(case when dir in ('out', 'miner') then cast(amount as integer) end), 0) received,
    count(*) n from addr_tx where address = ?`),
  addrHourly: db.prepare(`select (h.ts / 3600) * 3600 t,
    sum(case when a.dir = 'in' then -cast(a.amount as integer) else cast(a.amount as integer) end) net
    from addr_tx a join headers h on h.height = a.height where a.address = ? group by t order by t`),
  addrRecent: db.prepare(`select lower(hex(txid)) txid, height, dir, amount from addr_tx where address = ? order by height desc, rowid desc limit 25`),
  minedCount: db.prepare('select count(*) n from headers where miner = ?'),
  payoutsFor: db.prepare('select payout, count(*) blocks, sum(cast(amount as integer)) amount from miner_payouts where miner = ? group by payout order by amount desc'),
  burnedSum: db.prepare('select sum(cast(burned as integer)) s, count(burned) n from tx_index'),
  coldCandidates: db.prepare('select height, hash, blob from blocks where blob is not null and height <= ? order by height limit 25'),
  markCold: db.prepare('update blocks set blob = null, cold = ? where height = ?'),
};

// The node emits creation_id as a 64-bit integer (~9.2e18). JSON.parse would round it, making different
// slots look identical, so quote those numbers into strings before parsing.
const parseRpc = (text) => JSON.parse(text.replace(/"creation_id":\s*(\d{16,})/g, '"creation_id":"$1"'));

async function rpc(method, params = [], timeoutMs = 10_000) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(RPC_TOKEN && { authorization: `Bearer ${RPC_TOKEN}` }) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: `paranoid_${method}`, params }),
    signal: AbortSignal.timeout(timeoutMs),
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
// If a height is missing below that (the node returned no header for it once), the walk restarts from the hole.
const HEADER_BATCH = Number(process.env.HEADER_BATCH || 25);
const history = { synced_to: -1, tip: 0, missing: 0 };
let stuckGap = null;
async function syncHeaders(tip) {
  const { h: top, n } = q.headerTop.get();
  let h = Math.max(0, (top ?? -1) - RETAINED + 1);
  const gap = top != null && n < top + 1 ? q.firstGap.get().h : null;
  if (gap != null && gap !== stuckGap) h = Math.min(h, gap);
  for (let round = 0; round < HEADER_BATCH && h <= tip; round++) {
    const heights = Array.from({ length: Math.min(200, tip - h + 1) }, (_, i) => h + i);
    const rows = await rpcBatch(heights.map((x) => ['getBlockHeader', [x]]));
    db.exec('begin');
    try {
      for (const r of rows) if (r?.difficulty_target) saveHeader(r);
      db.exec('commit');
    } catch (e) { db.exec('rollback'); throw e; }
    h += heights.length;
  }
  if (gap != null && q.firstGap.get().h === gap) stuckGap = gap; // the node had nothing for it either: don't re-walk every pass
  if (stuckGap != null) q.addGap.run(stuckGap, 'header', Date.now());
  db.exec(`delete from gaps where kind = 'header' and height in (select height from headers)`);
  const after = q.headerTop.get();
  Object.assign(history, { synced_to: after.h ?? -1, tip, missing: after.h == null ? 0 : after.h + 1 - after.n });
}

// Current network numbers from the header history.
function blockTime(seconds, blocks) {
  const since = Math.floor(Date.now() / 1000) - seconds;
  const wall = q.spanSince.get(since);
  const r = wall.n > 1 && wall.t1 > wall.t0 ? wall : q.spanLast.get(blocks);
  return r.n > 1 && r.t1 > r.t0 ? (r.t1 - r.t0) / (r.n - 1) : null;
}
function networkStats() {
  const r = q.recentWork.get(120); // ~1 hour at the 30 s target
  const span = r.t1 - r.t0;
  return {
    hashrate: span > 0 ? r.w / span : null, // hashes per second
    avg_block_time: r.n > 1 ? span / (r.n - 1) : null,
    block_time_10m: blockTime(600, 20), // last 10 minutes, or the last 20 blocks (10 min at the 30 s target)
    block_time_24h: blockTime(86400, 2880),
    difficulty_work: q.tipWork.get()?.work ?? null, // expected hashes per block
    blocks_24h: q.blocksSince.get(Math.floor(Date.now() / 1000) - 86400).n,
    history,
  };
}

// V2 issuance from height 210,537, stepping every 1,051,200 blocks, then 1 NOID forever. Before that the node reports the live reward.
const ISSUANCE_START = 210537;
const ISSUANCE_INTERVAL = 1_051_200;
const ALLOCATION_END = 3_223_778;
const SUBSIDY_NOID = ['16', '11.30', '8', '5.65', '4', '2.83', '2', '1.41', '1'];
const SUBSIDY_AT = [210537, 1261737, 2312937, 3364137, 4415337, 5466537, 6517737, 7568937, 8620137];
function issuance(height) {
  const h = Number(height) || 0;
  const miner_share = h < ALLOCATION_END ? 0.9 : 1;
  if (h < ISSUANCE_START) return { tier: null, subsidy_noid: null, blocks_to_next_reward: ISSUANCE_START - h, next_reward_height: ISSUANCE_START, miner_share };
  const tier = Math.min(Math.floor((h - ISSUANCE_START) / ISSUANCE_INTERVAL), SUBSIDY_NOID.length - 1);
  const next = tier >= SUBSIDY_NOID.length - 1 ? null : ISSUANCE_START + (tier + 1) * ISSUANCE_INTERVAL;
  return { tier, subsidy_noid: SUBSIDY_NOID[tier], blocks_to_next_reward: next == null ? null : next - h, next_reward_height: next, miner_share };
}
const FEE_RULE = {
  base_micronoid: 5000, per_input_micronoid: 100, per_output_micronoid: 700, growth_base_micronoid: 2500,
  pressure: [{ fill: '<50%', multiplier: 1 }, { fill: '50–75%', multiplier: 2 }, { fill: '75–90%', multiplier: 4 }, { fill: '≥90%', multiplier: 8 }],
  relay: 'Relay floor is max(5000, 90% of the median of the last 50 mempool fees) when the mempool is at least 80% of 1024 txs or 384 MiB. It resets below 50% of both, or when the mempool is empty. The growth component is burned; base, inputs, outputs and tip are claimable by the miner.',
};
function feeParts(t) {
  const inputs = t?.n_inputs ?? t?.inputs?.length;
  const outputs = t?.n_outputs ?? t?.outputs?.length;
  if (inputs == null || outputs == null) return null;
  const base = FEE_RULE.base_micronoid;
  const inputFee = FEE_RULE.per_input_micronoid * inputs;
  const outputFee = FEE_RULE.per_output_micronoid * outputs;
  const known = base + inputFee + outputFee;
  const fee = Number(t.fee_micronoid);
  return { base, inputs: inputFee, outputs: outputFee, claimable: known, growth_or_tip: Number.isFinite(fee) ? Math.max(0, fee - known) : null, n_inputs: inputs, n_outputs: outputs };
}

// A header or body that is about to be overwritten is copied here first, in the same transaction as the write.
function saveHeader(r) {
  const prev = q.headerAt.get(r.height);
  const now = Date.now();
  if (prev && !sameHash(prev.hash, r.hash)) q.addOrphan.run(prev.height, prev.hash, 'header', null, prev.first_seen, now, 'replace', null);
  const first = prev && sameHash(prev.hash, r.hash) ? (prev.first_seen ?? now) : now;
  q.putHeader.run(r.height, hashBuf(r.hash), r.timestamp, r.miner ?? null, workOf(r.difficulty_target), r.active_slot_count ?? null, first,
    optBytes(r.prev_hash), optBytes(r.state_root), optBytes(r.tx_root || r.transactions_root), optBytes(r.nonce || r.nonce_hex), optBytes(r.difficulty_target), r.log_slots ?? null);
}
function indexBody(height, details) {
  q.delTxHeight.run(height);
  q.delAddrHeight.run(height);
  q.delPayout.run(height);
  const txs = details.retained?.transactions;
  let coinbaseTo = null;
  if (Array.isArray(txs)) {
    txs.forEach((t, i) => {
      const id = String(t.tx_hash || t.txid || t.hash || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(id)) return;
      const txid = hashBuf(id);
      const burned = t.burned_micronoid ?? t.growth_burned_micronoid ?? null;
      q.putTx.run(txid, height, i, numCol(t.fee_micronoid), numCol(burned), t.coinbase ? 1 : 0);
      const inputs = t.inputs || [];
      for (const inp of inputs) {
        const owner = inp.owner || inp.address || inp.input_owner;
        if (owner) q.putAddr.run(owner, txid, height, 'in', String(inp.amount_micronoid ?? inp.value ?? inp.amount ?? '0'));
      }
      if (t.input_owner && !inputs.length) q.putAddr.run(t.input_owner, txid, height, 'in', String(t.input_sum_micronoid ?? '0'));
      for (const out of t.outputs || []) {
        const owner = out.owner || out.address;
        if (!owner) continue;
        q.putAddr.run(owner, txid, height, 'out', String(out.amount_micronoid ?? out.value ?? out.amount ?? '0'));
        if (t.coinbase) coinbaseTo = owner;
      }
    });
  }
  const miner = details.header?.miner;
  const reward = details.retained?.reward_micronoid;
  if (miner && reward != null) {
    const to = coinbaseTo || miner;
    q.putPayout.run(height, miner, to, String(reward));
    // No coinbase output in the body: the header miner is the only payout destination we can record.
    if (!coinbaseTo && details.header?.hash && /^[0-9a-f]{64}$/i.test(details.header.hash)) q.putAddr.run(miner, hashBuf(details.header.hash), height, 'miner', String(reward));
  }
}
function saveBody(h, hashHex, details) {
  const prev = q.hashAt.get(h);
  const now = Date.now();
  const raw = JSON.stringify(details);
  const blob = compressJson(raw);
  const txs = Array.isArray(details.retained?.transactions) ? details.retained.transactions.length : (details.retained ? 0 : null);
  db.exec('begin');
  try {
    if (prev && !sameHash(prev.hash, hashHex)) q.addOrphan.run(prev.height ?? h, prev.hash, 'body', prev.blob, prev.first_seen, now, 'replace', prev.cold);
    const first = prev && sameHash(prev.hash, hashHex) ? prev.first_seen : now;
    q.upsert.run(h, hashBuf(hashHex), blob, first, details.header?.timestamp ?? null, numCol(details.retained?.reward_micronoid), numCol(details.retained?.total_fees_micronoid), txs, null);
    q.clearGap.run(h, 'body');
    indexBody(h, details);
    db.exec('commit');
  } catch (e) { db.exec('rollback'); throw e; }
  packStats.raw = raw.length;
  packStats.zstd = blob.length;
}
function orphanAbove(tip) {
  const now = Date.now();
  for (const row of q.blocksAbove.all(tip)) q.addOrphan.run(row.height, row.hash, 'body', row.blob, row.first_seen, now, 'reorg', row.cold);
  for (const row of q.headersAbove.all(tip)) q.addOrphan.run(row.height, row.hash, 'header', null, row.first_seen, now, 'reorg', null);
}
function noteBodyGaps(tip) {
  const end = tip - RETAINED;
  let from = Number(q.meta.get('gap_from')?.v ?? 0);
  if (end < from) return;
  const now = Date.now();
  const stop = Math.min(end, from + 4999);
  db.exec('begin');
  try {
    for (let h = from; h <= stop; h++) if (!q.hashAt.get(h)) q.addGap.run(h, 'body', now);
    q.setMeta.run('gap_from', String(stop + 1));
    db.exec('commit');
  } catch (e) { db.exec('rollback'); throw e; }
}
const peers = () => (process.env.ARCHIVE_PEERS || '').split(',').map((s) => s.trim()).filter(Boolean);
async function fetchPeerBody(peer, height) {
  const base = peer.replace(/\/$/, '');
  try {
    const res = await fetch(base, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'paranoid_getBlockDetails', params: [height] }),
      signal: AbortSignal.timeout(8_000),
    });
    const body = parseRpc(await res.text());
    if (body.result?.header && body.result.retained) return body.result;
  } catch {}
  try {
    const res = await fetch(`${base}/api/block/${height}`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const body = await res.json();
    if (body?.retained && body?.header?.hash) return { header: body.header, retained: body.retained };
  } catch {}
  return null;
}
async function recoverGaps() {
  for (const g of q.nextGaps.all(20)) {
    if (g.kind !== 'body') { q.gapFail.run('header not served', g.height, g.kind); continue; }
    let saved = false;
    try {
      const details = await rpc('getBlockDetails', [g.height]);
      const hdr = q.headerAt.get(g.height);
      if (details?.retained && details.header?.hash && (!hdr || sameHash(hdr.hash, details.header.hash))) {
        saveBody(g.height, details.header.hash, details);
        saved = true;
      }
    } catch (e) { q.gapFail.run(String(e.message || 'node').slice(0, 180), g.height, g.kind); continue; }
    if (saved) continue;
    for (const peer of peers()) {
      try {
        const details = await fetchPeerBody(peer, g.height);
        if (!details?.header?.hash) continue;
        const hdr = q.headerAt.get(g.height);
        if (hdr && !sameHash(hdr.hash, details.header.hash)) continue;
        saveBody(g.height, details.header.hash, details);
        saved = true;
        break;
      } catch {}
    }
    if (!saved) q.gapFail.run('still pruned', g.height, g.kind);
  }
}
function coldDir() {
  if (process.env.COLD_DIR === 'off' || process.env.COLD_DIR === '') return null;
  if ((process.env.DB_PATH || '').endsWith(':memory:') && !process.env.COLD_DIR) return null;
  const dir = process.env.COLD_DIR || path.join(path.dirname(process.env.DB_PATH || path.join(__dirname, 'noid.db')), 'cold');
  return dir;
}
function maybeCold(tip) {
  const dir = coldDir();
  if (!dir) return;
  const after = Number(process.env.COLD_AFTER ?? 20000);
  const limit = tip - Math.max(Number.isFinite(after) ? after : 20000, MAX_REORG);
  if (!(limit >= 0)) return;
  fs.mkdirSync(dir, { recursive: true });
  for (const row of q.coldCandidates.all(limit)) {
    const name = `${row.height}-${hexOf(row.hash)}.zst`;
    if (!/^\d+-[0-9a-f]{64}\.zst$/.test(name)) continue;
    fs.writeFileSync(path.join(dir, name), row.blob);
    q.markCold.run(name, row.height);
  }
}
function readCold(name) {
  if (!/^\d+-[0-9a-f]{64}\.zst$/.test(name || '')) return null;
  const dir = coldDir();
  if (!dir) return null;
  return fs.readFileSync(path.join(dir, name));
}
function unpackRow(row) {
  if (!row) return null;
  const buf = row.blob ?? (row.cold ? readCold(row.cold) : null);
  if (!buf) return null;
  return JSON.parse(zstdDecompressSync(buf).toString());
}
const packStats = { raw: null, zstd: null };

// One indexer pass. Re-checking the whole retained window by hash also handles reorgs:
// a replaced block has a new hash at the same height and gets overwritten.
const indexer = { tip: null, at: null, supply: null, error: null }; // last successful pass, exposed in /api/stats for uptime monitors
const MAX_REORG = 18; // Parano1d consensus never replaces more blocks than this (CONSENSUS_FINALITY_DEPTH)
async function tick() {
  const tip = await rpc('blockCount');
  // The node's tip went down: a reorg (at most 18 blocks) drops the blocks above the new tip, which are no longer canonical.
  // Anything deeper is not a normal reorg (a node reset or resync): stop and keep every archived body until a person looks.
  const top = q.topBlock.get().h;
  if (top != null && tip < top) {
    if (top - tip > MAX_REORG) {
      indexer.error = `node tip ${tip} is ${top - tip} blocks below the indexed tip ${top}; indexing paused, nothing deleted. Check the node.`;
      throw new Error(indexer.error);
    }
    db.exec('begin');
    try {
      orphanAbove(tip); // before the delete: these rows are the only copy once the node has moved on
      for (const t of ['blocks', 'stats', 'headers', 'token_trades', 'token_transfers', 'token_candles', 'tx_index', 'addr_tx', 'miner_payouts']) db.prepare(`delete from ${t} where height > ?`).run(tip);
      q.addReorg.run(top, tip, Date.now(), top - tip);
      db.exec('commit');
    } catch (e) { db.exec('rollback'); throw e; }
    cache.clear();
  }
  let replaced = 0;
  for (let h = Math.max(0, tip - RETAINED + 1); h <= tip; h++) {
    const hash = await rpc('getBlockHash', [h]);
    const row = q.hashAt.get(h);
    if (!hash || sameHash(row?.hash, hash)) continue;
    const details = await rpc('getBlockDetails', [h]);
    if (details) { if (row) replaced++; saveBody(h, hash, details); cache.clear(); }
  }
  if (replaced && !(top != null && tip < top)) q.addReorg.run(top ?? tip, tip, Date.now(), replaced);
  const tipHash = hexOf(q.hashAt.get(tip)?.hash);
  if (!q.hasStat.get(tip, tipHash)) {
    const [chain, peers, mining, header] = await Promise.all([
      rpc('getChainInfo'), rpc('getPeerCount'), rpc('getMiningInfo'), rpc('getBlockHeader', [tip]),
    ]);
    const data = {
      active_slot_count: chain.active_slot_count,
      circulating_supply_micronoid: chain.circulating_supply_micronoid,
      difficulty_bits: mining.difficulty_bits,
      peers,
    };
    q.addStat.run(tip, header?.timestamp ?? null, JSON.stringify(data), tipHash);
    indexer.supply = chain.circulating_supply_micronoid;
  }
  await syncHeaders(tip);
  noteBodyGaps(tip);
  await recoverGaps().catch((e) => console.error('gaps:', e.message));
  try { maybeCold(tip); } catch (e) { console.error('cold:', e.message); }
  await bill.settleNoid(tip);
  // Token indexing must not pause block indexing: a missing v2.1 method is normal until the node ships it.
  if (await assets.sync()) cache.clear();
  Object.assign(indexer, { tip, at: Date.now(), error: null });
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

function othersAt(h) {
  return q.orphansAt.all(h).map((o) => ({ hash: hexOf(o.hash), kind: o.kind, reason: o.reason, first_seen: o.first_seen, replaced_at: o.replaced_at }));
}
function presentOrphan(row) {
  const details = unpackRow(row);
  const header = details?.header ?? { height: row.height, hash: hexOf(row.hash) };
  return { header, retained: details?.retained ?? null, archived: !!details?.retained, first_seen: row.first_seen, canonical: false, orphan: { reason: row.reason, replaced_at: row.replaced_at }, others: othersAt(row.height) };
}
async function blockByHeight(h) {
  const live = await rpc('getBlockDetails', [h]);
  if (!live) return null;
  const row = q.byHeight.get(h);
  const archivedBody = unpackRow(row);
  const match = !!(archivedBody && archivedBody.header?.hash === live.header.hash);
  const retained = live.retained ?? (match ? archivedBody.retained : null);
  const headerRow = q.headerAt.get(h);
  return {
    header: live.header, retained, archived: !live.retained && !!retained,
    first_seen: (match ? row.first_seen : null) ?? headerRow?.first_seen ?? null,
    canonical: true, stored_canonical: !row || match, others: othersAt(h),
  };
}

// NOID/USD from CoinPaprika (free, no key; NOID trades on SafeTrade). Ticker every 3 min plus
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
    usd: u.price, change_24h_pct: u.percent_change_24h, volume_24h_usd: u.volume_24h, updated: t.last_updated, source: 'CoinPaprika (SafeTrade)',
    change: { '15m': u.percent_change_15m, '1h': u.percent_change_1h, '6h': u.percent_change_6h, '24h': u.percent_change_24h, '7d': u.percent_change_7d, '30d': u.percent_change_30d },
    fetched_at: Date.now(), volume_change_24h_pct: u.volume_24h_change_24h, ath_usd: u.ath_price, ath_date: u.ath_date, from_ath_pct: u.percent_from_price_ath, rank: t.rank,
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

let labels = { at: 0, map: {} };
function labelFor(address) {
  if (!labels.at || Date.now() - labels.at >= Number(process.env.LABELS_REFRESH_MS || 1_800_000)) {
    labels.at = Date.now();
    labels.map = {};
    try {
      const raw = JSON.parse(fs.readFileSync(process.env.LABELS_FILE || path.join(__dirname, 'labels.json'), 'utf8'));
      for (const [k, v] of Object.entries(raw)) if (RE.address.test(k) && v && typeof v === 'object') labels.map[k] = v;
    } catch {}
  }
  return address ? labels.map[address] || null : null;
}

const bill = require('./billing.js')(db, rpc, () => price.now && { usd: price.now.usd, at: price.now.fetched_at }, () => indexer.tip);
const assets = require('./assets.js')(db, rpc, () => price.now);

// Candle interval -> [seconds per candle, how far back to show].
const CANDLES = { '15m': [900, 86400], '1h': [3600, 4 * 86400], '4h': [14400, 16 * 86400], '1d': [86400, 120 * 86400], '1w': [604800, 3 * 365 * 86400] }; // ~100 candles each
const WINDOWS = { '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400, all: 1e10 };

const routes = {
  async stats() {
    const [chain, state, node, peers, mining] = await Promise.all([
      rpc('getChainInfo'), rpc('getStateInfo'), rpc('getNodeStatus'), rpc('getPeerCount'), rpc('getMiningInfo'),
    ]);
    const bodies = db.prepare('select min(height) lo, max(height) hi from blocks').get();
    let feeFloor = null;
    try { feeFloor = (await rpc('getMempoolInfo'))?.fee_floor ?? null; } catch {}
    const burned = q.burnedSum.get();
    const econ = issuance(chain.height);
    return {
      chain, state, node, peers, mining, indexer,
      coverage: { bodies_from: bodies.lo, bodies_to: bodies.hi, headers_to: history.synced_to, gaps: q.gapCount.get().n, reorgs: q.reorgCount.get().n, orphans: q.orphanCount.get().n, since: q.minHeaderTs.get().t },
      network: networkStats(), txs_24h: q.txs24h.get(Math.floor(Date.now() / 1000) - 86400), price: price.now,
      economics: { ...econ, fee_floor: feeFloor, burned_micronoid: burned.n ? String(burned.s) : null, allocation_until: ALLOCATION_END },
      donate: process.env.DONATE_ADDRESS || null, ai: ai.enabled,
    };
  },

  async gaps(_, params) {
    const limit = Math.min(Math.max(Number(params.get('limit')) || 50, 1), 200);
    const kind = params.get('kind');
    const rows = kind === 'body' || kind === 'header' ? q.gapsKind.all(kind, limit) : q.gapsAll.all(limit);
    return { count: q.gapCount.get().n, gaps: rows };
  },

  async orphans(_, params) {
    const limit = Math.min(Math.max(Number(params.get('limit')) || 50, 1), 200);
    return { count: q.orphanCount.get().n, orphans: q.recentOrphans.all(limit).map((r) => ({ height: r.height, hash: hexOf(r.hash), kind: r.kind, reason: r.reason, first_seen: r.first_seen, replaced_at: r.replaced_at })) };
  },

  async economics() {
    let height = indexer.tip;
    try { height = (await rpc('getChainInfo')).height; } catch {}
    const burned = q.burnedSum.get();
    return {
      height, ...issuance(height), allocation_until: ALLOCATION_END, schedule: SUBSIDY_AT.map((at, i) => ({ height: at, noid: SUBSIDY_NOID[i] })),
      fees: FEE_RULE, burned_micronoid: burned.n ? String(burned.s) : null,
      note: 'Before height 210537 the live block reward is whatever the node reports. There is no max supply: the tail is 1 NOID per block.',
    };
  },

  async receipts() {
    return { available: false, how: 'parano1d-cli receipt TXID', verify: 'parano1d-cli verify', note: 'This explorer has no receipt RPC. Contract receipts stay verifiable with the CLI after the node prunes the block body.' };
  },

  async contracts() {
    return {
      available: false,
      abi: '16-instruction integer ABI',
      templates: ['refundable payments', 'timelocked vaults', 'delegated allowance', 'budgets', 'recurring', 'gradual release'],
      note: 'No contract RPC is published for this explorer. Templates are executed and verified on the node; this page does not simulate them.',
    };
  },

  async blocks(_, params) {
    const tip = await rpc('blockCount');
    const before = RE.height.test(params.get('before') || '') ? Math.min(Number(params.get('before')), tip) : tip;
    const limit = Math.min(Math.max(Number(params.get('limit')) || 20, 1), 50);
    const heights = [];
    for (let h = before; h >= 0 && heights.length < limit; h--) heights.push(h);
    const headers = heights.length ? await rpcBatch(heights.map((h) => ['getBlockHeader', [h]])) : [];
    // Tx count, reward and fees exist only for bodies this explorer captured.
    const body = new Map(q.bodyStats.all(heights.at(-1) ?? 0, heights[0] ?? 0).map((r) => [r.height, r]));
    return { tip, blocks: headers.filter(Boolean).map((b) => {
      const x = body.get(b.height)?.hash === b.hash ? body.get(b.height) : null; // never another block's body
      return { ...b, txs: x?.txs ?? null, reward_micronoid: x?.reward ?? null, total_fees_micronoid: x?.fees ?? null, indexed: !!x };
    }) };
  },

  async block(id) {
    if (RE.height.test(id)) return blockByHeight(Number(id));
    if (RE.hash.test(id)) {
      const buf = hashBuf(id);
      const row = q.heightOf.get(buf) ?? q.headerByHash.get(buf);
      if (row) return blockByHeight(row.height);
      const orph = q.orphanByHash.get(buf);
      return orph ? presentOrphan(orph) : null;
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
    const totals = q.addrTotals.get(addr);
    const label = labelFor(addr);
    return {
      address: addr, balance_micronoid: balance.toString(), rank: q.richRank.get(addr)?.rank ?? null, slots, activity,
      label: label ? { entity: label.entity || null, note: label.note || null } : null,
      blocks_mined: q.minedCount.get(addr).n,
      archive: {
        partial: true,
        note: 'Totals, the hourly net and payout destinations come only from block bodies this explorer stored. They are not a full wallet balance.',
        sent_micronoid: String(totals.sent), received_micronoid: String(totals.received), tx_count: totals.n,
        hourly: q.addrHourly.all(addr).map((r) => ({ t: r.t, net_micronoid: String(r.net) })),
        recent: q.addrRecent.all(addr),
        payouts: q.payoutsFor.all(addr).map((r) => ({ payout: r.payout, blocks: r.blocks, amount_micronoid: String(r.amount) })),
      },
    };
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
    const miners = rows.slice(0, 15).map((r) => ({ ...r, share: total ? r.blocks / total : 0, entity: labelFor(r.miner)?.entity || null }));
    const hot = miners.find((r) => r.share > 0.5);
    return { window: params.get('window') || '24h', blocks: total, miner_count: rows.length, miners, warning: hot ? `${hot.entity || hot.miner || 'One miner'} mined more than half the blocks in this window.` : null };
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
      relay: FEE_RULE.relay, fees_rule: FEE_RULE,
      txs: txs.slice(0, 100).map((t) => ({ ...t, fee_parts: feeParts(t) })),
      // Minimum accepted fee for common shapes (inputs -> outputs); NOID fees are rule-based, not an auction.
      fees: [{ shape: '1 → 1', ...f11 }, { shape: '1 → 2 (typical payment)', ...f12 }, { shape: '2 → 2', ...f22 }].map((f) => ({ shape: f.shape, fee_micronoid: f.fee_micronoid, burn_slots: f.net_new_slots, fee_parts: feeParts({ n_inputs: f.n_inputs, n_outputs: f.n_outputs, fee_micronoid: f.fee_micronoid }) })),
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

  // OHLC candles. NOID trades only on SafeTrade, whose candle API isn't reachable for us, so candles are built from
  // our own price samples (CoinPaprika's SafeTrade price every 3 min): open = first sample in the candle, close = last,
  // high/low = extremes of the samples, so a spike between two samples is missed. Before our samples begin, daily
  // (1d/1w) or hourly (1h/4h) closes fill in as `approx` candles that open at the previous close. No per-candle volume exists.
  async candles(_, params) {
    if (!price.now) return null;
    const iv = Object.hasOwn(CANDLES, params.get('interval')) ? params.get('interval') : '1h';
    const [b, span] = CANDLES[iv];
    const now = Math.floor(Date.now() / 1000);
    const first = q.firstTick.get().t ?? now;
    const MON = 4 * 86400; // weeks start on Monday (1970-01-05), not on the epoch's Thursday
    const start = (t) => (b === 604800 ? Math.floor((t - MON) / b) * b + MON : Math.floor(t / b) * b);
    const since = start(now - span);
    const filler = b >= 86400 ? price.daily : b >= 3600 ? price.hourly : [];
    const pts = [
      ...filler.filter((p) => p.t >= since && p.t < first).map((p) => ({ t: p.t, usd: p.usd, approx: true })),
      ...q.tickRange.all(since).map((r) => ({ t: r.ts, usd: r.usd, approx: false })),
    ].sort((x, y) => x.t - y.t);
    const candles = [];
    for (const p of pts) {
      const t = start(p.t), c = candles.at(-1);
      if (c?.t === t) { c.h = Math.max(c.h, p.usd); c.l = Math.min(c.l, p.usd); c.c = p.usd; c.n++; c.approx &&= p.approx; continue; }
      const o = p.approx && c ? c.c : p.usd; // a lone close has no open of its own: continue from the previous candle
      candles.push({ t, o, h: Math.max(o, p.usd), l: Math.min(o, p.usd), c: p.usd, n: 1, approx: p.approx });
    }
    return { interval: iv, bucket: b, candles, samples_since: first, source: 'CoinPaprika price of SafeTrade NOID/USDT, sampled every 3 minutes' };
  },

  async holders(_, params) {
    const w = params.get('window') || '30d';
    const since = Math.floor(Date.now() / 1000) - (WINDOWS[w] ?? WINDOWS['30d']);
    // A sweep reads the Live State in batches over ~20 minutes while blocks keep arriving, so figures are approximate as of `at`.
    return { window: w, latest: q.lastHolders.get() ?? null, points: q.holdersSeries.all(since), first: db.prepare('select min(ts) t from holders').get().t, approximate: true, sweep: { at: sweep.at, took_ms: sweep.ms, running: sweep.running, progress: sweep.progress, error: sweep.error, every_ms: HOLDERS_EVERY_MS } };
  },

  async richlist(_, params) {
    const n = Math.min(Math.max(Number(params.get('limit')) || 50, 1), 500);
    const latest = q.lastHolders.get();
    const rows = q.richList.all(n).map((r) => ({ ...r, share: latest?.supply ? r.balance / latest.supply : null, entity: labelFor(r.address)?.entity || null }));
    const hot = rows.find((r) => r.share > 0.5);
    return { updated: latest?.ts ?? null, approximate: true, supply: latest?.supply ?? null, holders: latest?.holders ?? null, warning: hot ? `${hot.entity || hot.address} holds more than half of the swept supply.` : null, rows };
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

  // Routes must return a promise: the handler shares in-flight calls with .finally.
  tokens: async (...a) => assets.tokens(...a),
  token: async (...a) => assets.token(...a),
  collections: async (...a) => assets.collections(...a),
  collection: async (...a) => assets.collection(...a),
  swap: async (...a) => assets.swap(...a),

  async search(_, params) {
    const s = (params.get('q') || '').trim().toLowerCase();
    if (RE.height.test(s)) return { type: 'block', id: s };
    if (RE.address.test(s)) return { type: 'address', id: s };
    if (RE.hash.test(s)) {
      if (await rpc('getTx', [s])) return { type: 'tx', id: s };
      const buf = hashBuf(s);
      if (q.heightOf.get(buf) || q.headerByHash.get(buf) || q.orphanByHash.get(buf)) return { type: 'block', id: s };
    }
    return null;
  },
};

const ai = require('./chat.js')(routes);

// shortcut: in-memory per-IP limiter, resets on restart and is per-process; move to the reverse proxy if you run several instances.
const hits = new Map();
setInterval(() => hits.clear(), 60_000).unref();

// Short-lived response cache keyed by path + the query parameters routes actually read (so ?key= or junk parameters
// don't defeat it). Responses are chain data, the same for everyone. Identical misses in flight share one node call.
const cache = new Map();
const inflight = new Map();
const PARAMS = ['before', 'limit', 'page', 'window', 'q', 'interval', 'demo', 'sort', 'dir', 'preset', 'side', 'amount', 'slippage', 'token', 'sender', 'kind', 'tf',
  'min_liq', 'max_liq', 'min_vol', 'max_vol', 'min_age', 'max_age', 'min_mcap', 'max_mcap', 'min_txns', 'max_txns', 'min_buys', 'max_buys', 'min_sells', 'max_sells',
  'min_floor', 'max_floor', 'min_items', 'max_items', 'min_owners', 'max_owners'];
const cacheKey = (url) => url.pathname + '?' + PARAMS.filter((k) => url.searchParams.has(k)).map((k) => `${k}=${url.searchParams.get(k)}`).join('&');
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

    const parts = url.pathname.split('/');
    const name = parts[2];
    const id = parts[3] || '';
    const sub = parts[4] ? decodeURIComponent(parts[4]) : '';
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
    if (!acct && !ownPage && name !== 'stats' && name !== 'health') return send(401, { error: 'API key required. Create one free at /account and send it as the x-api-key header.' });
    if (url.pathname === '/api/live') return live(req, res, ip);
    if (name === 'health') {
      const stallMs = Number(process.env.STALL_MS || 120_000);
      const age = indexer.at == null ? null : Date.now() - indexer.at;
      const stalled = indexer.at == null || age > stallMs || !!indexer.error;
      const body = { ok: !stalled, stalled, age_ms: age, stall_ms: stallMs, indexer, gaps: q.gapCount.get().n, reorgs: q.reorgCount.get().n };
      return send(body.ok ? 200 : 503, body, { 'cache-control': 'no-store' });
    }
    // Billing: a keyed request counts only when it returns data (200, cached or not); errors, 404s and the live feed are free.
    const ok = (body, xcache) => { if (acct) bill.countRequest(acct); send(200, body, { 'cache-control': `private, max-age=${CACHE_MS / 1000 | 0}`, vary: 'sec-fetch-site, x-api-key', 'x-cache': xcache }); };
    const key = cacheKey(url);
    const hit = cache.get(key);
    if (hit && hit.until > Date.now()) return ok(hit.body, 'HIT');

    const route = Object.hasOwn(routes, name) && routes[name];
    if (!route) return send(404, { error: 'unknown endpoint' });
    let p = inflight.get(key);
    if (!p) {
      p = route(decodeURIComponent(id), url.searchParams, sub).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    const out = await p;
    if (out == null) return send(404, { error: 'not found' });
    if (CACHE_MS > 0) cache.set(key, { until: Date.now() + CACHE_MS, body: out });
    ok(out, 'MISS');
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
    push(`data: ${JSON.stringify(lastLive)}\n\n`);
  } catch (e) {
    push(`event: down\ndata: ${JSON.stringify(e.message)}\n\n`);
  }
  if (listeners.size) setTimeout(livePoll, LIVE_MS); else liveOn = false;
}
// A viewer that stops reading (stalled tab, slow link) is dropped once 256 KB is queued for it; the browser reconnects.
const SSE_MAX_QUEUED = 256 * 1024, SSE_PER_IP = 10;
function push(msg) {
  for (const res of listeners) {
    if (res.writableLength > SSE_MAX_QUEUED) { listeners.delete(res); res.destroy(); continue; }
    res.write(msg);
  }
}
const liveIps = new Map();
function live(req, res, ip) {
  if (listeners.size >= 1000) return res.writeHead(503).end();
  if ((liveIps.get(ip) || 0) >= SSE_PER_IP) return res.writeHead(429, { 'retry-after': 60 }).end();
  liveIps.set(ip, (liveIps.get(ip) || 0) + 1);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no', 'access-control-allow-origin': '*' });
  res.write('retry: 3000\n\n');
  if (lastLive) res.write(`data: ${JSON.stringify(lastLive)}\n\n`);
  listeners.add(res);
  let dropped = false;
  const drop = () => {
    listeners.delete(res);
    if (dropped) return;
    dropped = true;
    const n = liveIps.get(ip) - 1;
    n > 0 ? liveIps.set(ip, n) : liveIps.delete(ip);
  };
  req.on('close', drop);
  res.on('close', drop);
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

module.exports = { server, tick, db, price, indexer, cacheKey, peerIps, workOf, parseRpc, sweepHolders, pollPrice: () => pollPrice(), migrateDb, compressJson, packStats, issuance };
