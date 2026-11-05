// Runs the indexer + API against a fake node: `npm test`.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { zstdDecompressSync } = require('node:zlib');

const H = (n, salt = '') => require('node:crypto').createHash('sha256').update(`${n}${salt}`).digest('hex');
const ADDR = 'o1qqqqqqqqqqqq';
const PAY_ADDR = 'o1payqqqqqqqq';
let paySlots = [];
const WHSEC = 'whsec_test';
let tip = 99, fork = '', contractHeight = null;
const holes = new Set(); // heights the fake node has no header for // `fork` changes hashes from height 98 up to simulate a reorg
const hash = (h) => H(h, h >= 98 ? fork : '');
// Target 2^240 little-endian -> 2^16 expected hashes per block; blocks 60 s apart; two alternating miners.
const TARGET = '00'.repeat(30) + '0100';
const header = (h) => (h <= tip ? { height: h, hash: hash(h), prev_hash: hash(h - 1), timestamp: 1700000000 + h * 60, miner: h % 2 ? 'o1minerodd' : 'o1minereven', difficulty_target: TARGET, active_slot_count: 1000 + h, state_root: H('state' + h), tx_root: H('txroot' + h), nonce: '00000000000000ab', log_slots: 24 } : null);
const TRADE_ASSET = 'ab'.repeat(32); // 64 hex: a v2.1 asset id
const tx = (h) => ({ tx_hash: H(`tx${h}`), fee_micronoid: 10,
  // A buy as a v2.1 body carries it: 10 NOID in, 254.868967 tokens out -> 39,235 µNOID per token.
  ...(h === 95 ? { trades: [{ asset_id: TRADE_ASSET, side: 'buy', owner: PAY_ADDR, execution_index: 0,
    gross_input_units: '10000000', spent_input_units: '10000000', output_units: '254868967', network_fee_micronoid: 9800 }] } : {}) });

const node = {
  blockCount: () => tip,
  getBlockHash: ([h]) => header(h)?.hash ?? null,
  getBlockHeader: ([h]) => (holes.has(h) ? null : header(h)),
  getBlockDetails: ([h]) => header(h) && { header: header(h), retained: h > tip - 42 ? { reward_micronoid: 5e6, transactions: [{ ...tx(h), ...(h === contractHeight ? { contract: 'call' } : {}) }] } : null },
  verifyReceipt: ([hex]) => ({ merkle_valid: hex === 'abcd', canonical: hex === 'abcd', confirmed: hex === 'abcd', error: hex === 'abcd' ? null : 'bad proof', authenticated_summary: hex === 'abcd' ? { txid: 'ab'.repeat(32), claimed_height: 70, fee_micronoid: 10, outputs: [{ amount_micronoid: 5, owner: PAY_ADDR }] } : undefined }),
  verifyObjectReceipt: ([hex]) => ({ valid: hex === 'eeff', height: 71, txid: 'cd'.repeat(32), terminal: false, fee_micronoid: 5000, canonical: true }),
  getTx: ([id]) => (id === H('tx70') ? { tx_hash: id, height: 70, block_hash: hash(70), tx_position: 0 } : null),
  getChainInfo: () => ({ height: tip, active_slot_count: 10, circulating_supply_micronoid: '123000000' }),
  getPeerCount: () => 8,
  getMiningInfo: () => ({ difficulty_bits: 30 }),
  getSlotsByOwner: ([a]) => (a === PAY_ADDR ? paySlots : [{ slot_index: 1, value: '9007199254740993' }, { slot_index: 2, value: 7 }]),
  getRecentTransactions: () => ({ total: 0, transactions: [] }),
  getStateInfo: () => ({ log_slots: 4 }), getNodeStatus: () => ({}), // 16-slot state keeps the sweep tiny
  getSlot: ([i]) => ({ 0: ['o1minerodd', 700], 3: ['o1minereven', 200], 9: ['o1minerodd', 300], 12: ['o1whalewhale', 5000] }[i]
    ? { slot_index: i, value: { 0: 700, 3: 200, 9: 300, 12: 5000 }[i], creation_id: '9223372036854775' + i, owner: { 0: 'o1minerodd', 3: 'o1minereven', 9: 'o1minerodd', 12: 'o1whalewhale' }[i], empty: false }
    : { slot_index: i, value: 0, creation_id: 0, owner: '', empty: true }),
  getMempoolInfo: () => ({ size: 2, fee_floor: 5000, txs: [{ tx_hash: H('m1'), fee_micronoid: 9000, fee_rate: 1285, n_inputs: 1, n_outputs: 2 }, { tx_hash: H('m2'), fee_micronoid: 6000, fee_rate: 654, n_inputs: 1, n_outputs: 1 }] }),
  estimateFeeDetailed: ([i, o]) => ({ n_inputs: i, n_outputs: o, net_new_slots: o - i, fee_micronoid: 5000 + 1000 * o }),
};

const rpcServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c)).on('end', () => {
    const call = ({ id, method, params }) => {
      const fn = node[method.replace('paranoid_', '')];
      if (typeof fn !== 'function') return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } };
      return { jsonrpc: '2.0', id, result: fn(params) };
    };
    const req = JSON.parse(body);
    res.end(JSON.stringify(Array.isArray(req) ? req.map(call) : call(req)));
  });
});

