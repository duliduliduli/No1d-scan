// Tokens, pools, trades and NFT collections for Explore.
// Parano1d v2.1 has not published this RPC yet. sync() asks the node and writes nothing
// until those methods exist. Sample rows live only in memory behind ?demo=1 or TOKENS_DEMO=1.
//
// Expected node methods (all prefixed paranoid_ by the RPC client):
//   getAssetSnapshot() -> { tokens, trades, pools, collections }
//     tokens[]: id, name, ticker, creator, supply, reserve_micronoid, created_ts, created_height,
//       logo, graduated, launch (launchpad|direct), links {website, twitter, telegram},
//       circulating (whole tokens; FDV uses supply until this is set),
//       price_micronoid, curve_target_micronoid, curve_raised_micronoid,
//       curve_virtual_noid_micronoid, curve_virtual_token, holders[{address, balance}]
//     pools[]: id, token_id, reserve_token, reserve_noid_micronoid, lp_supply
//     trades[]: txid, token_id, ts, height, side (buy|sell), token_amount, noid_micronoid,
//       trader, venue (curve|pool), price_micronoid
//     transfers[]: txid, token_id, ts, height, from, to, amount
//   Trades are stored on (token_id, ts) and folded into 1-minute OHLCV in token_candles.
//   Charts sum those minutes. 1w buckets start Monday 00:00 UTC. ?before=&limit= pages them.
//     collections[]: id, name, creator, items, owners, floor_micronoid, volume_micronoid,
//       created_ts, nfts[{id, name, owner, image, traits[{trait, value}]}],
//       sales[{txid, item_id, ts, height, price_micronoid, seller, buyer}],
//       transfers[{txid, item_id, ts, height, from, to}],
//       listings[{item_id, price_micronoid, seller}]
//   Sale prices fold into 1-minute OHLCV (kind sale). The current floor is one flat minute
//   (kind floor) until the node sends a floor series. Both use sales μNOID as volume.
//   quoteSwap({token_id, side, amount_micronoid|token_amount, slippage_bps, fee_bps, fee_address})
//     -> { expected_out_token|expected_out_micronoid, min_out_token|min_out_micronoid,
//          price_impact_pct, spot_price_micronoid, exec_price_micronoid, fee_in_tx, venue }
//   buildSwap({...quote fields, sender}) -> { unsigned, fee_in_tx }
//     unsigned is the bytes the wallet signs. A payload that already carries a signature is refused.
//   getOpenOrders({token_id}) -> { bids: [{ price_micronoid, token_amount }], asks: [...] }
//     When this method is missing, the book is derived from pool or curve reserves and labeled as such.
//   getNftOrders({collection_id}) -> { listings: [{ price_micronoid, item_id, size }], bids: [...] }
//     When this method is missing, the book groups listings by price and is labeled floor depth.
//
// Parano1d v2.1.0 (shipped) does not have the methods above. It exposes, with object params:
//   getNativeCatalog({kind: markets|collections|nft_listings, limit: 1..64, cursor?}) -> { height, items[], next }
//     next is a NativeCatalogCursor; pass it back as cursor for the following page.
//   getNativeHoldings({owner, limit, cursor?}) -> { holdings[], next }
//   prepareNativeIntent({owner, request: {action, ...}}) -> unsigned intent + NativeWalletPreview
//     (quoted_output, minimum_output, network_fee, market_fee, ...). trade takes
//     {asset_id, buy, gross_input, minimum_output, slippage_bps (u16), valid_until (u16)}.
//   submitTxIntent({hex}) submits a client-signed intent. This server never calls it.
// Before activation (block 279,370) catalogues are empty and prepareNativeIntent answers
// "native operations are not active at the candidate height".
// When getAssetSnapshot is missing, sync() falls back to the native catalogue, quotes use the
// local curve/pool formula and build uses prepareNativeIntent (the fee cannot be put in the tx).
//
// The fee is a separate output to SWAP_FEE_ADDRESS when buildSwap reports fee_in_tx.
// Until the node can do that, the quote only itemizes the fee. This process never signs.
const ADDR = /^o1[02-9ac-hj-np-z]{6,120}$/;
const ID = /^[A-Za-z0-9:_-]{1,80}$/;
const NOTICE = 'Tokens coming with v2.1';
const WINS = { '5m': 300, '1h': 3600, '6h': 21600, '24h': 86400 };
const TFS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800 };
const WEEK_OFF = 345600; // 1970-01-05, so a week starts Monday 00:00 UTC
const CANDLE_MAX = 1000;
const U = 1_000_000n;
const TOKEN_SORTS = new Set(['liquidity', 'volume', 'age', 'mcap', 'fdv', 'txns', 'makers', 'buys', 'sells', 'change', 'progress']);
const LOW_LIQ = 10_000n * U;
const NFT_SORTS = new Set(['volume', 'floor', 'items', 'owners', 'age']);

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
    create index if not exists token_trades_trader on token_trades(trader, ts);
    create table if not exists token_holders (
      token_id text not null, address text not null, balance text not null, primary key (token_id, address));
    create index if not exists token_holders_addr on token_holders(address);
    create table if not exists nft_collections (
      id text primary key, name text not null, creator text, items integer not null default 0,
      owners integer not null default 0, floor_micronoid text, volume_micronoid text not null default '0',
      created_ts integer, updated_height integer);
    create table if not exists nft_items (
      id text primary key, collection_id text not null, name text, owner text, image text, traits text);
    create index if not exists nft_items_col on nft_items(collection_id);
    create table if not exists nft_sales (
      txid text primary key, collection_id text not null, item_id text, ts integer not null, height integer,
      price_micronoid text not null, seller text, buyer text);
    create index if not exists nft_sales_col_ts on nft_sales(collection_id, ts);
    create table if not exists nft_transfers (
      txid text not null, collection_id text not null, item_id text not null default '', ts integer not null, height integer,
      from_addr text not null default '', to_addr text not null default '',
      primary key (txid, collection_id, item_id, from_addr, to_addr));
    create index if not exists nft_transfers_col_ts on nft_transfers(collection_id, ts);
    create table if not exists nft_listings (
      collection_id text not null, item_id text not null, price_micronoid text not null, seller text,
      primary key (collection_id, item_id));
    create table if not exists nft_candles (
      collection_id text not null, kind text not null, bucket integer not null,
      o integer not null, h integer not null, l integer not null, c integer not null,
      v integer not null, n integer not null, height integer,
      primary key (collection_id, kind, bucket));
    create table if not exists token_transfers (
      txid text not null, token_id text not null, ts integer not null, height integer,
      from_addr text not null default '', to_addr text not null default '', amount text not null,
      primary key (txid, token_id, from_addr, to_addr));
    create index if not exists token_transfers_tok_ts on token_transfers(token_id, ts);
    create table if not exists token_candles (
      token_id text not null, bucket integer not null,
      o integer not null, h integer not null, l integer not null, c integer not null,
      v integer not null, n integer not null, height integer,
      primary key (token_id, bucket));
  `);
  for (const sql of ['alter table tokens add column launch text', 'alter table tokens add column links text', 'alter table nft_items add column traits text']) {
    try { db.exec(sql); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  }

  const q = {
    tokens: db.prepare('select * from tokens'),
    pools: db.prepare('select * from pools'),
    // (token_id, ts) index range. No GROUP BY: that spills a temp b-tree, and temp_store=memory has nowhere to put the file.
    tradeBefore: db.prepare('select * from token_trades where token_id = ? and ts < ? order by ts desc limit 1'),
    tradesSince: db.prepare('select * from token_trades where token_id = ? and ts >= ? order by ts'),
    tradesIn: db.prepare('select price_micronoid, noid_micronoid, height from token_trades where token_id = ? and ts >= ? and ts < ? and price_micronoid is not null order by ts'),
    token: db.prepare('select * from tokens where id = ?'),
    poolsFor: db.prepare('select * from pools where token_id = ?'),
    tradesFor: db.prepare('select * from token_trades where token_id = ? order by ts desc limit 400'),
    // (trader, ts) covers the wallet scan. Sort stays in the index order.
    tradesByTrader: db.prepare('select * from token_trades where trader = ? order by ts desc limit 400'),
    // Sort in JS. ORDER BY cast(balance) cannot use (token_id, address) and asks SQLite for a temp b-tree.
    holdersFor: db.prepare('select address, balance from token_holders where token_id = ?'),
    holdersByAddr: db.prepare('select token_id, balance from token_holders where address = ?'),
    holderCount: db.prepare('select count(*) n from token_holders where token_id = ?'),
    candlesBefore: db.prepare('select bucket t, o, h, l, c, v, n from token_candles where token_id = ? and bucket < ? order by bucket desc limit cast(? as integer)'),
    candleOlder: db.prepare('select 1 x from token_candles where token_id = ? and bucket < ? limit 1'),
    transfersFor: db.prepare('select txid, ts, height, from_addr, to_addr, amount from token_transfers where token_id = ? order by ts desc limit 40'),
    cols: db.prepare('select * from nft_collections'),
    col: db.prepare('select * from nft_collections where id = ?'),
    items: db.prepare('select id, name, owner, image, traits from nft_items where collection_id = ? order by id limit 60'),
    salesFor: db.prepare('select txid, item_id, ts, height, price_micronoid, seller, buyer from nft_sales where collection_id = ? order by ts desc limit 200'),
    nftXfers: db.prepare('select txid, item_id, ts, height, from_addr, to_addr from nft_transfers where collection_id = ? order by ts desc limit 200'),
    listingsFor: db.prepare('select item_id, price_micronoid, seller from nft_listings where collection_id = ?'),
    salesCount: db.prepare('select count(*) n from nft_sales where collection_id = ?'),
    nftSalesIn: db.prepare('select price_micronoid, height from nft_sales where collection_id = ? and ts >= ? and ts < ? and price_micronoid is not null order by ts'),
    nftCandlesBefore: db.prepare('select bucket t, o, h, l, c, v, n from nft_candles where collection_id = ? and kind = ? and bucket < ? order by bucket desc limit cast(? as integer)'),
    nftCandleOlder: db.prepare('select 1 x from nft_candles where collection_id = ? and kind = ? and bucket < ? limit 1'),
    upToken: db.prepare(`insert or replace into tokens (id, name, ticker, creator, supply, reserve_micronoid, created_height, created_ts, logo, graduated, price_micronoid, curve_target_micronoid, curve_raised_micronoid, curve_virtual_noid, curve_virtual_token, updated_height, launch, links)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    upPool: db.prepare('insert or replace into pools (id, token_id, reserve_token, reserve_noid_micronoid, lp_supply, updated_height) values (?, ?, ?, ?, ?, ?)'),
    upTrade: db.prepare('insert or ignore into token_trades (txid, token_id, ts, height, side, token_amount, noid_micronoid, trader, venue, price_micronoid) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    upCandle: db.prepare('insert or replace into token_candles (token_id, bucket, o, h, l, c, v, n, height) values (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    upTransfer: db.prepare('insert or ignore into token_transfers (txid, token_id, ts, height, from_addr, to_addr, amount) values (?, ?, ?, ?, ?, ?, ?)'),
    delHolders: db.prepare('delete from token_holders where token_id = ?'),
    upHolder: db.prepare('insert or replace into token_holders (token_id, address, balance) values (?, ?, ?)'),
    upCol: db.prepare('insert or replace into nft_collections (id, name, creator, items, owners, floor_micronoid, volume_micronoid, created_ts, updated_height) values (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    delItems: db.prepare('delete from nft_items where collection_id = ?'),
    upItem: db.prepare('insert or replace into nft_items (id, collection_id, name, owner, image, traits) values (?, ?, ?, ?, ?, ?)'),
    upSale: db.prepare('insert or ignore into nft_sales (txid, collection_id, item_id, ts, height, price_micronoid, seller, buyer) values (?, ?, ?, ?, ?, ?, ?, ?)'),
    upNftXfer: db.prepare('insert or ignore into nft_transfers (txid, collection_id, item_id, ts, height, from_addr, to_addr) values (?, ?, ?, ?, ?, ?, ?)'),
    delListings: db.prepare('delete from nft_listings where collection_id = ?'),
    upListing: db.prepare('insert or replace into nft_listings (collection_id, item_id, price_micronoid, seller) values (?, ?, ?, ?)'),
    upNftCandle: db.prepare('insert or replace into nft_candles (collection_id, kind, bucket, o, h, l, c, v, n, height) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  };

  // available: getAssetSnapshot has answered. quote/build: swap RPC is present (not merely "method not found").
  const status = { native: false, available: false, quote: false, build: false, orders: false, nftOrders: false, error: null, retryAt: 0, dexProbeAt: 0 };

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
    if (p?.usd > 0) return p.usd;
    const pin = Number(process.env.USD_PER_NOID);
    return pin > 0 ? pin : null;
  };
  const usdOf = (micro, usd) => {
    if (micro == null || usd == null) return null;
    const n = Number(micro) / 1e6 * usd;
    return Number.isFinite(n) ? n : null;
  };
  const pct = (now, then) => (then == null || then <= 0n || now == null) ? null : Number((now - then) * 10000n / then) / 100;
  function linksOf(raw) {
    let src = raw;
    if (typeof raw === 'string') { try { src = JSON.parse(raw); } catch { return null; } }
    if (!src || typeof src !== 'object') return null;
    const website = typeof src.website === 'string' && /^https:\/\/\S+$/.test(src.website) ? src.website : null;
    const handle = (v) => (typeof v === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(v) ? v : null);
    const links = { website, twitter: handle(src.twitter), telegram: handle(src.telegram) };
    return links.website || links.twitter || links.telegram ? links : null;
  }
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
  const swapLive = () => feeConfig().ok && ((status.quote && status.build) || status.native);

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
      { id: 'gcat', name: 'Ghost Cat', ticker: 'GCAT', supply: 100_000_000n, price: 2000n, p24: 1786n, age_h: 1920, vol: 12_000n * U, buys: 24, sells: 10, graduated: true, launch: 'launchpad', poolNoid: 25_000n * U, poolToken: 12_500_000n, links: { website: 'https://example.com/gcat', twitter: 'ghostcat', telegram: 'ghostcat' } },
      { id: 'nbus', name: 'Night Bus', ticker: 'NBUS', supply: 20_000_000n, price: 5000n, p24: 3704n, age_h: 30, vol: 8_000n * U, buys: 18, sells: 6, launch: 'launchpad', raised: 17_200n * U, vToken: 4_000_000n },
      { id: 'qsun', name: 'Quiet Sun', ticker: 'QSUN', supply: 50_000_000n, price: 100n, p24: 95n, age_h: 2, vol: 50n * U, buys: 3, sells: 1, launch: 'launchpad', raised: 400n * U, vToken: 10_000_000n },
      { id: 'crown', name: 'Paper Crown', ticker: 'CROWN', supply: 10_000_000n, price: 8000n, p24: 9412n, age_h: 100, vol: 3_000n * U, buys: 8, sells: 14, graduated: true, launch: 'direct', poolNoid: 4_000n * U, poolToken: 500_000n },
      { id: 'orbit', name: 'Low Orbit', ticker: 'ORBIT', supply: 8_000_000n, price: 3000n, p24: 1667n, age_h: 12, vol: 1_500n * U, buys: 14, sells: 3, launch: 'launchpad', raised: 14_000n * U, vToken: 5_000_000n },
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
      const makers = ['o1acdefghjkmnpqr', 'o1qqqqqqqqqqqq', 'o1payqqqqqqqq'];
      let ntr = 0;
      const push = (ts, price, noid, side) => trades.push({
        txid: `${s.id}-${ts}-${side}`, token_id: s.id, ts, height: 236000 + s.age_h, side,
        token_amount: price > 0n ? ((noid / price) || 1n).toString() : '1',
        noid_micronoid: noid.toString(), price_micronoid: price.toString(), trader: makers[ntr++ % makers.length], venue: s.graduated ? 'pool' : 'curve',
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
        address: i === 0 ? 'o1acdefghjkmnpqr' : `o1${'qrp'[i].repeat(14)}`,
        balance: (s.supply * pctShare / 100n).toString(),
      }));
      return {
        id: s.id, name: s.name, ticker: s.ticker, creator: 'o1acdefghjkmnpqr', supply: s.supply, reserve_micronoid: s.supply * 1000n,
        created_ts, created_height: 236500 - s.age_h, logo: null, graduated: !!s.graduated, launch: s.launch, links: s.links || null,
        price_micronoid: s.price, curve, pool, trades, holders,
      };
    });
    const wallets = ['o1acdefghjkmnpqr', 'o1qqqqqqqqqqqq', 'o1payqqqqqqqq'];
    const collections = [
      { id: 'stamps', name: 'Night Stamps', creator: null, items: 100, owners: 40, floor_micronoid: 12n * U, volume_micronoid: 5_000n * U, created_ts: now - 20 * 86400, items_list: ['Ash', 'Mint', 'Quiet', 'North'] },
      { id: 'faces', name: 'Paper Faces', creator: null, items: 24, owners: 10, floor_micronoid: 2n * U, volume_micronoid: 800n * U, created_ts: now - 3 * 86400, items_list: ['Fold', 'Crease'] },
      { id: 'glass', name: 'Empty Glass', creator: null, items: 8, owners: 1, floor_micronoid: null, volume_micronoid: 0n, created_ts: now - 3600, items_list: ['Cup'] },
    ].map((c) => {
      const nfts = c.items_list.map((name, i) => ({
        id: `${c.id}-${i + 1}`, name, owner: wallets[i % 2], image: null,
        traits: c.floor_micronoid == null ? [] : [
          { trait: 'Backdrop', value: ['Ash', 'Mint', 'Ink', 'Glass'][i % 4] },
          { trait: 'Ink', value: name },
        ],
      }));
      const sales = [];
      const transfers = [];
      const listings = [];
      if (c.floor_micronoid) {
        const floor = c.floor_micronoid;
        [floor, floor, floor + floor / 4n, floor * 2n, 600n * U, 6000n * U].forEach((price, i) => {
          const item = nfts[i % nfts.length];
          sales.push({
            txid: `${c.id}-sale-${i}`, item_id: item.id, ts: now - 180 * (i + 1), height: null,
            price_micronoid: price, seller: wallets[(i + 1) % 3], buyer: wallets[i % 3],
          });
        });
        transfers.push({ txid: `${c.id}-xfer-0`, item_id: nfts[0].id, ts: now - 90, height: null, from: wallets[1], to: wallets[0] });
        listings.push(
          { item_id: nfts[0].id, price_micronoid: floor, seller: nfts[0].owner },
          { item_id: nfts[1].id, price_micronoid: floor, seller: nfts[1].owner },
        );
        if (nfts[2]) listings.push({ item_id: nfts[2].id, price_micronoid: floor + floor / 4n, seller: nfts[2].owner });
      }
      return { ...c, nfts, sales, transfers, listings };
    });
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
    let txns = 0, buys = 0, sells = 0, vol = 0n, buyVol = 0n, sellVol = 0n;
    const makers = new Set(), buyers = new Set(), sellers = new Set();
    for (const tr of trades) {
      if (tr.ts < cutoff) continue;
      txns++;
      const amt = tr.noid || 0n;
      if (tr.side === 'sell') { sells++; sellVol += amt; if (tr.trader) sellers.add(tr.trader); }
      else { buys++; buyVol += amt; if (tr.trader) buyers.add(tr.trader); }
      vol += amt;
      if (tr.trader) makers.add(tr.trader);
    }
    const last = [...trades].reverse().find((tr) => tr.price != null)?.price ?? null;
    return {
      txns, buys, sells, vol, buy_vol: buyVol, sell_vol: sellVol,
      buyers: buyers.size, sellers: sellers.size, makers: makers.size,
      change: pct(last, priceAt(trades, cutoff)),
    };
  }

  function presentToken(raw, trades, now, usd) {
    const supply = bi(raw.supply) || 0n;
    const circulating = bi(raw.circulating) ?? supply;
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
      creator: raw.creator || null, graduated: !!raw.graduated,
      launch: raw.launch === 'direct' || raw.launch === 'launchpad' ? raw.launch : (curve ? 'launchpad' : null),
      links: linksOf(raw.links),
      created_ts: raw.created_ts ?? null, created_height: Number.isInteger(raw.created_height) ? raw.created_height : null,
      age_s: raw.created_ts ? Math.max(0, now - Number(raw.created_ts)) : null,
      supply: supply.toString(),
      reserve_micronoid: reserve.toString(),
      backing_per_token_micronoid: supply > 0n ? (reserve / supply).toString() : null,
      price_micronoid: last?.toString() ?? null,
      price_usd: usdOf(last, usd),
      liquidity_micronoid: liquidity.toString(),
      liquidity_usd: usdOf(liquidity, usd),
      mcap_micronoid: last != null ? (last * circulating).toString() : null,
      mcap_usd: last != null ? usdOf(last * circulating, usd) : null,
      fdv_micronoid: last != null ? (last * supply).toString() : null,
      fdv_usd: last != null ? usdOf(last * supply, usd) : null,
      volume_micronoid: win.vol.toString(),
      volume_usd: usdOf(win.vol, usd),
      txns: win.txns, buys: win.buys, sells: win.sells, makers: win.makers,
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
      txns: w.txns, buys: w.buys, sells: w.sells, makers: w.makers,
    };
  }
  function publicToken(row) {
    const { stats, _pool, _curve, _last, ...rest } = row;
    return rest;
  }
  function pubWindows(stats) {
    const out = {};
    for (const [k, w] of Object.entries(stats || {})) {
      out[k] = {
        txns: w.txns, buys: w.buys, sells: w.sells, makers: w.makers,
        buyers: w.buyers || 0, sellers: w.sellers || 0, change: w.change,
        volume_micronoid: (w.vol || 0n).toString(),
        buy_vol_micronoid: (w.buy_vol || 0n).toString(),
        sell_vol_micronoid: (w.sell_vol || 0n).toString(),
      };
    }
    return out;
  }

  function sortRows(rows, key, dir) {
    const mul = dir === 'asc' ? 1 : -1;
    const val = (r) => {
      if (key === 'liquidity') return bi(r.liquidity_micronoid);
      if (key === 'volume') return bi(r.volume_micronoid);
      if (key === 'mcap') return bi(r.mcap_micronoid);
      if (key === 'fdv') return bi(r.fdv_micronoid);
      if (key === 'age') return r.age_s;
      if (key === 'txns') return r.txns;
      if (key === 'makers') return r.makers;
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
    return q.tokens.all().map((t) => {
      const recent = q.tradesSince.all(t.id, since - 120);
      const base = q.tradeBefore.get(t.id, since);
      const trades = base && !recent.some((r) => r.txid === base.txid) ? [base, ...recent] : recent;
      const curve = t.curve_target_micronoid ? {
        raised_micronoid: t.curve_raised_micronoid, target_micronoid: t.curve_target_micronoid,
        virtual_noid: t.curve_virtual_noid, virtual_token: t.curve_virtual_token,
      } : null;
      return presentToken({ ...t, graduated: !!t.graduated, pool: pools.get(t.id) || null, curve }, indexTrades(trades).get(t.id) || [], now, noidUsd());
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
      else if (preset === 'trending') sort = 'txns';
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
    if (preset === 'watch') {
      const raw = params.get('ids') || '';
      if (raw.length > 8000) throw bad('ids is too long');
      const ids = new Set(raw.split(',').map((s) => s.trim()).filter((s) => ID.test(s)).slice(0, 200));
      rows = rows.filter((r) => ids.has(r.id));
    }
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
      trades = [...chartTrades].reverse().filter((t) => bi(t.token_amount) > 0n).slice(0, 80).map(publicTrade);
      holders = src.holders.map((h) => ({ ...h, share: row.supply !== '0' ? Number(BigInt(h.balance) * 10000n / BigInt(row.supply)) / 100 : null }));
    } else {
      chartTrades = q.tradesFor.all(id).map((t) => ({ ...t, ts: Number(t.ts), price: bi(t.price_micronoid), noid: bi(t.noid_micronoid) || 0n })).reverse();
      trades = q.tradesFor.all(id).slice(0, 80).map(publicTrade);
      const supply = bi(row.supply) || 0n;
      holders = q.holdersFor.all(id)
        .sort((a, b) => (bi(b.balance) > bi(a.balance) ? 1 : bi(b.balance) < bi(a.balance) ? -1 : 0))
        .slice(0, 20)
        .map((h) => ({ address: h.address, balance: h.balance, share: supply > 0n ? Number(bi(h.balance) * 10000n / supply) / 100 : null }));
    }
    const chart = chartTrades.filter((t) => t.price != null).map((t) => ({ t: t.ts, price_micronoid: t.price.toString(), price_usd: usdOf(t.price, noidUsd()) }));
    const pool = row._pool ? {
      reserve_token: String(row._pool.reserve_token),
      reserve_noid_micronoid: String(bi(row._pool.reserve_noid_micronoid) ?? 0n),
      lp_supply: row._pool.lp_supply == null ? null : String(row._pool.lp_supply),
    } : null;
    const top10 = Math.round(holders.slice(0, 10).reduce((s, h) => s + (h.share || 0), 0) * 100) / 100;
    const warnings = [];
    const dev = holders.find((h) => h.address && h.address === row.creator);
    if (dev?.share >= 20) warnings.push({ code: 'dev_hold', text: `Creator holds ${dev.share}% of supply.` });
    if ((bi(row.liquidity_micronoid) || 0n) < LOW_LIQ) warnings.push({ code: 'low_liq', text: 'Liquidity is under 10,000 NOID.' });
    return {
      demo, live: demo ? false : !!status.available,
      token: {
        ...publicToken(row), pool, holders_n: demo ? holders.length : q.holderCount.get(id).n, top10_pct: top10,
        windows: pubWindows(row.stats),
        backing_note: '0.001 NOID of the creation reserve per whole token, when the token was minted at the preview rate.',
      },
      chart, trades, holders, warnings, swap: swapInfo(demo),
    };
  }

  function bucketOf(t, sec) {
    if (sec === 604800) return t - ((t - WEEK_OFF) % sec);
    return t - (t % sec);
  }
  function rollup(mins, sec) {
    const out = [];
    for (const c of mins) {
      const b = bucketOf(c.t, sec);
      const o = bi(c.o), h = bi(c.h), l = bi(c.l), cl = bi(c.c), v = bi(c.v) || 0n;
      const g = out.at(-1);
      if (!g || g.t !== b) out.push({ t: b, o, h, l, c: cl, v, n: c.n || 0 });
      else {
        if (h > g.h) g.h = h;
        if (l < g.l) g.l = l;
        g.c = cl; g.v += v; g.n += c.n || 0;
      }
    }
    return out;
  }
  function candleOut(rows) {
    return rows.map((c) => ({ t: c.t, o: c.o.toString(), h: c.h.toString(), l: c.l.toString(), c: c.c.toString(), v: c.v.toString(), n: c.n }));
  }
  function candleLimit(params) {
    const raw = params.get('limit');
    if (raw == null || raw === '') return 300;
    if (!/^\d+$/.test(raw)) throw bad('bad limit');
    return Math.min(Math.max(Number(raw), 1), CANDLE_MAX);
  }
  function candleBefore(params) {
    const raw = params.get('before');
    if (raw == null || raw === '') return null;
    if (!/^\d+$/.test(raw)) throw bad('bad before');
    return Number(raw);
  }
  // Fixture path for the visible page only. Real candles are folded from stored trades.
  function pathPrice(id, t, created, now, endPrice) {
    const span = Math.max(now - created, 1);
    const u = Math.max(0, Math.min(1, (t - created) / span));
    const phase = [...id].reduce((s, ch) => s + ch.charCodeAt(0), 0);
    const wobble = Math.sin(t / 1500 + phase) * 0.06 + Math.sin(t / 7200 + phase * 0.2) * 0.11;
    let n = Math.round(Number(endPrice) * (0.38 + 0.62 * u) * (1 + wobble * (1 - u * 0.9)));
    if (t >= now - 60) n = Number(endPrice);
    if (!Number.isFinite(n) || n < 1) n = 1;
    return BigInt(Math.min(n, Number.MAX_SAFE_INTEGER));
  }
  function demoCandles(token, sec, before, limit, now) {
    const endPrice = bi(token.price_micronoid) || 1n;
    const created = Number(token.created_ts) || now - sec;
    const last = before == null ? bucketOf(now, sec) : bucketOf(before - 1, sec);
    const first = bucketOf(created, sec);
    const phase = [...token.id].reduce((s, ch) => s + ch.charCodeAt(0), 0);
    const candles = [];
    for (let i = 0; i < limit; i++) {
      const t = last - i * sec;
      if (t < first) break;
      const samples = [0, 0.27, 0.5, 0.73, 0.999].map((f) => pathPrice(token.id, t + Math.floor(sec * f), created, now, endPrice));
      let o = samples[0], h = o, l = o;
      for (const p of samples) { if (p > h) h = p; if (p < l) l = p; }
      let c = samples.at(-1);
      if (t + sec > now) { c = endPrice; if (c > h) h = c; if (c < l) l = c; }
      const wave = (Math.sin((t / 86400) * Math.PI * 2 + phase) + 1) / 2;
      const v = BigInt(Math.round((400 + wave * 8600) * Math.max(sec / 60, 1))) * 1000n;
      candles.push({ t, o, h, l, c, v, n: 1 + ((Math.floor(t / sec) + phase) % 7) });
    }
    candles.reverse();
    return { candles, more: candles.length > 0 && candles[0].t > first, oldest: candles[0]?.t ?? null };
  }
  function storedPage(id, sec, before, limit, now) {
    const end = before ?? (now + sec);
    const per = Math.max(1, sec / 60);
    const cap = Math.min((limit + 1) * per, 20000);
    const desc = q.candlesBefore.all(id, end, cap);
    const reached = desc.length < cap;
    const mins = desc.reverse();
    let candles = rollup(mins, sec).filter((c) => c.t < end);
    if (!reached && candles.length && mins.length && mins[0].t > candles[0].t) candles.shift();
    if (candles.length > limit) candles = candles.slice(-limit);
    const oldest = candles[0]?.t ?? null;
    return { candles, more: oldest != null && !!q.candleOlder.get(id, oldest), oldest };
  }
  function candleView(id, params) {
    checkId(id);
    const tf = params.get('tf') || '15m';
    if (!Object.hasOwn(TFS, tf)) throw bad('bad tf');
    const sec = TFS[tf];
    const demo = isDemo(params);
    const now = Math.floor(Date.now() / 1000);
    const token = findPresented(id, demo, now);
    if (!token) return null;
    const limit = candleLimit(params);
    const sinceRaw = params.get('since');
    if (sinceRaw != null && sinceRaw !== '') {
      if (!/^\d+$/.test(sinceRaw)) throw bad('bad since');
      const from = bucketOf(Number(sinceRaw), sec);
      const page = demo ? demoCandles(token, sec, null, limit, now) : storedPage(id, sec, null, limit, now);
      const candles = page.candles.filter((c) => c.t >= from);
      return { demo, tf, bucket: sec, candles: candleOut(candles), more: false, oldest: candles[0]?.t ?? null, limit };
    }
    const before = candleBefore(params);
    const page = demo ? demoCandles(token, sec, before, limit, now) : storedPage(id, sec, before, limit, now);
    return { demo, tf, bucket: sec, candles: candleOut(page.candles), more: page.more, oldest: page.oldest, limit };
  }
  function tradeView(id, params) {
    checkId(id);
    const demo = isDemo(params);
    const now = Math.floor(Date.now() / 1000);
    if (!findPresented(id, demo, now)) return null;
    const trades = demo
      ? [...(indexTrades(demoCatalog(now).tokens.find((t) => t.id === id).trades).get(id) || [])].reverse().slice(0, 200).map(publicTrade)
      : q.tradesFor.all(id).slice(0, 200).map(publicTrade);
    return { demo, trades };
  }
  // shortcut: top traders and wallet PnL use the newest 400 indexed fills, not the wallet's full history.
  function pnlOf(trades, priceMicro, usd) {
    let boughtNoid = 0n, soldNoid = 0n, boughtTok = 0n, soldTok = 0n, buys = 0, sells = 0, first = null, last = null;
    for (const t of trades) {
      const noid = bi(t.noid_micronoid) || bi(t.noid) || 0n;
      const tok = bi(t.token_amount) || 0n;
      if (t.side === 'sell') { sells++; soldNoid += noid; soldTok += tok; }
      else { buys++; boughtNoid += noid; boughtTok += tok; }
      const ts = Number(t.ts);
      if (first == null || ts < first) first = ts;
      if (last == null || ts > last) last = ts;
    }
    const remain = boughtTok - soldTok;
    const bag = remain > 0n && priceMicro != null ? remain * priceMicro : 0n;
    const pnl = soldNoid - boughtNoid + bag;
    return {
      buys, sells, txns: buys + sells, first_ts: first, last_ts: last,
      bought_noid_micronoid: boughtNoid.toString(), sold_noid_micronoid: soldNoid.toString(),
      bought_token: boughtTok.toString(), sold_token: soldTok.toString(), remaining_token: remain.toString(),
      pnl_micronoid: pnl.toString(), pnl_usd: usdOf(pnl < 0n ? -pnl : pnl, usd) == null ? null : (pnl < 0n ? -usdOf(-pnl, usd) : usdOf(pnl, usd)),
    };
  }
  function tradersView(id, params) {
    checkId(id);
    const demo = isDemo(params);
    const now = Math.floor(Date.now() / 1000);
    const row = findPresented(id, demo, now);
    if (!row) return null;
    const trades = demo
      ? (indexTrades(demoCatalog(now).tokens.find((t) => t.id === id).trades).get(id) || [])
      : q.tradesFor.all(id);
    const by = new Map();
    for (const t of trades) {
      if (!t.trader) continue;
      const g = by.get(t.trader) || [];
      g.push(t);
      by.set(t.trader, g);
    }
    const price = bi(row.price_micronoid);
    const usd = noidUsd();
    const traders = [...by.entries()].map(([address, list]) => {
      const vol = list.reduce((s, t) => s + (bi(t.noid_micronoid) || bi(t.noid) || 0n), 0n);
      return { address, ...pnlOf(list, price, usd), volume_micronoid: vol.toString(), volume_usd: usdOf(vol, usd) };
    });
    traders.sort((a, b) => (BigInt(b.volume_micronoid) > BigInt(a.volume_micronoid) ? 1 : BigInt(b.volume_micronoid) < BigInt(a.volume_micronoid) ? -1 : 0));
    return { demo, token_id: id, label: 'Indexed trades', traders: traders.slice(0, 20) };
  }
  // Deterministic sample txs for this address, folded into a running NOID balance. Never written, never mixed into trades.
  function demoBalance(address, now) {
    let s = 2166136261;
    for (let i = 0; i < address.length; i++) s = Math.imul(s ^ address.charCodeAt(i), 16777619) >>> 0;
    const rnd = () => ((s = Math.imul(1664525, s) + 1013904223 >>> 0) / 4294967296);
    const start = now - 96 * 86400;
    const txs = [{ t: start, delta: 800 + rnd() * 2200 }];
    let bal = txs[0].delta;
    const pushTx = (t) => {
      const out = rnd() < 0.46;
      const mag = out ? 15 + rnd() * 220 : 20 + rnd() * 260;
      let delta = out ? -mag : mag;
      if (bal + delta < 8) delta = mag;
      bal += delta;
      txs.push({ t, delta });
    };
    for (let i = 1; i <= 64; i++) pushTx(start + Math.floor((now - 86400 - start) * i / 64));
    for (let i = 1; i <= 8; i++) pushTx(now - 86400 + Math.floor(86300 * i / 8));
    let run = 0;
    const pts = [];
    for (const tx of txs) {
      run = Math.round((run + tx.delta) * 10000) / 10000;
      const prev = pts.at(-1);
      pts.push({ t: prev && tx.t <= prev.t ? prev.t + 60 : tx.t, balance: run });
    }
    return pts;
  }
  function walletView(address, params) {
    if (!ADDR.test(address || '')) throw bad('expected an address');
    const demo = isDemo(params);
    const focus = params.get('token') || '';
    if (focus && !ID.test(focus)) throw bad('expected a token id');
    const now = Math.floor(Date.now() / 1000);
    const usd = noidUsd();
    let holdings, trades;
    if (demo) {
      holdings = [];
      trades = [];
      for (const t of demoCatalog(now).tokens) {
        const h = t.holders.find((x) => x.address === address);
        if (h) holdings.push({ token_id: t.id, name: t.name, ticker: t.ticker, balance: String(h.balance), price_micronoid: t.price_micronoid.toString() });
        for (const tr of t.trades) if (tr.trader === address) trades.push(tr);
      }
      trades.sort((a, b) => b.ts - a.ts);
    } else {
      holdings = q.holdersByAddr.all(address).map((h) => {
        const t = q.token.get(h.token_id);
        return { token_id: h.token_id, name: t?.name || h.token_id, ticker: t?.ticker || '', balance: h.balance, price_micronoid: t?.price_micronoid || null };
      });
      trades = q.tradesByTrader.all(address);
    }
    holdings.sort((a, b) => ((bi(b.balance) || 0n) > (bi(a.balance) || 0n) ? 1 : -1));
    const focused = focus ? trades.filter((t) => t.token_id === focus) : trades;
    const presented = focus ? findPresented(focus, demo, now) : null;
    const pnl = pnlOf(focused, presented ? bi(presented.price_micronoid) : null, usd);
    return {
      demo, address, token_id: focus || null,
      holdings: holdings.map((h) => {
        const value = bi(h.price_micronoid) == null ? null : (bi(h.balance) || 0n) * bi(h.price_micronoid);
        return { token_id: h.token_id, name: h.name, ticker: h.ticker, balance: String(h.balance), value_micronoid: value == null ? null : value.toString(), value_usd: usdOf(value, usd) };
      }),
      trades: focused.slice(0, 80).map(publicTrade),
      pnl, activity: { txns: pnl.txns, buys: pnl.buys, sells: pnl.sells, first_ts: pnl.first_ts, last_ts: pnl.last_ts },
      ...(demo ? { balance_points: demoBalance(address, now) } : {}),
    };
  }
  function holderView(id, params) {
    const detail = tokenDetail(id, params);
    if (!detail) return null;
    return { demo: detail.demo, holders_n: detail.token.holders_n, top10_pct: detail.token.top10_pct, holders: detail.holders };
  }
  function transferView(id, params) {
    checkId(id);
    const demo = isDemo(params);
    const now = Math.floor(Date.now() / 1000);
    if (!findPresented(id, demo, now)) return null;
    if (demo) {
      const src = demoCatalog(now).tokens.find((t) => t.id === id);
      const transfers = [...src.trades].reverse().slice(0, 40).map((t) => ({
        txid: t.txid, ts: t.ts, height: t.height,
        from: t.side === 'sell' ? t.trader : null, to: t.side === 'buy' ? t.trader : null, amount: String(t.token_amount),
      }));
      return { demo: true, transfers };
    }
    return {
      demo: false,
      transfers: q.transfersFor.all(id).map((t) => ({ txid: t.txid, ts: t.ts, height: t.height, from: t.from_addr || null, to: t.to_addr || null, amount: t.amount })),
    };
  }

  function publicTrade(t) {
    const noid = t.noid_micronoid == null ? (t.noid?.toString() ?? null) : String(t.noid_micronoid);
    return {
      txid: t.txid, ts: Number(t.ts), side: t.side, token_id: t.token_id || null, token_amount: String(t.token_amount),
      noid_micronoid: noid, usd: usdOf(bi(noid), noidUsd()),
      price_micronoid: t.price_micronoid == null ? (t.price?.toString() ?? null) : String(t.price_micronoid),
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
    if (params.get('preset') === 'watch') {
      const raw = params.get('ids') || '';
      if (raw.length > 8000) throw bad('ids is too long');
      const ids = new Set(raw.split(',').map((s) => s.trim()).filter((s) => ID.test(s)).slice(0, 200));
      rows = rows.filter((r) => ids.has(r.id));
    }
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
    const salesN = demo ? (src.sales || []).length : q.salesCount.get(id).n;
    return {
      demo, live: demo ? false : !!status.available,
      collection: {
        id: src.id, name: src.name, creator: src.creator || null,
        items: Number(src.items) || items.length, owners: Number(src.owners) || 0,
        floor_micronoid: floor?.toString() ?? null, floor_usd: usdOf(floor, usd),
        volume_micronoid: vol.toString(), volume_usd: usdOf(vol, usd),
        sales_n: salesN,
        created_ts: src.created_ts ?? null, age_s: src.created_ts ? Math.max(0, now - Number(src.created_ts)) : null,
      },
      items: items.map((n) => ({ id: n.id, name: n.name || null, owner: n.owner || null, image: typeof n.image === 'string' && /^https:\/\//.test(n.image) ? n.image : null, traits: traitsOf(n) })),
    };
  }

  function traitsOf(n) {
    let raw = n.traits;
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = []; } }
    if (!Array.isArray(raw)) return [];
    return raw.filter((t) => t && typeof t.trait === 'string' && typeof t.value === 'string').slice(0, 24)
      .map((t) => ({ trait: t.trait.slice(0, 40), value: t.value.slice(0, 40) }));
  }
  function traitsJson(n) {
    const rows = traitsOf(n);
    return rows.length ? JSON.stringify(rows) : null;
  }
  function findCollection(id, demo, now) {
    return demo ? demoCatalog(now).collections.find((c) => c.id === id) : q.col.get(id);
  }
  // shortcut: demo floor and sale candles are a walk to the current floor, not the sample sales. Replace when the node sends history.
  function demoNftCandles(col, kind, sec, before, limit, now) {
    const floor = bi(col.floor_micronoid);
    if (!floor) return { candles: [], more: false, oldest: null };
    const end = kind === 'floor' ? floor : floor * 115n / 100n;
    return demoCandles({ id: col.id + kind, price_micronoid: end, created_ts: col.created_ts }, sec, before, limit, now);
  }
  function storedNftPage(id, kind, sec, before, limit, now) {
    const end = before ?? (now + sec);
    const per = Math.max(1, sec / 60);
    const cap = Math.min((limit + 1) * per, 20000);
    const desc = q.nftCandlesBefore.all(id, kind, end, cap);
    const reached = desc.length < cap;
    const mins = desc.reverse();
    let candles = rollup(mins, sec).filter((c) => c.t < end);
    if (!reached && candles.length && mins.length && mins[0].t > candles[0].t) candles.shift();
    if (candles.length > limit) candles = candles.slice(-limit);
    const oldest = candles[0]?.t ?? null;
    return { candles, more: oldest != null && !!q.nftCandleOlder.get(id, kind, oldest), oldest };
  }
  function nftCandles(id, params) {
    checkId(id);
    const tf = params.get('tf') || '15m';
    if (!Object.hasOwn(TFS, tf)) throw bad('bad tf');
    const kind = params.get('kind') || 'sale';
    if (kind !== 'sale' && kind !== 'floor') throw bad('bad kind');
    const sec = TFS[tf];
    const demo = isDemo(params);
    const now = Math.floor(Date.now() / 1000);
    const col = findCollection(id, demo, now);
    if (!col) return null;
    const limit = candleLimit(params);
    const before = candleBefore(params);
    const page = demo ? demoNftCandles(col, kind, sec, before, limit, now) : storedNftPage(id, kind, sec, before, limit, now);
    return { demo, tf, kind, bucket: sec, candles: candleOut(page.candles), more: page.more, oldest: page.oldest, limit };
  }
  function groupLevels(list, desc) {
    const map = new Map();
    for (const o of list) {
      const price = strInt(o.price_micronoid);
      if (!price || BigInt(price) === 0n) continue;
      const size = strInt(o.size) || strInt(o.token_amount) || 1n;
      const n = typeof size === 'bigint' ? size : BigInt(size);
      if (n <= 0n) continue;
      map.set(price, (map.get(price) || 0n) + n);
    }
    const prices = [...map.keys()].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1) * (desc ? -1 : 1));
    let total = 0n;
    return prices.slice(0, 12).map((p) => {
      const size = map.get(p);
      total += size;
      return { price_micronoid: p, size: size.toString(), total: total.toString() };
    });
  }
  function nftBookFromOrders(raw) {
    return { bids: groupLevels(Array.isArray(raw?.bids) ? raw.bids : [], true), asks: groupLevels(Array.isArray(raw?.listings) ? raw.listings : (raw?.asks || []), false) };
  }
  async function nftBook(id, params) {
    checkId(id);
    const demo = isDemo(params);
    const now = Math.floor(Date.now() / 1000);
    const col = findCollection(id, demo, now);
    if (!col) return null;
    const floor = bi(col.floor_micronoid);
    const pack = (book, source) => ({
      demo, source, floor_micronoid: floor?.toString() ?? null,
      label: source === 'orders' ? 'NFT orders' : 'Listings and floor depth',
      bids: book.bids, asks: book.asks,
    });
    if (!demo && status.nftOrders) {
      try {
        const book = nftBookFromOrders(await rpc('getNftOrders', [{ collection_id: id }]));
        if (book.bids.length || book.asks.length) return pack(book, 'orders');
      } catch (e) {
        if (!missingMethod(e)) throw e;
        status.nftOrders = false;
      }
    }
    const listings = demo ? (col.listings || []) : q.listingsFor.all(id);
    return pack({ bids: [], asks: groupLevels(listings, false) }, 'listings');
  }
  function nftActivity(id, params) {
    checkId(id);
    const demo = isDemo(params);
    const now = Math.floor(Date.now() / 1000);
    const col = findCollection(id, demo, now);
    if (!col) return null;
    const names = new Map((demo ? col.nfts : q.items.all(id)).map((n) => [n.id, n.name || null]));
    const usd = noidUsd();
    const sales = (demo ? col.sales || [] : q.salesFor.all(id)).map((s) => ({
      ts: Number(s.ts), kind: 'sale', txid: s.txid, item_id: s.item_id || null, item_name: names.get(s.item_id) || null,
      price_micronoid: String(s.price_micronoid), usd: usdOf(bi(s.price_micronoid), usd),
      wallet: s.buyer || null, other: s.seller || null,
    }));
    const transfers = (demo ? col.transfers || [] : q.nftXfers.all(id)).map((t) => ({
      ts: Number(t.ts), kind: 'transfer', txid: t.txid, item_id: t.item_id || null, item_name: names.get(t.item_id) || null,
      price_micronoid: null, usd: null, wallet: (t.to || t.to_addr) || null, other: (t.from || t.from_addr) || null,
    }));
    const events = [...sales, ...transfers].sort((a, b) => b.ts - a.ts || (a.txid < b.txid ? -1 : 1)).slice(0, 200);
    return { demo, events };
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
    if (!demo && !status.quote && status.native) {
      // v2.1 has no quote RPC; the local formula estimates and prepareNativeIntent returns the node's exact quote.
      const est = previewQuote(row, side, amount, slip, fee.bps);
      return est && { ...est, demo: false, signable: true, formula: 'local', note: 'Estimate. The node returns the exact quoted_output and minimum_output when the intent is prepared.' };
    }
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
    if (!status.build && status.native) return buildNative(params, quoted, sender);
    const out = await rpc('buildSwap', [{
      token_id: params.get('token'), side: quoted.side, sender,
      slippage_bps: quoted.slippage_bps, fee_bps: fee.bps, fee_address: fee.address,
      amount_micronoid: quoted.in.noid_micronoid, token_amount: quoted.in.token,
    }]);
    if (!out || out.signature || out.signed || out.signed_tx) throw Object.assign(new Error('refusing a signed payload'), { status: 502 });
    return { signable: true, demo: false, unsigned: out.unsigned ?? null, fee_in_tx: out.fee_in_tx === true, draft: quoted.draft };
  }

  const NATIVE_TTL = 120; // valid_until is a u16 on the node; blocks of validity
  async function buildNative(params, quoted, sender) {
    const assetId = params.get('token');
    const buy = quoted.side === 'buy';
    const gross = buy ? quoted.in.noid_micronoid : quoted.in.token;
    const minOut = buy ? quoted.min_out?.token : quoted.min_out?.noid_micronoid;
    if (!gross) throw bad('missing amount');
    const out = await rpc('prepareNativeIntent', {
      owner: sender,
      request: { action: 'trade', asset_id: assetId, buy, gross_input: String(gross), minimum_output: String(minOut ?? '0'), slippage_bps: quoted.slippage_bps, valid_until: NATIVE_TTL },
    });
    if (!out || out.signature || out.signed || out.signed_tx) throw Object.assign(new Error('refusing a signed payload'), { status: 502 });
    return { signable: true, demo: false, native: true, unsigned: out, fee_in_tx: false, draft: quoted.draft };
  }

  async function nativePages(kind, maxPages = 20) {
    const items = [];
    let cursor = null;
    for (let i = 0; i < maxPages; i++) {
      const page = await rpc('getNativeCatalog', { kind, limit: 64, ...(cursor && { cursor }) }, 10_000);
      if (Array.isArray(page?.items)) items.push(...page.items);
      if (!page?.next) break;
      cursor = page.next;
    }
    return items;
  }
  const pick = (o, ...ks) => { for (const k of ks) if (o?.[k] != null) return o[k]; return null; };
  // shortcut: catalogue item fields are not documented and are empty until activation; map common names.
  async function nativeSnapshot() {
    const [markets, cols, listings] = await Promise.all([nativePages('markets'), nativePages('collections'), nativePages('nft_listings')]);
    const tokens = [], pools = [];
    for (const m of markets) {
      const id = String(pick(m, 'asset_id', 'id', 'market_id') ?? '');
      if (!id) continue;
      const meta = m.metadata && typeof m.metadata === 'object' ? m.metadata : {};
      const short = id.slice(0, 8);
      tokens.push({
        id, name: pick(meta, 'name') ?? pick(m, 'name') ?? `Token ${short}`, ticker: pick(meta, 'ticker', 'symbol') ?? pick(m, 'ticker', 'symbol') ?? short.toUpperCase(),
        creator: pick(m, 'creator', 'owner'), supply: pick(m, 'whole_tokens', 'supply', 'total_supply'),
        reserve_micronoid: pick(m, 'reserve_micronoid', 'backing_micronoid', 'reserve'), created_height: pick(m, 'created_height', 'height'),
        logo: pick(meta, 'image', 'logo'), graduated: !!pick(m, 'graduated'), price_micronoid: pick(m, 'price_micronoid', 'spot_price_micronoid'),
        launch: 'launchpad',
      });
      const rt = pick(m, 'pool_reserve_token', 'reserve_token'), rn = pick(m, 'pool_reserve_micronoid', 'reserve_noid_micronoid');
      if (rt != null && rn != null) pools.push({ id: `${id}:pool`, token_id: id, reserve_token: rt, reserve_noid_micronoid: rn });
    }
    const byCol = new Map();
    for (const L of listings) {
      const cid = String(pick(L, 'collection_id') ?? '');
      if (!cid) continue;
      if (!byCol.has(cid)) byCol.set(cid, []);
      byCol.get(cid).push({ item_id: String(pick(L, 'serial', 'item_id') ?? ''), price_micronoid: pick(L, 'ask_micronoid', 'price_micronoid'), seller: pick(L, 'seller', 'owner') });
    }
    const collections = cols.map((c) => {
      const id = String(pick(c, 'collection_id', 'id') ?? '');
      const meta = c.metadata && typeof c.metadata === 'object' ? c.metadata : {};
      return { id, name: pick(meta, 'name') ?? pick(c, 'name') ?? `Collection ${id.slice(0, 8)}`, creator: pick(c, 'creator'), items: pick(c, 'minted', 'items', 'last_serial') ?? 0,
        listings: byCol.get(id) || [] };
    }).filter((c) => c.id);
    return { tokens, pools, trades: [], collections };
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
        const launch = t.launch === 'direct' || t.launch === 'launchpad' ? t.launch : null;
        const links = linksOf(t.links);
        q.upToken.run(String(t.id), String(t.name).slice(0, 80), String(t.ticker).slice(0, 16), t.creator ? String(t.creator) : null,
          strInt(t.supply), strInt(t.reserve_micronoid) || '0', Number.isInteger(t.created_height) ? t.created_height : null,
          Number.isInteger(t.created_ts) ? t.created_ts : null, typeof t.logo === 'string' ? t.logo.slice(0, 300) : null,
          t.graduated ? 1 : 0, strInt(t.price_micronoid), strInt(t.curve_target_micronoid), strInt(t.curve_raised_micronoid),
          strInt(t.curve_virtual_noid_micronoid), strInt(t.curve_virtual_token), Number.isInteger(t.updated_height) ? t.updated_height : null,
          launch, links ? JSON.stringify(links) : null);
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
        const price = strInt(t.price_micronoid);
        const info = q.upTrade.run(txid, String(t.token_id), t.ts, Number.isInteger(t.height) ? t.height : null, side, strInt(t.token_amount), strInt(t.noid_micronoid),
          ADDR.test(t.trader || '') ? t.trader : null, t.venue === 'pool' || t.venue === 'curve' ? t.venue : null, price);
        if (info.changes) bumpCandle(String(t.token_id), t.ts);
      }
      for (const t of (Array.isArray(snap.transfers) ? snap.transfers : [])) {
        const txid = String(t.txid || '');
        if (!/^[A-Za-z0-9:_-]{8,80}$/.test(txid) || !ID.test(String(t.token_id || '')) || !strInt(t.amount) || !Number.isInteger(t.ts)) continue;
        const from = ADDR.test(t.from || '') ? t.from : '';
        const to = ADDR.test(t.to || '') ? t.to : '';
        q.upTransfer.run(txid, String(t.token_id), t.ts, Number.isInteger(t.height) ? t.height : null, from, to, strInt(t.amount));
      }
      for (const c of cols) {
        if (!ID.test(String(c.id || '')) || !c.name) continue;
        q.upCol.run(String(c.id), String(c.name).slice(0, 80), c.creator ? String(c.creator) : null, Number(c.items) || 0, Number(c.owners) || 0,
          strInt(c.floor_micronoid), strInt(c.volume_micronoid) || '0', Number.isInteger(c.created_ts) ? c.created_ts : null, Number.isInteger(c.updated_height) ? c.updated_height : null);
        if (Array.isArray(c.nfts)) {
          q.delItems.run(String(c.id));
          for (const n of c.nfts.slice(0, 200)) if (ID.test(String(n.id || ''))) q.upItem.run(String(n.id), String(c.id), n.name ? String(n.name).slice(0, 80) : null, ADDR.test(n.owner || '') ? n.owner : null, typeof n.image === 'string' ? n.image.slice(0, 300) : null, traitsJson(n));
        }
        if (Array.isArray(c.sales)) {
          for (const s of c.sales) {
            const txid = String(s.txid || '');
            if (!/^[A-Za-z0-9:_-]{8,80}$/.test(txid) || !Number.isInteger(s.ts) || !strInt(s.price_micronoid)) continue;
            const info = q.upSale.run(txid, String(c.id), ID.test(String(s.item_id || '')) ? String(s.item_id) : null, s.ts, Number.isInteger(s.height) ? s.height : null, strInt(s.price_micronoid), ADDR.test(s.seller || '') ? s.seller : null, ADDR.test(s.buyer || '') ? s.buyer : null);
            if (info.changes) bumpNftSale(String(c.id), s.ts);
          }
        }
        if (Array.isArray(c.transfers)) {
          for (const t of c.transfers) {
            const txid = String(t.txid || '');
            if (!/^[A-Za-z0-9:_-]{8,80}$/.test(txid) || !Number.isInteger(t.ts)) continue;
            q.upNftXfer.run(txid, String(c.id), ID.test(String(t.item_id || '')) ? String(t.item_id) : '', t.ts, Number.isInteger(t.height) ? t.height : null, ADDR.test(t.from || '') ? t.from : '', ADDR.test(t.to || '') ? t.to : '');
          }
        }
        if (Array.isArray(c.listings)) {
          q.delListings.run(String(c.id));
          for (const L of c.listings.slice(0, 200)) {
            if (!ID.test(String(L.item_id || '')) || !strInt(L.price_micronoid)) continue;
            q.upListing.run(String(c.id), String(L.item_id), strInt(L.price_micronoid), ADDR.test(L.seller || '') ? L.seller : null);
          }
        }
        const floorNow = strInt(c.floor_micronoid);
        // shortcut: one flat minute for the floor the node reports now. A floor series replaces this.
        if (floorNow) bumpFloorCandle(String(c.id), floorNow, Number.isInteger(c.updated_height) ? c.updated_height : null);
      }
      db.exec('commit');
      return true;
    } catch (e) { db.exec('rollback'); throw e; }
  }

  const missingMethod = (e) => /method not found|not supported|unknown method|-32601/i.test(e.message || '');

  async function probeDex() {
    // A zero wait probes on this sync even when a longer wait was already scheduled.
    if (probeWait() > 0 && Date.now() < status.dexProbeAt) return;
    status.dexProbeAt = Date.now() + probeWait();
    const gone = async (method) => {
      try { await rpc(method, [{}], 2_000); return false; }
      catch (e) { return missingMethod(e); }
    };
    status.quote = !(await gone('quoteSwap'));
    status.build = !(await gone('buildSwap'));
    status.orders = !(await gone('getOpenOrders'));
    status.nftOrders = !(await gone('getNftOrders'));
  }

  async function sync() {
    if (!status.available && Date.now() < status.retryAt && probeWait() > 0) return false;
    try {
      let snap;
      try {
        snap = await rpc('getAssetSnapshot', [], status.available ? 20_000 : 2_000);
        status.native = false;
      } catch (e) {
        if (!missingMethod(e)) throw e;
        snap = await nativeSnapshot(); // throws "method not found" on pre-2.1 nodes
        if (!status.native) console.log('assets: using v2.1 native catalogue');
        status.native = true;
      }
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
      status.native = false;
      status.quote = false;
      status.build = false;
      status.orders = false;
      status.nftOrders = false;
      status.error = e.message;
      status.retryAt = Date.now() + (missing ? probeWait() : 30_000);
      return false;
    }
  }

  // Rebuild the minute from trades in time order, so a late older fill does not become the close.
  function bumpCandle(tokenId, ts) {
    const bucket = ts - (ts % 60);
    let o, h, l, c, v = 0n, n = 0, height = null;
    for (const r of q.tradesIn.all(tokenId, bucket, bucket + 60)) {
      const price = bi(r.price_micronoid);
      const vol = bi(r.noid_micronoid) || 0n;
      if (price == null || price > BigInt(Number.MAX_SAFE_INTEGER) || vol > BigInt(Number.MAX_SAFE_INTEGER)) continue;
      if (!n) o = h = l = price;
      else { if (price > h) h = price; if (price < l) l = price; }
      c = price; v += vol; n++;
      // shortcut: height is the last trade in the minute, so a reorg drops a minute that also holds an older fill.
      if (Number.isInteger(r.height)) height = r.height;
    }
    if (!n) return;
    const safe = (x) => Number(x > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : x);
    q.upCandle.run(tokenId, bucket, safe(o), safe(h), safe(l), safe(c), safe(v), n, height);
  }
  function bumpNftSale(id, ts) {
    const bucket = ts - (ts % 60);
    let o, h, l, c, v = 0n, n = 0, height = null;
    for (const r of q.nftSalesIn.all(id, bucket, bucket + 60)) {
      const price = bi(r.price_micronoid);
      if (price == null || price <= 0n || price > BigInt(Number.MAX_SAFE_INTEGER)) continue;
      if (!n) o = h = l = price;
      else { if (price > h) h = price; if (price < l) l = price; }
      c = price; v += price; n++;
      if (Number.isInteger(r.height)) height = r.height;
    }
    if (!n) return;
    const safe = (x) => Number(x > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : x);
    q.upNftCandle.run(id, 'sale', bucket, safe(o), safe(h), safe(l), safe(c), safe(v), n, height);
  }
  function bumpFloorCandle(id, floorStr, height) {
    const price = Number(floorStr);
    if (!Number.isFinite(price) || price < 1 || price > Number.MAX_SAFE_INTEGER) return;
    const now = Math.floor(Date.now() / 1000);
    const bucket = now - (now % 60);
    let v = 0, n = 0;
    for (const r of q.nftSalesIn.all(id, bucket, bucket + 60)) {
      const p = bi(r.price_micronoid);
      if (p == null) continue;
      v += Number(p > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : p);
      n++;
    }
    q.upNftCandle.run(id, 'floor', bucket, price, price, price, price, v, n, height);
  }

  function levelsFromOrders(raw) {
    const side = (list, desc) => {
      const map = new Map();
      for (const o of Array.isArray(list) ? list : []) {
        const price = strInt(o.price_micronoid);
        const size = strInt(o.token_amount) || strInt(o.size);
        if (!price || !size || BigInt(size) === 0n) continue;
        map.set(price, (map.get(price) || 0n) + BigInt(size));
      }
      const prices = [...map.keys()].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1) * (desc ? -1 : 1));
      let total = 0n;
      return prices.slice(0, 12).map((p) => {
        const size = map.get(p);
        total += size;
        return { price_micronoid: p, size: size.toString(), total: total.toString() };
      });
    };
    return { bids: side(raw?.bids, true), asks: side(raw?.asks, false) };
  }
  // Constant-product ladder. Each level is 0.5% of the token reserve. Price is the marginal fill, not a resting order.
  function ladderFromReserves(R, T) {
    const bids = [], asks = [];
    if (R <= 0n || T <= 1n) return { bids, asks };
    const step = T / 200n;
    if (step <= 0n) return { bids, asks };
    let bidCum = 0n, askCum = 0n;
    for (let i = 1; i <= 8; i++) {
      const before = step * BigInt(i - 1);
      const T1 = T - before;
      if (T1 > step) {
        const cost = (R * T / T1) * step / (T1 - step);
        const price = cost / step;
        if (price > 0n) { askCum += step; asks.push({ price_micronoid: price.toString(), size: step.toString(), total: askCum.toString() }); }
      }
      const T2 = T + before;
      const out = step * (R * T / T2) / (T2 + step);
      const bidPrice = out / step;
      if (bidPrice > 0n) { bidCum += step; bids.push({ price_micronoid: bidPrice.toString(), size: step.toString(), total: bidCum.toString() }); }
    }
    return { bids, asks };
  }
  function finishBook(book, source, venue, demo, trades) {
    const bid = book.bids[0] ? BigInt(book.bids[0].price_micronoid) : null;
    const ask = book.asks[0] ? BigInt(book.asks[0].price_micronoid) : null;
    const spread = bid != null && ask != null && ask >= bid ? ask - bid : null;
    const mid = bid != null && ask != null ? (ask + bid) / 2n : null;
    const where = venue === 'curve' ? 'curve reserves' : 'pool reserves';
    return {
      demo, source, venue, label: source === 'orders' ? 'Open orders' : `Derived from ${where}`,
      spread_micronoid: spread == null ? null : spread.toString(),
      spread_pct: spread != null && mid > 0n ? Number(spread * 10000n / mid) / 100 : null,
      bids: book.bids, asks: book.asks, trades: trades.slice(0, 12),
    };
  }
  async function bookView(id, params) {
    checkId(id);
    const demo = isDemo(params);
    const now = Math.floor(Date.now() / 1000);
    const row = findPresented(id, demo, now);
    if (!row) return null;
    const trades = (demo
      ? [...(indexTrades(demoCatalog(now).tokens.find((t) => t.id === id).trades).get(id) || [])].reverse()
      : q.tradesFor.all(id)
    ).slice(0, 12).map(publicTrade);
    if (!demo && status.orders) {
      try {
        const book = levelsFromOrders(await rpc('getOpenOrders', [{ token_id: id }]));
        if (book.bids.length || book.asks.length) return finishBook(book, 'orders', null, false, trades);
      } catch (e) {
        if (!missingMethod(e)) throw e;
        status.orders = false;
      }
    }
    const reserves = reservesOf(row);
    if (!reserves) return finishBook({ bids: [], asks: [] }, 'reserves', null, demo, trades);
    return finishBook(ladderFromReserves(reserves.R, reserves.T), 'reserves', reserves.venue, demo, trades);
  }

  return {
    sync, status,
    tokens: (id, params, sub) => {
      if (sub === 'candles') return candleView(id, params);
      if (sub === 'trades') return tradeView(id, params);
      if (sub === 'traders') return tradersView(id, params);
      if (sub === 'holders') return holderView(id, params);
      if (sub === 'transfers') return transferView(id, params);
      if (sub === 'book') return bookView(id, params);
      if (sub) return null;
      return id ? tokenDetail(id, params) : listTokens(params);
    },
    token: (id, params) => tokenDetail(id, params),
    wallet: (address, params) => walletView(address, params),
    collections: (id, params, sub) => {
      if (sub === 'candles') return nftCandles(id, params);
      if (sub === 'book') return nftBook(id, params);
      if (sub === 'activity') return nftActivity(id, params);
      if (sub) return null;
      return id ? collectionDetail(id, params) : listCollections(params);
    },
    collection: (id, params) => collectionDetail(id, params),
    swap,
  };
};
