// Paid promoted slots. A row stays hidden until it is paid and an admin approves it.
// It leaves the promoted section on its own when `ends` passes. It is not part of Explore's sort.
const { randomBytes } = require('node:crypto');

const ID = /^[A-Za-z0-9:_-]{1,80}$/;
const DISCLAIMER = 'Paid promotion. Not a recommendation or endorsement by NOID Scan.';
const bad = (m, status = 400) => Object.assign(new Error(m), { status });

function packs() {
  const raw = process.env.BOOST_PACKS ?? '12:6h,40:1d,100:7d';
  const out = [];
  for (const part of String(raw).split(',')) {
    const m = part.trim().match(/^(\d+):(\d+)([hd])$/i);
    if (!m) continue;
    const usdc = Number(m[1]);
    const n = Number(m[2]);
    const secs = (m[3].toLowerCase() === 'd' ? n * 86400 : n * 3600);
    if (!Number.isInteger(usdc) || usdc < 1 || usdc > 1_000_000 || n < 1 || secs > 90 * 86400) continue;
    const id = `${n}${m[3].toLowerCase()}`;
    if (out.some((p) => p.id === id)) continue;
    out.push({ id, usdc, secs, label: id });
  }
  return out.slice(0, 8);
}

module.exports = function boosts(db, lookup) {
  db.exec(`
    create table if not exists boosts (
      id text primary key, asset_id text not null, kind text not null, account text not null,
      pack text not null, usdc integer not null, secs integer not null, status text not null,
      pay_ref text, created integer not null, reviewed integer, starts integer, ends integer);
    create index if not exists boosts_live on boosts(status, ends);
    create index if not exists boosts_asset on boosts(asset_id, status);
  `);
  // Profile extras bought with a promoted slot (Promote page). Shown only while the slot is live.
  for (const col of ['website text', 'twitter text', 'banner blob', 'banner_type text']) try { db.exec(`alter table boosts add column ${col}`); } catch {}
  const q = {
    byId: db.prepare('select * from boosts where id = ?'),
    open: db.prepare("select id, account, status from boosts where asset_id = ? and status = ? limit 1"),
    insert: db.prepare(`insert into boosts (id, asset_id, kind, account, pack, usdc, secs, status, created)
      values (?, ?, ?, ?, ?, ?, ?, 'unpaid', ?)`),
    updateUnpaid: db.prepare("update boosts set pack = ?, usdc = ?, secs = ? where id = ? and account = ? and status = 'unpaid'"),
    pay: db.prepare("update boosts set status = 'pending', pay_ref = ? where id = ? and account = ? and status = 'unpaid'"),
    review: db.prepare('update boosts set status = ?, reviewed = ?, starts = ?, ends = ? where id = ? and status = ?'),
    pending: db.prepare("select id, asset_id, kind, pack, usdc, secs, created, website, twitter, banner is not null has_banner from boosts where status = 'pending'"),
    setExtras: db.prepare("update boosts set website = ?, twitter = ?, banner = ?, banner_type = ? where id = ? and status = 'unpaid'"),
    liveExtras: db.prepare("select website, twitter, banner is not null has_banner from boosts where asset_id = ? and status = 'live' and ends > ? order by ends desc limit 1"),
    liveBanner: db.prepare("select banner, banner_type from boosts where asset_id = ? and status = 'live' and ends > ? and banner is not null order by ends desc limit 1"),
    anyBanner: db.prepare('select banner, banner_type from boosts where id = ? and banner is not null'),
    live: db.prepare("select id, asset_id, kind, pack, usdc, ends from boosts where status = 'live' and ends > ? order by ends"),
    expire: db.prepare("update boosts set status = 'expired' where status = 'live' and ends <= ?"),
  };

  // shortcut: expiry runs on the next list, create, or admin read, not on a timer. Add a timer if a row must flip while nobody is reading.
  function expire(now = Date.now()) {
    q.expire.run(now);
  }
  function shape(row, asset, demo) {
    return {
      id: row.id, asset_id: row.asset_id, kind: row.kind, until: row.ends ?? row.until, pack: row.pack, usdc: row.usdc,
      label: 'Promoted', asset,
    };
  }
  function rowsFor(params) {
    const demo = params.get('demo') === '1' || process.env.TOKENS_DEMO === '1';
    const kind = params.get('kind') === 'collection' ? 'collection' : params.get('kind') === 'token' ? 'token' : '';
    const asset = params.get('asset') || '';
    if (asset && !ID.test(asset)) throw bad('expected a token or collection id');
    const now = Date.now();
    const src = demo
      ? [
        { id: 'demo-gcat', asset_id: 'gcat', kind: 'token', pack: '1d', usdc: 40, ends: now + 86400000 },
        { id: 'demo-stamps', asset_id: 'stamps', kind: 'collection', pack: '1d', usdc: 40, ends: now + 86400000 },
      ]
      : (expire(now), q.live.all(now));
    return {
      demo,
      boosts: src.filter((r) => (!kind || r.kind === kind) && (!asset || r.asset_id === asset)).map((r) => {
        const found = lookup(r.kind, r.asset_id, demo);
        return found ? shape(r, found, demo) : null;
      }).filter(Boolean),
    };
  }
  function list(params) {
    const page = rowsFor(params);
    return { ...page, label: 'Promoted', disclaimer: DISCLAIMER, packs: packs() };
  }

  function create(acct, body, extras = null) {
    const out = createRow(acct, body);
    if (extras) q.setExtras.run(extras.website ?? null, extras.twitter ?? null, extras.banner?.bytes ?? null, extras.banner?.type ?? null, out.id);
    return out;
  }
  function createRow(acct, body) {
    const kind = body?.kind === 'collection' ? 'collection' : body?.kind === 'token' ? 'token' : '';
    if (!kind || !ID.test(body?.asset_id || '')) throw bad('expected a token or collection id');
    const pack = packs().find((p) => p.id === body.pack);
    if (!pack) throw bad('unknown pack');
    if (!lookup(kind, body.asset_id, false)) throw bad('that listing is not on the explorer yet');
    expire();
    if (q.open.get(body.asset_id, 'live')) throw bad('this listing is already promoted');
    if (q.open.get(body.asset_id, 'pending')) throw bad('this listing is already in review');
    const open = q.open.get(body.asset_id, 'unpaid');
    if (open && open.account !== acct.id) throw bad('someone else has already started a promoted slot for this listing');
    if (open) {
      q.updateUnpaid.run(pack.id, pack.usdc, pack.secs, open.id, acct.id);
      return { id: open.id, status: 'unpaid', usdc: pack.usdc, pack: pack.id, asset_id: body.asset_id, kind };
    }
    const id = randomBytes(8).toString('hex');
    q.insert.run(id, body.asset_id, kind, acct.id, pack.id, pack.usdc, pack.secs, Date.now());
    return { id, status: 'unpaid', usdc: pack.usdc, pack: pack.id, asset_id: body.asset_id, kind };
  }

  function ownedUnpaid(account, id) {
    const row = q.byId.get(id || '');
    if (!row || row.account !== account || row.status !== 'unpaid') return null;
    return row;
  }
  function markPaid(id, ref, account) {
    const row = q.byId.get(id || '');
    if (!row || (account && row.account !== account)) return false;
    if (row.status === 'pending' && row.pay_ref === ref) return true;
    if (row.status !== 'unpaid') return false;
    return q.pay.run(ref, id, row.account).changes === 1;
  }
  function view(acct, id) {
    const row = q.byId.get(id || '');
    if (!row || !acct || row.account !== acct.id) return null;
    return { id: row.id, asset_id: row.asset_id, kind: row.kind, status: row.status, usdc: row.usdc, pack: row.pack, until: row.ends ?? null };
  }
  function adminList() {
    expire();
    return q.pending.all().sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1));
  }
  function review(id, action) {
    if (action !== 'approve' && action !== 'reject') throw bad('action must be approve or reject');
    const row = q.byId.get(id || '');
    if (!row || row.status !== 'pending') return null;
    expire();
    if (action === 'approve' && q.open.get(row.asset_id, 'live')) throw bad('this listing is already promoted');
    const now = Date.now();
    const status = action === 'approve' ? 'live' : 'rejected';
    const starts = action === 'approve' ? now : null;
    const ends = action === 'approve' ? now + row.secs * 1000 : null;
    if (q.review.run(status, now, starts, ends, id, 'pending').changes !== 1) return null;
    return { id, status, until: ends };
  }

  // Extras (website, X, banner) for a listing with a live, approved slot; null otherwise.
  function extrasFor(assetId, now = Date.now()) {
    const row = q.liveExtras.get(assetId, now);
    if (!row || (!row.website && !row.twitter && !row.has_banner)) return null;
    return { website: row.website || null, twitter: row.twitter || null, banner: !!row.has_banner };
  }
  function banner(assetId) {
    const row = q.liveBanner.get(assetId, Date.now());
    return row ? { bytes: row.banner, type: row.banner_type } : null;
  }
  function adminBanner(id) {
    const row = q.anyBanner.get(id || '');
    return row ? { bytes: row.banner, type: row.banner_type } : null;
  }

  return { list, create, extrasFor, banner, adminBanner, ownedUnpaid, markPaid, view, adminList, review, packs, disclaimer: DISCLAIMER };
};