test('indexer + api', async (t) => {
  await new Promise((r) => rpcServer.listen(0, r));
  process.env.RPC_URL = `http://127.0.0.1:${rpcServer.address().port}`;
  process.env.DB_PATH = ':memory:';
  process.env.PAY_ADDRESS = PAY_ADDR;
  process.env.USD_PER_NOID = '0.20'; // $5 pack = 25 NOID
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
  process.env.NODE_ENV = 'test';
  process.env.ADMIN_TOKEN = 'adm-test';
  const labelFile = path.join(os.tmpdir(), `noid-labels-${process.pid}.json`);
  fs.writeFileSync(labelFile, JSON.stringify({ o1whalewhale: { entity: 'Test Whale', note: 'fixture' } }));
  process.env.LABELS_FILE = labelFile;
  // Candle and watchlist checks add requests on top of the indexer suite.
  process.env.RATE_LIMIT = '1000';
  const { server, tick, db, compressJson, packStats, issuance, pollUsdc, nearestUsd } = require('./server.js');
  await new Promise((r) => server.listen(0, r));
  const get = async (p, opt = {}) => {
    const headers = opt.bare ? opt.headers : { 'sec-fetch-site': 'same-origin', ...opt.headers };
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/${p}`, { ...opt, headers });
    return [r.status, await r.json(), r.headers];
  };
  const post = (p, body, headers = {}) => get(p, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
  t.after(() => { server.close(); rpcServer.close(); });

  await tick();
  const count = () => db.prepare('select count(*) n, min(height) lo from blocks').get();
  assert.deepStrictEqual({ ...count() }, { n: 42, lo: 58 }, 'stores exactly the retained window');
  const raw99 = JSON.stringify(node.getBlockDetails([99]));
  const z99 = db.prepare('select blob from blocks where height = 99').get();
  assert.strictEqual(zstdDecompressSync(z99.blob).toString(), raw99, 'stored body is zstd of the node JSON');
  assert.strictEqual(packStats.raw, raw99.length);
  const fat = JSON.stringify({ header: header(1), retained: { transactions: Array.from({ length: 80 }, (_, i) => ({ tx_hash: H('fat' + i), fee_micronoid: 9000, n_inputs: 2, n_outputs: 2, outputs: [{ owner: 'o1minerodd', amount_micronoid: '1000000' }, { owner: 'o1minereven', amount_micronoid: '2000000' }] })) } });
  const fatZ = compressJson(fat);
  assert.ok(fatZ.length < Buffer.byteLength(fat));
  console.log(`COMPRESSION live ${raw99.length} -> ${z99.blob.length} bytes; padded ${Buffer.byteLength(fat)} -> ${fatZ.length} bytes`);
  assert.strictEqual(db.prepare(`select count(*) n from gaps where kind = 'body'`).get().n, 58, 'pruned heights with no body are gaps');

  // Body survives node pruning via our archive.
  tip = 120;
  await tick();
  const [, b70] = await get('block/70');
  assert.strictEqual(b70.archived, true);
  assert.strictEqual(b70.retained.transactions[0].tx_hash, H('tx70'));

  const [, byHash] = await get(`block/${hash(70)}`);
  assert.strictEqual(byHash.header.height, 70);

  const [, t70] = await get(`tx/${H('tx70')}`);
  assert.deepStrictEqual(t70.details, tx(70));

  // Reorg: same heights, new hashes -> rows replaced.
  fork = 'b';
  await tick();
  assert.strictEqual(Buffer.from(db.prepare('select hash from blocks where height = 100').get().hash).toString('hex'), hash(100));
  assert.strictEqual(db.prepare(`select count(*) n from orphans where height = 100 and kind = 'body' and reason = 'replace'`).get().n, 1, 'old body copied before replace');
  assert.ok(zstdDecompressSync(db.prepare(`select blob from orphans where height = 100 and kind = 'body'`).get().blob).toString().includes(H(100, '')));
  const [, old100] = await get(`block/${H(100, '')}`);
  assert.strictEqual(old100.canonical, false);
  assert.strictEqual(old100.header.hash, H(100, ''));

  // Archived body is not served under a header it does not belong to.
  tip = 150;
  await tick();
  const [, b100] = await get('block/100');
  assert.strictEqual(b100.archived, true);
  assert.strictEqual(b100.canonical, true);
  assert.ok(b100.first_seen > 0);
  assert.ok(b100.others.some((o) => o.reason === 'replace' && o.hash === H(100, '')));

  const [, addr] = await get(`address/${ADDR}`);
  assert.strictEqual(addr.balance_micronoid, '9007199254741000', 'BigInt sum, no float loss');

  assert.deepStrictEqual((await get('search?q=70'))[1], { type: 'block', id: '70' });
  assert.deepStrictEqual((await get(`search?q=${H('tx70')}`))[1], { type: 'tx', id: H('tx70') });

  // The node forgets a transaction once the block body is pruned. This explorer captured the body when the block was
  // new and keeps the txid for good, so a searched txid still answers, and says where the answer came from.
  const oldTx = '7c'.repeat(32);
  db.prepare('insert or replace into tx_index (txid, height, position, fee, burned, coinbase, contract) values (?, ?, ?, ?, ?, ?, ?)')
    .run(Buffer.from(oldTx, 'hex'), 30, 2, '9000', null, 0, null);
  db.prepare(`insert or replace into token_trades (txid, token_id, ts, height, side, token_amount, noid_micronoid, trader, venue, price_micronoid)
    values (?, ?, ?, 30, 'buy', '12', '400000', ?, 'curve', '33333')`).run(oldTx + ':1', TRADE_ASSET, 1700000100, PAY_ADDR);
  const [oldStatus, oldT] = await get(`tx/${oldTx}`);
  assert.strictEqual(oldStatus, 200, 'a pruned transaction is still answered from our own index');
  assert.strictEqual(oldT.source, 'index');
  assert.strictEqual(oldT.height, 30);
  assert.strictEqual(oldT.fee_micronoid, '9000');
  assert.strictEqual(oldT.effects.trades.length, 1, 'what the transaction did comes with it');
  assert.strictEqual(oldT.effects.trades[0].token_amount, '12');
  assert.deepStrictEqual((await get(`search?q=${oldTx}`))[1], { type: 'tx', id: oldTx }, 'search finds it once the node has forgotten it');
  assert.strictEqual((await get(`tx/${'5a'.repeat(32)}`))[0], 404, 'a txid nobody has seen is still not found');
  assert.strictEqual((await get(`tx/${H('tx70')}`))[1].source, 'node', 'the node still answers first while it can');
  assert.deepStrictEqual((await get(`search?q=${ADDR}`))[1], { type: 'address', id: ADDR });

  assert.strictEqual((await get('block/abc'))[0], 400);
  assert.strictEqual((await get('address/notanaddress'))[0], 400);
  assert.strictEqual((await get('block/99999'))[0], 404);
  assert.strictEqual((await get('constructor'))[0], 404);
  assert.strictEqual((await get('block/%zz'))[0], 400, 'bad percent-encoding must not crash the server');
  assert.strictEqual((await get('block/1'))[0], 200, 'server still alive');

  // Second identical request within CACHE_MS is served from memory.
  assert.strictEqual((await get('stats'))[2].get('x-cache'), 'MISS');
  assert.strictEqual((await get('stats'))[2].get('x-cache'), 'HIT');

  // Accounts: key shown once, only its hash stored.
  const [, acct] = await post('account', {});
  assert.match(acct.key, /^nk_[0-9a-f]{40}$/);
  assert.strictEqual(db.prepare('select count(*) n from accounts where key_hash = ?').get(acct.key).n, 0, 'raw key never stored');
  const K = { 'x-api-key': acct.key };
  assert.strictEqual((await get('me', { headers: K }))[1].credits, 0);
  assert.strictEqual((await get('me'))[0], 401);
  assert.strictEqual((await get('me', { headers: { 'x-api-key': 'nk_' + '0'.repeat(40) } }))[0], 401);

  // Wallet as account: a key links one o1… address, an address belongs to one account, and unlink clears it.
  assert.strictEqual((await post('link', { address: 'o1acdefghjkmnpqr' }))[0], 401, 'linking needs a key');
  assert.strictEqual((await post('link', { address: 'not-an-address' }, K))[0], 400);
  const [, linked] = await post('link', { address: 'o1acdefghjkmnpqr' }, K);
  assert.strictEqual(linked.wallet, 'o1acdefghjkmnpqr');
  assert.strictEqual((await get('me', { headers: K }))[1].wallet, 'o1acdefghjkmnpqr', 'the account answers with its wallet');
  const [, rival] = await post('account', {});
  assert.strictEqual((await post('link', { address: 'o1acdefghjkmnpqr' }, { 'x-api-key': rival.key }))[0], 409, 'a wallet cannot sit on two accounts');
  assert.strictEqual((await get('me', { headers: { 'x-api-key': rival.key } }))[1].wallet, null);
  assert.strictEqual((await post('unlink', {}, K))[1].wallet, null);
  assert.strictEqual((await get('me', { headers: K }))[1].wallet, null);
  await post('link', { address: 'o1acdefghjkmnpqr' }, K);

  // NOID top-up: unique amount -> matching slot appears -> credited once the tip is 18 blocks past it.
  const credits = async () => (await get('me', { headers: K }))[1].credits;
  const mine = async (n) => { tip += n; await tick(); };
  // An output already on the address before the order was quoted can never pay it, even with matching digits.
  paySlots = [{ slot_index: 8, value: '5001234', creation_id: 'c0' }];
  await tick();
  const [, quote] = await post('topup', { plan: 'starter' }, K);
  const micro = Math.round(Number(quote.amount_noid) * 1e6);
  assert.ok(micro > 5e6 && micro < 5.01e6 && quote.paid === false && quote.address === PAY_ADDR && quote.status === 'waiting');
  assert.strictEqual(quote.plan.id, 'starter');
  assert.strictEqual(quote.credits, 1000);
  assert.strictEqual(quote.requests, 1_000_000);
  assert.strictEqual((await post('topup', { plan: 'megapack' }, K))[0], 400, 'only the published NOID plans');
  assert.strictEqual((await post('topup', { usd: 5 }, K))[0], 400, 'dollar packs are gone: plans are NOID amounts');
  db.prepare('update noid_topups set amount = 5001234, dust = 1234 where id = ?').run(quote.id);
  await mine(20);
  assert.strictEqual(await credits(), 0, 'pre-existing output did not pay the newer order');
  db.prepare('update noid_topups set amount = ?, dust = ? where id = ?').run(micro, micro % 10000, quote.id);
  paySlots = [{ slot_index: 9, value: String(micro), creation_id: 'c1' }];
  await tick();
  const [, conf] = await get(`topup/${quote.id}`, { headers: K });
  assert.deepStrictEqual([conf.status, conf.confirmations], ['confirming', { have: 0, need: 18 }]);
  await mine(17);
  assert.strictEqual(await credits(), 0, 'not credited at depth 17');
  await mine(1);
  assert.strictEqual((await get(`topup/${quote.id}`, { headers: K }))[1].paid, true);
  await tick();
  assert.strictEqual(await credits(), 1000, 'credited exactly once at depth 18');
  // A payment that disappears (reorged out) before it is final never credits.
  const [, q2] = await post('topup', { plan: 'starter' }, K);
  const micro2 = Math.round(Number(q2.amount_noid) * 1e6);
  paySlots = [{ slot_index: 10, value: String(micro2), creation_id: 'c2' }];
  await tick();
  paySlots = [];
  await mine(18);
  assert.strictEqual(await credits(), 1000, 'reorged-out payment not credited');
  paySlots = [{ slot_index: 9, value: String(micro2), creation_id: 'c1' }];
  await mine(18);
  assert.strictEqual(await credits(), 1000, 'an already-used slot cannot pay a second quote');
  // Overpayment with the same last digits is credited at the quoted rate: +1 NOID on a 5 NOID plan = +200 credits.
  paySlots = [{ slot_index: 11, value: String(micro2 + 1_000_000), creation_id: 'c3' }];
  await tick(); await mine(18);
  assert.strictEqual((await get('me', { headers: K }))[1].credits, 1000 + 1000 + 200, 'overpayment credited proportionally');
  assert.strictEqual((await get(`topup/${q2.id}`, { headers: K }))[1].credits_added, 1200);
  assert.strictEqual((await get(`stats?key=${acct.key}`))[2].get('x-tier'), 'paid');

  // API gate: scripts need a key, our own pages and keyed clients don't; stats stays open for uptime monitors.
  assert.strictEqual((await get('txs', { bare: true }))[0], 401);
  assert.strictEqual((await get('txs', { bare: true, headers: K }))[0], 200);
  assert.strictEqual((await get('stats', { bare: true }))[0], 200);

  // Cards are gone for good: there is no card rail and no webhook to forge.
  const noHook = await post('stripe-webhook', {}, { 'stripe-signature': 't=1,v1=00' });
  assert.ok(noHook[0] === 404 || noHook[0] === 405, 'no card webhook route, got ' + noHook[0]);
  assert.strictEqual((await get('pricing'))[1].payment, 'noid');
  assert.strictEqual((await get('pricing'))[1].card, undefined, 'no card flag');
  assert.deepStrictEqual((await get('pricing'))[1].plans.map((p) => [p.id, p.noid, p.credits]), [['starter', 5, 1000], ['pro', 10, 3000], ['scale', 20, 8000]]);

  // Professional API behaviour: wrong key fails loudly, rate-limit and credit headers on every keyed call.
  const [badStatus, badBody] = await get('blocks', { bare: true, headers: { 'x-api-key': 'nk_' + 'f'.repeat(40) } });
  assert.strictEqual(badStatus, 401); assert.match(badBody.error, /unknown API key/);
  const [, , hdr] = await get('blocks', { bare: true, headers: K });
  assert.strictEqual(hdr.get('x-tier'), 'paid'); assert.strictEqual(hdr.get('x-ratelimit-limit'), '3000'); assert.strictEqual(hdr.get('x-credits-remaining'), '2200');
  assert.strictEqual((await get('me', { headers: K }))[1].tier, 'paid');

  // There is no AI assistant: the route and the module are gone, and the account page no longer sells it.
  assert.strictEqual((await get('chat'))[0], 404, 'no chat route');
  assert.notStrictEqual((await post('chat', { messages: [{ role: 'user', content: 'hi' }] }))[0], 200, 'the assistant cannot be called');
  const [, price0] = await get('pricing');
  assert.strictEqual(price0.chat_cost, undefined);
  assert.strictEqual(price0.free_chats_per_day, undefined);

  const hist = (await get('me', { headers: K }))[1].history.map((h) => h.reason);
  assert.ok(hist.some((r) => r.startsWith('NOID top-up')), 'the top-up is in the ledger');
  assert.ok(!hist.some((r) => /card/i.test(r)), 'no card rail anywhere in the ledger');

  // Late payment: an expired order keeps its digits reserved, and a payment for it still goes to the same account.
  const [, q3] = await post('topup', { plan: 'starter' }, K);
  const micro3 = Math.round(Number(q3.amount_noid) * 1e6);
  db.prepare('update noid_topups set created = ? where id = ?').run(Date.now() - 25 * 3600_000, q3.id);
  await tick();
  assert.strictEqual((await get(`topup/${q3.id}`, { headers: K }))[1].status, 'expired', 'expired orders are kept, not deleted');
  assert.throws(() => db.prepare('insert into noid_topups (id, account, amount, credits, created, dust) values (?, ?, ?, ?, ?, ?)').run('x', acct.id, micro3, 1000, Date.now(), micro3 % 10000), /UNIQUE/, 'a newer order cannot take the held digits');
  const before = await credits();
  paySlots = [{ slot_index: 12, value: String(micro3), creation_id: 'c4' }];
  await tick(); await mine(18);
  assert.strictEqual(await credits(), before + 1000, 'late payment credited to the account that ordered it');
  // Fault injection: if crediting fails, the order is not marked paid and no ledger row is written.
  const [, other] = await post('account', {});
  const [, q4] = await post('topup', { plan: 'starter' }, { 'x-api-key': other.key });
  db.prepare('update accounts set id = ? where id = ?').run('gone', other.id); // the order's account no longer exists
  paySlots = [{ slot_index: 13, value: String(Math.round(Number(q4.amount_noid) * 1e6)), creation_id: 'c5' }];
  await tick(); await mine(18);
  assert.strictEqual(db.prepare('select paid_ref from noid_topups where id = ?').get(q4.id).paid_ref, null, 'order not claimed');
  assert.strictEqual(db.prepare("select count(*) n from ledger where ref = 'noid:c5'").get().n, 0, 'no ledger entry');
  assert.strictEqual(db.prepare("select status from noid_seen where ref = 'noid:c5'").get().status, 'review', 'flagged for a manual look');
  paySlots = [];

  // A stale live price no longer stops API plan quotes: plans are fixed in NOID. Promote quotes still pause.
  const { price: px } = require('./server.js');
  delete process.env.USD_PER_NOID;
  px.now = { usd: 0.2, fetched_at: Date.now() - 16 * 60_000 };
  const [okStatus, fresh] = await post('topup', { plan: 'pro' }, K);
  assert.strictEqual(okStatus, 200, 'a fixed-NOID plan still quotes while the USD feed is stale');
  assert.strictEqual(fresh.plan.id, 'pro');
  assert.strictEqual(fresh.credits, 3000);
  assert.ok(Math.abs(Number(fresh.amount_noid) - 10) < 0.01);
  assert.match((await get('pricing'))[1].noid_paused, /out of date/, 'the USD-based promoted quotes still report the pause');
  px.now.fetched_at = Date.now();
  process.env.USD_PER_NOID = '0.20';

  // Billing counts only requests that return data; cache keys ignore the key and unknown parameters.
  const reqs = async () => (await get('me', { headers: K }))[1].requests;
  const r0 = await reqs();
  await get('nosuchroute', { bare: true, headers: K }); await get('block/99999999', { bare: true, headers: K });
  assert.strictEqual(await reqs(), r0, 'errors are free');
  await get('txs?page=2&junk=1', { bare: true, headers: K });
  const [, , h2] = await get('txs?page=2&other=x', { bare: true, headers: K });
  assert.strictEqual(h2.get('x-cache'), 'HIT', 'irrelevant parameters share the cache');
  assert.strictEqual((await get('txs?page=3', { bare: true, headers: K }))[2].get('x-cache'), 'MISS', 'different page is a different answer');
  assert.strictEqual(await reqs(), r0 + 3, 'each data response counts once');

  // Header shown with another block's body stats: never. A changed hash at the same height hides the old body.
  fork = 'c';
  const [, mixed] = await get('blocks?limit=4');
  assert.ok(mixed.blocks.every((b) => b.indexed === false || b.height < 98), 'old bodies not attached to new headers');
  await tick();
  // Tip goes down by a few blocks: rows above it are dropped. A deep drop is an incident: nothing is deleted.
  const top = tip;
  tip -= 3; await tick();
  assert.strictEqual(db.prepare('select max(height) h from blocks').get().h, tip);
  assert.strictEqual(db.prepare('select max(height) h from headers').get().h, tip);
  assert.ok(db.prepare(`select count(*) n from orphans where reason = 'reorg' and height > ?`).get(tip).n >= 3, 'rows copied before the rollback delete');
  const kept = db.prepare('select count(*) n from blocks').get().n;
  const orphansKept = db.prepare('select count(*) n from orphans').get().n;
  tip -= 19;
  await assert.rejects(tick(), /indexing paused, nothing deleted/);
  assert.strictEqual(db.prepare('select count(*) n from blocks').get().n, kept);
  assert.strictEqual(db.prepare('select count(*) n from orphans').get().n, orphansKept, 'a deep tip drop deletes nothing');
  assert.strictEqual((await get('health'))[0], 503);
  tip = top; await tick();
  const { indexer: ix } = require('./server.js');
  assert.strictEqual(ix.error, null, 'recovers once the node is back');
  fork = 'b'; await tick(); // back to the chain the older checks below expect

  // Live feed: at most 10 open streams per IP.
  const streams = [];
  for (let i = 0; i < 10; i++) { const c = new AbortController(); streams.push(c); await fetch(`http://127.0.0.1:${server.address().port}/api/live`, { signal: c.signal, headers: { 'sec-fetch-site': 'same-origin' } }); }
  assert.strictEqual((await fetch(`http://127.0.0.1:${server.address().port}/api/live`, { headers: { 'sec-fetch-site': 'same-origin' } })).status, 429);
  streams.forEach((c) => c.abort());

  // Live feed pushes the node's current numbers.
  const ac = new AbortController();
  const liveRes = await fetch(`http://127.0.0.1:${server.address().port}/api/live`, { signal: ac.signal, headers: { 'sec-fetch-site': 'same-origin' } });
  assert.strictEqual(liveRes.headers.get('content-type'), 'text/event-stream');
  const reader = liveRes.body.getReader();
  let buf = '';
  while (!buf.includes('data: {')) buf += new TextDecoder().decode((await reader.read()).value);
  const live = JSON.parse(buf.slice(buf.indexOf('data: {') + 6).split('\n')[0]);
  assert.strictEqual(live.chain.height, tip);
  assert.strictEqual(live.header.height, tip);
  ac.abort();

  // Header history: every height from genesis, overwritten on reorg; hashrate = work / time.
  assert.strictEqual(db.prepare('select count(*) n from headers').get().n, tip + 1, 'all headers since genesis');
  assert.strictEqual(Buffer.from(db.prepare('select hash from headers where height = 100').get().hash).toString('hex'), hash(100), 'reorged header replaced');
  assert.strictEqual(Buffer.from(db.prepare('select state_root from headers where height = 100').get().state_root).toString('hex'), H('state100'));
  assert.strictEqual(Buffer.from(db.prepare('select nonce from headers where height = 100').get().nonce).toString('hex'), '00000000000000ab');
  assert.strictEqual(db.prepare('select log_slots s from headers where height = 100').get().s, 24);
  const seen = db.prepare('select first_seen from headers where height = 100').get().first_seen;
  await tick();
  assert.strictEqual(db.prepare('select first_seen from headers where height = 100').get().first_seen, seen, 're-reading the same header keeps first_seen');
  const [, st] = await get('stats');
  assert.ok(Math.abs(st.network.hashrate - 65536 / 60) < 15, `hashrate ${st.network.hashrate}`);
  assert.strictEqual(st.network.avg_block_time, 60);
  assert.strictEqual(st.network.block_time_10m, 60);
  assert.strictEqual(st.network.block_time_24h, 60);
  assert.strictEqual(st.coverage.since, 1700000000);
  assert.ok(st.coverage.gaps >= 58);
  assert.ok(st.coverage.reorgs >= 1);
  assert.strictEqual(st.economics.fee_floor, 5000);
  assert.strictEqual(st.economics.burned_micronoid, null);
  assert.strictEqual(st.economics.blocks_to_next_reward, 210537 - st.chain.height);
  assert.strictEqual(st.economics.subsidy_noid, null);
  assert.strictEqual((await get('health', { bare: true }))[0], 200);
  const [, allMiners] = await get('miners?window=all');
  assert.deepStrictEqual(allMiners.miners.map((m) => m.miner).sort(), ['o1minereven', 'o1minerodd']);
  assert.strictEqual(allMiners.blocks, tip + 1);
  assert.ok(allMiners.warning == null);
  const [, series] = await get('history?window=all');
  assert.ok(series.points.length >= 1 && series.points[0].hashrate > 0 && series.points[0].block_time === 60);
  const [, mp] = await get('mempool');
  assert.strictEqual(mp.size, 2);
  assert.strictEqual(mp.total_fees_micronoid, 15000);
  assert.strictEqual(mp.fees[1].fee_micronoid, 7000);
  assert.strictEqual(mp.txs[0].fee_parts.base, 5000);
  assert.strictEqual(mp.txs[0].fee_parts.inputs, 100);
  assert.strictEqual(mp.txs[0].fee_parts.outputs, 1400);
  assert.strictEqual(mp.txs[0].fee_parts.growth_or_tip, 2500);
  assert.deepStrictEqual((await get(`search?q=${hash(5)}`))[1], { type: 'block', id: hash(5) }, 'any block hash is searchable');
  const [, bl] = await get('blocks?limit=3');
  assert.strictEqual(bl.blocks[0].txs, 1, 'tx count from captured body');
  // A block body is the only trade feed a v2.1 node has: the fill lands in token_trades and rolls into a candle.
  const fill = db.prepare('select * from token_trades').get();
  assert.ok(fill && fill.token_id === TRADE_ASSET, 'a fill embedded in a block is indexed');
  assert.strictEqual(fill.side, 'buy');
  assert.strictEqual(fill.noid_micronoid, '10000000', 'a buy spends the µNOID side');
  assert.strictEqual(fill.price_micronoid, '39235', 'price is the µNOID side over the token side');
  assert.strictEqual(fill.trader, PAY_ADDR, 'the fill keeps the trader');
  assert.strictEqual(db.prepare('select count(*) n from token_candles where token_id = ?').get(TRADE_ASSET).n, 1, 'the fill rolls into a candle');
  // Wipe the fills and let the backfill read them out of the stored bodies again.
  db.prepare('delete from token_trades').run();
  db.prepare('delete from token_candles').run();
  db.prepare("insert or replace into meta (k, v) values ('trades_backfill_below', '0')").run();
  await tick();
  assert.strictEqual(db.prepare('select count(*) n from token_trades').get().n, 1, 'the backfill recovers fills from stored bodies');

  // Holes in the header history are refilled, not just the top; a height the node can't serve is not re-walked forever.
  db.prepare('delete from headers where height between 30 and 40').run();
  await tick();
  assert.strictEqual(db.prepare('select count(*) n from headers').get().n, tip + 1, 'hole below the top refilled');
  holes.add(5); db.prepare('delete from headers where height = 5').run();
  let calls = 0; const realHeader = node.getBlockHeader; node.getBlockHeader = (a) => { calls++; return realHeader(a); };
  await tick(); const first = calls; calls = 0; await tick();
  assert.ok(first > tip - 10 && calls < 50, `walked from the hole once (${first} reads), then back to the top only (${calls})`);
  assert.strictEqual(db.prepare('select count(*) n from headers').get().n, tip, 'the one unservable height stays missing');
  assert.strictEqual(db.prepare(`select count(*) n from gaps where kind = 'header' and height = 5`).get().n, 1);
  node.getBlockHeader = realHeader; holes.clear();
  // Big grouped queries keep temp data in memory (the service's /tmp is read-only).
  assert.strictEqual(db.prepare('pragma temp_store').get().temp_store, 2);
  // Supply reads through the ts index. A GROUP BY temp b-tree is what fails with "disk I/O error"
  // when /tmp, /var/tmp and the cwd are read-only.
  const plan = db.prepare(`explain query plan select ts, cast(json_extract(data, '$.circulating_supply_micronoid') as real) supply from stats where ts >= 0 order by ts`).all().map((r) => r.detail).join('\n');
  assert.match(plan, /USING INDEX stats_ts/);
  assert.doesNotMatch(plan, /TEMP B-TREE/);
  // Fake headers are stamped in 2023, so recent windows only see rows we place near Date.now().
  const supplyNow = Math.floor(Date.now() / 1000);
  const old = supplyNow - 10 * 86400;
  db.exec('begin');
  const insStat = db.prepare('insert into stats (height, ts, data, hash) values (?, ?, ?, ?)');
  for (let i = 0; i < 48; i++) insStat.run(5_000_000 + i, old + i * 3600, JSON.stringify({ circulating_supply_micronoid: 5000 + i }), `sup${i}`);
  for (let i = 0; i < 6; i++) insStat.run(6_000_000 + i, supplyNow - 3000 + i * 300, JSON.stringify({ circulating_supply_micronoid: 9000 + i }), `suph${i}`);
  db.exec('commit');
  const [, supAll] = await get('supply?window=all');
  assert.strictEqual(supAll.window, 'all');
  assert.ok(supAll.points.some((p) => p.supply === 5047), 'last old sample is the max of its bucket');
  assert.strictEqual(supAll.points.at(-1).supply, 9005);
  const [, sup7] = await get('supply?window=7d');
  assert.ok(sup7.points.length >= 1 && sup7.points.every((p) => p.supply >= 9000 && p.supply <= 9005));
  const [, sup1] = await get('supply?window=1h');
  assert.strictEqual(sup1.window, '1h');
  assert.strictEqual(sup1.points.at(-1).supply, 9005);
  assert.ok(sup1.points.every((p) => p.t >= supplyNow - 3600 - 300));
  const [hc, hb] = await get('health', { bare: true });
  assert.strictEqual(hc, 200);
  assert.deepStrictEqual({ ok: hb.ok, result: hb.db.result, temp: hb.temp_store }, { ok: true, result: 'ok', temp: 2 });

  // Icons and link-preview image are served as files; anything else falls back to the app page.
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [p, type] of [['/favicon.ico', 'image/x-icon'], ['/og.png', 'image/png'], ['/apple-touch-icon.png', 'image/png'], ['/site.webmanifest', 'application/manifest+json']]) {
    const r = await fetch(base + p);
    assert.strictEqual(r.status, 200, p); assert.strictEqual(r.headers.get('content-type'), type, p); assert.ok((await r.arrayBuffer()).byteLength > 100, p);
  }
  assert.match(await (await fetch(base + '/../server.js')).text(), /<title>NOID Scan/, 'no path escapes into the filesystem');

  // Holders sweep: aggregates every funded slot by owner; rich list and concentration follow.
  const { sweepHolders } = require('./server.js');
  await sweepHolders();
  const [, hol] = await get('holders');
  assert.strictEqual(hol.latest.holders, 3); assert.strictEqual(hol.latest.supply, 6200); assert.strictEqual(hol.latest.slots, 4);
  const [, rich] = await get('richlist?limit=2');
  assert.deepStrictEqual(rich.rows.map((r) => [r.address, r.balance, r.slots]), [['o1whalewhale', 5000, 1], ['o1minerodd', 1000, 2]]);
  assert.strictEqual(rich.rows[0].entity, 'Test Whale');
  assert.strictEqual(rich.rows[1].entity, null);
  assert.match(rich.warning, /Test Whale/);
  assert.ok(Math.abs(rich.rows[0].share - 5000 / 6200) < 1e-9);
  assert.strictEqual((await get('address/o1whalewhale'))[1].rank, 1);

  // Price ticks: samples bucket into series with market cap from supply.
  db.prepare('insert into price_ticks values (?, ?, ?, ?)').run(Math.floor(Date.now() / 1000) - 600, 0.5, 1000, 2_000_000);
  db.prepare('insert into price_ticks values (?, ?, ?, ?)').run(Math.floor(Date.now() / 1000) - 300, 0.6, 1200, 2_000_000);
  const { price: priceState } = require('./server.js');
  priceState.now = { usd: 0.6 };
  const nowS = Math.floor(Date.now() / 1000);
  priceState.hourly = Array.from({ length: 23 }, (_, i) => ({ t: nowS - (24 - i) * 3600, usd: 0.4 + i * 0.001 }));
  priceState.daily = Array.from({ length: 10 }, (_, i) => ({ t: nowS - (10 - i) * 86400, usd: 0.3 + i * 0.01 }));
  const [, p7] = await get('price?window=7d');
  assert.ok(p7.points.length > 25, `7d window is filled from external history before our ticks: ${p7.points.length} points`);
  assert.ok(p7.points[0].t <= nowS - 6 * 86400 && p7.points.at(-1).usd >= 0.5, 'spans the week and ends on our newest ticks');
  assert.ok(p7.points.every((p, i) => i === 0 || p.t >= p7.points[i - 1].t), 'sorted by time');
  // Candles: open = first sample, close = last, high/low = extremes; older closes fill in as faded candles.
  const T = Math.floor(nowS / 900) * 900 - 3600;
  for (const [dt, usd] of [[0, 0.5], [180, 0.7], [360, 0.4], [540, 0.55]]) db.prepare('insert into price_ticks (ts, usd) values (?, ?)').run(T + dt, usd);
  const [, c15] = await get('candles?interval=15m');
  assert.deepStrictEqual(c15.candles.find((c) => c.t === T), { t: T, o: 0.5, h: 0.7, l: 0.4, c: 0.55, n: 4, approx: false });
  assert.ok(c15.candles.every((c) => c.t % 900 === 0 && !c.approx), '15m: own samples only, aligned');
  const [, c1d] = await get('candles?interval=1d');
  assert.strictEqual(c1d.interval, '1d', 'interval is part of the cache key');
  const filled = c1d.candles.filter((c) => c.approx);
  assert.ok(filled.length >= 8 && filled.every((c, i) => i === 0 || c.o === filled[i - 1].c), 'daily closes chain open-to-previous-close');
  const [, c1w] = await get('candles?interval=1w');
  assert.ok(c1w.candles.every((c) => new Date(c.t * 1000).getUTCDay() === 1), 'weekly candles start on Monday');
  assert.strictEqual((await get('candles?interval=bogus'))[1].interval, '1h');
  const [, ps] = await get('price?window=24h');
  assert.ok(ps.points.length >= 2 && ps.points.at(-1).usd === 0.6 && Math.abs(ps.points.at(-1).market_cap_usd - 1.2) < 1e-9);

  // Full history is paged on the price_ticks primary key (no GROUP BY, no temp file).
  const aged = T - 3 * 86400;
  const insTick = db.prepare('insert into price_ticks (ts, usd) values (?, ?)');
  for (let i = 0; i < 48; i++) insTick.run(aged + i * 900, 0.2 + (i % 5) * 0.01);
  const tickPlan = db.prepare('explain query plan select ts, usd, volume_24h, supply from price_ticks where ts < ? order by ts desc limit cast(? as integer)').all(2_000_000_000, 10).map((r) => r.detail).join('\n');
  assert.match(tickPlan, /PRIMARY KEY|COVERING INDEX/i, tickPlan);
  assert.doesNotMatch(tickPlan, /TEMP/);
  const [, newest] = await get('price?limit=2');
  assert.strictEqual(newest.points.length, 2);
  assert.strictEqual(newest.points[1].usd, 0.6);
  assert.ok(newest.points[0].t < newest.points[1].t && newest.more && newest.oldest === newest.points[0].t);
  let cursor = newest.oldest, pages = 0, sawDaily = false, prev = newest.points[0].t + 1;
  while (pages++ < 20) {
    const [, p] = await get(`price?limit=20&before=${cursor}`);
    assert.ok(p.points.every((x) => x.t < cursor && x.t < prev), 'price pages move backward without overlap');
    prev = p.oldest ?? 0;
    if (p.points.some((x) => x.hi == null && x.usd < 0.4)) sawDaily = true;
    if (!p.more) { assert.ok(p.points.length); break; }
    assert.ok(p.oldest < cursor);
    cursor = p.oldest;
  }
  assert.ok(sawDaily, 'paging reaches CoinPaprika daily closes');
  assert.ok(pages < 40, 'price history ends');
  const [, cpage] = await get('candles?interval=15m&limit=2');
  assert.strictEqual(cpage.candles.length, 2);
  assert.ok(cpage.more && cpage.candles.every((c) => c.t % 900 === 0 && c.t <= cpage.candles.at(-1).t));
  const [, colder] = await get(`candles?interval=15m&limit=40&before=${cpage.oldest}`);
  assert.ok(colder.candles.every((c) => c.t < cpage.oldest));
  let b15 = null, seenT = false, seenOld = false, n15 = 0;
  while (n15++ < 15) {
    const [, p] = await get(`candles?interval=15m&limit=40${b15 ? `&before=${b15}` : ''}`);
    const hit = p.candles.find((c) => c.t === T);
    if (hit) {
      seenT = true;
      assert.deepStrictEqual(hit, { t: T, o: 0.5, h: 0.7, l: 0.4, c: 0.55, n: 4, approx: false });
    }
    if (p.candles.some((c) => c.t === aged)) seenOld = true;
    if (!p.more) break;
    assert.ok(p.oldest < (b15 ?? Infinity));
    b15 = p.oldest;
  }
  assert.ok(seenT && seenOld, '15m pages include the known candle and older samples');
  let wk = null, wpages = 0, mondays = [];
  while (wpages++ < 20) {
    const [, w] = await get(`candles?interval=1w&limit=3${wk ? `&before=${wk}` : ''}`);
    assert.strictEqual(w.interval, '1w');
    assert.ok(w.candles.every((c) => new Date(c.t * 1000).getUTCDay() === 1 && (!wk || c.t < wk)));
    mondays.push(...w.candles);
    if (!w.more) break;
    wk = w.oldest;
  }
  assert.ok(mondays.length >= 2 && wpages < 20, 'weekly history is finite and aligned');
  assert.strictEqual((await get('candles?interval=1h&before=soon'))[0], 400);
  assert.strictEqual((await get('price?limit=lots'))[0], 400);
  const [, capped] = await get('candles?interval=1d&limit=999999');
  assert.ok(capped.candles.length >= 1 && capped.candles.length <= 5000);
  const js = await fetch(base + '/lightweight-charts.js');
  assert.strictEqual(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.match(await js.text(), /LightweightCharts/);

  // The self-custody wallet ships as files: page script, BIP39 words, wasm engine.
  // They must never fall back to the app page, and the engine must be real wasm.
  const wallet = await fetch(base + '/wallet.js');
  assert.strictEqual(wallet.status, 200);
  assert.match(wallet.headers.get('content-type'), /javascript/);
  assert.match(await wallet.text(), /No1dWallet/);
  const words = await (await fetch(base + '/bip39.txt')).text();
  assert.strictEqual(words.trim().split('\n').length, 2048, 'the word list is complete');
  const tradeEngine = await fetch(base + '/noid-trade.wasm');
  assert.strictEqual(tradeEngine.headers.get('content-type'), 'application/wasm', 'the trade engine is served');
  assert.match((await fetch(base + '/trade-worker.js')).headers.get('content-type'), /javascript/, 'the trade worker is served');
  // A code asset must not be trusted for a day: a browser holding a wallet.js from before
  // the trade panel rendered a Review button that threw on its first line and looked dead.
  const tag = wallet.headers.get('etag');
  assert.ok(tag, 'code assets carry an etag');
  assert.match(wallet.headers.get('cache-control') || '', /no-cache/, 'code assets revalidate');
  const again = await fetch(base + '/wallet.js', { headers: { 'if-none-match': tag } });
  assert.strictEqual(again.status, 304, 'an unchanged asset answers 304');
  assert.match((await fetch(base + '/fonts/plex-sans-400.woff2')).headers.get('cache-control') || '', /immutable/, 'fonts stay immutable');
  const engine = await fetch(base + '/noid-wallet.wasm');
  assert.strictEqual(engine.status, 200);
  assert.strictEqual(engine.headers.get('content-type'), 'application/wasm');
  assert.deepStrictEqual([...new Uint8Array((await engine.arrayBuffer()).slice(0, 4))], [0x00, 0x61, 0x73, 0x6d], 'wasm magic');
  assert.strictEqual((await fetch(base + '/wallet')).status, 200, 'the wallet page is the app page');
  const homeHtml = await (await fetch(base + '/')).text();
  assert.match(homeHtml, /href="\/favorites"/, 'favorites are a page of their own, not a hidden tab');
  assert.match(homeHtml, /class="explore"[^>]*>Explore<\/a>\s*<a class="favlink" href="\/favorites"/, 'Favorites sits beside Explore in the header');
  assert.doesNotMatch(homeHtml, /data-dock="fav"/, 'Favorites is not a dock tab any more');
  assert.match(homeHtml, /data-label="1"/, 'a star can render as a labelled Save button');
  // A wallet script too old to have these methods must produce a sentence, not a dead button.
  assert.match(homeHtml, /wallet\.js\?v=2/, 'the page asks for the current wallet script, not a cached one');
  assert.match(homeHtml, /WNEED\.some\(\(k\) => typeof W\[k\] !== 'function'\)/, 'the trade panel checks the wallet API before using it');
  assert.match(homeHtml, /running an old copy of the wallet script/, 'and says so when it is stale');
  assert.match(homeHtml, /This wallet holds no NOID yet/, 'an empty wallet gets a sentence a person can act on');
  assert.match((await fetch(base + '/')).headers.get('cache-control') || '', /no-cache/, 'the app page revalidates too');
  assert.match(homeHtml, /ADDR_STAR/, 'addresses are favorites too');
  assert.match(homeHtml, /migrateAddrWatch\(\)/, 'the old browser-only address list folds into favorites at boot');
  assert.doesNotMatch(homeHtml, /id="addrwatch"/, 'the second, unlistable address list is gone');
  assert.match(homeHtml, /class="alertbtn"/);
  assert.match(homeHtml, /safe-area-inset-bottom/);
  assert.match(homeHtml, /axisDoubleClickReset/);
  assert.match(homeHtml, /\/wallet\.js/, 'the app page loads the wallet module');
  assert.match(homeHtml, /touch-action:pan-y/);
  assert.match(homeHtml, /vertTouchDrag: true/);
  assert.match(homeHtml, /class="iauto on"/);
  assert.match(homeHtml, /id="balauto"/);
  assert.doesNotMatch(homeHtml, /bottom:\s*56px/);
  assert.match(homeHtml, /data-star/);
  assert.match(homeHtml, /id="wcard"/, 'the account page leads with the wallet card');
  assert.match(homeHtml, /no1d_wallet_identity_v1/, 'the site knows the browser identity key');
  assert.match(homeHtml, /WalletDex\.identity/, 'the account page can read the wallet identity');
  assert.doesNotMatch(homeHtml, /Create free account/, 'no sign-up wall in front of a wallet that already exists');
  assert.match(homeHtml, /1W/);
  assert.match(homeHtml, /tokenchart/);
  assert.match(homeHtml, /Total you pay/);
  assert.match(homeHtml, /Trading is not investment advice/); // one plain line where the bulleted risk box used to be
  assert.match(homeHtml, /never holds your wallet/);
  assert.match(homeHtml, /open here soon/);
  assert.match(homeHtml, /aria-label="Paid promotion">⚡/);
  assert.doesNotMatch(homeHtml, /pill enh|>Enhanced<|Duli Media/);
  assert.match(homeHtml, /async promote\(/);
  assert.match(homeHtml, /href="\/promote" data-link/);
  assert.match(homeHtml, /data-enh="usdc"/);
  assert.match(homeHtml, /id="book"/);
  assert.match(homeHtml, /Derived from pool reserves/);
  assert.match(homeHtml, /Open orders/);
  assert.match(homeHtml, /id="enhform"/);
  assert.match(homeHtml, /Profile review/);
  assert.match(homeHtml, /Sample page\. Payment is not taken/);
  assert.match(homeHtml, /My trades/);
  assert.match(homeHtml, /Top traders/);
  assert.match(homeHtml, /Top holders/);
  assert.match(homeHtml, /Copy address/);
  assert.match(homeHtml, /id="sharebtn"/);
  assert.match(homeHtml, /Screener/);
  assert.match(homeHtml, /Chart\+Txns/);
  assert.match(homeHtml, /Price alerts are not on this explorer yet/);
  assert.match(homeHtml, /₀₁₂₃₄₅₆₇₈₉/);
  {
    const fn = homeHtml.match(/function subUsd\(x\) \{\n[\s\S]*?\n\}/);
    assert.ok(fn, 'subUsd is in the page');
    const money = (x, d = 2) => '$' + Number(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    const usd4 = (x) => money(x, x < 1 ? 4 : 2);
    const subUsd = new Function('money', 'usd4', `${fn[0]}; return subUsd;`)(money, usd4);
    assert.strictEqual(subUsd(0.000003239), '$0.0₅3239');
    assert.strictEqual(subUsd(0.00002), '$0.0₄2');
    assert.strictEqual(subUsd(0.032), usd4(0.032));
    assert.strictEqual(subUsd(null), '–');
  }
  assert.match(homeHtml, />\$100/);
  assert.match(homeHtml, />\$1k/);
  assert.match(homeHtml, /Pair age/);
  assert.match(homeHtml, /data-tabs="nftkind"/);
  assert.match(homeHtml, /data-tabs="homekind"/);
  assert.match(homeHtml, /Listings and floor depth/);
  assert.match(homeHtml, /class="traits"/);
  assert.match(homeHtml, /Sales and transfers/);
  assert.doesNotMatch(homeHtml, /Recommended/);
  assert.doesNotMatch(homeHtml, /featured pick/i);
  assert.doesNotMatch(homeHtml, /\bendorsed\b/i);
  assert.match(homeHtml, /Promoted/);
  assert.match(homeHtml, /Paid promotion\. Not a recommendation or endorsement by NOID Scan\./);
  assert.match(homeHtml, /data-boost=/);
  assert.match(homeHtml, /id="promotion"/);
  assert.match(homeHtml, /aria-label="Promoted"/);
  assert.doesNotMatch(homeHtml, /@keyframes promocrwl/, 'the Promoted strip is a static label, not a scrolling ticker');
  assert.match(homeHtml, /class="promobar"><span class="pill promo"/);
  assert.match(homeHtml, /class="metapill"/);
  assert.match(homeHtml, /id="topclist"/);
  assert.match(homeHtml, /Connected nodes/);
  assert.match(homeHtml, /id="gnode"/);
  assert.match(homeHtml, /Peers connected to NOID Scan's node only · approximate city/);
  assert.doesNotMatch(homeHtml, /YOUR NODE|Your node/);
  assert.doesNotMatch(homeHtml, /Top countries|paintTopCountries/);
  assert.match(homeHtml, /aria-label="Zoom in"/);
  assert.match(homeHtml, /'NOID SCAN'/);
  assert.match(homeHtml, /id="pxspark"/);
  assert.match(homeHtml, /Balance over time/);
  assert.match(homeHtml, /aria-label="\$\{on \? 'Remove' : 'Add'\} \$\{esc\(name \|\| id\)\} \$\{on \? 'from' : 'to'\} favorites"/, 'stars speak favorites, not a second watchlist');
  assert.match(homeHtml, /starBtn\(ADDR_STAR\(a\.address\), 'this address', \{ label: true \}\)/, 'every address page can save itself');
  assert.match(homeHtml, /id="addrchart"/);
  assert.match(homeHtml, /id="balchart"/);
  assert.match(homeHtml, /aria-label="Account balance over time"/);
  assert.match(homeHtml, /balrange/);
  assert.match(homeHtml, /id="balhead"/);
  assert.match(homeHtml, /usd_points/);
  assert.match(homeHtml, /usdText\(row\.value\)/);
  assert.match(homeHtml, /balLabel\(noidAt\.get\(t\)\)/);
  assert.doesNotMatch(homeHtml, /Not the live balance/);
  assert.match(homeHtml, /arcDashAnimateTime/);
  assert.match(homeHtml, /1Y/);
  assert.doesNotMatch(homeHtml, /mined more than half/);
  assert.doesNotMatch(homeHtml, /Countries of peers connected to this explorer's node/);
  assert.match(homeHtml, /prefers-reduced-motion: reduce/);
  assert.match(homeHtml, /Get verified ✓/);
  assert.match(homeHtml, /id="sortpop"/);
  assert.match(homeHtml, /id="listbar"/);
  assert.match(homeHtml, /aria-label="USDC chain"/);
  assert.match(homeHtml, /native USDC on the chain you pick/);
  assert.match(homeHtml, /href="\/privacy"/);
  assert.match(homeHtml, /DRAFT pending legal review/);
  assert.doesNotMatch(homeHtml, /Duli Media LLC/);
  assert.doesNotMatch(homeHtml, /hudring|hudRing/);
  assert.match(homeHtml, /color-mix\(in srgb, var\(--card\) 97%, transparent\)/);
  assert.match(homeHtml, /id="rcpthex"/);
  assert.match(homeHtml, /verifyReceipt/);
  assert.match(homeHtml, /aria-label="Paid promotion"/);
  const tokenCardSrc = homeHtml.slice(homeHtml.indexOf('function tokenCards'), homeHtml.indexOf('function nftTable'));
  assert.match(tokenCardSrc, /listBolt\(t\)/);
  assert.doesNotMatch(tokenCardSrc, /paidMarks|>Enhanced</);
  const siteHead = homeHtml.slice(homeHtml.indexOf('<header>'), homeHtml.indexOf('</header>'));
  assert.doesNotMatch(siteHead, /Duli Media LLC/);
  const billingSrc = require('fs').readFileSync(require('path').join(__dirname, 'billing.js'), 'utf8');
  assert.doesNotMatch(billingSrc, /Duli Media LLC/);

  // 64-bit creation ids must survive parsing: two consecutive ids are different slots, not the same payment.
  const { parseRpc } = require('./server.js');
  const big = parseRpc('{"result":[{"creation_id":9223372036854775807,"value":5},{"creation_id":9223372036854775806,"value":5}]}');
  assert.notStrictEqual(big.result[0].creation_id, big.result[1].creation_id);
  assert.strictEqual(big.result[0].creation_id, '9223372036854775807');

  // Peer map: only established connections on the P2P port with public IPs count.
  const { peerIps, peerConns, maskIp } = require('./server.js');
  const procNet = [
    '  sl  local_address rem_address   st',
    '   0: 0100007F:2580 0100007F:9C40 01', // loopback: private
    '   1: 0F02000A:2580 08080808:C350 01', // inbound to :9600 from 8.8.8.8
    '   2: 0F02000A:D431 01010101:2580 01', // outbound to 1.1.1.1:9600
    '   3: 0F02000A:D432 04040808:2580 06', // TIME_WAIT: ignored
    '   4: 0F02000A:01BB 09090909:D000 01', // HTTPS, not P2P: ignored
    '   5: 00000000000000000000000000000000:2580 0000000000000000FFFF00000A0B0C0D:C351 01', // v4-mapped v6
  ].join('\n');
  assert.deepStrictEqual(peerIps(procNet).sort(), ['1.1.1.1', '13.12.11.10', '8.8.8.8']);
  assert.ok(peerConns(procNet).every((c) => typeof c.inbound === 'boolean'));
  assert.strictEqual(maskIp('203.0.113.9'), '203.•.•.•');
  assert.strictEqual(maskIp('2001:0db8:0000:0000:0000:0000:0000:0001'), '2001:•••');

  // Country lookup keeps the flat shape (codes only, everything else null) and shrugs off a miss.
  const { geoRow } = require('./server.js');
  assert.strictEqual(geoRow({ ip: '8.8.8.8', country: 'US' }).cc, 'US');
  assert.strictEqual(geoRow({ ip: '8.8.8.8', country: 'US' }).city, null);
  assert.strictEqual(geoRow({ error: 'reserved range' }), null);

  const [, charts] = await get('charts');
  assert.ok(charts.length >= 3 && charts[0].peers === 8);

  // Tokens and NFTs: empty until the node speaks v2.1. Demo rows are not stored.
  delete process.env.TOKENS_DEMO; delete process.env.SWAP_ENABLED; delete process.env.SWAP_FEE_ADDRESS;
  const [, none] = await get('tokens');
  assert.strictEqual(none.demo, false);
  // curated fallback rows are served even from a node that does not speak v2.1
  const curatedCount = require('./tokens-extra.json').length;
  assert.strictEqual(none.tokens.length, curatedCount);
  const noidcat = none.tokens.find((t) => t.ticker === 'NOIDCAT');
  assert.ok(noidcat, 'the curated NOIDCAT row is served');
  assert.strictEqual(noidcat.id, 'c9df752917d995cfd7636920c97e9c2770784b33944e678fdce4dae98235a93f', 'the curated row carries the real asset id, not another launch\'s');
  assert.ok(none.notice === null || /v2\.1/.test(none.notice));
  assert.strictEqual((await get('collections'))[1].collections.length, 0);
  const [, demo] = await get('tokens?demo=1');
  assert.strictEqual(demo.demo, true);
  assert.strictEqual(demo.tokens[0].id, 'gcat');
  const [, byAge] = await get('tokens?demo=1&sort=age&dir=asc');
  assert.notStrictEqual(byAge.tokens[0].id, 'gcat');
  assert.ok(byAge.tokens.some((t) => t.id === 'gcat'));
  const [, promoTok] = await get('boosts?demo=1&kind=token');
  assert.ok(promoTok.boosts.some((b) => b.asset_id === 'gcat' && b.label === 'Promoted'));
  assert.strictEqual(promoTok.disclaimer, 'Paid promotion. Not a recommendation or endorsement by NOID Scan.');
  assert.doesNotMatch(JSON.stringify(promoTok), /Recommended/);
  assert.ok(promoTok.boosts[0].asset.enhanced);
  assert.strictEqual(typeof promoTok.boosts[0].asset.price_usd, 'number');
  assert.strictEqual(typeof promoTok.boosts[0].asset.change['24h'], 'number');
  const [, byFloor] = await get('collections?demo=1&sort=floor&dir=asc');
  assert.notStrictEqual(byFloor.collections[0].id, 'stamps');
  const [, promoNft] = await get('boosts?demo=1&kind=collection');
  assert.ok(promoNft.boosts.some((b) => b.asset_id === 'stamps' && b.label === 'Promoted'));
  assert.ok(demo.tokens.every((t) => t.backing_per_token_micronoid === '1000'));
  assert.strictEqual(demo.page, 1);
  assert.strictEqual(demo.count, 5);
  assert.ok(demo.tokens[0].spark.length >= 2);
  assert.strictEqual(demo.tokens[0].creator, 'o1acdefghjkmnpqr');
  const p2 = (await get('tokens?demo=1&page=2'))[1];
  assert.strictEqual(p2.tokens.length, 0);
  assert.strictEqual(p2.count, 5);
  assert.strictEqual((await get('tokens?demo=1&page=nope'))[0], 400);
  assert.strictEqual((await get('tokens?demo=1&preset=new'))[1].tokens[0].id, 'qsun');
  assert.strictEqual((await get('tokens?demo=1&preset=gainers'))[1].tokens[0].id, 'orbit');
  const grad = (await get('tokens?demo=1&preset=graduating'))[1];
  assert.ok(grad.tokens.every((t) => !t.graduated && t.curve));
  assert.strictEqual(grad.tokens[0].id, 'nbus');
  assert.ok(grad.tokens[0].curve.progress >= grad.tokens.at(-1).curve.progress);
  assert.deepStrictEqual((await get('tokens?demo=1&q=sun'))[1].tokens.map((t) => t.id), ['qsun']);
  assert.deepStrictEqual((await get('tokens?demo=1&min_liq=10000'))[1].tokens.map((t) => t.id).sort(), ['gcat', 'nbus', 'orbit']);
  assert.deepStrictEqual((await get('tokens?demo=1&max_age=5'))[1].tokens.map((t) => t.id), ['qsun']);
  const hiTx = (await get('tokens?demo=1&min_txns=20'))[1];
  assert.ok(hiTx.tokens.some((t) => t.id === 'gcat') && hiTx.tokens.every((t) => t.txns >= 20) && !hiTx.tokens.some((t) => t.id === 'qsun'));
  assert.strictEqual((await get('tokens?demo=1&min_liq=nope'))[0], 400);
  const [, tok] = await get('token/gcat?demo=1');
  assert.strictEqual(tok.demo, true);
  assert.strictEqual(tok.token.venue, 'pool');
  assert.ok(tok.chart.length >= 2 && tok.trades.length >= 1 && tok.holders.length >= 1);
  assert.ok(tok.trades.every((t) => t.txid && t.trader && typeof t.usd === 'number'));
  const [, traders] = await get('tokens/gcat/traders?demo=1');
  assert.strictEqual(traders.label, 'Indexed trades');
  assert.ok(traders.traders.length >= 1 && traders.traders[0].txns >= 1 && traders.traders[0].volume_micronoid);
  const [, wal] = await get('wallet/o1acdefghjkmnpqr?demo=1&token=gcat');
  assert.ok(wal.holdings.some((h) => h.token_id === 'gcat'));
  assert.ok(wal.trades.length >= 1 && wal.trades.every((t) => t.trader === 'o1acdefghjkmnpqr' && t.token_id === 'gcat'));
  assert.strictEqual(wal.pnl.buys + wal.pnl.sells, wal.pnl.txns);
  assert.strictEqual(wal.activity.txns, wal.pnl.txns);
  assert.ok(wal.pnl.txns >= wal.trades.length);
  const pts = wal.balance_points;
  assert.ok(Array.isArray(pts) && pts.length >= 24);
  assert.ok(pts.every((p, i) => Number.isFinite(p.t) && Number.isFinite(p.balance) && p.balance >= 0 && (i === 0 || p.t > pts[i - 1].t)));
  assert.ok(pts[0].t < pts.at(-1).t - 30 * 86400);
  assert.ok(pts.filter((p) => p.t >= pts.at(-1).t - 86400).length >= 2);
  assert.ok(pts.some((p) => p.balance !== pts[0].balance));
  const [, walSame] = await get('wallet/o1acdefghjkmnpqr?demo=1');
  assert.deepStrictEqual(walSame.balance_points.map((p) => p.balance), pts.map((p) => p.balance));
  const [, walOther] = await get('wallet/o1qqqqqqqqqqqq?demo=1');
  assert.notDeepStrictEqual(walOther.balance_points.map((p) => p.balance), pts.map((p) => p.balance));
  assert.strictEqual(nearestUsd([{ t: 100, usd: 1 }, { t: 200, usd: 2 }], 140), 1);
  assert.strictEqual(nearestUsd([{ t: 100, usd: 1 }, { t: 200, usd: 2 }], 160), 2);
  assert.strictEqual(nearestUsd([{ t: 100, usd: 1 }, { t: 200, usd: 2 }], 150), 1);
  assert.strictEqual(nearestUsd([{ t: 100, usd: 1 }, { t: 200, usd: 2 }], 50), 1);
  assert.strictEqual(nearestUsd([{ t: 100, usd: 1 }, { t: 200, usd: 2 }], 900), 2);
  assert.strictEqual(nearestUsd([], 1), null);
  const usd = wal.usd_points;
  assert.ok(Array.isArray(usd) && usd.length >= pts.length);
  assert.ok(usd.every((p, i) => Number.isFinite(p.usd) && p.balance >= 0 && (i === 0 || p.t > usd[i - 1].t)));
  assert.ok(Math.abs(usd[0].usd / usd[0].balance - 0.3) < 1e-8, 'a point before every sample uses the earliest price');
  assert.ok(Math.abs(usd.at(-1).usd / usd.at(-1).balance - 0.6) < 1e-8, 'the latest point uses the current NOID price');
  assert.ok(usd.some((p, i) => i && p.balance === usd[i - 1].balance && p.usd !== usd[i - 1].usd), 'the same NOID balance is revalued when the price moves');
  assert.strictEqual((await get('wallet/not-an-address?demo=1'))[0], 400);
  assert.strictEqual((await get('token/gcat'))[0], 404);
  const [, screen] = await get('tokens/gcat?demo=1');
  assert.strictEqual(screen.token.launch, 'launchpad');
  assert.strictEqual(screen.token.fdv_micronoid, screen.token.mcap_micronoid);
  assert.ok(screen.token.makers >= 1);
  assert.ok(screen.warnings.some((w) => w.code === 'dev_hold'));
  assert.ok(screen.token.top10_pct >= 40);
  assert.equal(typeof screen.token.windows['24h'].buy_vol_micronoid, 'string');
  assert.ok(screen.token.windows['5m'].txns >= 0 && screen.token.windows['24h'].buys >= screen.token.windows['24h'].buyers);
  assert.strictEqual((await get('tokens/crown?demo=1'))[1].token.launch, 'direct');
  assert.ok((await get('tokens/crown?demo=1'))[1].warnings.some((w) => w.code === 'low_liq'));
  const [, candles] = await get('tokens/gcat/candles?demo=1&tf=5m');
  assert.strictEqual(candles.tf, '5m');
  assert.ok(candles.candles.length > 20);
  assert.ok(candles.candles.every((c) => BigInt(c.h) >= BigInt(c.l) && BigInt(c.h) >= BigInt(c.o) && BigInt(c.h) >= BigInt(c.c) && BigInt(c.v) > 0n));
  const [, hour] = await get('tokens/gcat/candles?demo=1&tf=1h&limit=3');
  assert.strictEqual(hour.candles.length, 3);
  assert.strictEqual(hour.more, true);
  assert.ok(hour.candles.every((c) => c.t % 3600 === 0));
  const [, hourOlder] = await get(`tokens/gcat/candles?demo=1&tf=1h&limit=3&before=${hour.oldest}`);
  assert.ok(hourOlder.candles.length === 3 && hourOlder.candles.at(-1).t < hour.oldest);
  const [, weeksDemo] = await get('tokens/gcat/candles?demo=1&tf=1w&limit=20');
  assert.ok(weeksDemo.candles.length >= 8);
  assert.ok(weeksDemo.candles.every((c) => new Date(c.t * 1000).getUTCDay() === 1));
  const [, days] = await get('tokens/gcat/candles?demo=1&tf=1d&limit=5');
  assert.ok(days.candles.every((c) => c.t % 86400 === 0 && BigInt(c.v) > 0n));
  assert.strictEqual((await get('tokens/gcat/candles?demo=1&tf=1m&before=soon'))[0], 400);
  assert.deepStrictEqual((await get('tokens?demo=1&preset=watch&ids=crown,qsun'))[1].tokens.map((t) => t.id).sort(), ['crown', 'qsun']);
  assert.strictEqual((await get('tokens?demo=1&preset=watch'))[1].tokens.length, 0);
  assert.strictEqual((await get('stars'))[0], 401);
  const [, starred] = await post('stars', { id: 'gcat', on: true }, K);
  assert.deepStrictEqual(starred.ids, ['gcat']);
  const [, mergedStars] = await post('stars', { ids: ['gcat', 'nbus', 'not an id'] }, K);
  assert.deepStrictEqual(mergedStars.ids.sort(), ['gcat', 'nbus']);
  assert.deepStrictEqual((await post('stars', { id: 'gcat', on: false }, K))[1].ids, ['nbus']);
  assert.strictEqual((await post('stars', { id: 'bad id' }, K))[0], 400);
  // Favorites hold addresses as well as tokens: one list, one account, one page.
  const favAddr = 'addr:o1acdefghjkmnpqr';
  assert.ok((await post('stars', { id: favAddr, on: true }, K))[1].ids.includes(favAddr), 'an address can be saved');
  assert.ok((await post('stars', { ids: ['gcat', favAddr] }, K))[1].ids.includes('gcat'), 'a mixed batch of tokens and addresses is fine');
  const afterFav = (await post('stars', { id: favAddr, on: false }, K))[1].ids;
  assert.ok(!afterFav.includes(favAddr), 'unstarring an address removes just it');
  assert.ok(afterFav.includes('nbus'), 'and leaves the other favorites alone');
  assert.ok((await get('tokens/gcat/trades?demo=1'))[1].trades.length >= 1);
  assert.strictEqual((await get('tokens/gcat/candles?demo=1&tf=nope'))[0], 400);
  assert.strictEqual((await get('tokens/missing/trades?demo=1'))[0], 404);
  assert.strictEqual((await get('collections?demo=1'))[1].collections[0].id, 'stamps');
  assert.strictEqual((await get('collections?demo=1&q=paper'))[1].collections[0].id, 'faces');
  assert.deepStrictEqual((await get('collections?demo=1&min_floor=5'))[1].collections.map((c) => c.id), ['stamps']);
  const [, stampsCol] = await get('collection/stamps?demo=1');
  assert.ok(stampsCol.items.length >= 1);
  assert.ok(stampsCol.items[0].traits.some((t) => t.trait === 'Backdrop'));
  assert.match(stampsCol.collection.enhanced.banner, /demo=1/);
  assert.strictEqual(stampsCol.collection.enhanced.website, 'https://example.com/stamps');
  assert.strictEqual(stampsCol.collection.enhanced.twitter, 'https://x.com/nightstamps');
  assert.strictEqual((await get('collection/faces?demo=1'))[1].collection.enhanced, null);
  assert.strictEqual((await fetch(base + '/api/profile-media/stamps/banner?demo=1')).status, 200);
  assert.strictEqual((await get('collection/stamps'))[0], 404);
  const [, saleC] = await get('collections/stamps/candles?demo=1&tf=5m');
  assert.strictEqual(saleC.kind, 'sale');
  assert.ok(saleC.candles.length > 0 && saleC.candles.every((c) => BigInt(c.h) >= BigInt(c.l) && BigInt(c.v) > 0n));
  const [, floorC] = await get('collections/stamps/candles?demo=1&tf=1m&kind=floor&limit=5');
  assert.strictEqual(floorC.candles.at(-1).c, '12000000');
  const [, weekC] = await get('collections/stamps/candles?demo=1&tf=1w&kind=sale&limit=8');
  assert.ok(weekC.candles.length >= 1 && weekC.candles.every((c) => new Date(c.t * 1000).getUTCDay() === 1));
  assert.strictEqual((await get('collections/stamps/candles?demo=1&kind=nope'))[0], 400);
  const [, nftBook] = await get('collections/stamps/book?demo=1');
  assert.strictEqual(nftBook.source, 'listings');
  assert.strictEqual(nftBook.label, 'Listings and floor depth');
  assert.strictEqual(nftBook.bids.length, 0);
  assert.strictEqual(nftBook.asks[0].price_micronoid, '12000000');
  assert.ok(BigInt(nftBook.asks[0].size) >= 1n);
  const [, nftAct] = await get('collections/stamps/activity?demo=1');
  assert.ok(nftAct.events.some((e) => e.kind === 'sale' && typeof e.usd === 'number' && e.wallet));
  assert.ok(nftAct.events.some((e) => e.kind === 'transfer' && e.wallet));
  assert.deepStrictEqual((await get('collections?demo=1&preset=watch&ids=stamps'))[1].collections.map((c) => c.id), ['stamps']);
  assert.ok((await post('stars', { id: 'stamps', on: true }, K))[1].ids.includes('stamps'));
  const [, off] = await get('swap/quote?token=gcat&side=buy&amount=100');
  assert.strictEqual(off.enabled, false);
  assert.strictEqual(off.signable, false);

  // Trade intents: on by default, off with SWAP_ENABLED=false, sized in micro-units on both sides, and the node's own
  // unsigned_intent_hex field is the payload the wallet signs.
  process.env.SWAP_ENABLED = 'false';
  assert.strictEqual((await get('swap/intent?token=...1&side=buy&amount=1&sender=o1acdefghjkmnpqr'))[0], 403, 'SWAP_ENABLED=false switches intents off');
  delete process.env.SWAP_ENABLED;
  const seenIntents = [];
  const INTENT_TOKEN = 'ef'.repeat(32);
  node.prepareNativeIntent = ({ owner, request }) => {
    seenIntents.push({ owner, request });
    return { plan_id: 'p1', intent_id: 'i1', owner, unsigned_intent_hex: 'deadbeef', review: { quoted_output: '282892894', minimum_output: '280063966', fee_micronoid: '9800', valid_until: 12 } };
  };
  const [, pageData] = await get('tokens/gcat?demo=1');
  assert.strictEqual(pageData.swap.intent.enabled, true, 'the token page route tells the page native trading is on');
  const [, buyI] = await get(`swap/intent?token=${INTENT_TOKEN}&side=buy&amount=1.5&slippage=1&sender=o1acdefghjkmnpqr`);
  assert.strictEqual(buyI.signable, true);
  assert.strictEqual(buyI.unsigned, 'deadbeef', 'the node field is read as the unsigned payload');
  assert.strictEqual(buyI.detail.review.quoted_output, '282892894');
  assert.strictEqual(seenIntents[0].request.gross_input, '1500000', 'a buy is sized in micro-NOID');
  assert.strictEqual(seenIntents[0].request.slippage_bps, 100);
  assert.strictEqual(seenIntents[0].request.buy, true);
  const [, sellI] = await get(`swap/intent?token=${INTENT_TOKEN}&side=sell&amount=5&slippage=1&sender=o1acdefghjkmnpqr`);
  assert.strictEqual(sellI.request.gross_input, '5000000', 'a sell is whole tokens scaled to micro-units');
  assert.strictEqual(seenIntents[1].request.buy, false);
  assert.strictEqual((await get(`swap/intent?token=${INTENT_TOKEN}&side=hold&amount=1&sender=o1acdefghjkmnpqr`))[0], 400);
  assert.strictEqual((await get(`swap/intent?token=${INTENT_TOKEN}&side=buy&amount=1`))[0], 400, 'a sender is required');
  assert.strictEqual((await post('swap-submit', { signed: 'not hex' }))[0], 400);
  assert.strictEqual((await post('swap-submit', { signed: 'deadbeef' }))[0], 400, 'a node that cannot submit says so');
  node.submitTxIntent = ({ hex }) => ({ txid: 'aa'.repeat(32), accepted: hex.length / 2 });
  const [, relayed] = await post('swap-submit', { signed: 'deadbeef' });
  assert.strictEqual(relayed.submitted, true, 'already-signed bytes are relayed');
  assert.strictEqual(relayed.result.accepted, 4);
  // A proven intent carries a ~77 KB authorization bundle; one well past that size still relays.
  const proven = '4e4f4944544f3231' + 'ab'.repeat(400_000);
  const [bigStatus, bigRelayed] = await post('swap-submit', { signed: proven });
  assert.strictEqual(bigStatus, 200, 'a full-size proven intent fits the submit limits');
  assert.strictEqual(bigRelayed.result.accepted, proven.length / 2);
  delete node.submitTxIntent;
  delete node.prepareNativeIntent;
  delete process.env.SWAP_ENABLED;

  const [, qte] = await get('swap/quote?demo=1&token=gcat&side=buy&amount=100&slippage=1');
  assert.strictEqual(qte.demo, true);
  assert.strictEqual(qte.signable, false);
  assert.strictEqual(qte.unsigned, null);
  assert.strictEqual(qte.fee_in_tx, false);
  assert.strictEqual(qte.fee.bps, 50);
  assert.strictEqual(qte.fee.micronoid, '500000');
  assert.strictEqual(qte.in.noid_micronoid, '100000000', 'the total the buyer pays includes the fee');
  assert.strictEqual(qte.to_venue_micronoid, '99500000');
  assert.ok(Math.abs(qte.price_impact_pct - 0.398) < 0.02);
  assert.ok(BigInt(qte.min_out.token) < BigInt(qte.expected_out.token));
  const [, sell] = await get('swap/quote?demo=1&token=gcat&side=sell&amount=1000&slippage=1');
  assert.ok(BigInt(sell.fee.micronoid) > 0n && BigInt(sell.min_out.noid_micronoid) < BigInt(sell.expected_out.noid_micronoid));
  assert.strictEqual((await get('swap/build?demo=1&token=gcat&side=buy&amount=1'))[0], 400);
  assert.strictEqual(db.prepare('select count(*) n from tokens').get().n, 0, 'demo rows are not written');
  // The only fills in the table are the ones a block body carried; nothing demo-shaped gets stored.
  assert.strictEqual(db.prepare('select count(*) n from token_trades where token_id != ?').get(TRADE_ASSET).n, 0);
  assert.strictEqual(db.prepare('select count(*) n from token_trades').get().n, 1);

  // The indexer stores a snapshot once the node answers, and a reorg drops trades above the new tip.
  process.env.ASSET_PROBE_MS = '0';
  // v2.1.0 nodes have no getAssetSnapshot; sync falls back to paged getNativeCatalog.
  const seenKinds = [];
  // The node takes positional params -- (kind, cursor, limit) -- and rejects the object
  // form the explorer used to send, which is what silently froze every catalogue read.
  node.getNativeCatalog = ([kind, cursor, limit]) => {
    seenKinds.push(kind);
    assert.ok(limit >= 1 && limit <= 64, 'node rejects limits outside 1..=64');
    if (kind === 'markets' && !cursor) return { kind, height: 1, items: [], next: { after_key: 'k1' } };
    if (kind === 'markets') return { kind, height: 1, items: [{ asset_id: 'ab'.repeat(32), whole_tokens: '100000', reserve_micronoid: '100000000' }], next: null };
    return { kind, height: 1, items: [], next: null };
  };
  await tick();
  assert.deepStrictEqual([...new Set(seenKinds)].sort(), ['collections', 'markets', 'nft_listings']);
  const nat = db.prepare('select * from tokens where id = ?').get('ab'.repeat(32));
  assert.ok(nat && nat.supply === '100000' && nat.ticker === 'ABABABAB', 'a native market is stored from the second catalogue page');
  // ?ids= is the favorites list itself, so it has to filter on its own: before, the favorites page listed every token.
  const onlyOne = await get(`tokens?ids=${TRADE_ASSET}`);
  assert.strictEqual(onlyOne[1].tokens.length, 1, 'ids filters the catalog with no preset attached');
  assert.strictEqual(onlyOne[1].tokens[0].id, TRADE_ASSET);
  assert.strictEqual((await get('tokens?ids=' + 'z'.repeat(9000)))[0], 400, 'a runaway ids list is refused');
  db.prepare('delete from tokens').run();
  // an empty catalogue still shows the curated fallback rows
  node.getNativeCatalog = ([kind]) => ({ kind, height: 1, items: [], next: null });
  await tick();
  const curated = require('./tokens-extra.json').map((x) => x.id);
  assert.ok(curated.every((id) => db.prepare('select 1 from tokens where id = ?').get(id)), 'curated fallback tokens are listed when the catalogue is empty');
  // v2.1 emits {key, primary, related}: the asset id is the key minus its class prefix.
  const k2 = 'cd'.repeat(32);
  node.getNativeCatalog = ([kind]) => (kind === 'markets'
    ? { kind, height: 1, items: [{ key: `8000${k2}`, primary: { kind: 49, amount_micronoid: '250000' }, whole_tokens: '100000', related: [{ kind: 1, amount_micronoid: '9000000' }] }], next: null }
    : { kind, height: 1, items: [], next: null });
  await tick();
  assert.ok(db.prepare('select * from tokens where id = ?').get(k2), 'a key-shaped catalogue entry stores its token');
  db.prepare('delete from tokens').run();
  // A v2.1 market row as the node really emits it: key/primary/related, no whole_tokens anywhere.
  node.getNativeCatalog = ([kind]) => (kind === 'markets'
    ? { kind, height: 1, items: [{ key: `8000${k2}`, primary: { kind: 49, amount_micronoid: '250000' }, related: [{ kind: 1, amount_micronoid: '0' }, { kind: 3, amount_micronoid: '500000000' }] }], next: null }
    : { kind, height: 1, items: [], next: null });
  await tick();
  const k2row = db.prepare('select * from tokens where id = ?').get(k2);
  assert.ok(k2row, 'a v2.1 catalogue row with no whole_tokens is still stored');
  assert.strictEqual(k2row.supply, '500000', 'supply is derived from the kind-3 backing relation');
  assert.strictEqual(k2row.reserve_micronoid, '250000', 'the market primary amount is the NOID reserve');
  db.prepare('delete from tokens').run();
  // The curve quote is the only live price a v2.1 node offers: a 1 NOID buy preview, price = 1e12 / out.
  node.walletPreviewNative = (arg) => { const r = Array.isArray(arg) ? arg[0] : arg;
    return { asset_id: r.asset_id, buy: r.buy, gross_input: r.gross_input, plan_id: 'p1', quoted_output: '200000000' }; };
  db.prepare('delete from token_marks').run();
  await tick();
  const priced = db.prepare('select * from tokens where id = ?').get(k2);
  assert.strictEqual(priced.price_micronoid, '5000', 'a v2.1 row takes its price from the curve quote');
  assert.strictEqual(db.prepare('select count(*) n from token_marks where id = ?').get(k2).n, 1, 'a sync leaves one price mark');
  // Two marks two hours apart give the change window and the spark something to read.
  db.prepare('insert into token_marks (id, ts, height, price_micronoid) values (?, ?, ?, ?)')
    .run(k2, Math.floor(Date.now() / 1000) - 7200, 1, '2500');
  const [, listed] = await get('tokens');
  const pricedRow = listed.tokens.find((t) => t.id === k2);
  assert.strictEqual(pricedRow.price_micronoid, '5000', 'the explorer row carries the curve price');
  assert.strictEqual(pricedRow.mcap_micronoid, '2500000000', 'mcap is price times supply');
  assert.strictEqual(pricedRow.fdv_micronoid, '2500000000', 'fdv follows the same price');
  assert.strictEqual(pricedRow.change['1h'], 100, '1h change is computed from the recorded marks');
  assert.strictEqual(pricedRow.spark.length, 2, 'the spark reads the recorded marks');
  delete node.walletPreviewNative;
  db.prepare('delete from tokens').run();
  db.prepare('delete from token_marks').run();
  delete node.getNativeCatalog;
  node.getAssetSnapshot = () => ({
    tokens: [{ id: 'live1', name: 'Live Coin', ticker: 'LIVE', supply: '1000', reserve_micronoid: '1000000', created_ts: 1700000000, graduated: false, price_micronoid: '1000', curve_target_micronoid: '20000000000', curve_raised_micronoid: '1000000000', holders: [{ address: 'o1acdefghjkmnpqr', balance: '400' }] }],
    trades: [{ txid: 'live1trade01', token_id: 'live1', ts: Math.floor(Date.now() / 1000) - 30, side: 'buy', token_amount: '10', noid_micronoid: '10000', price_micronoid: '1000', venue: 'curve', trader: 'o1acdefghjkmnpqr' }],
    transfers: [{ txid: 'live1trade01', token_id: 'live1', ts: Math.floor(Date.now() / 1000) - 30, to: 'o1acdefghjkmnpqr', amount: '10' }],
    collections: [{ id: 'col1', name: 'Live Col', items: 2, owners: 1, floor_micronoid: '5000000', volume_micronoid: '9000000', created_ts: 1700000000, nfts: [{ id: 'n1', name: 'One', owner: 'o1acdefghjkmnpqr' }] }],
  });
  await tick();
  await tick();
  assert.strictEqual(db.prepare(`select count(*) n from tokens where id = 'live1'`).get().n, 1, 'the snapshot token is stored once');
  assert.strictEqual(db.prepare("select count(*) n from token_trades where token_id = 'live1'").get().n, 1, 'the same trade is stored once');
  assert.strictEqual(db.prepare(`select n from token_candles where token_id = 'live1'`).get().n, 1, 'a trade rolls into one 1m candle, once');
  assert.strictEqual(db.prepare('select count(*) n from token_transfers').get().n, 1);
  const minute = Math.floor(Date.now() / 1000);
  const candleBase = minute - (minute % 300) - 600;
  node.getAssetSnapshot = () => ({
    tokens: [{ id: 'live1', name: 'Live Coin', ticker: 'LIVE', supply: '1000', reserve_micronoid: '1000000', created_ts: 1700000000, graduated: false, price_micronoid: '2000', curve_target_micronoid: '20000000000', curve_raised_micronoid: '1000000000', holders: [{ address: 'o1acdefghjkmnpqr', balance: '400' }, { address: 'o1qqqqqqqqqqqq', balance: '100' }] }],
    trades: [
      { txid: 'ohlcvtrade03', token_id: 'live1', ts: candleBase + 20, side: 'sell', token_amount: '1', noid_micronoid: '2000', price_micronoid: '1500', venue: 'curve', trader: 'o1acdefghjkmnpqr' },
      { txid: 'ohlcvtrade01', token_id: 'live1', ts: candleBase, side: 'buy', token_amount: '1', noid_micronoid: '1000', price_micronoid: '1000', venue: 'curve', trader: 'o1acdefghjkmnpqr' },
      { txid: 'ohlcvtrade04', token_id: 'live1', ts: candleBase + 5, side: 'sell', token_amount: '1', noid_micronoid: '100', price_micronoid: '500', venue: 'curve', trader: 'o1qqqqqqqqqqqq' },
      { txid: 'ohlcvtrade02', token_id: 'live1', ts: candleBase + 10, side: 'buy', token_amount: '1', noid_micronoid: '5000', price_micronoid: '3000', venue: 'curve', trader: 'o1acdefghjkmnpqr' },
      { txid: 'ohlcvtrade05', token_id: 'live1', ts: candleBase + 60, side: 'buy', token_amount: '1', noid_micronoid: '4000', price_micronoid: '2000', venue: 'curve', trader: 'o1acdefghjkmnpqr' },
      { txid: 'ohlcvweeksun', token_id: 'live1', ts: 1703980800, side: 'buy', token_amount: '1', noid_micronoid: '100', price_micronoid: '100', venue: 'curve', trader: 'o1acdefghjkmnpqr' },
      { txid: 'ohlcvweekmon', token_id: 'live1', ts: 1704067200, side: 'buy', token_amount: '1', noid_micronoid: '400', price_micronoid: '400', venue: 'curve', trader: 'o1acdefghjkmnpqr' },
    ],
  });
  await tick();
  const bar = db.prepare('select o, h, l, c, v, n from token_candles where token_id = ? and bucket = ?').get('live1', candleBase);
  assert.deepStrictEqual({ ...bar }, { o: 1000, h: 3000, l: 500, c: 1500, v: 8100, n: 4 }, 'minute OHLCV follows trade time, not ingest order');
  const [, m1] = await get('tokens/live1/candles?tf=1m&limit=50');
  const hit = m1.candles.find((c) => c.t === candleBase);
  assert.deepStrictEqual([hit.o, hit.h, hit.l, hit.c, hit.v, String(hit.n)], ['1000', '3000', '500', '1500', '8100', '4']);
  const [, five] = await get(`tokens/live1/candles?tf=5m&limit=1&before=${candleBase + 300}`);
  const rolled = five.candles.find((c) => c.t === candleBase);
  assert.ok(rolled && rolled.o === '1000' && rolled.h === '3000' && rolled.l === '500' && rolled.c === '2000' && rolled.v === '12100');
  const [, newestCandle] = await get('tokens/live1/candles?tf=1m&limit=1');
  assert.strictEqual(newestCandle.candles.length, 1);
  assert.strictEqual(newestCandle.more, true);
  const [, olderCandle] = await get(`tokens/live1/candles?tf=1m&limit=1&before=${newestCandle.oldest}`);
  assert.ok(olderCandle.candles.length === 1 && olderCandle.candles[0].t < newestCandle.oldest);
  const [, weeks] = await get('tokens/live1/candles?tf=1w&limit=50');
  assert.ok(weeks.candles.every((c) => new Date(c.t * 1000).getUTCDay() === 1), 'weekly candles start on Monday');
  assert.ok(weeks.candles.some((c) => c.t === 1703462400) && weeks.candles.some((c) => c.t === 1704067200));
  const candlePlan = db.prepare("explain query plan select bucket from token_candles where token_id = 'live1' and bucket < 2000000000 order by bucket desc limit 10").all().map((r) => r.detail).join(' ');
  assert.match(candlePlan, /token_candles/);
  assert.doesNotMatch(candlePlan, /TEMP B-TREE/);
  const tradePlan = db.prepare("explain query plan select ts from token_trades where token_id = 'live1' and ts < 2000000000 order by ts desc limit 1").all().map((r) => r.detail).join(' ');
  assert.match(tradePlan, /token_trades_tok_ts/);
  assert.doesNotMatch(tradePlan, /TEMP B-TREE/);
  const traderPlan = db.prepare("explain query plan select ts from token_trades where trader = 'o1acdefghjkmnpqr' order by ts desc limit 10").all().map((r) => r.detail).join(' ');
  assert.match(traderPlan, /token_trades_trader/);
  assert.doesNotMatch(traderPlan, /TEMP B-TREE/);
  const [, liveTok] = await get('tokens');
  assert.strictEqual(liveTok.demo, false);
  assert.strictEqual(liveTok.tokens[0].ticker, 'LIVE');
  assert.strictEqual(liveTok.tokens[0].backing_per_token_micronoid, '1000');
  assert.ok((await get('tokens?demo=1'))[1].tokens.every((t) => t.id !== 'live1'));
  assert.strictEqual((await get('token/live1'))[1].holders[0].address, 'o1acdefghjkmnpqr');
  assert.strictEqual((await get('collection/col1'))[1].items[0].name, 'One');
  assert.strictEqual((await get('swap/quote?token=live1&side=buy&amount=1'))[1].enabled, false, 'snapshot alone does not turn swaps on');
  db.prepare(`insert into token_trades (txid, token_id, ts, height, side, token_amount, noid_micronoid) values ('reorgtrade1', 'live1', 1700000000, ?, 'buy', '1', '1')`).run(tip + 5);
  db.prepare(`insert into token_candles (token_id, bucket, o, h, l, c, v, n, height) values ('live1', 1, 1, 1, 1, 1, 1, 1, ?)`).run(tip + 5);
  db.prepare(`insert into token_transfers (txid, token_id, ts, height, from_addr, to_addr, amount) values ('reorgxfer01', 'live1', 1, ?, '', 'o1acdefghjkmnpqr', '1')`).run(tip + 5);
  db.prepare(`insert into nft_sales (txid, collection_id, item_id, ts, height, price_micronoid) values ('reorgsale01', 'col1', 'n1', 1, ?, '1')`).run(tip + 5);
  db.prepare(`insert into nft_candles (collection_id, kind, bucket, o, h, l, c, v, n, height) values ('col1', 'sale', 1, 1, 1, 1, 1, 1, 1, ?)`).run(tip + 5);
  db.prepare(`insert into nft_transfers (txid, collection_id, item_id, ts, height, from_addr, to_addr) values ('reorgnxfer1', 'col1', 'n1', 1, ?, '', 'o1acdefghjkmnpqr')`).run(tip + 5);
  const tipBefore = tip;
  tip -= 2;
  await tick();
  assert.strictEqual(db.prepare(`select count(*) n from token_trades where txid = 'reorgtrade1'`).get().n, 0);
  // Candle heights are block heights now that fills come from bodies, so the reorg test asks about the tip.
  assert.strictEqual(db.prepare('select count(*) n from token_candles where height > ?').get(tip).n, 0);
  assert.strictEqual(db.prepare(`select count(*) n from token_transfers where txid = 'reorgxfer01'`).get().n, 0);
  assert.strictEqual(db.prepare(`select count(*) n from nft_sales where txid = 'reorgsale01'`).get().n, 0);
  assert.strictEqual(db.prepare('select count(*) n from nft_candles where height > 0').get().n, 0);
  assert.strictEqual(db.prepare(`select count(*) n from nft_transfers where txid = 'reorgnxfer1'`).get().n, 0);
  tip = tipBefore;
  await tick();
  delete process.env.ASSET_PROBE_MS;

  // Enhanced profile: images, https links, payment without credits, then admin approval.
  const images = require('./images.js');
  const png = images.solidPng(8, 8, [12, 40, 48]);
  const b64 = png.toString('base64');
  assert.throws(() => images.prepare(images.solidPng(1501, 10, [1, 1, 1]), 'banner'), /1500/);
  assert.throws(() => images.prepare(Buffer.concat([png, Buffer.alloc(1_000_000)]), 'banner'), /1 MB/);
  const text = Buffer.from('Comment\0secret-gps');
  const textLen = Buffer.alloc(4);
  textLen.writeUInt32BE(text.length);
  const dirtyPng = Buffer.concat([png.subarray(0, png.indexOf('IEND') - 4), textLen, Buffer.from('tEXt'), text, Buffer.alloc(4), png.subarray(png.indexOf('IEND') - 4)]);
  const cleaned = images.prepare(dirtyPng, 'icon');
  assert.strictEqual(cleaned.type, 'image/png');
  assert.ok(!cleaned.bytes.includes(Buffer.from('secret-gps')));
  const exif = Buffer.from('Exif\0\0SECRET');
  const app1Len = Buffer.alloc(2);
  app1Len.writeUInt16BE(exif.length + 2);
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe1]), app1Len, exif,
    Buffer.from([0xff, 0xc0, 0x00, 0x08, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01]),
    Buffer.from([0xff, 0xda, 0x00, 0x02, 0x00, 0xff, 0xd9]),
  ]);
  const jpg = images.prepare(jpeg, 'icon');
  assert.strictEqual(jpg.type, 'image/jpeg');
  assert.ok(!jpg.bytes.includes(Buffer.from('SECRET')));
  const vp8x = Buffer.alloc(18);
  vp8x.write('VP8X', 0); vp8x.writeUInt32LE(10, 4); vp8x.writeUIntLE(7, 12, 3); vp8x.writeUIntLE(7, 15, 3);
  const secret = Buffer.from('EXIFSECRET');
  const exifChunk = Buffer.alloc(8 + secret.length);
  exifChunk.write('EXIF', 0); exifChunk.writeUInt32LE(secret.length, 4); secret.copy(exifChunk, 8);
  const webpBody = Buffer.concat([vp8x, exifChunk]);
  const webp = Buffer.alloc(12 + webpBody.length);
  webp.write('RIFF', 0); webp.writeUInt32LE(4 + webpBody.length, 4); webp.write('WEBP', 8); webpBody.copy(webp, 12);
  const web = images.prepare(webp, 'icon');
  assert.strictEqual(web.type, 'image/webp');
  assert.ok(!web.bytes.includes(secret));
  const profileBody = (over) => ({ token_id: 'live1', description: 'A live coin with a night market.', website: 'https://example.com/live', twitter: 'https://twitter.com/livecoin', icon: b64, banner: b64, ...over });
  assert.strictEqual((await post('profile', profileBody(), {}))[0], 401);
  assert.match((await post('profile', profileBody({ website: 'http://example.com/live' }), K))[1].error, /https/);
  assert.strictEqual((await post('profile', profileBody({ website: 'javascript:alert(1)' }), K))[0], 400);
  assert.strictEqual((await post('profile', profileBody({ website: 'https://user:pass@example.com/live' }), K))[0], 400);
  const [, made] = await post('profile', profileBody(), K);
  assert.strictEqual(made.status, 'unpaid');
  assert.strictEqual(made.usd, 100);
  assert.strictEqual(made.usdc, 100);
  const [, updated] = await post('profile', profileBody({ description: 'Updated night market coin.' }), K);
  assert.strictEqual(updated.id, made.id);
  const creditsBefore = await credits();
  const [, pay] = await post('profile-pay', { id: made.id, method: 'noid' }, K);
  assert.strictEqual(pay.kind, 'profile');
  assert.strictEqual(pay.usd, 100);
  const microP = Math.round(Number(pay.amount_noid) * 1e6);
  assert.ok(microP > 500e6 && microP < 500e6 + 10000, pay.amount_noid);
  const taken = new Set(db.prepare('select dust from noid_topups where paid_ref is null and id != ?').all(pay.id).map((r) => r.dust));
  let dust = 4242;
  while (taken.has(dust)) dust++;
  const amount = 1_495_000_000 + dust;
  db.prepare('update noid_topups set amount = ?, dust = ? where id = ?').run(amount, dust, pay.id);
  paySlots = [{ slot_index: 40, value: String(amount), creation_id: 'prof1' }];
  await tick();
  await mine(18);
  paySlots = [];
  assert.strictEqual(await credits(), creditsBefore, 'a profile payment does not add credits');
  assert.strictEqual((await get(`profile/${made.id}`, { headers: K }))[1].status, 'pending');
  assert.strictEqual((await get('token/live1?window=1h'))[1].token.enhanced, null);
  assert.strictEqual((await fetch(base + '/api/profile-media/live1/icon', { headers: { 'sec-fetch-site': 'same-origin' } })).status, 404);
  assert.strictEqual((await get('admin', { headers: { 'x-admin-token': 'adm-test' } }))[0], 200);
  process.env.ADMIN_TOKEN = 'adm-test';
  try {
    assert.strictEqual((await get('admin'))[0], 401);
    assert.strictEqual((await get('admin', { headers: { 'x-admin-token': 'nope' } }))[0], 401);
    const [, queue] = await get('admin', { headers: { 'x-admin-token': 'adm-test' } });
    assert.ok(queue.pending.some((p) => p.id === made.id && p.description === 'Updated night market coin.'));
    const preview = await fetch(base + `/api/admin-media/${made.id}/banner`, { headers: { 'x-admin-token': 'adm-test', 'sec-fetch-site': 'same-origin' } });
    assert.strictEqual(preview.status, 200);
    assert.match(preview.headers.get('content-type'), /image\/png/);
    assert.ok((await preview.arrayBuffer()).byteLength > 20);
    assert.strictEqual((await post('admin', { id: made.id, action: 'approve' }, { 'x-admin-token': 'adm-test' }))[1].status, 'approved');
    const [, shown] = await get('token/live1?window=5m');
    assert.strictEqual(shown.token.enhanced.description, 'Updated night market coin.');
    assert.strictEqual(shown.token.enhanced.website, 'https://example.com/live');
    assert.strictEqual(shown.token.enhanced.twitter, 'https://x.com/livecoin');
    assert.match(shown.token.logo, /profile-media\/live1\/icon/);
    const listed = (await get('tokens?window=5m'))[1].tokens.find((t) => t.id === 'live1');
    assert.strictEqual(listed.enhanced.twitter, 'https://x.com/livecoin');
    const pub = await fetch(base + '/api/profile-media/live1/banner', { headers: { 'sec-fetch-site': 'same-origin' } });
    assert.strictEqual(pub.status, 200);
    assert.match(pub.headers.get('content-type'), /image\/png/);
    assert.strictEqual((await post('profile', profileBody({ description: 'again' }), K))[0], 400);
    const [, second] = await post('profile', profileBody({ token_id: 'live2', description: 'Second listing.', twitter: '' }), K);
    assert.match((await post('profile-pay', { id: second.id, method: 'card' }, K))[1].error, /method must be noid or usdc/, 'no card rail for profiles either');
    const [, pay2] = await post('profile-pay', { id: second.id, method: 'noid' }, K);
    assert.strictEqual(pay2.kind, 'profile');
    assert.ok(Number(pay2.amount_noid) > 0);
    db.prepare("update token_profiles set status = 'pending', pay_ref = 'noid:testprof' where id = ?").run(second.id);
    assert.strictEqual((await get(`profile/${second.id}`, { headers: K }))[1].status, 'pending');
    assert.strictEqual(await credits(), creditsBefore, 'promoting with NOID does not touch API credits');
    assert.strictEqual((await post('admin', { id: second.id, action: 'reject' }, { 'x-admin-token': 'adm-test' }))[1].status, 'rejected');
    assert.strictEqual((await get(`profile/${second.id}`, { headers: K }))[1].status, 'rejected');
    assert.ok(!(await get('admin', { headers: { 'x-admin-token': 'adm-test' } }))[1].pending.some((p) => p.id === second.id));
  } finally {
    delete process.env.ADMIN_TOKEN;
  }
  assert.strictEqual((await get('admin', { headers: { 'x-admin-token': 'adm-test' } }))[0], 404);
  process.env.ADMIN_TOKEN = 'adm-test';   // the rest of the suite walks the review queue
  const [, gcat] = await get('tokens/gcat?demo=1');
  assert.match(gcat.token.enhanced.banner, /demo=1/);
  assert.strictEqual(gcat.token.enhanced.twitter, 'https://x.com/ghostcat');
  assert.strictEqual((await get('tokens/qsun?demo=1'))[1].token.enhanced, null);
  assert.strictEqual((await get('tokens?demo=1'))[1].enhance_usd, 100);
  assert.strictEqual((await get('tokens?demo=1&window=6h'))[1].enhance_usdc, 100);
  const demoImg = await fetch(base + '/api/profile-media/gcat/banner?demo=1');
  assert.strictEqual(demoImg.status, 200);
  assert.match(demoImg.headers.get('content-type'), /image\/png/);
  assert.strictEqual((await fetch(base + '/api/profile-media/qsun/icon?demo=1')).status, 404);

  // Order book: pool or curve reserves until the node exposes getOpenOrders.
  const [, gcatBook] = await get('tokens/gcat/book?demo=1');
  assert.strictEqual(gcatBook.demo, true);
  assert.strictEqual(gcatBook.source, 'reserves');
  assert.match(gcatBook.label, /pool reserves/);
  assert.ok(gcatBook.bids.length && gcatBook.asks.length);
  assert.ok(BigInt(gcatBook.asks[0].price_micronoid) > BigInt(gcatBook.bids[0].price_micronoid));
  assert.ok(gcatBook.spread_micronoid && gcatBook.trades.length);
  assert.match((await get('tokens/qsun/book?demo=1'))[1].label, /curve reserves/);
  const [, liveBook] = await get('tokens/live1/book');
  assert.strictEqual(liveBook.demo, false);
  assert.strictEqual(liveBook.source, 'reserves');
  assert.strictEqual(liveBook.bids.length, 0);
  assert.ok(liveBook.trades.length);
  process.env.ASSET_PROBE_MS = '0';
  node.getOpenOrders = () => ({
    bids: [{ price_micronoid: '1000', token_amount: '5' }, { price_micronoid: '1000', token_amount: '5' }],
    asks: [{ price_micronoid: '1200', token_amount: '3' }],
  });
  await tick();
  const [, openBook] = await get('tokens/live1/book?window=1m');
  assert.strictEqual(openBook.source, 'orders');
  assert.strictEqual(openBook.label, 'Open orders');
  assert.strictEqual(openBook.bids[0].size, '10');
  assert.strictEqual(openBook.asks[0].size, '3');
  assert.strictEqual(openBook.spread_micronoid, '200');
  delete node.getOpenOrders;
  await tick();
  assert.strictEqual((await get('tokens/live1/book?window=5m'))[1].source, 'reserves');
  delete process.env.ASSET_PROBE_MS;
  process.env.ASSET_PROBE_MS = '0';
  const nftNow = Math.floor(Date.now() / 1000);
  node.getAssetSnapshot = () => ({
    collections: [{
      id: 'col1', name: 'Live Col', items: 2, owners: 1, floor_micronoid: '5000000', volume_micronoid: '9000000', created_ts: 1700000000,
      nfts: [{ id: 'n1', name: 'One', owner: 'o1acdefghjkmnpqr', traits: [{ trait: 'Ink', value: 'Blue' }] }],
      sales: [{ txid: 'col1sale0001', item_id: 'n1', ts: nftNow - 40, price_micronoid: '5000000', seller: 'o1qqqqqqqqqqqq', buyer: 'o1acdefghjkmnpqr', height: 1 }],
      transfers: [{ txid: 'col1xfer0001', item_id: 'n1', ts: nftNow - 20, from: 'o1qqqqqqqqqqqq', to: 'o1acdefghjkmnpqr' }],
      listings: [{ item_id: 'n1', price_micronoid: '5000000', seller: 'o1acdefghjkmnpqr' }],
    }],
  });
  await tick();
  assert.strictEqual((await get('collection/col1'))[1].items[0].traits[0].value, 'Blue');
  assert.ok((await get('collections/col1/activity'))[1].events.some((e) => e.kind === 'sale' && e.price_micronoid === '5000000' && e.wallet));
  const [, listedBook] = await get('collections/col1/book');
  assert.strictEqual(listedBook.source, 'listings');
  assert.match(listedBook.label, /floor depth/);
  assert.strictEqual(listedBook.asks[0].size, '1');
  assert.ok((await get('collections/col1/candles?tf=1m&kind=sale&limit=5'))[1].candles.some((c) => c.c === '5000000' && BigInt(c.v) >= 5000000n));
  assert.ok((await get('collections/col1/candles?tf=1m&kind=floor&limit=3'))[1].candles.some((c) => c.c === '5000000'));
  const salePlan = db.prepare("explain query plan select ts from nft_sales where collection_id = 'col1' and ts < 2000000000 order by ts desc limit 10").all().map((r) => r.detail).join(' ');
  assert.match(salePlan, /nft_sales_col_ts/);
  assert.doesNotMatch(salePlan, /TEMP B-TREE/);
  const nftCandlePlan = db.prepare("explain query plan select bucket from nft_candles where collection_id = 'col1' and kind = 'sale' and bucket < 2000000000 order by bucket desc limit 10").all().map((r) => r.detail).join(' ');
  assert.match(nftCandlePlan, /nft_candles/);
  assert.doesNotMatch(nftCandlePlan, /TEMP B-TREE/);
  node.getNftOrders = () => ({
    listings: [{ price_micronoid: '5000000', item_id: 'n1' }, { price_micronoid: '7000000' }],
    bids: [{ price_micronoid: '4000000', size: '2' }],
  });
  await tick();
  const [, nftOrders] = await get('collections/col1/book?window=1m');
  assert.strictEqual(nftOrders.source, 'orders');
  assert.strictEqual(nftOrders.label, 'NFT orders');
  assert.strictEqual(nftOrders.asks[0].size, '1');
  assert.strictEqual(nftOrders.bids[0].size, '2');
  delete node.getNftOrders;
  await tick();
  assert.strictEqual((await get('collections/col1/book?window=5m'))[1].source, 'listings');
  delete process.env.ASSET_PROBE_MS;
  const [, liveWal] = await get('wallet/o1acdefghjkmnpqr?token=live1');
  assert.strictEqual(liveWal.demo, false);
  assert.ok(liveWal.holdings.some((h) => h.token_id === 'live1' && h.balance === '400'));
  assert.ok(liveWal.trades.length >= 1 && liveWal.pnl.txns >= 1);
  assert.ok(liveWal.balance_points == null);
  assert.ok(liveWal.usd_points == null);

  // Balances are read from the node's own state pages: kind 2 is one token balance, several pages of the same token
  // are summed, and every other kind is a market, listing or collection page. The indexed table is only a fallback.
  const pageHex = (id, units) => '4e4f494441533231' + '0100' + '0200' + id + '00'.repeat(32)
    + BigInt(units).toString(16).padStart(16, '0').match(/../g).reverse().join('') + '00'.repeat(8);
  const HEXID = 'ab'.repeat(32); // a real asset id, not a demo slug: the address decoder insists on 32 bytes
  db.prepare('insert or replace into tokens (id, name, ticker, supply, reserve_micronoid, price_micronoid) values (?, ?, ?, ?, ?, ?)')
    .run(HEXID, 'Page Coin', 'PAGE', '1000', '1000000', '2000');
  node.getNativeHoldings = ({ owner }) => ({ owner, height: 1, next: null, holdings: [
    { kind: 2, slot_index: 1, opening_hex: pageHex(HEXID, 250000000) },
    { kind: 2, slot_index: 2, opening_hex: pageHex(HEXID, 150000000) },
    { kind: 2, slot_index: 3, opening_hex: pageHex(HEXID, 0) },
    { kind: 1, slot_index: 4, opening_hex: pageHex(HEXID, 999000000) },
  ] });
  const [, fromNode] = await get('wallet/o1acdefghjkmnpqr');
  const held = fromNode.holdings.find((h) => h.token_id === HEXID);
  assert.ok(held, 'the node holdings are used when the node answers');
  assert.strictEqual(fromNode.holdings.length, 1, 'a market page is not a balance and an empty page is dropped');
  assert.strictEqual(held.units, '400000000', 'two pages of the same token sum');
  assert.strictEqual(held.balance, '400');
  assert.strictEqual(held.ticker, 'PAGE');
  assert.strictEqual(held.onchain, true);
  const [, screener] = await get('tokens/' + HEXID);
  assert.strictEqual(held.price_micronoid, screener.token.price_micronoid, 'the wallet prices a token exactly as the screener does');
  assert.strictEqual(held.value_micronoid, (BigInt(held.balance) * BigInt(held.price_micronoid)).toString(), 'value is quantity times price');
  assert.ok(Number.isFinite(held.value_usd));
  // The stored price column is often empty on the live chain; then the last trade is the price, as on the screener.
  db.prepare("update tokens set price_micronoid = null where id = ?").run(HEXID);
  db.prepare(`insert or replace into token_trades (txid, token_id, ts, height, side, token_amount, noid_micronoid, trader, venue, price_micronoid)
    values ('pagepx01', ?, ?, 60, 'buy', '5', '6175', 'o1acdefghjkmnpqr', 'curve', '1235')`).run(HEXID, Math.floor(Date.now() / 1000) - 10);
  const [, repriced] = await get('wallet/o1tkaxk4f6n638xesg8k7jyydx0ruugeccwtynsl5cmjedg6vpjhfsfes7dp');
  const rp = repriced.holdings.find((h) => h.token_id === HEXID);
  assert.ok(rp, 'a fresh address still reads its holdings');
  assert.strictEqual(rp.price_micronoid, '1235', 'the last trade prices a token the column left empty');
  assert.strictEqual(rp.value_micronoid, '494000', '400 whole tokens at 1235');
  db.prepare('delete from token_trades where txid = ?').run('pagepx01');
  // A buy must never read as a total loss. The address view has no focused token, so the remaining bag has to be
  // priced per token; before this, the price was null there and every buy showed as -100% of what was spent.
  const BAGTOK = 'cd'.repeat(32);
  const BAGADDR = 'o1acdefghjkmnpqrstuvwxyz';
  db.prepare('insert or replace into tokens (id, name, ticker, supply, reserve_micronoid, price_micronoid) values (?, ?, ?, ?, ?, ?)')
    .run(BAGTOK, 'Bag Coin', 'BAG', '1000', '1000000', '2500'); // 2500 micronoid per whole token
  db.prepare(`insert or replace into token_trades (txid, token_id, ts, height, side, token_amount, noid_micronoid, trader, venue, price_micronoid)
    values ('bagbuy01', ?, ?, 61, 'buy', '40', '120000', ?, 'curve', '3000')`).run(BAGTOK, Math.floor(Date.now() / 1000) - 5, BAGADDR);
  // A newer fill by someone else moves the price the screener quotes, and the bag follows it.
  db.prepare(`insert or replace into token_trades (txid, token_id, ts, height, side, token_amount, noid_micronoid, trader, venue, price_micronoid)
    values ('bagpx02', ?, ?, 62, 'sell', '10', '25000', 'o1acdefghjkmnpqrstuvwx', 'curve', '2500')`).run(BAGTOK, Math.floor(Date.now() / 1000) - 2);
  const [, bagwal] = await get('wallet/' + BAGADDR);
  assert.strictEqual(bagwal.pnl.bought_noid_micronoid, '120000', 'the buy is the cost basis');
  assert.strictEqual(bagwal.pnl.held_micronoid, '100000', '40 whole tokens still held, priced at the live 2500');
  assert.strictEqual(bagwal.pnl.pnl_micronoid, '-20000', 'the bag is credited: 100000 sold/value minus 120000 spent');
  assert.notStrictEqual(bagwal.pnl.pnl_micronoid, '-' + bagwal.pnl.bought_noid_micronoid, 'a buy is not the whole stake lost');
  assert.strictEqual(bagwal.pnl.unpriced_token, '0');
  assert.ok(bagwal.pnl.pnl_usd < 0 && bagwal.pnl.pnl_usd > -1, 'a small loss in USD, not the whole stake');
  // Focused on the token, the same bag is priced the same way.
  const [, focusedBag] = await get('wallet/' + BAGADDR + '?token=' + BAGTOK);
  assert.strictEqual(focusedBag.pnl.held_micronoid, '100000', 'the focused view prices the bag too');
  assert.strictEqual(focusedBag.pnl.pnl_micronoid, '-20000');
  db.prepare('delete from token_trades where txid = ?').run('bagbuy01');
  db.prepare('delete from token_trades where txid = ?').run('bagpx02');
  db.prepare('delete from tokens where id = ?').run(BAGTOK);

  // What a sale would actually pay, not what the mark price says: the node's own plan, asked for with quote=1.
  node.prepareNativeIntent = ({ owner, request }) => ({ review: {
    quoted_output: '2100000', noid_credit_micronoid: '2092600', fee_micronoid: '7400', request,
  } });
  const SELLADDR = 'o1acdefghjkmnpqrstuvwx';
  const [, qwal] = await get('wallet/' + SELLADDR + '?quote=1');
  const qh = qwal.holdings.find((h) => h.token_id === HEXID);
  assert.ok(qh, 'the holding is still listed with a quote');
  assert.strictEqual(qh.sell_now.net_micronoid, '2092600', 'the sale offer is the net credit after the network fee');
  assert.strictEqual(qh.sell_now.gross_micronoid, '2100000');
  assert.strictEqual(qh.sell_now.tokens, '400', 'a sale is sized in whole tokens');
  assert.ok(qh.sell_now.net_usd > 0 && qh.sell_now.net_usd < qh.value_usd, 'the offer in USD is below the mark value');
  const [, plain] = await get('wallet/' + SELLADDR);
  assert.strictEqual(plain.holdings.find((h) => h.token_id === HEXID).sell_now, undefined, 'no quote is asked for without quote=1');
  delete node.prepareNativeIntent;
  // A node without the method is the refusal case, and a different address keeps the response cache out of it.
  delete node.getNativeHoldings;
  await tick();
  const [, fallback] = await get('wallet/o1qqqqqqqqqqqq');
  assert.ok(fallback.holdings.some((h) => h.token_id === 'live1' && !h.onchain), 'a node without the method falls back to the indexed table');
  db.prepare('delete from tokens where id = ?').run(HEXID);
  await tick();

  // USDC: a chain is off until its address is set. An exact base-unit amount marks the profile pending and does not add credits.
  const { solanaCredits, mints, report } = require('./usdc.js');
  assert.strictEqual(mints.ethereum, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
  assert.strictEqual(mints.base, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  assert.strictEqual(mints.arbitrum, '0xaf88d065e77c8cC2239327C5EDb3A432268e5831');
  assert.strictEqual(mints.optimism, '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85');
  assert.strictEqual(mints.polygon, '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359');
  assert.strictEqual(mints.avalanche, '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E');
  assert.strictEqual(mints.solana, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  const usdcSrc = fs.readFileSync(path.join(__dirname, 'usdc.js'), 'utf8').toLowerCase();
  for (const bridged of ['0xff970a61a04b1ca14834a43f5de4533ebddb5cc8', '0x7f5c764cbc14f9669b88837ca1490cca17c31607', '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', '0xa7d7079b0fead91f3e65f86e8915cb59c1a4c664']) {
    assert.ok(!usdcSrc.includes(bridged), bridged);
  }
  const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const owner = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
  const solTx = {
    transaction: { signatures: ['sig1'], message: { instructions: [] } },
    meta: {
      preTokenBalances: [{ accountIndex: 0, mint, owner, uiTokenAmount: { amount: '10' } }],
      postTokenBalances: [
        { accountIndex: 0, mint, owner, uiTokenAmount: { amount: '100000133' } },
        { accountIndex: 1, mint: 'other', owner, uiTokenAmount: { amount: '999' } },
      ],
    },
  };
  assert.deepStrictEqual(solanaCredits(solTx, { address: owner, mint }), [{ tx: 'sig1', amount: '100000123' }]);
  const ata = 'Ata111111111111111111111111111111111111111';
  const solToAta = {
    transaction: { signatures: ['sig2'], message: { instructions: [{ parsed: { type: 'transferChecked', info: { destination: ata, mint, tokenAmount: { amount: '100000123' } } } }] } },
    meta: {},
  };
  assert.deepStrictEqual(solanaCredits(solToAta, { address: ata, mint }), [{ tx: 'sig2', amount: '100000123' }]);
  assert.deepStrictEqual(solanaCredits({ ...solToAta, meta: { err: 'fail' } }, { address: ata, mint }), []);
  assert.deepStrictEqual(solanaCredits({
    transaction: { signatures: ['sig3'], message: { instructions: [{ parsed: { type: 'transferChecked', info: { destination: ata, mint: 'nope', tokenAmount: { amount: '9' } } } }] } },
    meta: {},
  }, { address: ata, mint }), []);
  const [, third] = await post('profile', profileBody({ token_id: 'live3', description: 'Waiting on USDC.' }), K);
  assert.strictEqual(third.status, 'unpaid');
  assert.match((await post('profile-pay', { id: third.id, method: 'usdc', chain: 'base' }, K))[1].error, /USDC_EVM_ADDRESS/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, 'usdc.js'), 'utf8'), /generateKeyPair|Keypair|privateKey|createWallet/);
  process.env.USDC_EVM_ADDRESS = '0x' + 'ab'.repeat(20);
  assert.match(report().join('\n'), /USDC_EVM_ADDRESS is not a checksummed/);
  assert.deepStrictEqual((await get('boosts?kind=token&window=badevm'))[1].usdc_chains, []);
  const payAddr = '0xABaBaBaBABabABabAbAbABAbABabababaBaBABaB';
  const ethOnly = '0xCdCDCdCdcdcdcdCdcDcDCdcDcDCdCdcdCdcDCDcD';
  process.env.USDC_EVM_ADDRESS = payAddr;
  process.env.USDC_SOLANA_ADDRESS = '0x' + '11'.repeat(20);
  assert.match(report().join('\n'), /USDC_SOLANA_ADDRESS is not a valid base58/);
  assert.match((await post('profile-pay', { id: third.id, method: 'usdc', chain: 'solana' }, K))[1].error, /pick an enabled/);
  assert.deepStrictEqual((await get('boosts?kind=token&window=six'))[1].usdc_chains.map((c) => c.id).sort(), ['arbitrum', 'avalanche', 'base', 'ethereum', 'optimism', 'polygon']);
  process.env.USDC_SOLANA_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  assert.ok((await get('boosts?kind=token&window=solok'))[1].usdc_chains.some((c) => c.id === 'solana'));
  assert.match((await post('profile-pay', { id: third.id, method: 'usdc', chain: 'solana' }, K))[1].error, /USDC_SOLANA_RPC_URL/);
  delete process.env.USDC_SOLANA_ADDRESS;
  assert.match((await post('profile-pay', { id: third.id, method: 'usdc', chain: 'base' }, K))[1].error, /USDC_BASE_RPC_URL/);
  let usdcLog = null;
  let usdcTx = '0x' + 'ab'.repeat(32);
  let usdcLogs = null;
  const usdcRpc = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c)).on('end', () => {
      const call = JSON.parse(body || '{}');
      const logs = usdcLogs || (usdcLog ? [{ transactionHash: usdcTx, data: '0x' + BigInt(usdcLog).toString(16) }] : []);
      const result = call.method === 'eth_blockNumber' ? '0x64' : logs;
      res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
    });
  });
  const emptyRpc = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c)).on('end', () => {
      const call = JSON.parse(body || '{}');
      const result = call.method === 'eth_blockNumber' ? '0x64' : [];
      res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
    });
  });
  await new Promise((r) => usdcRpc.listen(0, '127.0.0.1', r));
  await new Promise((r) => emptyRpc.listen(0, '127.0.0.1', r));
  try {
    process.env.USDC_BASE_RPC_URL = `http://127.0.0.1:${usdcRpc.address().port}`;
    process.env.USDC_ETHEREUM_RPC_URL = `http://127.0.0.1:${emptyRpc.address().port}`;
    const [payStatus, order] = await post('profile-pay', { id: third.id, method: 'usdc', chain: 'base' }, K);
    assert.strictEqual(payStatus, 200);
    assert.strictEqual(order.chain, 'base');
    assert.strictEqual(order.address, payAddr);
    assert.strictEqual(order.usdc, 100);
    assert.match(order.amount_usdc, /^100\./);
    assert.strictEqual(order.reference, order.amount_base.slice(-6));
    assert.strictEqual(order.paid, false);
    assert.strictEqual((await get(`usdc-order/${order.id}`, { headers: K }))[1].amount_base, order.amount_base);
    usdcLog = (BigInt(order.amount_base) + 1n).toString();
    assert.strictEqual(await pollUsdc(), 0);
    assert.strictEqual((await get(`profile/${third.id}`, { headers: K }))[1].status, 'unpaid');
    usdcLog = order.amount_base;
    assert.strictEqual(await pollUsdc(), 1);
    assert.strictEqual((await get(`profile/${third.id}`, { headers: K }))[1].status, 'pending');
    assert.strictEqual(await credits(), creditsBefore, 'USDC profile payment does not add credits');
    assert.strictEqual(await pollUsdc(), 0);
    assert.strictEqual((await get(`usdc-order/${order.id}`, { headers: K }))[1].paid, true);

    // A promoted slot uses the pack price, stays out of the organic sort, and expires on the next read.
    process.env.BOOST_PACKS = '12:6h';
    assert.strictEqual((await post('boost', { asset_id: 'live1', kind: 'token', pack: 'nope' }, K))[0], 400);
    assert.strictEqual((await post('boost', { asset_id: 'not-a-token', kind: 'token', pack: '6h' }, K))[0], 400);
    const [boostStatus, madeBoost] = await post('boost', { asset_id: 'live1', kind: 'token', pack: '6h' }, K);
    assert.strictEqual(boostStatus, 200);
    assert.strictEqual(madeBoost.usdc, 12);
    assert.strictEqual(madeBoost.status, 'unpaid');
    const [, colBoost] = await post('boost', { asset_id: 'col1', kind: 'collection', pack: '6h' }, K);
    assert.strictEqual(colBoost.kind, 'collection');
    assert.match((await post('boost-pay', { id: madeBoost.id, method: 'card' }, K))[1].error, /method must be noid or usdc/);
    assert.strictEqual((await get('boosts?kind=token&window=poly1'))[1].usdc_chains.find((c) => c.id === 'polygon').confirmations, 128);
    process.env.USDC_POLYGON_CONFIRMATIONS = '5';
    assert.strictEqual((await get('boosts?kind=token&window=poly2'))[1].usdc_chains.find((c) => c.id === 'polygon').confirmations, 5);
    assert.match((await post('boost-pay', { id: colBoost.id, method: 'usdc', chain: 'polygon' }, K))[1].error, /USDC_POLYGON_RPC_URL/);
    process.env.USDC_POLYGON_ADDRESS = '0x' + 'cd'.repeat(20);
    assert.ok(!(await get('boosts?kind=token&window=badpoly'))[1].usdc_chains.some((c) => c.id === 'polygon'));
    delete process.env.USDC_POLYGON_ADDRESS;
    delete process.env.USDC_POLYGON_CONFIRMATIONS;
    const listed = (await get('boosts?kind=token&window=chains'))[1].usdc_chains.map((c) => c.id).sort();
    assert.deepStrictEqual(listed, ['arbitrum', 'avalanche', 'base', 'ethereum', 'optimism', 'polygon']);
    process.env.USDC_ETHEREUM_ADDRESS = ethOnly;
    const [ethStatus, ethOrder] = await post('boost-pay', { id: colBoost.id, method: 'usdc', chain: 'ethereum' }, K);
    assert.strictEqual(ethStatus, 200);
    assert.strictEqual(ethOrder.chain, 'ethereum');
    assert.strictEqual(ethOrder.address, ethOnly);
    delete process.env.USDC_ETHEREUM_ADDRESS;
    usdcTx = '0x' + 'ee'.repeat(32);
    usdcLog = ethOrder.amount_base;
    assert.strictEqual(await pollUsdc(), 0, 'a Base log does not settle an Ethereum order');
    assert.strictEqual((await get(`boost/${colBoost.id}`, { headers: K }))[1].status, 'unpaid');
    const [boostPayStatus, boostOrder] = await post('boost-pay', { id: madeBoost.id, method: 'usdc', chain: 'base' }, K);
    assert.strictEqual(boostPayStatus, 200);
    assert.strictEqual(boostOrder.usdc, 12);
    assert.match(boostOrder.amount_usdc, /^12\./);
    const [colPayStatus, colOrder] = await post('boost-pay', { id: colBoost.id, method: 'usdc', chain: 'base' }, K);
    assert.strictEqual(colPayStatus, 200);
    usdcLog = null;
    const sharedTx = '0x' + 'cd'.repeat(32);
    usdcLogs = [
      { transactionHash: sharedTx, data: '0x' + BigInt(boostOrder.amount_base).toString(16) },
      { transactionHash: sharedTx, data: '0x' + BigInt(colOrder.amount_base).toString(16) },
    ];
    assert.strictEqual(await pollUsdc(), 1, 'one transaction settles one order');
    assert.strictEqual((await get(`boost/${madeBoost.id}`, { headers: K }))[1].status, 'pending');
    assert.strictEqual((await get(`boost/${colBoost.id}`, { headers: K }))[1].status, 'unpaid');
    assert.strictEqual(await pollUsdc(), 0, 'the same transaction is not counted again');
    assert.strictEqual((await get(`boost/${colBoost.id}`, { headers: K }))[1].status, 'unpaid');
    usdcLogs = null;
    assert.strictEqual((await get(`boost/${madeBoost.id}`, { headers: K }))[1].status, 'pending');
    assert.strictEqual(await credits(), creditsBefore, 'a promoted slot does not add credits');
    assert.ok(!(await get('boosts?kind=token&window=1m'))[1].boosts.some((b) => b.asset_id === 'live1'));
    const organic = (await get('tokens?sort=volume&dir=desc&window=6h'))[1].tokens.map((t) => t.id);
    process.env.ADMIN_TOKEN = 'adm-test';
    assert.strictEqual((await post('admin', { id: madeBoost.id, action: 'approve', kind: 'boost' }, { 'x-admin-token': 'adm-test' }))[1].status, 'live');
    const [, liveBoosts] = await get('boosts?kind=token&window=5m');
    assert.ok(liveBoosts.boosts.some((b) => b.asset_id === 'live1' && b.label === 'Promoted'));
    assert.doesNotMatch(JSON.stringify(liveBoosts), /Recommended/);
    assert.deepStrictEqual((await get('tokens?sort=volume&dir=desc&window=24h'))[1].tokens.map((t) => t.id), organic);
    db.prepare('update boosts set ends = ? where id = ?').run(Date.now() - 1000, madeBoost.id);
    const [, expiredBoosts] = await get('boosts?kind=token&window=1h');
    assert.ok(!expiredBoosts.boosts.some((b) => b.asset_id === 'live1'));
    assert.strictEqual(db.prepare('select status from boosts where id = ?').get(madeBoost.id).status, 'expired');
    const boostPlan = db.prepare("explain query plan select asset_id from boosts where status = 'live' and ends > 0 order by ends").all().map((r) => r.detail).join(' ');
    assert.match(boostPlan, /boosts_live/);
    assert.doesNotMatch(boostPlan, /TEMP B-TREE/);
  } finally {
    usdcRpc.close();
    emptyRpc.close();
    for (const key of ['USDC_EVM_ADDRESS', 'USDC_BASE_ADDRESS', 'USDC_BASE_RPC_URL', 'USDC_BASE_CONFIRMATIONS', 'USDC_ETHEREUM_ADDRESS', 'USDC_ETHEREUM_RPC_URL', 'USDC_SOLANA_ADDRESS', 'USDC_SOLANA_RPC_URL', 'USDC_POLYGON_ADDRESS', 'USDC_POLYGON_CONFIRMATIONS', 'BOOST_PACKS', 'ADMIN_TOKEN']) delete process.env[key];
  }

  const [, whale] = await get('address/o1whalewhale');
  assert.strictEqual(whale.label.entity, 'Test Whale');
  assert.strictEqual(whale.archive.partial, true);
  assert.ok(db.prepare(`select count(*) n from headers where miner = 'o1minerodd'`).get().n > 0);
  assert.ok(BigInt(db.prepare(`select coalesce(sum(cast(amount as integer)), 0) s from addr_tx where address = 'o1minerodd' and dir = 'miner'`).get().s) > 0n);
  assert.ok(db.prepare(`select count(*) n from miner_payouts where miner = 'o1minerodd' and payout = 'o1minerodd'`).get().n > 0);
  assert.deepStrictEqual(issuance(210537), { tier: 0, subsidy_noid: '16', blocks_to_next_reward: 1051200, next_reward_height: 1261737, miner_share: 0.9 });
  assert.strictEqual(issuance(1261737).subsidy_noid, '11.30');
  assert.strictEqual(issuance(8620137).subsidy_noid, '1');
  assert.strictEqual(issuance(8620137).blocks_to_next_reward, null);
  assert.strictEqual(issuance(3223778).miner_share, 1);
  const [, eco] = await get('economics');
  assert.strictEqual(eco.schedule[1].noid, '11.30');
  assert.strictEqual(eco.schedule.at(-1).height, 8620137);
  assert.ok((await get('receipts'))[1].verify.includes('verifyReceipt'));
  assert.strictEqual((await post('receipts', { receipt: 'zz' }))[0], 400);
  assert.strictEqual((await post('receipts', { receipt: 'abcd' }))[1].result.merkle_valid, true);
  assert.strictEqual((await post('receipts', { receipt: 'eeff', kind: 'contract' }))[1].result.valid, true);
  contractHeight = tip + 1;
  tip += 1;
  await tick();
  const [, cts] = await get('contracts');
  assert.ok(cts.templates.some((t) => /timelocked vault/i.test(t.name)));
  assert.ok(cts.seen.some((r) => r.height === contractHeight && r.contract === 'call' && r.txid === H(`tx${contractHeight}`)));
  assert.ok((await get('orphans?limit=2'))[1].orphans.length >= 1);
  assert.strictEqual((await get('gaps?limit=1'))[1].gaps.length, 1);

  const peer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c)).on('end', () => {
      const call = JSON.parse(body || '{}');
      const h = call.params?.[0];
      const hdr = header(h);
      const result = hdr && { header: hdr, retained: { reward_micronoid: 5e6, transactions: [{ tx_hash: H('cb' + h), coinbase: true, fee_micronoid: 0, outputs: [{ owner: PAY_ADDR, amount_micronoid: '5000000' }] }] } };
      res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
    });
  });
  await new Promise((r) => peer.listen(0, '127.0.0.1', r));
  db.prepare(`delete from gaps where not (height = 3 and kind = 'body')`).run();
  process.env.ARCHIVE_PEERS = `http://127.0.0.1:${peer.address().port}`;
  await tick();
  peer.close();
  assert.ok(db.prepare('select 1 from blocks where height = 3').get(), 'gap filled from an archive peer');
  assert.strictEqual(db.prepare(`select count(*) n from gaps where height = 3`).get().n, 0);
  assert.strictEqual(db.prepare('select payout from miner_payouts where height = 3').get().payout, PAY_ADDR);
  const [, paid] = await get(`address/${PAY_ADDR}`);
  assert.strictEqual(paid.archive.partial, true);
  assert.ok(BigInt(paid.archive.received_micronoid) >= 5000000n);
  assert.ok(paid.archive.hourly.length >= 1);
  assert.ok(paid.balance_points.length >= 2);
  assert.ok(paid.balance_points.every((p, i) => Number.isFinite(p.t) && Number.isFinite(p.balance) && (i === 0 || p.t > paid.balance_points[i - 1].t)));
  const paidMicro = BigInt(paid.balance_micronoid);
  const asNoid = (n) => Number(n / 1000000n) + Number(n % 1000000n) / 1e6;
  const nets = paid.archive.hourly.reduce((s, p) => s + BigInt(p.net_micronoid), 0n);
  assert.ok(Math.abs(paid.balance_points.at(-1).balance - asNoid(paidMicro)) < 1e-6);
  assert.ok(Math.abs(paid.balance_points[0].balance - asNoid(paidMicro - nets)) < 1e-4);
  assert.ok(paid.balance_points[0].balance < paid.balance_points.at(-1).balance);
  assert.ok(paid.usd_points.length >= paid.balance_points.length);
  assert.strictEqual(paid.usd_points.at(-1).balance, paid.balance_points.at(-1).balance);
  assert.ok(Math.abs(paid.usd_points.at(-1).usd - paid.usd_points.at(-1).balance * 0.6) < 1e-8);
  assert.ok(Math.abs(paid.usd_points[0].usd - paid.usd_points[0].balance * 0.3) < 1e-4);

  const cold = fs.mkdtempSync(path.join(os.tmpdir(), 'noid-cold-'));
  process.env.COLD_DIR = cold;
  process.env.COLD_AFTER = '0';
  await tick();
  const moved = db.prepare('select cold, blob from blocks where height = 70').get();
  assert.match(moved.cold, /^70-[0-9a-f]{64}\.zst$/);
  assert.strictEqual(moved.blob, null);
  const [, cold70] = await get('block/70');
  assert.strictEqual(cold70.archived, true);
  assert.strictEqual(cold70.retained.transactions[0].tx_hash, H('tx70'));

  // db-check is read-only and refuses to rebuild a healthy file.
  const { DatabaseSync } = require('node:sqlite');
  const { execFileSync } = require('node:child_process');
  const tmpDb = path.join(os.tmpdir(), `noid-check-${process.pid}.db`);
  const tdb = new DatabaseSync(tmpDb);
  tdb.exec('create table stats (height integer primary key, ts integer, data text not null)');
  tdb.close();
  const checkOut = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/db-check.js', tmpDb], { encoding: 'utf8' });
  assert.match(checkOut, /quick_check: ok/);
  assert.throws(() => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/db-check.js', '--repair', tmpDb], { encoding: 'utf8' }), (e) => e.status === 2 && /Refusing --repair/.test(e.stderr));
  fs.rmSync(tmpDb, { force: true });
});

