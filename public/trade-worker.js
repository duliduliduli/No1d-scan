// Runs the trade module (noid-trade.wasm) off the page's main thread.
// Messages: { cmd: 'review', plan } -> { ok, review }
//           { cmd: 'authorize', master, index, plan } -> { ok, intent }   (master is 32 bytes, wiped after use)
//           { cmd: 'selftest' } -> { ok, result }
// The wallet starts a fresh worker for each trade and terminates it afterwards, so no key outlives the call.
'use strict';
let mod = null;

async function load() {
  if (mod) return mod;
  const res = await fetch('/noid-trade.wasm?v=1', { cache: 'force-cache' });
  if (!res.ok) throw new Error(`the trade engine is missing (${res.status})`);
  let x;
  const env = { noid_random: (ptr, len) => crypto.getRandomValues(new Uint8Array(x.memory.buffer, ptr, len)) };
  const { instance } = await WebAssembly.instantiateStreaming(res, { env });
  x = instance.exports;
  mod = x;
  return x;
}

function put(x, bytes) {
  const ptr = x.noid_alloc(bytes.length);
  new Uint8Array(x.memory.buffer, ptr, bytes.length).set(bytes);
  return ptr;
}

function take(x, ptr) {
  const view = new DataView(x.memory.buffer);
  const status = view.getUint32(ptr, true);
  const len = view.getUint32(ptr + 4, true);
  const text = new TextDecoder().decode(new Uint8Array(x.memory.buffer, ptr + 8, len).slice());
  x.noid_free(ptr, 8 + len);
  if (status !== 0) throw new Error(text);
  return text;
}

self.onmessage = async ({ data }) => {
  let masterPtr = 0, planPtr = 0, planLen = 0;
  try {
    const x = await load();
    if (data.cmd === 'selftest') return self.postMessage({ ok: true, result: JSON.parse(take(x, x.noid_trade_selftest())) });
    const plan = new TextEncoder().encode(JSON.stringify(data.plan));
    planPtr = put(x, plan); planLen = plan.length;
    if (data.cmd === 'review') return self.postMessage({ ok: true, review: JSON.parse(take(x, x.noid_trade_review(planPtr, planLen))) });
    if (data.cmd === 'authorize') {
      if (!(data.master instanceof Uint8Array) || data.master.length !== 32) throw new Error('the wallet key is missing');
      masterPtr = put(x, data.master);
      data.master.fill(0);
      return self.postMessage({ ok: true, intent: take(x, x.noid_trade_authorize(masterPtr, data.index >>> 0, planPtr, planLen)) });
    }
    throw new Error('unknown command');
  } catch (e) {
    self.postMessage({ ok: false, error: e && e.message ? e.message : String(e) });
  } finally {
    // noid_free wipes the buffer before releasing it.
    if (mod && masterPtr) mod.noid_free(masterPtr, 32);
    if (mod && planPtr) mod.noid_free(planPtr, planLen);
  }
};
