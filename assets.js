// Tokens, pools, trades and NFT collections for Explore.
// Parano1d v2.1 has not published this RPC yet. sync() asks the node and writes nothing
// until those methods exist. Sample rows live only in memory behind ?demo=1 or TOKENS_DEMO=1.
//
// Expected node methods (all prefixed paranoid_ by the RPC client):
//   getAssetSnapshot() -> { tokens, trades, pools, collections }
//     tokens[]: id, name, ticker, creator, supply, reserve_micronoid, created_ts, created_height,
//       logo, graduated, price_micronoid, curve_target_micronoid, curve_raised_micronoid,
//       curve_virtual_noid_micronoid, curve_virtual_token, holders[{address, balance}]
//     pools[]: id, token_id, reserve_token, reserve_noid_micronoid, lp_supply
//     trades[]: txid, token_id, ts, height, side (buy|sell), token_amount, noid_micronoid,
//       trader, venue (curve|pool), price_micronoid
//     collections[]: id, name, creator, items, owners, floor_micronoid, volume_micronoid,
//       created_ts, nfts[{id, name, owner, image}]
//   quoteSwap({token_id, side, amount_micronoid|token_amount, slippage_bps, fee_bps, fee_address})
//     -> { expected_out_token|expected_out_micronoid, min_out_token|min_out_micronoid,
//          price_impact_pct, spot_price_micronoid, exec_price_micronoid, fee_in_tx, venue }
//   buildSwap({...quote fields, sender}) -> { unsigned, fee_in_tx }
//     unsigned is the bytes the wallet signs. A payload that already carries a signature is refused.
//
// The fee is a separate output to SWAP_FEE_ADDRESS when buildSwap reports fee_in_tx.
// Until the node can do that, the quote only itemizes the fee. This process never signs.
const ADDR = /^o1[02-9ac-hj-np-z]{6,120}$/;
const ID = /^[A-Za-z0-9:_-]{1,80}$/;
const NOTICE = 'Native tokens activate with Parano1d v2.1';
const WINS = { '5m': 300, '1h': 3600, '6h': 21600, '24h': 86400 };
const TOKEN_SORTS = new Set(['liquidity', 'volume', 'age', 'mcap', 'txns', 'buys', 'sells', 'change', 'progress']);
const NFT_SORTS = new Set(['volume', 'floor', 'items', 'owners', 'age']);
const U = 1_000_000n;

