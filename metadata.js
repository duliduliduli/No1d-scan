// Native asset metadata: the names, tickers and logos behind Parano1d's v2.1 tokens.
//
// The chain itself carries no label. What it does carry is a metadata digest: the
// FungibleDefinition opening (kind 1) of every launched token commits to a 32-byte
// hash, and that hash addresses a manifest published by the protocol's own media
// service. So the sourcing chain is:
//
//   catalogue -> kind-1 opening -> digest -> media manifest -> name / symbol / image
//
// The manifest is content addressed, so we verify before we trust it: BLAKE3 over
// b"Parano1d/native-metadata/v1\0" || the canonical body must equal the digest taken
// from the chain. A manifest that does not verify is stored as unusable and the token
// keeps its hex fallback rather than showing a name nobody vouched for.
//
// Nothing here spends, signs or writes to the chain. Fetches are bounded (4 per pass,
// 8s timeout, 16 KiB manifests, 1.5 MiB images) and cached forever by hash, so the
// media service is contacted once per asset, not once per page view. Images are
// proxied through this server so a visitor's browser never talks to the third party.
'use strict';

const { blake3Hex } = require('./blake3.js');

// The domain separator the protocol's wallet uses (noid_gui/src/assets/media.rs).
const DOMAIN = Buffer.from('Parano1d/native-metadata/v1\0', 'utf8');
// Same default the wallet GUI ships with (noid_gui/src/assets/media/transport.rs).
const DEFAULT_ORIGIN = 'https://tradedata.parano1d.org/';

const HEX64 = /^[0-9a-f]{64}$/;
const MAX_MANIFEST = 16 * 1024;
const MAX_IMAGE = 1536 * 1024;
const FETCH_MS = 8000;

