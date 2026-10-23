// Enhanced token profiles. A submission stays hidden until it is paid and an admin approves it.
// Unpaid, pending and rejected rows are not part of the public token payload.
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const images = require('./images.js');

const ID = /^[A-Za-z0-9:_-]{1,80}$/;
const bad = (m, status = 400) => Object.assign(new Error(m), { status });

function priceUsdc() {
  const n = Number(process.env.ENHANCED_PROFILE_USDC ?? 100);
  return Number.isInteger(n) && n >= 1 && n <= 1_000_000 ? n : 100;
}
function priceUsd() {
  if (process.env.ENHANCED_PROFILE_USD == null || process.env.ENHANCED_PROFILE_USD === '') return priceUsdc();
  const n = Number(process.env.ENHANCED_PROFILE_USD);
  return Number.isInteger(n) && n >= 1 && n <= 100_000 ? n : priceUsdc();
}

function cleanText(s) {
  if (typeof s !== 'string') throw bad('description is required');
  const t = s.replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length < 1 || t.length > 200) throw bad('description must be 1–200 characters');
  return t;
}
function httpsUrl(s, kind) {
  if (s == null || s === '') return null;
  if (typeof s !== 'string' || s.length > 300) throw bad(`${kind} must be an https link`);
  let u;
  try { u = new URL(s); } catch { throw bad(`${kind} must be an https link`); }
  if (u.protocol !== 'https:' || u.username || u.password) throw bad(`${kind} must be an https link`);
  if (kind === 'X') {
    const host = u.hostname.replace(/^www\./, '');
    if (host !== 'x.com' && host !== 'twitter.com') throw bad('X link must be https://x.com/…');
    const handle = u.pathname.split('/').filter(Boolean)[0] || '';
    if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw bad('X link must be https://x.com/name');
    return `https://x.com/${handle}`;
  }
  if (!u.hostname.includes('.')) throw bad('website must be an https link');
  return u.origin + u.pathname + u.search + u.hash;
}
function b64(s, kind) {
  if (typeof s !== 'string') throw bad(`${kind} image is required`);
  const raw = s.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '');
  if (raw.length > 2_000_000) throw bad(`${kind} image is too large`);
  const buf = Buffer.from(raw, 'base64');
  if (!buf.length) throw bad(`${kind} image is required`);
  return buf;
}

const demoImg = { banner: null, icon: null };
function demoBytes(kind) {
  if (kind === 'banner') demoImg.banner ??= images.solidPng(900, 300, [12, 28, 32]);
  else demoImg.icon ??= images.solidPng(64, 64, [168, 245, 233]);
  return kind === 'banner' ? demoImg.banner : demoImg.icon;
}
function demoProfile(id) {
  const samples = {
    gcat: ['Night market ghost cat. Sample enhanced profile, not a paid listing.', 'https://example.com/gcat', 'https://x.com/ghostcat'],
    stamps: ['Night stamps, printed once. Sample enhanced profile, not a paid listing.', 'https://example.com/stamps', 'https://x.com/nightstamps'],
  };
  const row = samples[id];
  if (!row) return null;
  const q = '?demo=1';
  return {
    description: row[0], website: row[1], twitter: row[2],
    icon: `/api/profile-media/${id}/icon${q}`,
    banner: `/api/profile-media/${id}/banner${q}`,
  };
}

// Optional extras sent with a promoted slot from the Promote page: banner, website and X. All optional.
function extras(body) {
  const website = httpsUrl(body?.website, 'website');
  const twitter = httpsUrl(body?.twitter, 'X');
  const banner = body?.banner ? images.prepare(b64(body.banner, 'banner'), 'banner') : null;
  return website || twitter || banner ? { website, twitter, banner } : null;
}

