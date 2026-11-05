// Native metadata: the chain digest decode, BLAKE3 against the protocol's own vectors,
// manifest verification, the catalogue param shape, and the logo proxy route.
// Runs standalone: `node --test test-meta.js`.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

// Real material, taken from the live chain and the live media service on 2026-11-05.
const NEMO_OPENING = '4e4f4944415332310100010026dd19b5a9c4431ede91f25ed1fb7df69ae85f77eab2b8d3c87e83dd9b58ff0a44debe431ab3aa6c05d30952ff5bfdab4639222751430a941393a026baba0cda0010a5d4e8000000010000000000000051fe6035b00718df7e4bb34a5f092cb2d1a10cf44fafe5d5fb0850e5ee1dce8700000000000000000000000000000000';
const NEMO_ASSET = '26dd19b5a9c4431ede91f25ed1fb7df69ae85f77eab2b8d3c87e83dd9b58ff0a';
const NEMO_META = '51fe6035b00718df7e4bb34a5f092cb2d1a10cf44fafe5d5fb0850e5ee1dce87';
const NEMO_IMAGE = '6630e8511c3f13dab51381bd565434d16226b48133ff98e1eadee4e1746c0f3d';
// The exact bytes the media service serves for NEMO_META (292 bytes, canonical serde JSON).
// canonical_bytes() is serde JSON plus a trailing newline, and that newline is part of
// what gets hashed, so it has to be in the fixture.
const NEMO_BODY = '{"schema":1,"kind":"token","name":"Ignotus Nemo","symbol":"NEMO","description":"we are all ignotus nemo","website":"https://ignotusnemo.com/","image":{"hash":"' + NEMO_IMAGE + '","media_type":"image/png","width":400,"height":400,"bytes":389081}}\n';
// TIN has a real digest on chain but the media service has no manifest for it.
const TIN_OPENING = '4e4f494441533231010001009ff7e073e2d7707327b968e930b509376441e676d47d9d496315af8239bec7b93efd83673afc4aee5bd66e1be3ecb52d319a004a36861c86378e1e425e86328f0010a5d4e800000001000000000000005b0b585999b416501c2ac53d6dab294aae48d3ee26d1619bb96ad622a02a666200000000000000000000000000000000';
const TIN_ASSET = '9ff7e073e2d7707327b968e930b509376441e676d47d9d496315af8239bec7b9';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex');

const { blake3Hex } = require('./blake3.js');

// A well-formed FungibleDefinition opening for a fixture asset, with the digest at fields
// 5 and 6 where the chain puts it.
const MOON_ASSET = '073782e1e56ab410d5b33609f21b517726a3c6d0e4533ee232a0b3a6a44e2f1b';
const MOON_META = 'f80af7d6ff6c23e6c1c4ba0b8a1e0f5a1b2c3d4e5f60718293a4b5c6d7e8f90a';
const MOON_OPENING = '4e4f49444153323101000100' + MOON_ASSET + '0'.repeat(64) + '0'.repeat(32) + MOON_META + '0'.repeat(32);
const { DatabaseSync } = require('node:sqlite');

const DOMAIN = Buffer.from('Parano1d/native-metadata/v1\0', 'utf8');

