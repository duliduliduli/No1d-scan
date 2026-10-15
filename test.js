// Runs the indexer + API against a fake node: `npm test`.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

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
const header = (h) => (h <= tip ? { height: h, hash: hash(h), prev_hash: hash(h - 1), timestamp: 1700000000 + h * 60, miner: h % 2 ? 'o1minerodd' : 'o1minereven', difficulty_target: TARGET, active_slot_count: 1000 + h } : null);
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
    const call = ({ id, method, params }) => ({ jsonrpc: '2.0', id, result: node[method.replace('paranoid_', '')](params) });
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
  const { server, tick, db } = require('./server.js');
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
  assert.strictEqual(db.prepare('select hash from blocks where height = 100').get().hash, hash(100));

  // Archived body is not served under a header it does not belong to.
  tip = 150;
  await tick();
  const [, b100] = await get('block/100');
  assert.strictEqual(b100.archived, true);

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
  const kept = db.prepare('select count(*) n from blocks').get().n;
  tip -= 19;
  await assert.rejects(tick(), /indexing paused, nothing deleted/);
  assert.strictEqual(db.prepare('select count(*) n from blocks').get().n, kept);
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
  assert.strictEqual(db.prepare('select hash from headers where height = 100').get().hash, hash(100), 'reorged header replaced');
  const [, st] = await get('stats');
  assert.ok(Math.abs(st.network.hashrate - 65536 / 60) < 15, `hashrate ${st.network.hashrate}`);
  assert.strictEqual(st.network.avg_block_time, 60);
  const [, allMiners] = await get('miners?window=all');
  assert.deepStrictEqual(allMiners.miners.map((m) => m.miner).sort(), ['o1minereven', 'o1minerodd']);
  assert.strictEqual(allMiners.blocks, tip + 1);
  const [, series] = await get('history?window=all');
  assert.ok(series.points.length >= 1 && series.points[0].hashrate > 0 && series.points[0].block_time === 60);
  const [, mp] = await get('mempool');
  assert.strictEqual(mp.size, 2);
  assert.strictEqual(mp.total_fees_micronoid, 15000);
  assert.strictEqual(mp.fees[1].fee_micronoid, 7000);
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
  node.getBlockHeader = realHeader; holes.clear();
  // Big grouped queries keep temp data in memory (the service's /tmp is read-only).
  assert.strictEqual(db.prepare('pragma temp_store').get().temp_store, 2);

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
  const [, ps] = await get('price?window=24h');
  assert.ok(ps.points.length >= 2 && ps.points.at(-1).usd === 0.6 && Math.abs(ps.points.at(-1).market_cap_usd - 1.2) < 1e-9);

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
});
