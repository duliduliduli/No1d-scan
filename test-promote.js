// Promote orders, NOID receipt settlement, Stripe boost webhook, profile extras, and native trade intents.
const test = require('node:test');
const assert = require('node:assert');
const { createHmac } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const images = require('./images.js');

const PAY = 'o1payqqqqqqqq';
process.env.NODE_ENV = 'test';
process.env.PAY_ADDRESS = PAY;
process.env.USD_PER_NOID = '0.20';
process.env.STRIPE_SECRET_KEY = 'sk_test_x';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_p';

function setup(receipts = {}) {
  const db = new DatabaseSync(':memory:');
  const profiles = require('./profiles.js')(db);
  const boosts = require('./boosts.js')(db, (kind, id) => (id === 'tok1' ? { id, name: 'Tok', ticker: 'TOK', kind } : null));
  profiles.setFallback({ extras: (id) => boosts.extrasFor(id), banner: (id) => boosts.banner(id), adminBanner: (id) => boosts.adminBanner(id) });
  let tip = 1000;
  const calls = [];
  const rpc = async (m, p) => { calls.push([m, p]); if (m === 'verifyReceipt') return receipts[p[0]] ?? { merkle_valid: false, error: 'bad proof' }; throw new Error('method not found'); };
  const bill = require('./billing.js')(db, rpc, () => null, () => tip, profiles, boosts);
  const acct = { id: 'acct1' };
  db.prepare("insert into accounts (id, key_hash, created) values ('acct1', 'h1', 0), ('acct2', 'h2', 0)").run();
  return { db, profiles, boosts, bill, acct, calls, setTip: (t) => { tip = t; } };
}
const png = images.solidPng(30, 10, [1, 2, 3]).toString('base64');

test('boost with extras: hidden until paid and approved, then banner and links show', async () => {
  const { boosts, profiles, bill, acct } = setup({
    'aa01': { merkle_valid: true, canonical: true, confirmed: true, authenticated_summary: { txid: 'aa'.repeat(32), claimed_height: 900, outputs: [{ owner: PAY, amount_micronoid: 10_000_000_000 }] } },
  });
  const made = boosts.create(acct, { kind: 'token', asset_id: 'tok1', pack: '1d' }, profiles.extras({ website: 'https://tok.example', twitter: 'https://x.com/tok', banner: png }));
  assert.strictEqual(made.status, 'unpaid');
  const plain = profiles.decorate({ token: { id: 'tok1' } });
  assert.strictEqual(plain.token.enhanced, null, 'no banner or links before approval');
  assert.strictEqual(profiles.image('tok1', 'banner', new URLSearchParams()), null);
  const quote = await bill.routes['POST boost-pay'](acct, { id: made.id, method: 'noid' });
  assert.strictEqual(quote.kind, 'boost');
  assert.ok(Number(quote.amount_noid) >= 200 && Number(quote.amount_noid) < 200.01, quote.amount_noid);
  await assert.rejects(bill.routes['POST order-receipt'](acct, { order: quote.id, receipt: 'beef' }), /did not verify/);
  const paid = await bill.routes['POST order-receipt'](acct, { order: quote.id, receipt: 'aa01' });
  assert.strictEqual(paid.status, 'paid');
  assert.strictEqual(boosts.adminList()[0].website, 'https://tok.example/');
  assert.strictEqual(profiles.decorate({ token: { id: 'tok1' } }).token.enhanced, null, 'paid but not approved stays hidden');
  boosts.review(made.id, 'approve');
  const shown = profiles.decorate({ token: { id: 'tok1' } }).token.enhanced;
  assert.strictEqual(shown.source, 'promote');
  assert.strictEqual(shown.twitter, 'https://x.com/tok');
  assert.match(shown.banner, /profile-media\/tok1\/banner/);
  assert.strictEqual(profiles.image('tok1', 'banner', new URLSearchParams()).type, 'image/png');
});

