// Runs the indexer + API against a fake node: `npm test`.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const H = (n, salt = '') => require('node:crypto').createHash('sha256').update(`${n}${salt}`).digest('hex');
const ADDR = 'o1qqqqqqqqqqqq';
const PAY_ADDR = 'o1payqqqqqqqq';
let paySlots = [];
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
  process.env.KEY_PRICE_NOID = '25';
  const { server, tick, db } = require('./server.js');
  await new Promise((r) => server.listen(0, r));
  const get = async (p) => { const r = await fetch(`http://127.0.0.1:${server.address().port}/api/${p}`); return [r.status, await r.json(), r.headers]; };
  t.after(() => { server.close(); rpcServer.close(); });

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

  // Buy an API key with NOID: unique amount -> matching slot appears -> key issued.
  const [, order] = await get('pay/new');
  assert.ok(order.amount > 25e6 && order.amount < 25.01e6 && order.paid === false && order.address === PAY_ADDR);
  paySlots = [{ slot_index: 9, value: String(order.amount), creation_id: 'c1' }, { slot_index: 10, value: String(order.amount), creation_id: 'c2' }];
  await tick();
  const [, paid] = await get(`pay/${order.id}`);
  assert.ok(paid.paid && /^[0-9a-f]{32}$/.test(paid.key) && paid.expires > Date.now());
  await tick();
  assert.strictEqual((await get(`pay/${order.id}`))[1].key, paid.key, 'a second pass does not re-issue');
  assert.strictEqual((await get(`stats?key=${paid.key}`))[2].get('x-tier'), 'paid');
  assert.strictEqual((await get('stats?key=bogus'))[2].get('x-tier'), 'free');
  assert.strictEqual((await get('pay/nope'))[0], 404);

  // Live feed pushes the node's current numbers.
  const ac = new AbortController();
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/live`, { signal: ac.signal });
  assert.strictEqual(r.headers.get('content-type'), 'text/event-stream');
  const reader = r.body.getReader();
  let buf = '';
  while (!buf.includes('data: {')) buf += new TextDecoder().decode((await reader.read()).value);
  const evt = JSON.parse(buf.slice(buf.indexOf('data: {') + 6).split('\n')[0]);
  assert.strictEqual(evt.chain.height, tip);
  assert.strictEqual(evt.header.height, tip);
  ac.abort();

  const [, charts] = await get('charts');
  assert.ok(charts.length >= 3 && charts[0].peers === 8);
});