test('migrates a text-hash archive and backups round-trip', () => {
  const { DatabaseSync } = require('node:sqlite');
  const { migrateDb } = require('./server.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noid-mig-'));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`create table blocks (height integer primary key, hash text not null, details text not null);
    create index blocks_hash on blocks(hash);
    create table headers (height integer primary key, hash text not null, ts integer not null, miner text, work real not null, slots integer);
    create index headers_hash on headers(hash);
    create index headers_ts on headers(ts);`);
  const details = JSON.stringify({ header: { hash: 'ab'.repeat(32), timestamp: 1700004800 }, retained: { reward_micronoid: 5, transactions: [{ tx_hash: 'cd'.repeat(32) }] } });
  old.prepare('insert into blocks values (80, ?, ?)').run('ab'.repeat(32), details);
  old.prepare('insert into headers values (80, ?, 1700004800, ?, 1, 1)').run('ab'.repeat(32), 'o1minerodd');
  old.close();
  const migrated = new DatabaseSync(file);
  migrateDb(migrated);
  const row = migrated.prepare('select hash, blob, reward, txs from blocks where height = 80').get();
  assert.strictEqual(Buffer.from(row.hash).toString('hex'), 'ab'.repeat(32));
  assert.strictEqual(zstdDecompressSync(row.blob).toString(), details);
  assert.strictEqual(row.txs, 1);
  // A JS number bound into a text column is stored as "5.0", which BigInt rejects.
  assert.strictEqual(row.reward, '5');
  assert.strictEqual(migrated.prepare(`select type from pragma_table_info('blocks') where name = 'hash'`).get().type.toUpperCase(), 'BLOB');
  assert.strictEqual(Buffer.from(migrated.prepare('select hash from headers where height = 80').get().hash).toString('hex'), 'ab'.repeat(32));
  migrated.close();

  const { spawnSync } = require('node:child_process');
  const backups = path.join(dir, 'backups');
  // A missing cwd (this used to be the agent path /workspace) returns status null and no stderr.
  const run = spawnSync(process.execPath, ['scripts/backup.js'], { cwd: __dirname, env: { ...process.env, DB_PATH: file, BACKUP_DIR: backups } });
  assert.strictEqual(run.status, 0, run.stderr?.toString() || run.error?.message || 'backup failed');
  const out = fs.readdirSync(backups).filter((f) => f.endsWith('.db'));
  assert.strictEqual(out.length, 1);
  const snap = new DatabaseSync(path.join(backups, out[0]), { readOnly: true });
  assert.strictEqual(snap.prepare('select txs from blocks where height = 80').get().txs, 1);
  snap.close();
});

