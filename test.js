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
// Fake OpenRouter: first asks for the chain_stats tool, then answers from the tool result.
let aiDown = false;
const aiServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c)).on('end', () => {
    if (aiDown) { res.writeHead(500); return res.end(JSON.stringify({ error: { message: 'down' } })); }
    const { messages } = JSON.parse(body);
    const toolMsg = messages.find((m) => m.role === 'tool');
    const message = toolMsg
      ? { role: 'assistant', content: `Let me think about the user.\n</think>\n\nThe height is ${JSON.parse(toolMsg.content).chain.height}.` }
      : { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'chain_stats', arguments: '{}' } }] };
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
});
let tip = 99, fork = '';
const holes = new Set(); // heights the fake node has no header for // `fork` changes hashes from height 98 up to simulate a reorg
const hash = (h) => H(h, h >= 98 ? fork : '');
// Target 2^240 little-endian -> 2^16 expected hashes per block; blocks 60 s apart; two alternating miners.
const TARGET = '00'.repeat(30) + '0100';
const header = (h) => (h <= tip ? { height: h, hash: hash(h), prev_hash: hash(h - 1), timestamp: 1700000000 + h * 60, miner: h % 2 ? 'o1minerodd' : 'o1minereven', difficulty_target: TARGET, active_slot_count: 1000 + h, state_root: H('state' + h), tx_root: H('txroot' + h), nonce: '00000000000000ab', log_slots: 24 } : null);
const tx = (h) => ({ tx_hash: H(`tx${h}`), fee_micronoid: 10 });

