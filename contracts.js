// Paid promotions and API time, bought with NOID through a real Parano1d contract.
//
// Parano1d's contract runtime (ABI v3, active since block 210,537) builds an
// object with an ordinary o1 address. This module creates a `refundable_payment`
// object for each order:
//
//   payer    = the buyer's own address
//   payee    = ours
//   deadline = now + the tier's duration + a grace period
//
// The buyer pays the object address like any other NOID payment. Before the
// deadline we can claim it; after the deadline the buyer can take it back. The
// chain enforces the money, we only read it: when a funded instance appears we
// start the promotion (or add the API days), and we say exactly that on the page.
//
// We hold no key of anyone's. Claiming our own side is a wallet action on the
// machine that holds the payee key (see HANDOFF.md), not something a server can do.
const { randomBytes } = require('node:crypto');

const ADDR = /^o1[02-9ac-hj-np-z]{6,120}$/;
const ID = /^[A-Za-z0-9:_-]{1,80}$/;
const BLOCK_SECONDS = 30;
const GRACE_BLOCKS = 120; // one hour past the promotion, so a late claim is never a scramble
const bad = (m, status = 400) => Object.assign(new Error(m), { status });

// 1 NOID buys the first hour; bigger bags buy a longer run at a better rate.
const PROMO_TIERS = [
  { noid: 1, secs: 3600, label: '1 hour' },
  { noid: 3, secs: 6 * 3600, label: '6 hours' },
  { noid: 10, secs: 86400, label: '1 day' },
  { noid: 25, secs: 4 * 86400, label: '4 days' },
  { noid: 50, secs: 9 * 86400, label: '9 days' },
  { noid: 100, secs: 20 * 86400, label: '20 days' },
];
// API time is linear by design: 1 NOID is 1 day, and volume is rewarded above that.
const API_TIERS = [
  { noid: 1, days: 1 },
  { noid: 3, days: 3 },
  { noid: 10, days: 11 },
  { noid: 25, days: 30 },
  { noid: 50, days: 65 },
  { noid: 100, days: 140 },
];

// Any whole NOID from 1 to the top tier is a legal order: the time between two published tiers is
// interpolated, so a slider can name a number the price list does not. The published points are
// exact (1 NOID is 1 hour, 100 NOID is 20 days) and nothing between them is cheaper per NOID.
const MIN_NOID = 1;
const MAX_NOID = PROMO_TIERS[PROMO_TIERS.length - 1].noid;
const PROMO_POINTS = PROMO_TIERS.map((t) => [t.noid, t.secs]);
const API_POINTS = API_TIERS.map((t) => [t.noid, t.days * 86400]);