test('blake3 matches the reference vectors', () => {
  assert.strictEqual(blake3Hex(''), 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262');
  assert.strictEqual(blake3Hex('abc'), '6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85');
  // The tree layer, cross-checked against the reference blake3 crate (blake3 1.8.5) on
  // domain || 'a'*n. 1024 is one chunk, 1025 the first two-chunk tree, 3000 and 5000
  // deeper ones -- the case where merging the last chunk eagerly gives a wrong hash.
  for (const [n, want] of [
    [64, 'c9dd61a38ec63d20bdd8c4716db2b066400d294ff69b45912f99ea010b5d216d'],
    [1024, '84751ebefe078a3399b84fe82649ca379c105f7d4df66fe21c93688763e98205'],
    [1025, '8303079c435184cba8295f3b909aa16af3f69e97d313ce32cb54a4864c5aa189'],
    [2048, '0eddfa6170c37428519b942f49c741717c368906eab84215d022d40b3e451fde'],
    [3000, '11154962c949db526362d9fa11d142f2239d533b28c75ce694565da39c74eeb1'],
    [5000, 'd38ce12ca77bed0c2b60e361c42593fb573f080f44fd22e522050574625f23dc'],
  ]) assert.strictEqual(blake3Hex(Buffer.from('a'.repeat(n), 'utf8'), DOMAIN), want, `${n} bytes`);
  // The real manifest, hashed the way the protocol hashes it.
  assert.strictEqual(Buffer.byteLength(NEMO_BODY), 292);
  assert.strictEqual(blake3Hex(Buffer.from(NEMO_BODY, 'utf8'), DOMAIN), NEMO_META);
});

test('the metadata digest comes out of the chain opening', () => {
  const meta = require('./metadata.js')(new DatabaseSync(':memory:'), async () => null);
  assert.strictEqual(meta.digestFromOpening(NEMO_OPENING), NEMO_META);
  assert.strictEqual(meta.digestFromOpening(TIN_OPENING), '5b0b585999b416501c2ac53d6dab294aae48d3ee26d1619bb96ad622a02a6662');
  assert.strictEqual(meta.digestFromOpening(''), null);
  assert.strictEqual(meta.digestFromOpening('4e4f49444153323101000100'), null); // truncated
  assert.strictEqual(meta.digestFromOpening('4e4f49444153323101000200' + NEMO_OPENING.slice(24)), null); // a token balance page, not a definition
  assert.strictEqual(meta.digestFromOpening(NEMO_OPENING.replace('4e4f494441533231', '4e4f494441533232')), null); // bad magic
});

test('the catalogue is called with positional params and the labels reach the token row', async () => {
  const db = new DatabaseSync(':memory:');
  const calls = [];
  const rpc = async (method, params) => {
    calls.push([method, params]);
    if (method === 'getNativeCatalog') {
      assert.strictEqual(params[1], null, 'the first page passes a null cursor');
      assert.strictEqual(params[2], 64);
      // The snapshot also reads the collections and NFT listing catalogues; only markets
      // carry tokens here.
      if (params[0] !== 'markets') return { kind: params[0], items: [], next: null };
      // kind 3 is the backing reserve: 1e9 µNOID backs 1,000,000 whole tokens (0.001 NOID each).
      return { kind: 'markets', items: [{ key: '8000' + MOON_ASSET, primary: { kind: 33 }, related: [{ kind: 3, amount_micronoid: '1000000000' }, { kind: 1, opening_hex: MOON_OPENING }] }], next: null };
    }
    throw new Error('method not found');
  };
  // metadata.js owns asset_label; constructing it here is what a real boot does.
  const meta = require('./metadata.js')(db, rpc, { enabled: false });
  const assets = require('./assets.js')(db, rpc, () => null);
  await assets.sync();
  const cat = calls.find(([m]) => m === 'getNativeCatalog');
  assert.ok(cat, 'the catalogue is read');
  assert.deepStrictEqual(cat[1], ['markets', null, 64]);
  const row = db.prepare('select name, ticker, logo from tokens where id = ?').get(MOON_ASSET);
  assert.ok(row, 'the market produced a token row');
  // No label stored yet, so the row is honest about not knowing: the hex fallback, never a guess.
  assert.strictEqual(row.name, 'Token 073782e1');
  assert.strictEqual(row.ticker, '073782E1');
  // With a verified label present, the same snapshot carries the real name through.
  db.prepare('insert or replace into asset_label (id, name, ticker, logo, hash, updated) values (?, ?, ?, ?, ?, 1)')
    .run(MOON_ASSET, 'MoonNoid', 'MOON', `/api/asset-image/${NEMO_IMAGE}.png`, MOON_META);
  db.prepare('delete from tokens').run();
  await assets.sync();
  const again = db.prepare('select name, ticker, logo from tokens where id = ?').get(MOON_ASSET);
  assert.strictEqual(again.name, 'MoonNoid', 'a verified label outranks the placeholder');
  assert.strictEqual(again.ticker, 'MOON');
  assert.strictEqual(again.logo, `/api/asset-image/${NEMO_IMAGE}.png`);
  // The curated file still covers a token whose manifest was never published.
  const nemo = db.prepare('select name, ticker from tokens where id = ?').get(NEMO_ASSET);
  assert.deepStrictEqual(nemo, undefined, 'only the market in the fixture is ingested');
});

test('a manifest that does not verify is never used as a name', async () => {
  const media = http.createServer((req, res) => {
    if (req.url === `/metadata/${NEMO_META}.json`) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(NEMO_BODY.replace('Ignotus Nemo', 'Stolen Name')); }
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('nope');
  });
  await new Promise((r) => media.listen(0, r));
  const db = new DatabaseSync(':memory:');
  const rpc = async (method, params) => {
    if (method === 'getNativeCatalog') {
      assert.strictEqual(params.join(','), 'markets,,64');
      return { items: [
        { key: '8000' + NEMO_ASSET, related: [{ kind: 1, opening_hex: NEMO_OPENING }] },
        { key: '8000' + TIN_ASSET, related: [{ kind: 1, opening_hex: TIN_OPENING }] },
      ], next: null };
    }
    throw new Error('method not found');
  };
  const meta = require('./metadata.js')(db, rpc, { origin: `http://127.0.0.1:${media.address().port}/` });
  const out = await meta.refresh();
  assert.strictEqual(out.markets, 2);
  // NEMO's body was tampered with, so its digest no longer matches: no label, and the
  // manifest is remembered as unusable so we do not refetch it every pass.
  assert.strictEqual(db.prepare('select count(*) n from asset_label').get().n, 0);
  assert.strictEqual(db.prepare('select verified from asset_meta where hash = ?').get(NEMO_META).verified, 0);
  await meta.refresh();
  assert.strictEqual(meta.status.fetched, 2, 'a failed manifest is cached, not retried in a loop');
  media.close();
});