module.exports = function profiles(db, fallback = null) {
  db.exec(`
    create table if not exists token_profiles (
      id text primary key, token_id text not null, account text not null,
      description text not null, website text, twitter text,
      icon blob not null, icon_type text not null, banner blob not null, banner_type text not null,
      status text not null, pay_ref text unique, created integer not null, reviewed integer);
    create index if not exists token_profiles_tok on token_profiles(token_id, status);
    create index if not exists token_profiles_status on token_profiles(status, token_id);
  `);
  const q = {
    byId: db.prepare('select id, token_id, account, description, website, twitter, status, pay_ref, created from token_profiles where id = ?'),
    byTokenStatus: db.prepare('select id, account, status from token_profiles where token_id = ? and status = ? limit 1'),
    insert: db.prepare(`insert into token_profiles (id, token_id, account, description, website, twitter, icon, icon_type, banner, banner_type, status, created)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', ?)`),
    updateUnpaid: db.prepare(`update token_profiles set description = ?, website = ?, twitter = ?, icon = ?, icon_type = ?, banner = ?, banner_type = ?
      where id = ? and account = ? and status = 'unpaid'`),
    pay: db.prepare("update token_profiles set status = 'pending', pay_ref = ? where id = ? and account = ? and status = 'unpaid'"),
    review: db.prepare("update token_profiles set status = ?, reviewed = ? where id = ? and status = 'pending'"),
    pending: db.prepare("select id, token_id, description, website, twitter, created from token_profiles where status = 'pending'"),
    approved: db.prepare("select token_id, description, website, twitter from token_profiles where status = 'approved'"),
    pubImg: db.prepare("select icon, icon_type, banner, banner_type from token_profiles where token_id = ? and status = 'approved' limit 1"),
    anyImg: db.prepare('select icon, icon_type, banner, banner_type from token_profiles where id = ?'),
  };

  function fields(body) {
    if (!ID.test(body?.token_id || '')) throw bad('expected a token or collection id');
    const description = cleanText(body.description);
    const website = httpsUrl(body.website, 'website');
    const twitter = httpsUrl(body.twitter, 'X');
    const icon = images.prepare(b64(body.icon, 'icon'), 'icon');
    const banner = images.prepare(b64(body.banner, 'banner'), 'banner');
    return { token_id: body.token_id, description, website, twitter, icon, banner };
  }

  function create(acct, body) {
    const f = fields(body);
    for (const status of ['approved', 'pending']) {
      if (q.byTokenStatus.get(f.token_id, status)) throw bad(status === 'approved' ? 'this token already has an enhanced profile' : 'this token is already in review');
    }
    const open = q.byTokenStatus.get(f.token_id, 'unpaid');
    if (open && open.account !== acct.id) throw bad('someone else has already started an enhanced profile for this token');
    if (open) {
      q.updateUnpaid.run(f.description, f.website, f.twitter, f.icon.bytes, f.icon.type, f.banner.bytes, f.banner.type, open.id, acct.id);
      return { id: open.id, status: 'unpaid', usd: priceUsd(), usdc: priceUsdc(), token_id: f.token_id };
    }
    const id = randomBytes(8).toString('hex');
    q.insert.run(id, f.token_id, acct.id, f.description, f.website, f.twitter, f.icon.bytes, f.icon.type, f.banner.bytes, f.banner.type, Date.now());
    return { id, status: 'unpaid', usd: priceUsd(), usdc: priceUsdc(), token_id: f.token_id };
  }

  function ownedUnpaid(account, id) {
    const row = q.byId.get(id || '');
    if (!row || row.account !== account || row.status !== 'unpaid') return null;
    return row;
  }

  // Called inside the payment transaction. Replay of the same ref is a no-op success.
  function markPaid(id, ref, account) {
    const row = q.byId.get(id || '');
    if (!row || (account && row.account !== account)) return false;
    if (row.status === 'pending' && row.pay_ref === ref) return true;
    if (row.status !== 'unpaid') return false;
    const ok = q.pay.run(ref, id, row.account).changes === 1;
    if (ok) bust();
    return ok;
  }

  function view(acct, id) {
    const row = q.byId.get(id || '');
    if (!row || !acct || row.account !== acct.id) return null;
    return { id: row.id, token_id: row.token_id, status: row.status, usd: priceUsd(), usdc: priceUsdc(), description: row.description, website: row.website, twitter: row.twitter };
  }

  function adminOk(token) {
    const want = process.env.ADMIN_TOKEN;
    if (!want || typeof token !== 'string' || !token) return false;
    const a = createHash('sha256').update(token).digest();
    const b = createHash('sha256').update(want).digest();
    return timingSafeEqual(a, b);
  }
  function adminList() {
    return q.pending.all().sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1));
  }
  function review(id, action) {
    if (action !== 'approve' && action !== 'reject') throw bad('action must be approve or reject');
    const row = q.byId.get(id || '');
    if (!row || row.status !== 'pending') return null;
    if (action === 'approve' && q.byTokenStatus.get(row.token_id, 'approved')) throw bad('this token already has an enhanced profile');
    if (q.review.run(action === 'approve' ? 'approved' : 'rejected', Date.now(), id).changes !== 1) return null;
    bust();
    return { id, status: action === 'approve' ? 'approved' : 'rejected' };
  }

  let cache = { at: 0, rows: [] };
  const bust = () => { cache.at = 0; };
  function approvedRows() {
    if (Date.now() - cache.at > 2000) cache = { at: Date.now(), rows: q.approved.all() };
    return cache.rows;
  }
  function decorate(out) {
    if (!out || out.error) return out;
    const demo = !!out.demo;
    const rows = demo ? null : approvedRows();
    const apply = (t) => {
      if (!t?.id) return t;
      const e = demo ? demoProfile(t.id) : rows.find((r) => r.token_id === t.id);
      if (!e) {
        // A live promoted slot bought with extras shows its banner and links, nothing else. No row, no banner.
        const x = !demo && fallback?.extras?.(t.id);
        if (!x) return { ...t, enhanced: null };
        return { ...t, enhanced: { description: null, website: x.website, twitter: x.twitter, icon: null,
          banner: x.banner ? `/api/profile-media/${encodeURIComponent(t.id)}/banner` : null, source: 'promote' } };
      }
      const full = demo ? e : {
        description: e.description, website: e.website, twitter: e.twitter,
        icon: `/api/profile-media/${encodeURIComponent(t.id)}/icon`,
        banner: `/api/profile-media/${encodeURIComponent(t.id)}/banner`,
      };
      return { ...t, enhanced: full, logo: full.icon };
    };
    const next = { ...out, enhance_usd: priceUsd(), enhance_usdc: priceUsdc() };
    if (next.tokens) next.tokens = next.tokens.map(apply);
    if (next.token) next.token = apply(next.token);
    if (next.collections) next.collections = next.collections.map(apply);
    if (next.collection) next.collection = apply(next.collection);
    return next;
  }

  function image(tokenId, kind, params) {
    if (kind !== 'icon' && kind !== 'banner') return null;
    if (!ID.test(tokenId || '')) return null;
    if (params.get('demo') === '1') {
      if (tokenId !== 'gcat' && tokenId !== 'stamps') return null;
      return { bytes: demoBytes(kind), type: 'image/png' };
    }
    const row = q.pubImg.get(tokenId);
    if (!row) return kind === 'banner' ? fallback?.banner?.(tokenId) ?? null : null;
    return kind === 'icon' ? { bytes: row.icon, type: row.icon_type } : { bytes: row.banner, type: row.banner_type };
  }
  function adminImage(id, kind) {
    if (kind !== 'icon' && kind !== 'banner') return null;
    const row = q.anyImg.get(id || '');
    if (!row) return kind === 'banner' ? fallback?.adminBanner?.(id) ?? null : null;
    return kind === 'icon' ? { bytes: row.icon, type: row.icon_type } : { bytes: row.banner, type: row.banner_type };
  }

  const setFallback = (f) => { fallback = f; bust(); };
  return { extras, setFallback, create, ownedUnpaid, markPaid, view, adminOk, adminList, review, decorate, image, adminImage, priceUsd, priceUsdc };
};
