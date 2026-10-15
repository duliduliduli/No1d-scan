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
      ? { role: 'assistant', content: `The height is ${JSON.parse(toolMsg.content).chain.height}.` }
      : { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'chain_stats', arguments: '{}' } }] };
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
});
let tip = 99, fork = ''; // `fork` changes hashes from height 98 up to simulate a reorg
const hash = (h) => H(h, h >= 98 ? fork : '');
const header = (h) => (h <= tip ? { height: h, hash: hash(h), prev_hash: hash(h - 1), timestamp: 1700000000 + h * 60 } : null);
const tx = (h) => ({ tx_hash: H(`tx${h}`), fee_micronoid: 10 });

const node = {
  blockCount: () => tip,
  getBlockHash: ([h]) => header(h)?.hash ?? null,
  getBlockHeader: ([h]) => header(h),
  getBlockDetails: ([h]) => header(h) && { header: header(h), retained: h > tip - 42 ? { reward_micronoid: 5e6, transactions: [tx(h)] } : null },
  getTx: ([id]) => (id === H('tx70') ? { tx_hash: id, height: 70, block_hash: hash(70), tx_position: 0 } : null),
  getChainInfo: () => ({ height: tip, active_slot_count: 10, circulating_supply_micronoid: '123000000' }),
  getPeerCount: () => 8,
  getMiningInfo: () => ({ difficulty_bits: 30 }),
  getSlotsByOwner: ([a]) => (a === PAY_ADDR ? paySlots : [{ slot_index: 1, value: '9007199254740993' }, { slot_index: 2, value: 7 }]),
  getRecentTransactions: () => ({ total: 0, transactions: [] }),
  getStateInfo: () => ({}), getNodeStatus: () => ({}),
};

const rpcServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c)).on('end', () => {
    const { method, params } = JSON.parse(body);
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: node[method.replace('paranoid_', '')](params) }));
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
  await new Promise((r) => aiServer.listen(0, r));
  process.env.OPENROUTER_API_KEY = 'or-test';
  process.env.OPENROUTER_URL = `http://127.0.0.1:${aiServer.address().port}`;
  const { server, tick, db } = require('./server.js');
  await new Promise((r) => server.listen(0, r));
  const get = async (p, opt = {}) => { const r = await fetch(`http://127.0.0.1:${server.address().port}/api/${p}`, opt); return [r.status, await r.json(), r.headers]; };
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

  // NOID top-up: unique amount -> matching slot appears -> credits added once.
  const [, quote] = await post('topup', { method: 'noid', usd: 5 }, K);
  const micro = Math.round(Number(quote.amount_noid) * 1e6);
  assert.ok(micro > 25e6 && micro < 25.01e6 && quote.paid === false && quote.address === PAY_ADDR);
  assert.strictEqual((await post('topup', { method: 'noid', usd: 7 }, K))[0], 400, 'only fixed packs');
  paySlots = [{ slot_index: 9, value: String(micro), creation_id: 'c1' }];
  await tick(); await tick();
  assert.strictEqual((await get(`topup/${quote.id}`, { headers: K }))[1].paid, true);
  assert.strictEqual((await get('me', { headers: K }))[1].credits, 5000, 'credited exactly once');
  const [, q2] = await post('topup', { method: 'noid', usd: 5 }, K);
  paySlots = [{ slot_index: 9, value: String(Math.round(Number(q2.amount_noid) * 1e6)), creation_id: 'c1' }];
  await tick();
  assert.strictEqual((await get('me', { headers: K }))[1].credits, 5000, 'an already-used slot cannot pay a second quote');
  assert.strictEqual((await get(`stats?key=${acct.key}`))[2].get('x-tier'), 'paid');

  // Stripe webhook: only correctly signed events credit, and replays are ignored.
  const evt = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_1', payment_status: 'paid', client_reference_id: acct.id, amount_total: 2000, metadata: { credits: '20000' } } } });
  const sign = (body, ts = Math.floor(Date.now() / 1000)) => `t=${ts},v1=${require('node:crypto').createHmac('sha256', WHSEC).update(`${ts}.${body}`).digest('hex')}`;
  assert.strictEqual((await post('stripe-webhook', evt, { 'stripe-signature': 't=1,v1=00' }))[0], 400);
  assert.strictEqual((await post('stripe-webhook', evt, { 'stripe-signature': sign(evt, 1000) }))[0], 400, 'old timestamp rejected');
  assert.strictEqual((await post('stripe-webhook', evt, { 'stripe-signature': sign(evt) }))[0], 200);
  await post('stripe-webhook', evt, { 'stripe-signature': sign(evt) });
  assert.strictEqual((await get('me', { headers: K }))[1].credits, 25000, 'webhook replay credits once');

  // Chatbot: answers via tools from real routes; 3 free a day, then paid at 5 credits; refunded on model errors.
  const ask = (h = {}) => post('chat', { messages: [{ role: 'user', content: 'what is the height?' }] }, h);
  const [, a1] = await ask();
  assert.match(a1.reply, new RegExp(`height is ${tip}`), 'answer built from the chain_stats tool');
  assert.strictEqual(a1.free_left, 2);
  await ask(); await ask();
  assert.strictEqual((await ask())[0], 402, 'free quota used up');
  const [, a5] = await ask(K);
  assert.strictEqual(a5.paid, true);
  assert.strictEqual(a5.credits, 24995);
  aiDown = true;
  assert.strictEqual((await ask(K))[0], 502);
  assert.strictEqual((await get('me', { headers: K }))[1].credits, 24995, 'refunded when the model fails');
  aiDown = false;
  const hist = (await get('me', { headers: K }))[1].history.map((h) => h.reason);
  assert.ok(hist.includes('AI question') && hist.some((r) => r.startsWith('Card top-up')) && hist.some((r) => r.startsWith('NOID top-up')));

  const [, charts] = await get('charts');
  assert.ok(charts.length >= 3 && charts[0].peers === 8);
});