test('receipt: underpaid, unconfirmed, replayed, and other account are refused', async () => {
  const sum = (amt, h) => ({ merkle_valid: true, canonical: true, confirmed: true, authenticated_summary: { txid: 'bb'.repeat(32), claimed_height: h, outputs: [{ owner: PAY, amount_micronoid: amt }, { owner: 'o1other', amount_micronoid: 9e12 }] } });
  const { boosts, bill, acct, setTip } = setup({ 'bb01': sum(1, 900), 'bb02': sum(10e9, 995), 'bb03': sum(10e9, 900) });
  const b = boosts.create(acct, { kind: 'token', asset_id: 'tok1', pack: '6h' });
  const q = await bill.routes['POST boost-pay'](acct, { id: b.id, method: 'noid' });
  await assert.rejects(bill.routes['POST order-receipt'](acct, { order: q.id, receipt: 'bb01' }), /needs/);
  assert.strictEqual((await bill.routes['POST order-receipt'](acct, { order: q.id, receipt: 'bb02' })).status, 'confirming');
  assert.strictEqual(await bill.routes['POST order-receipt']({ id: 'acct2' }, { order: q.id, receipt: 'bb03' }), null);
  assert.strictEqual((await bill.routes['POST order-receipt'](acct, { order: q.id, receipt: 'bb03' })).status, 'paid');
  boosts.review(b.id, 'reject');
  const b2 = boosts.create(acct, { kind: 'token', asset_id: 'tok1', pack: '6h' });
  const q2 = await bill.routes['POST boost-pay'](acct, { id: b2.id, method: 'noid' });
  setTip(2000);
  await assert.rejects(bill.routes['POST order-receipt'](acct, { order: q2.id, receipt: 'bb03' }), /already paid another order/);
});

test('stripe webhook marks a boost paid only for the exact amount', () => {
  const { boosts, bill, acct } = setup();
  const b = boosts.create(acct, { kind: 'token', asset_id: 'tok1', pack: '1d' });
  const hook = (amount) => {
    const raw = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_' + amount, payment_status: 'paid', currency: 'usd', amount_total: amount, client_reference_id: acct.id, metadata: { kind: 'boost', boost_id: b.id } } } });
    const t = Math.floor(Date.now() / 1000);
    return bill.stripeWebhook(raw, `t=${t},v1=${createHmac('sha256', 'whsec_p').update(`${t}.${raw}`).digest('hex')}`);
  };
  hook(100);
  assert.strictEqual(boosts.view(acct, b.id).status, 'unpaid');
  hook(4000);
  assert.strictEqual(boosts.view(acct, b.id).status, 'pending', 'still needs admin approval');
});

test('native trade intent: gated, mocked before activation, never signs', async () => {
  const calls = [];
  let mode = 'inactive';
  const rpc = async (m, p) => { calls.push([m, p]); if (mode === 'inactive') throw new Error('native operations are not active at the candidate height'); return m === 'prepareNativeIntent' ? 'abcd' : { txid: 'ff' }; };
  const it = require('./intent.js')(rpc, () => 279000);
  const P = (o) => new URLSearchParams({ token: 'ab'.repeat(32), side: 'buy', amount: '1.5', slippage: '1', sender: 'o124ken009f8887g9yu7nd2tlhhxxv0t6y9hwdf472ptynyq0nm30ql04u3a', ...o });
  delete process.env.SWAP_ENABLED;
  await assert.rejects(it.prepare(P()), /off/);
  assert.strictEqual(it.info().enabled, false);
  process.env.SWAP_ENABLED = 'true';
  assert.deepStrictEqual(it.info().blocks_left, 370);
  const mock = await it.prepare(P({ demo: '1' }));
  assert.strictEqual(mock.mock, true);
  assert.strictEqual(mock.request.gross_input, '1500000');
  assert.strictEqual(calls.length, 0, 'demo never calls the node');
  await assert.rejects(it.prepare(P()), /279,370/);
  assert.deepStrictEqual(calls[0], ['prepareNativeIntent', { owner: 'o124ken009f8887g9yu7nd2tlhhxxv0t6y9hwdf472ptynyq0nm30ql04u3a', request: { action: 'trade', asset_id: 'ab'.repeat(32), buy: true, gross_input: '1500000', slippage_bps: 100 } }]);
  mode = 'live';
  const live = await it.prepare(P({ side: 'sell', amount: '7' }));
  assert.strictEqual(live.unsigned, 'abcd');
  assert.strictEqual(live.request.buy, false);
  await assert.rejects(it.prepare(P({ sender: 'bad' })), /o1/);
  await assert.rejects(it.prepare(P({ side: 'sell', amount: '1.5' })), /whole/);
  await assert.rejects(it.submit({ signed: 'zz' }), /hex/);
  assert.strictEqual((await it.submit({ signed: 'beef' })).submitted, true);
  delete process.env.SWAP_ENABLED;
});
