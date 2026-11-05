// Fetches a real trade plan from the explorer and runs it through the trade engine's checks,
// exactly as the wallet does. Read-only: a plan is a quote; nothing is signed, proven or sent.
//
//   node scripts/check-trade-plan.mjs <o1 address> [token id] [NOID amount] [base URL]
//
// Any real address works (for example a recent block's miner). Exit code 0 = the engine accepts it.
import fs from 'node:fs';
import path from 'node:path';

const [address, token = '26dd19b5a9c4431ede91f25ed1fb7df69ae85f77eab2b8d3c87e83dd9b58ff0a', amount = '1', base = 'https://parano1d-scan.com'] = process.argv.slice(2);
if (!/^o1/.test(address || '')) { console.error('usage: node scripts/check-trade-plan.mjs <o1 address> [token id] [NOID amount] [base URL]'); process.exit(2); }
const MAINNET_CHAIN = '860e70453390bf815718e933aa4927167a13d098b0151391eefd722ee1add610';

const q = new URLSearchParams({ sender: address, token, side: 'buy', amount, slippage: '1' });
const res = await fetch(`${base}/api/swap/intent?${q}`, { headers: { 'sec-fetch-site': 'same-origin' } });
const body = await res.json();
if (!res.ok) { console.error('server refused:', body.error); process.exit(1); }
const native = body.detail;

const file = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public', 'noid-trade.wasm');
let T;
T = (await WebAssembly.instantiate(fs.readFileSync(file), { env: { noid_random: (p, n) => crypto.getRandomValues(new Uint8Array(T.memory.buffer, p, n)) } })).instance.exports;
const review = (plan) => {
  const b = new TextEncoder().encode(JSON.stringify(plan));
  const p = T.noid_alloc(b.length);
  new Uint8Array(T.memory.buffer, p, b.length).set(b);
  const r = T.noid_trade_review(p, b.length);
  const v = new DataView(T.memory.buffer);
  const st = v.getUint32(r, true), n = v.getUint32(r + 4, true);
  const s = new TextDecoder().decode(new Uint8Array(T.memory.buffer, r + 8, n).slice());
  T.noid_free(r, 8 + n); T.noid_free(p, b.length);
  return [st, s];
};

// The same plan wallet.js builds: the request comes from the inputs, not from the server.
const [w, f = ''] = amount.split('.');
const plan = {
  native_plan: native,
  expected_request: { action: 'trade', asset_id: token, buy: true, gross_input: (BigInt(w) * 1000000n + BigInt((f + '000000').slice(0, 6))).toString(), minimum_output: null, slippage_bps: 100, valid_until: null },
  expected_chain: MAINNET_CHAIN,
  expected_parent_hash: native.review.parent_hash,
  maximum_fee_micronoid: String(native.review.fee_limit_micronoid ?? native.review.fee_micronoid),
};
console.log('chain id matches mainnet pin:', native.chain_id === MAINNET_CHAIN);
const [st, out] = review(plan);
if (st !== 0) { console.error('ENGINE REFUSES:', out); process.exit(1); }
const r = JSON.parse(out);
console.log('ENGINE ACCEPTS', { pays_micronoid: r.noid_debit_micronoid, quoted_units: r.quoted_output, minimum_units: r.minimum_output, fee: r.fee_micronoid, fee_limit: r.fee_limit_micronoid, candidate_height: r.candidate_height, valid_until: r.valid_until });
for (const [label, p] of [['different amount', { ...plan, expected_request: { ...plan.expected_request, gross_input: '1' } }], ['other chain', { ...plan, expected_chain: 'ab'.repeat(32) }]]) {
  console.log(`tampered (${label}) refused:`, review(p)[0] === 1);
}