module.exports = function metadata(db, rpc, opts = {}) {
  const origin = String(opts.origin || process.env.MEDIA_ORIGIN || DEFAULT_ORIGIN);
  const every = Number(opts.everyMs || process.env.METADATA_EVERY_MS || 10 * 60_000);
  const perPass = Number(opts.perPass || process.env.METADATA_PER_PASS || 4);
  const on = opts.enabled !== undefined ? !!opts.enabled : process.env.METADATA_OFF !== 'true';

  db.exec(`
    create table if not exists asset_meta (
      hash text primary key, name text, symbol text, description text, website text,
      image_hash text, body text, verified integer not null default 0, checked integer not null);
    create table if not exists asset_image (
      hash text primary key, media_type text not null, bytes blob not null, checked integer not null);
    -- The labels live here, keyed by asset id, so they survive a token row being rebuilt
    -- by the indexer and so the snapshot can read them before inserting its own row.
    create table if not exists asset_label (
      id text primary key, name text not null, ticker text, logo text, hash text not null, updated integer not null);`);

  const q = {
    meta: db.prepare('select * from asset_meta where hash = ?'),
    putMeta: db.prepare(`insert or replace into asset_meta
      (hash, name, symbol, description, website, image_hash, body, verified, checked) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    img: db.prepare('select media_type, bytes from asset_image where hash = ?'),
    putImg: db.prepare('insert or replace into asset_image (hash, media_type, bytes, checked) values (?, ?, ?, ?)'),
    putLabel: db.prepare(`insert or replace into asset_label (id, name, ticker, logo, hash, updated) values (?, ?, ?, ?, ?, ?)`),
    label: db.prepare('select * from asset_label where id = ?'),
    allLabels: db.prepare('select id, name, ticker, logo from asset_label'),
    counts: db.prepare('select (select count(*) from asset_meta) m, (select count(*) from asset_meta where verified = 1) v, (select count(*) from asset_image) i'),
  };

  // Push a label onto the live token row when the row disagrees with it. All three
  // fields are compared: a name that already matched used to leave a missing logo behind.
  function mirror(id, lab) {
    const ts = tokenStmtsFor();
    if (!ts) return;
    const tok = ts.get.get(id);
    if (tok && (tok.name !== lab.name || tok.ticker !== lab.ticker || (lab.logo || null) !== (tok.logo || null))) {
      ts.put.run(lab.name, lab.ticker, lab.logo, id);
    }
  }

  // The tokens table belongs to the indexer, so this module runs on a database that may
  // not have it yet (a fresh file, or a unit test). Prepared lazily, and skipped if absent.
  let tokenStmts;
  const tokenStmtsFor = () => {
    if (tokenStmts === undefined) {
      try {
        tokenStmts = {
          get: db.prepare('select id, name, ticker, logo from tokens where id = ?'),
          put: db.prepare('update tokens set name = ?, ticker = ?, logo = ? where id = ?'),
        };
      } catch { tokenStmts = null; }
    }
    return tokenStmts;
  };

  const status = { origin, available: null, tokens: 0, verified: 0, named: 0, fetched: 0, cached: 0, images: 0, error: null, at: null };

  // --- chain side ---------------------------------------------------------
  // A FungibleDefinition opening is: 8-byte magic, u16 version, u16 kind, then
  // field_count() 16-byte little-endian fields. Fields 5 and 6 are the low and high
  // halves of the metadata digest (noid_tx/src/native_assets.rs, fields_digest).
  function digestFromOpening(hex) {
    const s = String(hex || '').toLowerCase();
    if (!/^[0-9a-f]+$/.test(s) || s.length !== 280 || s.slice(0, 16) !== '4e4f494441533231') return null;
    if (s.slice(16, 20) !== '0100' || s.slice(20, 24) !== '0100') return null;
    const digest = s.slice(184, 248);
    return HEX64.test(digest) ? digest : null;
  }

  // The catalogue takes positional params: kind, cursor (null for the first page), limit.
  async function catalog(kind, max = 4) {
    const items = [];
    let cursor = null;
    for (let i = 0; i < max; i++) {
      const page = await rpc('getNativeCatalog', [kind, cursor, 64], 12_000);
      if (Array.isArray(page?.items)) items.push(...page.items);
      if (!page?.next) break;
      cursor = page.next;
    }
    return items;
  }

  // --- media side ---------------------------------------------------------
  const url = (path) => new URL(path, origin).toString();

  async function get(path, limit) {
    const res = await fetch(url(path), { signal: AbortSignal.timeout(FETCH_MS), redirect: 'error', headers: { accept: '*/*' } });
    if (!res.ok) throw new Error(`media ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > limit) throw new Error('media too large');
    return { buf, type: res.headers.get('content-type') || '' };
  }

  // serde_json's canonical bytes: the struct's fields in declaration order, no spaces,
  // optional fields dropped when absent and empty strings dropped. Needed because a
  // re-serialised copy of a manifest hashes differently from the bytes served for it.
  function canonical(man) {
    const parts = [`"schema":${Number(man.schema) || 0}`, `"kind":${JSON.stringify(String(man.kind))}`,
      `"name":${JSON.stringify(String(man.name || ''))}`];
    if (man.symbol != null) parts.push(`"symbol":${JSON.stringify(String(man.symbol))}`);
    if (man.description) parts.push(`"description":${JSON.stringify(String(man.description))}`);
    if (man.website != null) parts.push(`"website":${JSON.stringify(String(man.website))}`);
    if (man.image && typeof man.image === 'object') {
      const i = man.image;
      parts.push(`"image":{"hash":${JSON.stringify(String(i.hash || ''))},"media_type":${JSON.stringify(String(i.media_type || ''))},"width":${Number(i.width) || 0},"height":${Number(i.height) || 0},"bytes":${Number(i.bytes) || 0}}`);
    }
    return `{${parts.join(',')}}\n`;
  }

  // Fetch a manifest once, verify it against the on-chain digest, cache the verdict.
  async function manifest(hash, { force = false } = {}) {
    if (!HEX64.test(String(hash || ''))) return null;
    if (!force) {
      const row = q.meta.get(hash);
      if (row) return row.verified ? row : null;
    }
    let row = { hash, name: null, symbol: null, description: null, website: null, image_hash: null, body: null, verified: 0 };
    try {
      const { buf } = await get(`metadata/${hash}.json`, MAX_MANIFEST);
      const body = buf.toString('utf8');
      const man = JSON.parse(body);
      const raw = blake3Hex(buf, DOMAIN);
      const okRaw = raw === hash;
      const okCanon = !okRaw && man && man.schema !== undefined
        && blake3Hex(Buffer.from(canonical(man), 'utf8'), DOMAIN) === hash;
      if (!okRaw && !okCanon) throw new Error('hash mismatch');
      if (String(man.kind) !== 'token' || !man.name) throw new Error('not a token manifest');
      const cut = (s, n) => (typeof s === 'string' && s ? s.slice(0, n) : null);
      row = {
        hash, name: cut(man.name, 80), symbol: cut(man.symbol, 16),
        description: cut(man.description, 400), website: cut(man.website, 200),
        image_hash: man.image && HEX64.test(String(man.image.hash || '')) ? String(man.image.hash) : null,
        body, verified: 1,
      };
      status.verified++;
    } catch (e) {
      status.error = e.message;
      status.available = false;
    }
    q.putMeta.run(row.hash, row.name, row.symbol, row.description, row.website, row.image_hash, row.body, row.verified, Math.floor(Date.now() / 1000));
    status.fetched++;
    return row.verified ? row : null;
  }

  // Logos are proxied and kept here, so the page never loads an image from the media
  // service directly and a later outage cannot blank the screener.
  async function image(hash) {
    if (!HEX64.test(String(hash || ''))) return null;
    const hit = q.img.get(hash);
    if (hit) return hit;
    try {
      const { buf, type } = await get(`images/${hash}.png`, MAX_IMAGE);
      const media = /^image\//.test(type) ? type.split(';')[0] : 'image/png';
      q.putImg.run(hash, media, buf, Math.floor(Date.now() / 1000));
      return { media_type: media, bytes: buf };
    } catch (e) {
      status.error = e.message;
      return null;
    }
  }

  // --- wiring -------------------------------------------------------------
  // One pass: read the markets catalogue, decode each digest, label any token whose
  // manifest verifies and whose row is not already carrying that name.
  async function refresh(opts2 = {}) {
    // The budget is per pass, not per process: without a local counter the first four
    // manifests would be the only four ever fetched. Boot passes ask for a bigger one.
    const budget = Number(opts2.perPass || perPass);
    let fetches = 0;
    const out = { markets: 0, labelled: 0, fetched: 0 };
    // Rows written before their manifest was fetched still need the label: the indexer
    // rebuilds a token row from the catalogue on its own schedule, so catch up here.
    for (const lab of q.allLabels.all()) mirror(lab.id, lab);
    try {
      const items = await catalog('markets');
      out.markets = items.length;
      const seen = new Set();
      for (const m of items) {
        const defi = (Array.isArray(m.related) ? m.related : []).find((h) => Number(h?.kind) === 1);
        const id = String(m.key || '').replace(/^[0-9a-fA-F]{4}/, '');
        if (!defi || !HEX64.test(id)) continue;
        const digest = digestFromOpening(defi.opening_hex);
        if (!digest) continue;
        seen.add(id);
        const known = q.label.get(id);
        if (known && known.hash === digest) {
          // Already labelled for this exact digest: only make sure the live row agrees.
          mirror(id, known);
          out.labelled++;
          continue;
        }
        const cached = q.meta.get(digest);
        if (!cached && fetches >= budget) continue;
        if (!cached) fetches++;
        const man = await manifest(digest);
        if (!man) continue;
        const ticker = man.symbol || id.slice(0, 8).toUpperCase();
        const logo = man.image_hash ? `/api/asset-image/${man.image_hash}.png` : null;
        q.putLabel.run(id, man.name, ticker, logo, digest, Math.floor(Date.now() / 1000));
        mirror(id, { name: man.name, ticker, logo });
        if (man.image_hash) image(man.image_hash).catch(() => {});
        out.labelled++;
      }
      out.fetched = fetches;
      status.tokens = seen.size;
      status.named = out.labelled;
      status.available = true;
      status.error = null;
      status.at = Date.now();
      const c = q.counts.get();
      status.cached = c.m; status.verified = c.v; status.images = c.i;
    } catch (e) {
      status.available = false;
      status.error = e.message;
    }
    return out;
  }

  let timer = null;
  function start() {
    if (!on || timer) return;
    const tick = (o) => { refresh(o).catch((e) => { status.error = e.message; }); };
    // Quick passes at boot, with double the budget, label the whole catalogue within a
    // minute or two. After that the cadence is slow: nothing changes once a manifest is cached.
    setTimeout(() => tick({ perPass: perPass * 2 }), 8_000).unref?.();
    setTimeout(() => tick({ perPass: perPass * 2 }), 40_000).unref?.();
    setTimeout(() => tick({ perPass: perPass * 2 }), 120_000).unref?.();
    timer = setInterval(tick, Math.max(60_000, every));
    timer.unref?.();
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { digestFromOpening, canonical, manifest, image, refresh, start, stop, status, origin, catalog, DOMAIN };
};