test('the trade engine matches the wallet engine and proves on this machine', async () => {
  const load = async (file, env) => (await WebAssembly.instantiate(fs.readFileSync(path.join(__dirname, 'public', file)), { env })).instance.exports;
  let T;
  T = await load('noid-trade.wasm', { noid_random: (p, n) => crypto.getRandomValues(new Uint8Array(T.memory.buffer, p, n)) });
  const O = await load('noid-wallet.wasm', {});
  const result = (ptr) => {
    const v = new DataView(T.memory.buffer);
    const status = v.getUint32(ptr, true), n = v.getUint32(ptr + 4, true);
    const text = new TextDecoder().decode(new Uint8Array(T.memory.buffer, ptr + 8, n).slice());
    T.noid_free(ptr, 8 + n);
    return { status, text };
  };
  // Same 32-byte seed, same index -> same o1 address in both engines.
  const seed = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 255);
  for (const index of [0, 1, 13, 199]) {
    const a = O.noid_alloc(32), o = O.noid_alloc(128);
    new Uint8Array(O.memory.buffer, a, 32).set(seed);
    const len = O.noid_wallet_address_text(a, index, o);
    const old = new TextDecoder().decode(new Uint8Array(O.memory.buffer, o, len).slice());
    const t = T.noid_alloc(32);
    new Uint8Array(T.memory.buffer, t, 32).set(seed);
    const fresh = result(T.noid_trade_address(t, index));
    assert.strictEqual(fresh.status, 0);
    assert.strictEqual(fresh.text, old, `address ${index} matches the wallet engine`);
  }
  // A full owner proof for a throwaway key passes the chain verifier inside the engine.
  const st = result(T.noid_trade_selftest());
  assert.strictEqual(st.status, 0, st.text);
  assert.strictEqual(JSON.parse(st.text).ok, true);
  // A plan that is not a real node plan is refused before anything is proven.
  const bad = new TextEncoder().encode('{"native_plan":{}}');
  const p = T.noid_alloc(bad.length);
  new Uint8Array(T.memory.buffer, p, bad.length).set(bad);
  const refused = result(T.noid_trade_review(p, bad.length));
  assert.strictEqual(refused.status, 1);
  assert.match(refused.text, /invalid trade plan/);
  const w = fs.readFileSync(path.join(__dirname, 'public/wallet.js'), 'utf8');
  assert.match(w, /MAINNET_CHAIN = '860e70453390bf815718e933aa4927167a13d098b0151391eefd722ee1add610'/, 'the wallet pins mainnet (genesis hash)');
  assert.doesNotMatch(w, /prover is not bundled/);
});