function between(points, x) {
  if (x <= points[0][0]) return Math.round((points[0][1] * x) / points[0][0]);
  for (let i = 1; i < points.length; i += 1) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    if (x <= x1) return Math.round(y0 + ((y1 - y0) * (x - x0)) / (x1 - x0));
  }
  return null;
}
// Seconds to words, rounded to the minute and never up: 2 NOID is 3 hours 30 minutes, not 4 hours.
function duration(secs) {
  const d = Math.floor(secs / 86400);
  const rest = secs % 86400;
  const h = Math.floor(rest / 3600);
  const m = Math.round((rest % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d} day${d === 1 ? '' : 's'}`);
  if (h) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
  if (m && !d) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' ') : 'under a minute';
}
function termFor(kind, noid) {
  const n = Math.round(Number(noid));
  if (!Number.isFinite(n) || n < MIN_NOID || n > MAX_NOID) return null;
  const secs = between(kind === 'api' ? API_POINTS : PROMO_POINTS, n);
  if (!secs) return null;
  return {
    kind, noid: n, micronoid: n * 1_000_000, secs,
    label: duration(secs), unit: kind === 'api' ? 'of API time' : 'of promotion',
  };
}
const promoTerms = (noid) => termFor('promo', noid);
const apiTerms = (noid) => termFor('api', noid);

module.exports = function contracts(db, rpc, opts = {}) {
  const { payee = null, apiPayee = null, tip = () => null, lookupAsset = () => null, byWallet = () => null, onApiTime = () => {} } = opts;
  const payeeFor = (kind) => (kind === 'api' ? apiPayee || payee : payee);

  db.exec(`
    create table if not exists noid_contracts (
      id text primary key, kind text not null, asset_id text not null default '', account text,
      payer text not null, opening_hex text not null, address text not null, code_id text,
      noid integer not null, micronoid integer not null, secs integer not null,
      deadline_height integer not null, status text not null, slot integer, creation_id integer,
      created integer not null, funded integer, starts integer, ends integer, payee text);
    create index if not exists noid_contracts_open on noid_contracts(status, deadline_height);
    create index if not exists noid_contracts_watch on noid_contracts(status, created);
    create index if not exists noid_contracts_asset on noid_contracts(asset_id, status, ends);
  `);
  // The table shipped without the payee; add it additively so an existing copy heals too.
  try { db.exec('alter table noid_contracts add column payee text'); } catch { /* already there */ }
  const q = {
    insert: db.prepare(`insert into noid_contracts
      (id, kind, asset_id, account, payer, opening_hex, address, code_id, noid, micronoid, secs, deadline_height, status, created, payee)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting', ?, ?)`),
    byId: db.prepare('select * from noid_contracts where id = ?'),
    awaiting: db.prepare("select * from noid_contracts where status = 'awaiting' order by created limit 20"),
    live: db.prepare("select * from noid_contracts where status = 'live'"),
    // A funded instance turns the order on. One row per order, so a renewal is a new order.
    fund: db.prepare("update noid_contracts set status = 'live', slot = ?, creation_id = ?, funded = ?, starts = ?, ends = ? where id = ? and status = 'awaiting'"),
    miss: db.prepare("update noid_contracts set status = 'refundable' where id = ? and status = 'awaiting'"),
    finish: db.prepare("update noid_contracts set status = 'done' where id = ? and status = 'live'"),
    forPayer: db.prepare('select * from noid_contracts where payer = ? order by created desc limit 20'),
    forAccount: db.prepare('select * from noid_contracts where account = ? order by created desc limit 20'),
    liveAsset: db.prepare("select asset_id, ends from noid_contracts where kind = 'promo' and status = 'live' and ends > ? and asset_id = ? limit 1"),
    livePromos: db.prepare("select asset_id, ends, noid from noid_contracts where kind = 'promo' and status = 'live' and ends > ? order by ends"),
  };

  // The exact definition the node turns into a real object opening. No hidden fields:
  // these are the terms a buyer can read on the page and check on chain afterwards.
  function definition(kind, payer, microns, secs, height) {
    const expiry = height + Math.ceil(secs / BLOCK_SECONDS) + GRACE_BLOCKS;
    const to = payeeFor(kind);
    return {
      kind: 'refundable_payment',
      payer,
      payee: to,
      expiry_height: expiry,
      max_fee_micronoid: 20000,
    };
  }

  function shape(row, now = Date.now()) {
    const live = row.status === 'live' && row.ends > now;
    return {
      id: row.id, kind: row.kind, asset_id: row.asset_id || null, status: row.status,
      noid: row.noid, micronoid: row.micronoid, secs: row.secs, payer: row.payer,
      pay_address: row.address, opening_hex: row.opening_hex, code_id: row.code_id, payee: row.payee || null,
      deadline_height: row.deadline_height, slot: row.slot, creation_id: row.creation_id,
      created: row.created, starts: row.starts, ends: row.ends, live,
      remaining_secs: live ? Math.max(0, Math.round((row.ends - now) / 1000)) : 0,
    };
  }

  async function create(kind, body = {}) {
    if (kind !== 'promo' && kind !== 'api') throw bad('kind must be promo or api');
    const terms = kind === 'api' ? apiTerms(Number(body.noid)) : promoTerms(Number(body.noid));
    if (!terms) throw bad(`noid must be a whole number from ${MIN_NOID} to ${MAX_NOID}`);
    if (!payeeFor(kind)) throw bad('promotions are not accepting payment right now', 503);
    const payer = String(body.payer || '').trim();
    if (!ADDR.test(payer)) throw bad('expected the o1 address you will pay from');
    let asset = '';
    if (kind === 'promo') {
      asset = String(body.asset_id || '').trim().toLowerCase();
      if (!ID.test(asset)) throw bad('expected a token id');
      if (!lookupAsset(asset)) throw bad('that token is not on the explorer yet');
      const now = Date.now();
      if (q.liveAsset.get(now, asset)) throw bad('that token is already promoted');
    }
    const height = tip();
    if (!Number.isInteger(height) || height <= 0) throw bad('the node has not reported a height yet', 503);
    const info = await rpc('createObject', [definition(kind, payer, terms.micronoid, terms.secs, height)], 20_000);
    if (!info?.address || !info?.opening_hex) throw bad('the node did not return a contract opening', 502);
    const id = randomBytes(8).toString('hex');
    const account = body.account || (kind === 'api' ? byWallet(payer)?.id ?? null : null);
    q.insert.run(id, kind, asset, account, payer, info.opening_hex, info.address, info.code_id ?? null,
      terms.noid, terms.micronoid, terms.secs, info.deadline_height ?? definition(kind, payer, terms.micronoid, terms.secs, height).expiry_height, Date.now(), String(payeeFor(kind)));
    return { ...shape(q.byId.get(id)), terms: termsFor(kind) };
  }

  function termsFor(kind) {
    const points = kind === 'api' ? API_TIERS.map((t) => ({ noid: t.noid, label: `${t.days} day${t.days === 1 ? '' : 's'}` }))
      : PROMO_TIERS.map((t) => ({ noid: t.noid, label: t.label }));
    return { min: MIN_NOID, max: MAX_NOID, points };
  }

  // A funded instance is the whole proof that someone paid: the object address
  // holds the balance and this node reports the slot. Nothing else is trusted.
  async function watch(currentHeight) {
    // The indexer passes the height it just read, so a deadline is judged against this block, not the last one.
    const height = Number.isInteger(currentHeight) ? currentHeight : tip();
    if (!Number.isInteger(height) || height <= 0) return { checked: 0, funded: 0 };
    const rows = q.awaiting.all();
    let funded = 0;
    for (const row of rows) {
      let inst = null;
      try {
        inst = await rpc('getObjectInstances', [row.opening_hex, 0, 8], 15_000);
      } catch { continue; }
      const slot = (inst?.slots || []).find((s) => s && s.slot_index != null);
      if (slot) {
        const now = Date.now();
        if (q.fund.run(slot.slot_index, Number(slot.creation_id ?? 0), now, now, now + row.secs * 1000, row.id).changes === 1) {
          funded += 1;
          if (row.kind === 'api') {
            const acct = row.account || byWallet(row.payer)?.id || null;
            if (acct) {
              try { onApiTime(acct, row.secs, row.id); } catch { /* a grant that fails is retried by the next pass */ }
            }
          }
        }
        continue;
      }
      if (height > row.deadline_height) q.miss.run(row.id);
    }
    // A finished promotion stops being live the moment its window closes.
    const now = Date.now();
    for (const row of q.live.all()) if (row.ends && row.ends <= now) q.finish.run(row.id);
    return { checked: rows.length, funded };
  }

  function statuses(account) {
    const rows = account ? q.forAccount.all(account) : [];
    return { orders: rows.map((r) => shape(r)) };
  }
  function mine(payer) {
    if (!ADDR.test(String(payer || ''))) throw bad('expected an o1 address');
    return { orders: q.forPayer.all(payer).map((r) => shape(r)) };
  }
  function status(id) {
    const row = q.byId.get(String(id || ''));
    return row ? shape(row) : null;
  }
  // What Explore shows for a live, paid promotion: the same shape a paid boost has,
  // so the existing "Promoted" panel and its disclaimer carry it unchanged.
  function promotions(now = Date.now()) {
    return q.livePromos.all(now).map((r) => ({ asset_id: r.asset_id, kind: 'token', ends: r.ends, noid: r.noid, pack: 'noid' }));
  }
  function isPromoted(assetId, now = Date.now()) {
    return !!q.liveAsset.get(now, String(assetId || '').toLowerCase());
  }
  // A promotion someone paid for must be visible on the token page too, with the same words.
  function tierLabel(noid) {
    const t = termFor('promo', noid);
    return t ? t.label : `${noid} NOID`;
  }
  // The ratio the page shows under the slider: what one NOID buys at this point on the curve.
  function rateAt(kind, noid) {
    const t = termFor(kind, noid);
    return t ? { noid: t.noid, secs: t.secs, label: t.label, secs_per_noid: Math.round(t.secs / t.noid) } : null;
  }

  return {
    create, watch, status, statuses, mine, promotions, isPromoted, tierLabel, rateAt,
    terms: termsFor, tiers: { promo: PROMO_TIERS, api: API_TIERS }, min: MIN_NOID, max: MAX_NOID,
    disclaimer: 'Paid promotion. Not a recommendation or endorsement by NOID Scan.',
    payee: payeeFor,
  };
};