const node = {
  blockCount: () => tip,
  getBlockHash: ([h]) => header(h)?.hash ?? null,
  getBlockHeader: ([h]) => (holes.has(h) ? null : header(h)),
  getBlockDetails: ([h]) => header(h) && { header: header(h), retained: h > tip - 42 ? { reward_micronoid: 5e6, transactions: [tx(h)] } : null },
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
  await new Promise((r) => aiServer.listen(0, r));
  process.env.OPENROUTER_API_KEY = 'or-test';
  process.env.OPENROUTER_URL = `http://127.0.0.1:${aiServer.address().port}`;
  const labelFile = path.join(os.tmpdir(), `noid-labels-${process.pid}.json`);
  fs.writeFileSync(labelFile, JSON.stringify({ o1whalewhale: { entity: 'Test Whale', note: 'fixture' } }));
  process.env.LABELS_FILE = labelFile;
  // Candle and watchlist checks add requests on top of the indexer suite.
  process.env.RATE_LIMIT = '1000';
  const { server, tick, db, compressJson, packStats, issuance, pollUsdc } = require('./server.js');
  await new Promise((r) => server.listen(0, r));
  const get = async (p, opt = {}) => {
    const headers = opt.bare ? opt.headers : { 'sec-fetch-site': 'same-origin', ...opt.headers };
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/${p}`, { ...opt, headers });
    return [r.status, await r.json(), r.headers];
  };
  const post = (p, body, headers = {}) => get(p, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
  t.after(() => { server.close(); rpcServer.close(); aiServer.close(); });

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

  // NOID top-up: unique amount -> matching slot appears -> credited once the tip is 18 blocks past it.
  const credits = async () => (await get('me', { headers: K }))[1].credits;
  const mine = async (n) => { tip += n; await tick(); };
  // An output already on the address before the order was quoted can never pay it, even with matching digits.
  paySlots = [{ slot_index: 8, value: '25001234', creation_id: 'c0' }];
  await tick();
  const [, quote] = await post('topup', { method: 'noid', usd: 5 }, K);
  const micro = Math.round(Number(quote.amount_noid) * 1e6);
  assert.ok(micro > 25e6 && micro < 25.01e6 && quote.paid === false && quote.address === PAY_ADDR && quote.status === 'waiting');
  assert.strictEqual((await post('topup', { method: 'noid', usd: 7 }, K))[0], 400, 'only fixed packs');
  db.prepare('update noid_topups set amount = 25001234, dust = 1234 where id = ?').run(quote.id);
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
  assert.strictEqual(await credits(), 5000, 'credited exactly once at depth 18');
  // A payment that disappears (reorged out) before it is final never credits.
  const [, q2] = await post('topup', { method: 'noid', usd: 5 }, K);
  const micro2 = Math.round(Number(q2.amount_noid) * 1e6);
  paySlots = [{ slot_index: 10, value: String(micro2), creation_id: 'c2' }];
  await tick();
  paySlots = [];
  await mine(18);
  assert.strictEqual(await credits(), 5000, 'reorged-out payment not credited');
  paySlots = [{ slot_index: 9, value: String(micro2), creation_id: 'c1' }];
  await mine(18);
  assert.strictEqual(await credits(), 5000, 'an already-used slot cannot pay a second quote');
  // Overpayment with the same last digits is credited at the quoted rate: +1 NOID on a 25 NOID pack = +200 credits.
  paySlots = [{ slot_index: 11, value: String(micro2 + 1_000_000), creation_id: 'c3' }];
  await tick(); await mine(18);
  assert.strictEqual((await get('me', { headers: K }))[1].credits, 5000 + 5000 + 200, 'overpayment credited proportionally');
  assert.strictEqual((await get(`topup/${q2.id}`, { headers: K }))[1].credits_added, 5200);
  assert.strictEqual((await get(`stats?key=${acct.key}`))[2].get('x-tier'), 'paid');

  // API gate: scripts need a key, our own pages and keyed clients don't; stats stays open for uptime monitors.
  assert.strictEqual((await get('txs', { bare: true }))[0], 401);
  assert.strictEqual((await get('txs', { bare: true, headers: K }))[0], 200);
  assert.strictEqual((await get('stats', { bare: true }))[0], 200);

  // Stripe webhook: only correctly signed events credit, and replays are ignored.
  const evt = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_1', payment_status: 'paid', client_reference_id: acct.id, amount_total: 2000, currency: 'usd', metadata: { credits: '999999' } } } });
  const sign = (body, ts = Math.floor(Date.now() / 1000)) => `t=${ts},v1=${require('node:crypto').createHmac('sha256', WHSEC).update(`${ts}.${body}`).digest('hex')}`;
  assert.strictEqual((await post('stripe-webhook', evt, { 'stripe-signature': 't=1,v1=00' }))[0], 400);
  assert.strictEqual((await post('stripe-webhook', evt, { 'stripe-signature': sign(evt, 1000) }))[0], 400, 'old timestamp rejected');
  assert.strictEqual((await post('stripe-webhook', evt, { 'stripe-signature': sign(evt) }))[0], 200);
  await post('stripe-webhook', evt, { 'stripe-signature': sign(evt) });
  assert.strictEqual((await get('me', { headers: K }))[1].credits, 30200, 'webhook replay credits once; credits follow amount paid, not metadata');
  const eur = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_2', payment_status: 'paid', client_reference_id: acct.id, amount_total: 2000, currency: 'eur' } } });
  await post('stripe-webhook', eur, { 'stripe-signature': sign(eur) });
  assert.strictEqual((await get('me', { headers: K }))[1].credits, 30200, 'non-USD session ignored');

  // Professional API behaviour: wrong key fails loudly, rate-limit and credit headers on every keyed call.
  const [badStatus, badBody] = await get('blocks', { bare: true, headers: { 'x-api-key': 'nk_' + 'f'.repeat(40) } });
  assert.strictEqual(badStatus, 401); assert.match(badBody.error, /unknown API key/);
  const [, , hdr] = await get('blocks', { bare: true, headers: K });
  assert.strictEqual(hdr.get('x-tier'), 'paid'); assert.strictEqual(hdr.get('x-ratelimit-limit'), '3000'); assert.strictEqual(hdr.get('x-credits-remaining'), '30200');
  assert.strictEqual((await get('me', { headers: K }))[1].tier, 'paid');

  // Chatbot: answers via tools from real routes; 3 free a day, then paid at 5 credits; refunded on model errors.
  const ask = (h = {}) => post('chat', { messages: [{ role: 'user', content: 'what is the height?' }] }, h);
  const [, a1] = await ask();
  assert.match(a1.reply, new RegExp(`^The height is ${tip}`), 'answer built from the chain_stats tool, reasoning stripped');
  assert.strictEqual(a1.free_left, 2);
  await ask(); await ask();
  assert.strictEqual((await ask())[0], 402, 'free quota used up');
  const [, a5] = await ask(K);
  assert.strictEqual(a5.paid, true);
  assert.strictEqual(a5.credits, 30195);
  aiDown = true;
  assert.strictEqual((await ask(K))[0], 502);
  assert.strictEqual((await get('me', { headers: K }))[1].credits, 30195, 'refunded when the model fails');
  aiDown = false;
  const hist = (await get('me', { headers: K }))[1].history.map((h) => h.reason);
  assert.ok(hist.includes('AI question') && hist.some((r) => r.startsWith('Card top-up')) && hist.some((r) => r.startsWith('NOID top-up')));

  // Late payment: an expired order keeps its digits reserved, and a payment for it still goes to the same account.
  const [, q3] = await post('topup', { method: 'noid', usd: 5 }, K);
  const micro3 = Math.round(Number(q3.amount_noid) * 1e6);
  db.prepare('update noid_topups set created = ? where id = ?').run(Date.now() - 25 * 3600_000, q3.id);
  await tick();
  assert.strictEqual((await get(`topup/${q3.id}`, { headers: K }))[1].status, 'expired', 'expired orders are kept, not deleted');
  assert.throws(() => db.prepare('insert into noid_topups (id, account, amount, credits, created, dust) values (?, ?, ?, ?, ?, ?)').run('x', acct.id, micro3, 5000, Date.now(), micro3 % 10000), /UNIQUE/, 'a newer order cannot take the held digits');
  const before = await credits();
  paySlots = [{ slot_index: 12, value: String(micro3), creation_id: 'c4' }];
  await tick(); await mine(18);
  assert.strictEqual(await credits(), before + 5000, 'late payment credited to the account that ordered it');
  // Fault injection: if crediting fails, the order is not marked paid and no ledger row is written.
  const [, other] = await post('account', {});
  const [, q4] = await post('topup', { method: 'noid', usd: 5 }, { 'x-api-key': other.key });
  db.prepare('update accounts set id = ? where id = ?').run('gone', other.id); // the order's account no longer exists
  paySlots = [{ slot_index: 13, value: String(Math.round(Number(q4.amount_noid) * 1e6)), creation_id: 'c5' }];
  await tick(); await mine(18);
  assert.strictEqual(db.prepare('select paid_ref from noid_topups where id = ?').get(q4.id).paid_ref, null, 'order not claimed');
  assert.strictEqual(db.prepare("select count(*) n from ledger where ref = 'noid:c5'").get().n, 0, 'no ledger entry');
  assert.strictEqual(db.prepare("select status from noid_seen where ref = 'noid:c5'").get().status, 'review', 'flagged for a manual look');
  paySlots = [];

  // Stale live price pauses new NOID quotes; a fixed price does not.
  const { price: px } = require('./server.js');
  delete process.env.USD_PER_NOID;
  px.now = { usd: 0.2, fetched_at: Date.now() - 16 * 60_000 };
  assert.strictEqual((await post('topup', { method: 'noid', usd: 5 }, K))[0], 503, 'stale price: no new quotes');
  assert.match((await get('pricing'))[1].noid_paused, /out of date/);
  px.now.fetched_at = Date.now();
  const [okStatus, fresh] = await post('topup', { method: 'noid', usd: 5 }, K);
  assert.strictEqual(okStatus, 200); assert.ok(Math.abs(fresh.rate_usd_per_noid - 0.2) < 0.0001);
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

  // AI tools: amounts reach the model already converted, exactly; it never does unit math.
  const { forModel } = require('./chat.js');
  assert.deepStrictEqual(forModel({ chain: { height: 221000, circulating_supply_micronoid: '10718701000001', active_slot_count: 91214 }, latest: { supply: 5000, holders: 2141 }, fee_micronoid: 0 }),
    { chain: { height: 221000, circulating_supply_noid: '10,718,701.000001', active_slot_count: '91,214' }, latest: { supply_noid: '0.005', holders: 2141 }, fee_noid: '0' });

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
  const homeHtml = await (await fetch(base + '/')).text();
  assert.match(homeHtml, /Watchlist/);
  assert.match(homeHtml, /data-star/);
  assert.match(homeHtml, /1W/);
  assert.match(homeHtml, /tokenchart/);
  assert.match(homeHtml, /Total you pay/);
  assert.match(homeHtml, /Before you sign/);
  assert.match(homeHtml, /never holds your wallet/);
  assert.match(homeHtml, /off until v2\.1/);
  assert.match(homeHtml, /pill enh/);
  assert.match(homeHtml, /Enhanced Token Info/);
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
  assert.match(homeHtml, />Promoted</);
  assert.match(homeHtml, /Paid promotion\. Not a recommendation or endorsement by NOID Scan\./);
  assert.match(homeHtml, /data-boost=/);
  assert.match(homeHtml, /id="promotion"/);
  assert.match(homeHtml, /aria-label="Promoted"/);
  assert.match(homeHtml, /aria-label="USDC chain"/);
  assert.match(homeHtml, /native USDC on the chain you pick/);

  // 64-bit creation ids must survive parsing: two consecutive ids are different slots, not the same payment.
  const { parseRpc } = require('./server.js');
  const big = parseRpc('{"result":[{"creation_id":9223372036854775807,"value":5},{"creation_id":9223372036854775806,"value":5}]}');
  assert.notStrictEqual(big.result[0].creation_id, big.result[1].creation_id);
  assert.strictEqual(big.result[0].creation_id, '9223372036854775807');

  // Peer map: only established connections on the P2P port with public IPs count.
  const { peerIps } = require('./server.js');
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

  const [, charts] = await get('charts');
  assert.ok(charts.length >= 3 && charts[0].peers === 8);

  // Tokens and NFTs: empty until the node speaks v2.1. Demo rows are not stored.
  delete process.env.TOKENS_DEMO; delete process.env.SWAP_ENABLED; delete process.env.SWAP_FEE_ADDRESS;
  const [, none] = await get('tokens');
  assert.strictEqual(none.demo, false);
  assert.strictEqual(none.tokens.length, 0);
  assert.match(none.notice, /Tokens coming with v2\.1/);
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
  assert.strictEqual((await get('wallet/not-an-address?demo=1'))[0], 400);
  assert.strictEqual((await get('token/gcat'))[0], 404);
  const [, screen] = await get('tokens/gcat?demo=1');
  assert.strictEqual(screen.token.launch, 'launchpad');
  assert.strictEqual(screen.token.fdv_micronoid, screen.token.mcap_micronoid);
  assert.ok(screen.token.makers >= 1);
  assert.ok(screen.warnings.some((w) => w.code === 'dev_hold'));
  assert.ok(screen.token.top10_pct >= 40);
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
  assert.strictEqual(db.prepare('select count(*) n from token_trades').get().n, 0);

  // The indexer stores a snapshot once the node answers, and a reorg drops trades above the new tip.
  process.env.ASSET_PROBE_MS = '0';
  node.getAssetSnapshot = () => ({
    tokens: [{ id: 'live1', name: 'Live Coin', ticker: 'LIVE', supply: '1000', reserve_micronoid: '1000000', created_ts: 1700000000, graduated: false, price_micronoid: '1000', curve_target_micronoid: '20000000000', curve_raised_micronoid: '1000000000', holders: [{ address: 'o1acdefghjkmnpqr', balance: '400' }] }],
    trades: [{ txid: 'live1trade01', token_id: 'live1', ts: Math.floor(Date.now() / 1000) - 30, side: 'buy', token_amount: '10', noid_micronoid: '10000', price_micronoid: '1000', venue: 'curve', trader: 'o1acdefghjkmnpqr' }],
    transfers: [{ txid: 'live1trade01', token_id: 'live1', ts: Math.floor(Date.now() / 1000) - 30, to: 'o1acdefghjkmnpqr', amount: '10' }],
    collections: [{ id: 'col1', name: 'Live Col', items: 2, owners: 1, floor_micronoid: '5000000', volume_micronoid: '9000000', created_ts: 1700000000, nfts: [{ id: 'n1', name: 'One', owner: 'o1acdefghjkmnpqr' }] }],
  });
  await tick();
  await tick();
  assert.strictEqual(db.prepare('select count(*) n from tokens').get().n, 1);
  assert.strictEqual(db.prepare('select count(*) n from token_trades').get().n, 1, 'the same trade is stored once');
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
  assert.strictEqual(db.prepare('select count(*) n from token_candles where height > 0').get().n, 0);
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
  assert.strictEqual((await get('admin', { headers: { 'x-admin-token': 'adm-test' } }))[0], 404, 'review stays hidden until ADMIN_TOKEN is set');
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
    const wrong = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_prof_bad', payment_status: 'paid', client_reference_id: acct.id, amount_total: 100, currency: 'usd', metadata: { kind: 'profile', profile_id: second.id } } } });
    assert.strictEqual((await post('stripe-webhook', wrong, { 'stripe-signature': sign(wrong) }))[0], 200);
    assert.strictEqual((await get(`profile/${second.id}`, { headers: K }))[1].status, 'unpaid');
    assert.strictEqual(await credits(), creditsBefore, 'a short card payment does not buy the profile or credits');
    const good = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_prof', payment_status: 'paid', client_reference_id: acct.id, amount_total: 10000, currency: 'usd', metadata: { kind: 'profile', profile_id: second.id } } } });
    assert.strictEqual((await post('stripe-webhook', good, { 'stripe-signature': sign(good) }))[0], 200);
    assert.strictEqual((await get(`profile/${second.id}`, { headers: K }))[1].status, 'pending');
    assert.strictEqual(await credits(), creditsBefore);
    assert.strictEqual((await post('admin', { id: second.id, action: 'reject' }, { 'x-admin-token': 'adm-test' }))[1].status, 'rejected');
    assert.strictEqual((await get(`profile/${second.id}`, { headers: K }))[1].status, 'rejected');
    assert.ok(!(await get('admin', { headers: { 'x-admin-token': 'adm-test' } }))[1].pending.some((p) => p.id === second.id));
  } finally {
    delete process.env.ADMIN_TOKEN;
  }
  assert.strictEqual((await get('admin', { headers: { 'x-admin-token': 'adm-test' } }))[0], 404);
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

  // USDC: a chain is off until its address is set. An exact base-unit amount marks the profile pending and does not add credits.
  const { solanaCredits, mints } = require('./usdc.js');
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
  assert.match((await post('profile-pay', { id: third.id, method: 'usdc', chain: 'base' }, K))[1].error, /USDC_<CHAIN>_ADDRESS/);
  const payAddr = '0x' + 'ab'.repeat(20);
  process.env.USDC_BASE_ADDRESS = payAddr;
  process.env.USDC_SOLANA_ADDRESS = '0x' + '11'.repeat(20);
  process.env.USDC_SOLANA_RPC_URL = 'http://127.0.0.1:1';
  assert.match((await post('profile-pay', { id: third.id, method: 'usdc', chain: 'solana' }, K))[1].error, /pick an enabled/);
  delete process.env.USDC_SOLANA_ADDRESS;
  delete process.env.USDC_SOLANA_RPC_URL;
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
    process.env.USDC_ETHEREUM_ADDRESS = payAddr;
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
    assert.match((await post('boost-pay', { id: madeBoost.id, method: 'card' }, K))[1].error, /USDC/);
    process.env.USDC_POLYGON_ADDRESS = payAddr;
    assert.strictEqual((await get('boosts?kind=token&window=poly1'))[1].usdc_chains.find((c) => c.id === 'polygon').confirmations, 128);
    process.env.USDC_POLYGON_CONFIRMATIONS = '5';
    assert.strictEqual((await get('boosts?kind=token&window=poly2'))[1].usdc_chains.find((c) => c.id === 'polygon').confirmations, 5);
    assert.match((await post('boost-pay', { id: colBoost.id, method: 'usdc', chain: 'polygon' }, K))[1].error, /USDC_POLYGON_RPC_URL/);
    delete process.env.USDC_POLYGON_ADDRESS;
    delete process.env.USDC_POLYGON_CONFIRMATIONS;
    const listed = (await get('boosts?kind=token&window=chains'))[1].usdc_chains.map((c) => c.id).sort();
    assert.deepStrictEqual(listed, ['base', 'ethereum']);
    const [ethStatus, ethOrder] = await post('boost-pay', { id: colBoost.id, method: 'usdc', chain: 'ethereum' }, K);
    assert.strictEqual(ethStatus, 200);
    assert.strictEqual(ethOrder.chain, 'ethereum');
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
    for (const key of ['USDC_BASE_ADDRESS', 'USDC_BASE_RPC_URL', 'USDC_BASE_CONFIRMATIONS', 'USDC_ETHEREUM_ADDRESS', 'USDC_ETHEREUM_RPC_URL', 'USDC_SOLANA_ADDRESS', 'USDC_SOLANA_RPC_URL', 'USDC_POLYGON_ADDRESS', 'USDC_POLYGON_CONFIRMATIONS', 'BOOST_PACKS', 'ADMIN_TOKEN']) delete process.env[key];
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
  assert.strictEqual((await get('receipts'))[1].available, false);
  assert.ok((await get('contracts'))[1].templates.includes('timelocked vaults'));
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
  assert.strictEqual(migrated.prepare(`select type from pragma_table_info('blocks') where name = 'hash'`).get().type.toUpperCase(), 'BLOB');
  assert.strictEqual(Buffer.from(migrated.prepare('select hash from headers where height = 80').get().hash).toString('hex'), 'ab'.repeat(32));
  migrated.close();

  const { spawnSync } = require('node:child_process');
  const backups = path.join(dir, 'backups');
  const run = spawnSync(process.execPath, ['scripts/backup.js'], { cwd: '/workspace', env: { ...process.env, DB_PATH: file, BACKUP_DIR: backups } });
  assert.strictEqual(run.status, 0, run.stderr.toString());
  const out = fs.readdirSync(backups).filter((f) => f.endsWith('.db'));
  assert.strictEqual(out.length, 1);
  const snap = new DatabaseSync(path.join(backups, out[0]), { readOnly: true });
  assert.strictEqual(snap.prepare('select txs from blocks where height = 80').get().txs, 1);
  snap.close();
});