test('the phone menu stays open when the hamburger is the click target', () => {
  const html = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');
  // Outside-click used to treat the hamburger as outside, so the same tap opened and closed it.
  assert.match(html, /closest\('#menubtn, #dockmenu, #menu nav button'\)/);
  assert.match(html, /\.menu nav \{ display:none; pointer-events:none;/);
  assert.match(html, /\.menu\.open nav \{ display:flex; pointer-events:auto \}/);
  assert.match(html, /\.menu \{ position:relative; z-index:41;/);
  assert.match(html, /\.menu > button \{ position:relative; z-index:42;/);
});

test('a μNOID string with a trailing .0 still renders', () => {
  const html = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');
  const src = html.match(/function microInt\(v\) \{[\s\S]*?\n\}/)[0] + '\n' + html.match(/function noid\(v\) \{[\s\S]*?\n\}/)[0];
  const noid = new Function(`${src}; return noid;`)();
  assert.strictEqual(noid('14400000.0'), '14.4 NOID');
  assert.strictEqual(noid('14406500.0'), '14.4065 NOID');
  assert.strictEqual(noid('16000000'), '16 NOID');
  assert.strictEqual(noid(16000000), '16 NOID');
  assert.doesNotThrow(() => noid('not-a-number'));
});

test('trading shows what you can spend, a max and a slider, and says pending until the block lands', () => {
  const html = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');
  const w = fs.readFileSync(path.join(__dirname, 'public/wallet.js'), 'utf8');
  // The token trade card: available NOID when buying, available tokens when selling, Max, slider.
  for (const id of ['travail', 'trmax', 'trrange']) assert.match(html, new RegExp(`id="${id}"`), `the trade card has #${id}`);
  for (const id of ['tavail', 'tmax', 'trange']) assert.match(w, new RegExp(`id="${id}"`), `the wallet panel has #${id}`);
  assert.match(html, /const maxBuyMicro = \(\) => \(avail\.noid > FEE_RESERVE_MICRO/, 'a buy is capped at the NOID balance less the fee reserve');
  assert.match(html, /const maxSellWhole = \(\) => avail\.units \/ MICRO/, 'a sell is capped at whole tokens');
  assert.match(w, /const availMax = \(\) => \(side === 'buy'/, 'the wallet panel caps the same way');
  // The yellow-bordered bullet disclaimer is gone: one plain small line instead.
  assert.doesNotMatch(html, /class="risk"/);
  assert.match(html, /<p class="fine">Trading is not investment advice/);
  // A submitted trade is kept in this browser and said out loud until the chain shows it.
  assert.match(html, /id="trest"/, 'the trade card says what the amount buys or sells');
  assert.match(html, /function paintEst\(\)/, 'the estimate is painted as the amount changes');
  assert.match(w, /id="test"/, 'the wallet panel says the same');
  assert.match(w, /function paintEst\(\)/);
  assert.match(w, /\?quote=1/, 'the wallet asks the server for the sale offer, not just the mark price');
  assert.match(w, /chainTxidOf/, 'the banner shows the chain txid once the block lands');
  assert.match(w, /no1d_wallet_pending_v1/);
  assert.match(w, /PEND_MAX_WAIT_MS/);
  assert.match(w, /function settled\(p, unitsNow\)/);
  assert.match(w, /pending ok/);
});