test('a verified manifest labels its token and serves its logo', async (t) => {
  const media = http.createServer((req, res) => {
    if (req.url === `/metadata/${NEMO_META}.json`) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(NEMO_BODY); }
    if (req.url === `/images/${NEMO_IMAGE}.png`) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('nope');
  });
  await new Promise((r) => media.listen(0, r));
  const mediaPort = media.address().port;

  // A node that answers just enough for /api/stats to build.
  const stubNode = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c)).on('end', () => {
      const call = ({ id, method }) => {
        const table = {
          paranoid_getChainInfo: { height: 100, active_slot_count: 10, circulating_supply_micronoid: '1000' },
          paranoid_getStateInfo: { log_slots: 4 }, paranoid_getNodeStatus: {}, paranoid_getPeerCount: 1,
          paranoid_getMiningInfo: { difficulty_bits: 30 },
        };
        return table[method] ? { jsonrpc: '2.0', id, result: table[method] } : { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } };
      };
      const reqs = JSON.parse(body);
      res.end(JSON.stringify(Array.isArray(reqs) ? reqs.map(call) : call(reqs)));
    });
  });
  await new Promise((r) => stubNode.listen(0, r));
  process.env.RPC_URL = `http://127.0.0.1:${stubNode.address().port}`;
  process.env.DB_PATH = ':memory:';
  process.env.MEDIA_ORIGIN = `http://127.0.0.1:${mediaPort}/`;
  process.env.RATE_LIMIT = '1000';
  process.env.NODE_ENV = 'test';
  const { server, db, meta } = require('./server.js');
  t.after(() => { server.closeAllConnections?.(); server.close(); media.close(); stubNode.close(); meta.stop(); });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const rpc = async (method, params) => {
    if (method === 'getNativeCatalog') {
      return { items: [{ key: '8000' + NEMO_ASSET, related: [{ kind: 1, opening_hex: NEMO_OPENING }] }], next: null };
    }
    throw new Error('method not found');
  };
  const seeded = require('./metadata.js')(db, rpc, { origin: `http://127.0.0.1:${mediaPort}/` });
  // server.js built its own instance; drive the same tables through a fresh one so the
  // assertions do not depend on private state.
  const out = await seeded.refresh();
  assert.strictEqual(out.markets, 1);
  assert.strictEqual(seeded.status.verified, 1);
  const label = db.prepare('select name, ticker, logo, hash from asset_label where id = ?').get(NEMO_ASSET);
  assert.ok(label, 'the token was labelled');
  assert.strictEqual(label.name, 'Ignotus Nemo');
  assert.strictEqual(label.ticker, 'NEMO');
  assert.strictEqual(label.hash, NEMO_META);
  assert.strictEqual(label.logo, `/api/asset-image/${NEMO_IMAGE}.png`);

  // The logo is proxied through this server, so a visitor's browser never reaches the
  // media service and the bytes survive that service going away.
  const img = await fetch(`${base}${label.logo}`);
  assert.strictEqual(img.status, 200);
  assert.strictEqual(img.headers.get('content-type'), 'image/png');
  assert.ok((img.headers.get('cache-control') || '').includes('max-age='));
  const bytes = Buffer.from(await img.arrayBuffer());
  assert.ok(bytes.equals(PNG), 'the proxied logo is the published image');
  assert.strictEqual((await fetch(`${base}/api/asset-image/${'0'.repeat(64)}.png`)).status, 404);

  // And the image is cached, so the second request does not touch the media service.
  media.close();
  const cached = await fetch(`${base}${label.logo}`);
  assert.strictEqual(cached.status, 200);
  assert.ok(Buffer.from(await cached.arrayBuffer()).equals(PNG), 'served from our own cache after the origin died');

  const stats = await (await fetch(`${base}/api/stats`, { headers: { 'sec-fetch-site': 'same-origin' } })).json();
  assert.ok(stats.metadata && typeof stats.metadata.tokens === 'number', 'the stats page reports metadata progress');
  meta.stop();
  stubNode.close();
});
