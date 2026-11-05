// Runs the wallet's whole trade path for real -- plan, review, prove, finish -- and stops
// before submitting. Nothing is spent: no intent leaves this process.
//
//   node scripts/check-trade-authorize.mjs <wallet.key path> <index> [token id] [NOID amount]
//
// The keystore is a Parano1d node wallet.key: 16-byte magic `noid_plain_key_1` + 32-byte
// master secret. The secret stays in this process; the address is derived by the engine.
import fs from 'node:fs';
import path from 'node:path';

const [keyPath, indexArg, token = '1a05ae51cf7275495515971111bcfb0109abcbf9551327b09861372203c2ba5b', amount = '5'] =
  process.argv.slice(2);
const index = Number(indexArg || 0);
if (!keyPath) { console.error('usage: node scripts/check-trade-authorize.mjs <wallet.key path> <index> [token id] [NOID amount]'); process.exit(2); }

const MAINNET_CHAIN = '860e70453390bf815718e933aa4927167a13d098b0151391eefd722ee1add610';
const file = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public', 'noid-trade.wasm');

const raw = fs.readFileSync(keyPath);
if (raw.length !== 48 || raw.subarray(0, 16).toString('latin1') !== 'noid_plain_key_1') {
  console.error('that is not a Parano1d wallet.key file'); process.exit(2);
}
const master = raw.subarray(16, 48);

let T;
T = (await WebAssembly.instantiate(fs.readFileSync(file), {
  env: { noid_random: (p, n) => crypto.getRandomValues(new Uint8Array(T.memory.buffer, p, n)) },
})).instance.exports;

const call = (name, args) => {
  const ptrs = [];
  const alloc = (buf) => { const p = T.noid_alloc(buf.length); new Uint8Array(T.memory.buffer, p, buf.length).set(buf); ptrs.push([p, buf.length]); return p; };
  const enc = (s) => new TextEncoder().encode(s);
  const json = alloc(enc(JSON.stringify(args.plan)));
  const mp = alloc(master);
  const r = name === 'authorize'
    ? T.noid_trade_authorize(mp, args.index, json, enc(JSON.stringify(args.plan)).length)
    : T.noid_trade_review(json, enc(JSON.stringify(args.plan)).length);
  const v = new DataView(T.memory.buffer);
  const status = v.getUint32(r, true), n = v.getUint32(r + 4, true);
  const text = new TextDecoder().decode(new Uint8Array(T.memory.buffer, r + 8, n).slice());
  T.noid_free(r, 8 + n);
  for (const [p, len] of ptrs) T.noid_free(p, len);
  return [status, text];
};

const address = (() => {
  const mp = T.noid_alloc(master.length);
  new Uint8Array(T.memory.buffer, mp, master.length).set(master);
  const r = T.noid_trade_address(mp, index);
  const v = new DataView(T.memory.buffer);
  const n = v.getUint32(r + 4, true);
  const text = new TextDecoder().decode(new Uint8Array(T.memory.buffer, r + 8, n).slice());
  T.noid_free(r, 8 + n); T.noid_free(mp, master.length);
  return text;
})();
console.log('wallet address at index', index, ':', address);

const q = new URLSearchParams({ sender: address, token, side: 'buy', amount, slippage: '1' });
const res = await fetch(`https://parano1d-scan.com/api/swap/intent?${q}`, { headers: { 'sec-fetch-site': 'same-origin' } });
const body = await res.json();
if (!res.ok) { console.error('the node refused to plan:', body.error); process.exit(1); }
const native = body.detail;
const [w, f = ''] = String(amount).split('.');
const plan = {
  native_plan: native,
  expected_request: { action: 'trade', asset_id: token, buy: true, gross_input: (BigInt(w) * 1000000n + BigInt((f + '000000').slice(0, 6))).toString(), minimum_output: null, slippage_bps: 100, valid_until: null },
  expected_chain: MAINNET_CHAIN,
  expected_parent_hash: String(native.review?.parent_hash || ''),
  maximum_fee_micronoid: String(native.review?.fee_limit_micronoid ?? native.review?.fee_micronoid ?? '0'),
};
console.log('plan:', { kind: native.intent_kind, height: native.candidate_height, pays: native.review?.noid_debit_micronoid, gets: native.review?.quoted_output, fee: native.review?.fee_micronoid, valid_until: native.review?.valid_until });

const [rs, rout] = call('review', { plan });
console.log('review:', rs === 0 ? 'accepted' : 'REFUSED ' + rout);
if (rs !== 0) process.exit(1);

const t0 = Date.now();
const [as, aout] = call('authorize', { plan, index });
const ms = Date.now() - t0;
if (as !== 0) { console.error('authorize FAILED after', ms, 'ms:', aout); process.exit(1); }
const magic = Buffer.from(aout.slice(0, 16), 'hex').toString('latin1');
console.log('authorize OK in', ms, 'ms | intent bytes:', aout.length / 2, '| magic:', magic);
console.log('NOT submitted: nothing was spent.');