module.exports = function assets(db, rpc, priceNow) {
  db.exec(`
    create table if not exists tokens (
      id text primary key, name text not null, ticker text not null, creator text,
      supply text not null, reserve_micronoid text not null, created_height integer, created_ts integer,
      logo text, graduated integer not null default 0, price_micronoid text,
      curve_target_micronoid text, curve_raised_micronoid text,
      curve_virtual_noid text, curve_virtual_token text, updated_height integer);
    create table if not exists pools (
      id text primary key, token_id text not null, reserve_token text not null,
      reserve_noid_micronoid text not null, lp_supply text, updated_height integer);
    create index if not exists pools_token on pools(token_id);
    create table if not exists token_trades (
      txid text primary key, token_id text not null, ts integer not null, height integer,
      side text not null, token_amount text not null, noid_micronoid text not null,
      trader text, venue text, price_micronoid text);
    create index if not exists token_trades_tok_ts on token_trades(token_id, ts);
    create table if not exists token_holders (
      token_id text not null, address text not null, balance text not null, primary key (token_id, address));
    create table if not exists nft_collections (
      id text primary key, name text not null, creator text, items integer not null default 0,
      owners integer not null default 0, floor_micronoid text, volume_micronoid text not null default '0',
      created_ts integer, updated_height integer);
    create table if not exists nft_items (
      id text primary key, collection_id text not null, name text, owner text, image text);
    create index if not exists nft_items_col on nft_items(collection_id);
  `);

  const q = {
    tokens: db.prepare('select * from tokens'),
    pools: db.prepare('select * from pools'),
    recentTrades: db.prepare('select * from token_trades where ts >= ?'),
    baseTrades: db.prepare(`select t.* from token_trades t join (
      select token_id, max(ts) ts from token_trades where ts < ? group by token_id
    ) m on m.token_id = t.token_id and m.ts = t.ts`),
    token: db.prepare('select * from tokens where id = ?'),
    poolsFor: db.prepare('select * from pools where token_id = ?'),
    tradesFor: db.prepare('select * from token_trades where token_id = ? order by ts desc limit 400'),
    holdersFor: db.prepare('select address, balance from token_holders where token_id = ? order by cast(balance as integer) desc limit 20'),
    cols: db.prepare('select * from nft_collections'),
    col: db.prepare('select * from nft_collections where id = ?'),
    items: db.prepare('select id, name, owner, image from nft_items where collection_id = ? order by id limit 60'),
    upToken: db.prepare(`insert or replace into tokens (id, name, ticker, creator, supply, reserve_micronoid, created_height, created_ts, logo, graduated, price_micronoid, curve_target_micronoid, curve_raised_micronoid, curve_virtual_noid, curve_virtual_token, updated_height)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    upPool: db.prepare('insert or replace into pools (id, token_id, reserve_token, reserve_noid_micronoid, lp_supply, updated_height) values (?, ?, ?, ?, ?, ?)'),
    upTrade: db.prepare('insert or ignore into token_trades (txid, token_id, ts, height, side, token_amount, noid_micronoid, trader, venue, price_micronoid) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    delHolders: db.prepare('delete from token_holders where token_id = ?'),
    upHolder: db.prepare('insert or replace into token_holders (token_id, address, balance) values (?, ?, ?)'),
    upCol: db.prepare('insert or replace into nft_collections (id, name, creator, items, owners, floor_micronoid, volume_micronoid, created_ts, updated_height) values (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    delItems: db.prepare('delete from nft_items where collection_id = ?'),
    upItem: db.prepare('insert or replace into nft_items (id, collection_id, name, owner, image) values (?, ?, ?, ?, ?)'),
  };

  // available: getAssetSnapshot has answered. quote/build: swap RPC is present (not merely "method not found").
  const status = { available: false, quote: false, build: false, error: null, retryAt: 0, dexProbeAt: 0 };

  const probeWait = () => {
    const n = Number(process.env.ASSET_PROBE_MS ?? 600_000);
    return Number.isFinite(n) && n >= 0 ? n : 600_000;
  };
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  const bi = (v) => {
    if (v == null || v === '') return null;
    try { const n = BigInt(v); return n >= 0n ? n : null; } catch { return null; }
  };
  const strInt = (v) => {
    const n = bi(v);
    return n == null ? null : n.toString();
  };
  const isDemo = (params) => params.get('demo') === '1' || process.env.TOKENS_DEMO === '1';
  const noidUsd = () => {
    const p = priceNow();
    return p?.usd > 0 ? p.usd : null;
  };
  const usdOf = (micro, usd) => {
    if (micro == null || usd == null) return null;
    const n = Number(micro) / 1e6 * usd;
    return Number.isFinite(n) ? n : null;
  };
  const pct = (now, then) => (then == null || then <= 0n || now == null) ? null : Number((now - then) * 10000n / then) / 100;
  const feeConfig = () => {
    const raw = process.env.SWAP_FEE_BPS;
    const bps = raw == null || raw === '' ? 50 : Number(raw);
    const address = process.env.SWAP_FEE_ADDRESS || '';
    const bpsOk = Number.isInteger(bps) && bps >= 0 && bps <= 1000;
    const addrOk = ADDR.test(address);
    return {
      bps: bpsOk ? bps : 50, address: addrOk ? address : null,
      ok: process.env.SWAP_ENABLED === 'true' && bpsOk && addrOk,
    };
  };
  const swapLive = () => feeConfig().ok && status.quote && status.build;

  function checkId(id) {
    if (!ID.test(id || '')) throw bad('expected a token or collection id');
    return id;
  }
  function paramInt(params, key) {
    const s = params.get(key);
    if (s == null || s === '') return null;
    if (!/^\d+$/.test(s)) throw bad(`bad ${key}`);
    return Number(s);
  }
  function paramNoid(params, key) {
    const s = params.get(key);
    if (s == null || s === '') return null;
    if (!/^\d+(\.\d{1,6})?$/.test(s)) throw bad(`bad ${key}`);
    const [w, f = ''] = s.split('.');
    return BigInt(w) * U + BigInt(f.padEnd(6, '0'));
  }
  function paramHours(params, key) {
    const s = params.get(key);
    if (s == null || s === '') return null;
    if (!/^\d+(\.\d{1,2})?$/.test(s)) throw bad(`bad ${key}`);
    return Number(s) * 3600;
  }
  function inRange(v, min, max) {
    if (min != null && (v == null || v < min)) return false;
    if (max != null && (v == null || v > max)) return false;
    return true;
  }

  // ---- demo catalog (never written) ----
  // Prices are μNOID per whole token. Curve targets are the preview's 20,000 NOID.
  function demoCatalog(now) {
    const spec = [
      { id: 'gcat', name: 'Ghost Cat', ticker: 'GCAT', supply: 100_000_000n, price: 2000n, p24: 1786n, age_h: 240, vol: 12_000n * U, buys: 24, sells: 10, graduated: true, poolNoid: 25_000n * U, poolToken: 12_500_000n },
      { id: 'nbus', name: 'Night Bus', ticker: 'NBUS', supply: 20_000_000n, price: 5000n, p24: 3704n, age_h: 30, vol: 8_000n * U, buys: 18, sells: 6, raised: 17_200n * U, vToken: 4_000_000n },
      { id: 'qsun', name: 'Quiet Sun', ticker: 'QSUN', supply: 50_000_000n, price: 100n, p24: 95n, age_h: 2, vol: 50n * U, buys: 3, sells: 1, raised: 400n * U, vToken: 10_000_000n },
      { id: 'crown', name: 'Paper Crown', ticker: 'CROWN', supply: 10_000_000n, price: 8000n, p24: 9412n, age_h: 100, vol: 3_000n * U, buys: 8, sells: 14, graduated: true, poolNoid: 4_000n * U, poolToken: 500_000n },
      { id: 'orbit', name: 'Low Orbit', ticker: 'ORBIT', supply: 8_000_000n, price: 3000n, p24: 1667n, age_h: 12, vol: 1_500n * U, buys: 14, sells: 3, raised: 14_000n * U, vToken: 5_000_000n },
    ];
    const target = 20_000n * U;
    const tokens = spec.map((s) => {
      const created_ts = now - s.age_h * 3600;
      const curve = s.graduated ? null : {
        raised_micronoid: s.raised, target_micronoid: target,
        virtual_noid: s.price * s.vToken, virtual_token: s.vToken,
      };
      const pool = s.graduated ? { id: `pool-${s.id}`, reserve_noid_micronoid: s.poolNoid, reserve_token: s.poolToken, lp_supply: null } : null;
      const trades = [];
      const push = (ts, price, noid, side) => trades.push({
        txid: `${s.id}-${ts}-${side}`, token_id: s.id, ts, height: null, side,
        token_amount: price > 0n ? (noid / price).toString() : '1',
        noid_micronoid: noid.toString(), price_micronoid: price.toString(), trader: null, venue: s.graduated ? 'pool' : 'curve',
      });
      push(now - 86400 - 90, s.p24, 1n, 'buy'); // baseline just outside the 24h window
      const span = Math.min(s.age_h * 3600, 20 * 3600);
      const n = s.buys + s.sells;
      for (let i = 0; i < n; i++) {
        const ts = now - 15 - Math.floor((span - 30) * (n - 1 - i) / Math.max(n - 1, 1));
        const price = s.p24 + (s.price - s.p24) * BigInt(i + 1) / BigInt(n);
        const share = i === n - 1 ? s.vol * 3n / 10n : i === Math.floor(n / 2) ? s.vol * 7n / 10n : 1n;
        push(ts, price > 0n ? price : 1n, share, i < s.buys ? 'buy' : 'sell');
      }
      push(now - 5, s.price, 1n, 'buy');
      const holders = [40n, 25n, 10n].map((pctShare, i) => ({
        address: `o1${'acd'[i].repeat(14)}`,
        balance: (s.supply * pctShare / 100n).toString(),
      }));
      return {
        id: s.id, name: s.name, ticker: s.ticker, creator: 'o1acdefghjkmnpqr', supply: s.supply, reserve_micronoid: s.supply * 1000n,
        created_ts, created_height: null, logo: null, graduated: !!s.graduated, price_micronoid: s.price,
        curve, pool, trades, holders,
      };
    });
    const collections = [
      { id: 'stamps', name: 'Night Stamps', creator: null, items: 100, owners: 40, floor_micronoid: 12n * U, volume_micronoid: 5_000n * U, created_ts: now - 20 * 86400, items_list: ['Ash', 'Mint', 'Quiet', 'North'] },
      { id: 'faces', name: 'Paper Faces', creator: null, items: 24, owners: 10, floor_micronoid: 2n * U, volume_micronoid: 800n * U, created_ts: now - 3 * 86400, items_list: ['Fold', 'Crease'] },
      { id: 'glass', name: 'Empty Glass', creator: null, items: 8, owners: 1, floor_micronoid: null, volume_micronoid: 0n, created_ts: now - 3600, items_list: ['Cup'] },
    ].map((c) => ({
      ...c,
      nfts: c.items_list.map((name, i) => ({ id: `${c.id}-${i + 1}`, name, owner: 'o1acdefghjkmnpqr', image: null })),
    }));
    return { tokens, collections };
  }

  function indexTrades(list) {
    const by = new Map();
    for (const t of list) {
      const row = { ...t, ts: Number(t.ts), price: bi(t.price_micronoid), noid: bi(t.noid_micronoid) || 0n, side: t.side };
      const arr = by.get(t.token_id) || [];
      arr.push(row);
      by.set(t.token_id, arr);
    }
    for (const arr of by.values()) arr.sort((a, b) => a.ts - b.ts);
    return by;
  }

  function priceAt(trades, t) {
    let p = null;
    for (const tr of trades) if (tr.ts <= t && tr.price != null) p = tr.price;
    return p;
  }

  function windowStats(trades, now, sec) {
    const cutoff = now - sec;
    let txns = 0, buys = 0, sells = 0, vol = 0n;
    for (const tr of trades) {
      if (tr.ts < cutoff) continue;
      txns++;
      if (tr.side === 'sell') sells++; else buys++;
      vol += tr.noid;
    }
    const last = [...trades].reverse().find((tr) => tr.price != null)?.price ?? null;
    return { txns, buys, sells, vol, change: pct(last, priceAt(trades, cutoff)) };
  }

  function presentToken(raw, trades, now, usd) {
    const supply = bi(raw.supply) || 0n;
    const reserve = bi(raw.reserve_micronoid) || 0n;
    const last = [...(trades || [])].reverse().find((tr) => tr.price != null)?.price ?? bi(raw.price_micronoid);
    const pool = raw.pool || null;
    const curve = raw.curve || null;
    const poolNoid = pool ? bi(pool.reserve_noid_micronoid) || 0n : 0n;
    const raised = curve ? bi(curve.raised_micronoid) || 0n : 0n;
    const target = curve ? bi(curve.target_micronoid) || 0n : 0n;
    const liquidity = pool ? poolNoid * 2n : raised;
    const progress = !raw.graduated && target > 0n ? Number(raised * 10000n / target) / 100 : null;
    const change = {};
    const stats = {};
    for (const [k, sec] of Object.entries(WINS)) {
      const w = windowStats(trades || [], now, sec);
      change[k] = w.change;
      stats[k] = w;
    }
    const win = stats['24h'];
    const prices = (trades || []).map((t) => t.price).filter((p) => p != null);
    let spark = [];
    if (prices.length >= 2) {
      const step = Math.max(1, Math.ceil(prices.length / 16));
      for (let i = 0; i < prices.length; i += step) spark.push(Number(prices[i]));
      const last = Number(prices[prices.length - 1]);
      if (spark[spark.length - 1] !== last) spark.push(last);
      spark = spark.slice(-16);
    }
    return {
      id: raw.id, name: raw.name, ticker: raw.ticker, logo: typeof raw.logo === 'string' && /^https:\/\//.test(raw.logo) ? raw.logo : null,
      creator: raw.creator || null, graduated: !!raw.graduated, created_ts: raw.created_ts ?? null,
      age_s: raw.created_ts ? Math.max(0, now - Number(raw.created_ts)) : null,
      supply: supply.toString(),
      reserve_micronoid: reserve.toString(),
      backing_per_token_micronoid: supply > 0n ? (reserve / supply).toString() : null,
      price_micronoid: last?.toString() ?? null,
      price_usd: usdOf(last, usd),
      liquidity_micronoid: liquidity.toString(),
      liquidity_usd: usdOf(liquidity, usd),
      mcap_micronoid: last != null ? (last * supply).toString() : null,
      mcap_usd: last != null ? usdOf(last * supply, usd) : null,
      volume_micronoid: win.vol.toString(),
      volume_usd: usdOf(win.vol, usd),
      txns: win.txns, buys: win.buys, sells: win.sells,
      change, spark, stats,
      curve: curve && target > 0n ? { progress, raised_micronoid: raised.toString(), target_micronoid: target.toString() } : null,
      venue: pool ? 'pool' : curve ? 'curve' : null,
      _pool: pool, _curve: curve, _last: last,
    };
  }

  function applyWindow(row, window) {
    const w = row.stats[window] || row.stats['24h'];
    const usd = noidUsd();
    return {
      ...publicToken(row),
      volume_micronoid: w.vol.toString(), volume_usd: usdOf(w.vol, usd),
      txns: w.txns, buys: w.buys, sells: w.sells,
    };
  }
  function publicToken(row) {
    const { stats, _pool, _curve, _last, ...rest } = row;
    return rest;
  }

  function sortRows(rows, key, dir) {
    const mul = dir === 'asc' ? 1 : -1;
    const val = (r) => {
      if (key === 'liquidity') return bi(r.liquidity_micronoid);
      if (key === 'volume') return bi(r.volume_micronoid);
      if (key === 'mcap') return bi(r.mcap_micronoid);
      if (key === 'age') return r.age_s;
      if (key === 'txns') return r.txns;
      if (key === 'buys') return r.buys;
      if (key === 'sells') return r.sells;
      if (key === 'change') return r._change;
      if (key === 'progress') return r.curve?.progress ?? null;
      if (key === 'floor') return bi(r.floor_micronoid);
      if (key === 'items') return r.items;
      if (key === 'owners') return r.owners;
      return null;
    };
    return rows.sort((a, b) => {
      const av = val(a), bv = val(b);
      if (av == null && bv == null) return a.id < b.id ? -1 : 1;
      if (av == null) return 1;
      if (bv == null) return -1;
      const c = av > bv ? 1 : av < bv ? -1 : (a.id < b.id ? -1 : 1);
      return c * mul;
    });
  }

  function realTokens(now) {
    const pools = new Map();
    for (const p of q.pools.all()) {
      const prev = pools.get(p.token_id);
      if (!prev || (bi(p.reserve_noid_micronoid) || 0n) > (bi(prev.reserve_noid_micronoid) || 0n)) pools.set(p.token_id, p);
    }
    const since = now - 86400;
    const by = indexTrades([...q.baseTrades.all(since), ...q.recentTrades.all(since - 120)]);
    return q.tokens.all().map((t) => {
      const curve = t.curve_target_micronoid ? {
        raised_micronoid: t.curve_raised_micronoid, target_micronoid: t.curve_target_micronoid,
        virtual_noid: t.curve_virtual_noid, virtual_token: t.curve_virtual_token,
      } : null;
      return presentToken({ ...t, graduated: !!t.graduated, pool: pools.get(t.id) || null, curve }, by.get(t.id) || [], now, noidUsd());
    });
  }

  function demoTokens(now) {
    const cat = demoCatalog(now);
    return cat.tokens.map((t) => presentToken(t, indexTrades(t.trades).get(t.id) || [], now, noidUsd()));
  }

  function listTokens(params) {
    const demo = isDemo(params);
    const now = Math.floor(Date.now() / 1000);
    const window = Object.hasOwn(WINS, params.get('window') || '') ? params.get('window') : '24h';
    const preset = params.get('preset') || '';
    let sort = params.get('sort') || '';
    let dir = params.get('dir') === 'asc' ? 'asc' : 'desc';
    if (!TOKEN_SORTS.has(sort)) {
      if (preset === 'new') { sort = 'age'; dir = 'asc'; }
      else if (preset === 'gainers') sort = 'change';
      else if (preset === 'graduating') sort = 'progress';
      else sort = 'volume';
    }
    const qtext = (params.get('q') || '').trim().toLowerCase();
    if (qtext.length > 64) throw bad('search is too long');
    const filters = {
      liq: [paramNoid(params, 'min_liq'), paramNoid(params, 'max_liq')],
      vol: [paramNoid(params, 'min_vol'), paramNoid(params, 'max_vol')],
      mcap: [paramNoid(params, 'min_mcap'), paramNoid(params, 'max_mcap')],
      age: [paramHours(params, 'min_age'), paramHours(params, 'max_age')],
      txns: [paramInt(params, 'min_txns'), paramInt(params, 'max_txns')],
      buys: [paramInt(params, 'min_buys'), paramInt(params, 'max_buys')],
      sells: [paramInt(params, 'min_sells'), paramInt(params, 'max_sells')],
    };
    let rows = (demo ? demoTokens(now) : realTokens(now)).map((r) => {
      const view = applyWindow(r, window);
      view._change = r.change[window];
      view.curve = r.curve;
      return view;
    });
    if (preset === 'graduating') rows = rows.filter((r) => !r.graduated && r.curve);
    if (qtext) rows = rows.filter((r) => `${r.name} ${r.ticker} ${r.id}`.toLowerCase().includes(qtext));
    rows = rows.filter((r) => inRange(bi(r.liquidity_micronoid), ...filters.liq)
      && inRange(bi(r.volume_micronoid), ...filters.vol)
      && inRange(bi(r.mcap_micronoid), ...filters.mcap)
      && inRange(r.age_s, ...filters.age)
      && inRange(r.txns, ...filters.txns)
      && inRange(r.buys, ...filters.buys)
      && inRange(r.sells, ...filters.sells));
    sortRows(rows, sort, dir);
    for (const r of rows) delete r._change;
    const page = pageSlice(rows, params);
    return {
      demo, live: !!status.available, window, sort, dir, preset: preset || null,
      notice: demo || rows.length ? null : (status.available ? 'No native tokens yet.' : NOTICE),
      count: rows.length, page: page.page, page_size: page.page_size, pages: page.pages,
      tokens: page.slice,
      swap: swapInfo(demo),
    };
  }

  function swapInfo(demo) {
    const fee = feeConfig();
    return { live: swapLive(), show: !!demo || swapLive(), fee_bps: fee.bps, fee_pct: fee.bps / 100, fee_address: fee.address, signable: !demo && swapLive() };
  }

  function findPresented(id, demo, now) {
    const rows = demo ? demoTokens(now) : realTokens(now);
    return rows.find((r) => r.id === id) || null;
  }

  function tokenDetail(id, params) {
    checkId(id);
    const demo = isDemo(params);
    const now = Math.floor(Date.now() / 1000);
    const row = findPresented(id, demo, now);
    if (!row) return null;
    let trades, holders, chartTrades;
    if (demo) {
      const src = demoCatalog(now).tokens.find((t) => t.id === id);
      chartTrades = indexTrades(src.trades).get(id) || [];
      trades = [...chartTrades].reverse().filter((t) => bi(t.token_amount) > 0n).slice(0, 40).map(publicTrade);
      holders = src.holders.map((h) => ({ ...h, share: row.supply !== '0' ? Number(BigInt(h.balance) * 10000n / BigInt(row.supply)) / 100 : null }));
    } else {
      chartTrades = q.tradesFor.all(id).map((t) => ({ ...t, ts: Number(t.ts), price: bi(t.price_micronoid), noid: bi(t.noid_micronoid) || 0n })).reverse();
      trades = q.tradesFor.all(id).slice(0, 40).map(publicTrade);
      const supply = bi(row.supply) || 0n;
      holders = q.holdersFor.all(id).map((h) => ({ address: h.address, balance: h.balance, share: supply > 0n ? Number(bi(h.balance) * 10000n / supply) / 100 : null }));
    }
    const chart = chartTrades.filter((t) => t.price != null).map((t) => ({ t: t.ts, price_micronoid: t.price.toString(), price_usd: usdOf(t.price, noidUsd()) }));
    const pool = row._pool ? {
      reserve_token: String(row._pool.reserve_token),
      reserve_noid_micronoid: String(bi(row._pool.reserve_noid_micronoid) ?? 0n),
      lp_supply: row._pool.lp_supply == null ? null : String(row._pool.lp_supply),
    } : null;
    return {
      demo, live: demo ? false : !!status.available,
      token: { ...publicToken(row), pool, backing_note: '0.001 NOID of the creation reserve per whole token, when the token was minted at the preview rate.' },
      chart, trades, holders, swap: swapInfo(demo),
    };
  }

  function publicTrade(t) {
    return {
      txid: t.txid, ts: Number(t.ts), side: t.side, token_amount: String(t.token_amount),
      noid_micronoid: String(t.noid_micronoid), price_micronoid: t.price_micronoid == null ? (t.price?.toString() ?? null) : String(t.price_micronoid),
      trader: t.trader || null, venue: t.venue || null, height: t.height ?? null,
    };
  }

  function listCollections(params) {
    const demo = isDemo(params);
    const now = Math.floor(Date.now() / 1000);
    const usd = noidUsd();
    let sort = params.get('sort') || 'volume';
    const dir = params.get('dir') === 'asc' ? 'asc' : 'desc';
    if (!NFT_SORTS.has(sort)) sort = 'volume';
    const qtext = (params.get('q') || '').trim().toLowerCase();
    if (qtext.length > 64) throw bad('search is too long');
    const minV = paramNoid(params, 'min_vol'), maxV = paramNoid(params, 'max_vol');
    const minF = paramNoid(params, 'min_floor'), maxF = paramNoid(params, 'max_floor');
    const minI = paramInt(params, 'min_items'), maxI = paramInt(params, 'max_items');
    const minO = paramInt(params, 'min_owners'), maxO = paramInt(params, 'max_owners');
    const minA = paramHours(params, 'min_age'), maxA = paramHours(params, 'max_age');
    const src = demo ? demoCatalog(now).collections : q.cols.all();
    let rows = src.map((c) => {
      const floor = bi(c.floor_micronoid);
      const vol = bi(c.volume_micronoid) || 0n;
      const created = c.created_ts == null ? null : Number(c.created_ts);
      return {
        id: c.id, name: c.name, creator: c.creator || null, items: Number(c.items) || 0, owners: Number(c.owners) || 0,
        floor_micronoid: floor?.toString() ?? null, floor_usd: usdOf(floor, usd),
        volume_micronoid: vol.toString(), volume_usd: usdOf(vol, usd),
        created_ts: created, age_s: created ? Math.max(0, now - created) : null,
      };
    });
    if (qtext) rows = rows.filter((r) => `${r.name} ${r.id}`.toLowerCase().includes(qtext));
    rows = rows.filter((r) => inRange(bi(r.volume_micronoid), minV, maxV) && inRange(bi(r.floor_micronoid), minF, maxF)
      && inRange(r.items, minI, maxI) && inRange(r.owners, minO, maxO) && inRange(r.age_s, minA, maxA));
    sortRows(rows, sort, dir);
    const page = pageSlice(rows, params);
    return {
      demo, live: !!status.available, sort, dir,
      notice: demo || rows.length ? null : (status.available ? 'No collections yet.' : NOTICE),
      count: rows.length, page: page.page, page_size: page.page_size, pages: page.pages,
      collections: page.slice,
    };
  }

  function pageSlice(rows, params) {
    const pageSize = 25;
    const page = Math.min(Math.max(paramInt(params, 'page') || 1, 1), 1000);
    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    const start = (page - 1) * pageSize;
    return { page, page_size: pageSize, pages, slice: rows.slice(start, start + pageSize) };
  }

  function collectionDetail(id, params) {
    checkId(id);
    const demo = isDemo(params);
    const now = Math.floor(Date.now() / 1000);
    const src = demo ? demoCatalog(now).collections.find((c) => c.id === id) : q.col.get(id);
    if (!src) return null;
    const usd = noidUsd();
    const floor = bi(src.floor_micronoid);
    const vol = bi(src.volume_micronoid) || 0n;
    const items = demo ? src.nfts : q.items.all(id);
    return {
      demo, live: demo ? false : !!status.available,
      collection: {
        id: src.id, name: src.name, creator: src.creator || null,
        items: Number(src.items) || items.length, owners: Number(src.owners) || 0,
        floor_micronoid: floor?.toString() ?? null, floor_usd: usdOf(floor, usd),
        volume_micronoid: vol.toString(), volume_usd: usdOf(vol, usd),
        created_ts: src.created_ts ?? null, age_s: src.created_ts ? Math.max(0, now - Number(src.created_ts)) : null,
      },
      items: items.map((n) => ({ id: n.id, name: n.name || null, owner: n.owner || null, image: typeof n.image === 'string' && /^https:\/\//.test(n.image) ? n.image : null })),
    };
  }

  function slippageBps(params) {
    const s = params.get('slippage');
    if (s == null || s === '') return 100;
    if (!/^\d+(\.\d{1,2})?$/.test(s)) throw bad('bad slippage');
    const bps = Math.round(Number(s) * 100);
    if (bps < 0 || bps > 5000) throw bad('slippage must be between 0 and 50 percent');
    return bps;
  }
  function amountOf(params) {
    const s = params.get('amount');
    if (s == null || !/^\d+(\.\d{1,6})?$/.test(s) || Number(s) <= 0) throw bad('amount must be a positive number');
    const [w, f = ''] = s.split('.');
    return BigInt(w) * U + BigInt((f + '000000').slice(0, 6));
  }

  function reservesOf(row) {
    if (row.graduated && row._pool) {
      const R = bi(row._pool.reserve_noid_micronoid) || 0n;
      const T = bi(row._pool.reserve_token) || 0n;
      if (R > 0n && T > 0n) return { R, T, venue: 'pool' };
    }
    const c = row._curve;
    if (c) {
      const R = bi(c.virtual_noid) || 0n;
      const T = bi(c.virtual_token) || 0n;
      if (R > 0n && T > 0n) return { R, T, venue: 'curve' };
    }
    return null;
  }

  // Preview constant-product quote. Live mode prefers paranoid_quoteSwap and does not use this.
  // Buy: fee is withheld from the NOID in, then the rest hits the curve or pool.
  // Sell: fee is withheld from the NOID out. Both are itemized; fee_in_tx stays false until the node says otherwise.
  function previewQuote(row, side, amount, slip, feeBps) {
    const book = reservesOf(row);
    const fee = feeConfig();
    const base = {
      enabled: true, demo: true, signable: false, fee_in_tx: false, formula: 'preview', unsigned: null,
      side, slippage_bps: slip, slippage_pct: slip / 100,
      fee: { bps: feeBps, pct: feeBps / 100, micronoid: '0', address: fee.address, in_tx: false },
      token_id: row.id, ticker: row.ticker, venue: book?.venue ?? row.venue,
    };
    if (!book) return { ...base, quotable: false, note: 'No pool or curve reserves to quote yet.' };
    const { R, T, venue } = book;
    const bps = BigInt(feeBps);
    const slipKeep = BigInt(10000 - slip);
    if (side === 'buy') {
      const gross = amount;
      const feeMicro = gross * bps / 10000n;
      const into = gross - feeMicro;
      const out = into * T / (R + into);
      if (out <= 0n) return { ...base, quotable: false, note: 'Amount is too small to quote.' };
      const min = out * slipKeep / 10000n;
      const impact = Number(into * 10000n / R) / 100;
      return {
        ...base, quotable: true, venue,
        price_impact_pct: impact,
        spot_price_micronoid: (R / T).toString(),
        exec_price_micronoid: (into / out).toString(),
        fee: { ...base.fee, micronoid: feeMicro.toString() },
        in: { noid_micronoid: gross.toString(), token: null },
        to_venue_micronoid: into.toString(),
        expected_out: { token: out.toString(), noid_micronoid: null },
        min_out: { token: min.toString(), noid_micronoid: null },
        draft: draft(row, side, venue, { noid_micronoid: gross.toString() }, { token: min.toString() }, fee, feeMicro, false),
        note: 'Preview quote from reserves. The fee is itemized only — demo mode cannot submit a transaction, and the v2.1 builder is what adds the fee as its own output.',
      };
    }
    const tokenIn = amount / U;
    if (tokenIn <= 0n) return { ...base, quotable: false, note: 'Sell whole tokens (the amount is in tokens).' };
    const noidOut = tokenIn * R / (T + tokenIn);
    const feeMicro = noidOut * bps / 10000n;
    const user = noidOut - feeMicro;
    const min = user * slipKeep / 10000n;
    const impact = Number(tokenIn * 10000n / (T + tokenIn)) / 100;
    return {
      ...base, quotable: true, venue,
      price_impact_pct: impact,
      spot_price_micronoid: (R / T).toString(),
      exec_price_micronoid: tokenIn > 0n ? (noidOut / tokenIn).toString() : null,
      fee: { ...base.fee, micronoid: feeMicro.toString() },
      in: { noid_micronoid: null, token: tokenIn.toString() },
      to_venue_micronoid: null,
      expected_out: { token: null, noid_micronoid: user.toString() },
      min_out: { token: null, noid_micronoid: min.toString() },
      draft: draft(row, side, venue, { token: tokenIn.toString() }, { noid_micronoid: min.toString() }, fee, feeMicro, false),
      note: 'Preview quote from reserves. The fee is itemized only — demo mode cannot submit a transaction.',
    };
  }

  function draft(row, side, venue, amountIn, minOut, fee, feeMicro, inTx) {
    return {
      version: 1,
      note: 'Logical swap for the wallet to encode. This server does not sign or broadcast it.',
      swap: { token_id: row.id, side, venue, amount_in: amountIn, min_out: minOut },
      fee_output: feeMicro > 0n ? { address: fee.address, micronoid: feeMicro.toString(), included: !!inTx } : null,
    };
  }

  async function quote(params) {
    const demo = isDemo(params);
    const fee = feeConfig();
    if (!demo && !swapLive()) {
      return { enabled: false, demo: false, signable: false, fee_bps: fee.bps, fee_pct: fee.bps / 100, reason: 'Swap is hidden until SWAP_ENABLED=true, SWAP_FEE_ADDRESS is set, and the node exposes quoteSwap and buildSwap.' };
    }
    const id = params.get('token') || '';
    checkId(id);
    const side = params.get('side') === 'sell' ? 'sell' : params.get('side') === 'buy' ? 'buy' : null;
    if (!side) throw bad('side must be buy or sell');
    const amount = amountOf(params);
    const slip = slippageBps(params);
    const now = Math.floor(Date.now() / 1000);
    const row = findPresented(id, demo, now);
    if (!row) return null;
    if (demo || !status.quote) return previewQuote(row, side, amount, slip, fee.bps);
    const body = {
      token_id: id, side, slippage_bps: slip, fee_bps: fee.bps, fee_address: fee.address,
      ...(side === 'buy' ? { amount_micronoid: amount.toString() } : { token_amount: (amount / U).toString() }),
    };
    const out = await rpc('quoteSwap', [body]);
    const impact = Number(out?.price_impact_pct);
    const feeMicro = bi(out?.fee_micronoid) ?? (side === 'buy' ? amount * BigInt(fee.bps) / 10000n : 0n);
    const inTx = out?.fee_in_tx === true;
    return {
      enabled: true, demo: false, signable: status.build, quotable: true, formula: 'node', fee_in_tx: inTx, unsigned: null,
      side, venue: out?.venue || row.venue, slippage_bps: slip, slippage_pct: slip / 100,
      price_impact_pct: Number.isFinite(impact) ? impact : null,
      spot_price_micronoid: out?.spot_price_micronoid == null ? null : String(out.spot_price_micronoid),
      exec_price_micronoid: out?.exec_price_micronoid == null ? null : String(out.exec_price_micronoid),
      fee: { bps: fee.bps, pct: fee.bps / 100, micronoid: feeMicro.toString(), address: fee.address, in_tx: inTx },
      in: side === 'buy' ? { noid_micronoid: amount.toString(), token: null } : { noid_micronoid: null, token: (amount / U).toString() },
      to_venue_micronoid: out?.to_venue_micronoid == null ? null : String(out.to_venue_micronoid),
      expected_out: {
        token: out?.expected_out_token == null ? null : String(out.expected_out_token),
        noid_micronoid: out?.expected_out_micronoid == null ? null : String(out.expected_out_micronoid),
      },
      min_out: {
        token: out?.min_out_token == null ? null : String(out.min_out_token),
        noid_micronoid: out?.min_out_micronoid == null ? null : String(out.min_out_micronoid),
      },
      draft: draft(row, side, out?.venue || row.venue, body, { token: out?.min_out_token ?? null, noid_micronoid: out?.min_out_micronoid ?? null }, fee, feeMicro, inTx),
      note: inTx
        ? 'The fee is a separate output in the transaction your wallet will sign.'
        : 'The node did not put the fee in the transaction. The amount above is the disclosed fee only.',
    };
  }

  async function build(params) {
    if (isDemo(params)) throw bad('demo mode cannot sign or submit a swap');
    if (!swapLive()) throw Object.assign(new Error('swap is not enabled'), { status: 403 });
    const sender = params.get('sender') || '';
    if (!ADDR.test(sender)) throw bad('expected an o1… sender address');
    const quoted = await quote(params);
    if (!quoted) return null;
    const fee = feeConfig();
    const out = await rpc('buildSwap', [{
      token_id: params.get('token'), side: quoted.side, sender,
      slippage_bps: quoted.slippage_bps, fee_bps: fee.bps, fee_address: fee.address,
      amount_micronoid: quoted.in.noid_micronoid, token_amount: quoted.in.token,
    }]);
    if (!out || out.signature || out.signed || out.signed_tx) throw Object.assign(new Error('refusing a signed payload'), { status: 502 });
    return { signable: true, demo: false, unsigned: out.unsigned ?? null, fee_in_tx: out.fee_in_tx === true, draft: quoted.draft };
  }

  async function swap(id, params) {
    if (id === 'quote') return quote(params);
    if (id === 'build') return build(params);
    return null;
  }

  function ingest(snap) {
    if (!snap || typeof snap !== 'object') return false;
    const tokens = Array.isArray(snap.tokens) ? snap.tokens : [];
    const pools = Array.isArray(snap.pools) ? snap.pools : [];
    const trades = Array.isArray(snap.trades) ? snap.trades : [];
    const cols = Array.isArray(snap.collections) ? snap.collections : [];
    db.exec('begin');
    try {
      for (const t of tokens) {
        if (!ID.test(String(t.id || '')) || !t.name || !t.ticker || !strInt(t.supply)) continue;
        q.upToken.run(String(t.id), String(t.name).slice(0, 80), String(t.ticker).slice(0, 16), t.creator ? String(t.creator) : null,
          strInt(t.supply), strInt(t.reserve_micronoid) || '0', Number.isInteger(t.created_height) ? t.created_height : null,
          Number.isInteger(t.created_ts) ? t.created_ts : null, typeof t.logo === 'string' ? t.logo.slice(0, 300) : null,
          t.graduated ? 1 : 0, strInt(t.price_micronoid), strInt(t.curve_target_micronoid), strInt(t.curve_raised_micronoid),
          strInt(t.curve_virtual_noid_micronoid), strInt(t.curve_virtual_token), Number.isInteger(t.updated_height) ? t.updated_height : null);
        if (Array.isArray(t.holders)) {
          q.delHolders.run(String(t.id));
          for (const h of t.holders.slice(0, 50)) if (ADDR.test(h.address || '') && strInt(h.balance)) q.upHolder.run(String(t.id), h.address, strInt(h.balance));
        }
      }
      for (const p of pools) {
        if (!ID.test(String(p.id || '')) || !ID.test(String(p.token_id || '')) || !strInt(p.reserve_token) || !strInt(p.reserve_noid_micronoid)) continue;
        q.upPool.run(String(p.id), String(p.token_id), strInt(p.reserve_token), strInt(p.reserve_noid_micronoid), strInt(p.lp_supply), Number.isInteger(p.updated_height) ? p.updated_height : null);
      }
      for (const t of trades) {
        const txid = String(t.txid || '');
        if (!/^[A-Za-z0-9:_-]{8,80}$/.test(txid) || !ID.test(String(t.token_id || ''))) continue;
        const side = t.side === 'sell' ? 'sell' : t.side === 'buy' ? 'buy' : null;
        if (!side || !strInt(t.token_amount) || !strInt(t.noid_micronoid) || !Number.isInteger(t.ts)) continue;
        q.upTrade.run(txid, String(t.token_id), t.ts, Number.isInteger(t.height) ? t.height : null, side, strInt(t.token_amount), strInt(t.noid_micronoid),
          ADDR.test(t.trader || '') ? t.trader : null, t.venue === 'pool' || t.venue === 'curve' ? t.venue : null, strInt(t.price_micronoid));
      }
      for (const c of cols) {
        if (!ID.test(String(c.id || '')) || !c.name) continue;
        q.upCol.run(String(c.id), String(c.name).slice(0, 80), c.creator ? String(c.creator) : null, Number(c.items) || 0, Number(c.owners) || 0,
          strInt(c.floor_micronoid), strInt(c.volume_micronoid) || '0', Number.isInteger(c.created_ts) ? c.created_ts : null, Number.isInteger(c.updated_height) ? c.updated_height : null);
        if (Array.isArray(c.nfts)) {
          q.delItems.run(String(c.id));
          for (const n of c.nfts.slice(0, 200)) if (ID.test(String(n.id || ''))) q.upItem.run(String(n.id), String(c.id), n.name ? String(n.name).slice(0, 80) : null, ADDR.test(n.owner || '') ? n.owner : null, typeof n.image === 'string' ? n.image.slice(0, 300) : null);
        }
      }
      db.exec('commit');
      return true;
    } catch (e) { db.exec('rollback'); throw e; }
  }

  const missingMethod = (e) => /method not found|not supported|unknown method|-32601/i.test(e.message || '');

  async function probeDex() {
    if (Date.now() < status.dexProbeAt) return;
    status.dexProbeAt = Date.now() + probeWait();
    const gone = async (method) => {
      try { await rpc(method, [{}], 2_000); return false; }
      catch (e) { return missingMethod(e); }
    };
    status.quote = !(await gone('quoteSwap'));
    status.build = !(await gone('buildSwap'));
  }

  async function sync() {
    if (!status.available && Date.now() < status.retryAt && probeWait() > 0) return false;
    try {
      const snap = await rpc('getAssetSnapshot', [], status.available ? 20_000 : 2_000);
      const wrote = ingest(snap || {});
      if (!status.available) console.log('assets: node snapshot online');
      status.available = true;
      status.error = null;
      status.retryAt = 0;
      await probeDex();
      return wrote;
    } catch (e) {
      const missing = missingMethod(e);
      if (status.available || !missing) console.error('assets:', e.message);
      status.available = false;
      status.quote = false;
      status.build = false;
      status.error = e.message;
      status.retryAt = Date.now() + (missing ? probeWait() : 30_000);
      return false;
    }
  }

  return {
    sync, status,
    tokens: (_id, params) => listTokens(params),
    token: (id, params) => tokenDetail(id, params),
    collections: (_id, params) => listCollections(params),
    collection: (id, params) => collectionDetail(id, params),
    swap,
  };
};
