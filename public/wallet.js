// No1d Wallet — a self-custody Parano1d (NOID) wallet that runs in this page.
//
// What it does
//   * makes a 24-word seed in your browser, from the browser's own randomness
//   * derives the same `o1…` addresses a Parano1d desktop wallet derives
//     (the derivation runs in the wallet engine, built from the chain's source)
//   * keeps the seed encrypted with your passphrase (PBKDF2 + AES-GCM) in this
//     browser only, and never sends it, or anything derived from it, anywhere
//   * shows balance, unspent outputs, mining payouts and token positions from
//     this explorer's public data
//   * offers itself to this site as `window.parano1d`, the same provider
//     interface a browser extension would expose
//
//   * trades native tokens. Parano1d is signatureless: a spend carries a
//     zero-knowledge proof that you own the address. The node prepares an
//     unsigned plan; the trade engine (noid-trade.wasm, built from the official
//     Parano1d SDK, source in wasm/noid-trade) checks the plan against what you
//     asked for, then proves and verifies it in a worker on this device. Only
//     the finished intent leaves the browser.
//
// What it does not do yet
//   * plain NOID payments to another address (the engine supports them; the
//     send screen is not built).
//
// The seed is the wallet. Anyone with the 24 words (or the daemon key file it
// writes) controls the funds; this page cannot recover them for you.
(function () {
  'use strict';

  const STORE_KEY = 'noid_wallet_v1';
  const SESSION = { master: null, seedWords: null, index: 0 };
  let engine = null, wordList = null, engineError = null;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

  // ---------------------------------------------------------------- engine ---
  async function loadEngine() {
    if (engine) return engine;
    if (engineError) throw new Error(engineError);
    try {
      const res = await fetch('/noid-wallet.wasm', { cache: 'force-cache' });
      if (!res.ok) throw new Error(`wallet engine missing (${res.status})`);
      const { instance } = await WebAssembly.instantiateStreaming(res, {});
      engine = instance.exports;
      return engine;
    } catch (error) {
      engineError = `the wallet engine could not load: ${error.message}`;
      throw new Error(engineError);
    }
  }

  async function loadWords() {
    if (wordList) return wordList;
    const res = await fetch('/bip39.txt', { cache: 'force-cache' });
    if (!res.ok) throw new Error('the word list could not load');
    const list = (await res.text()).split('\n').map((w) => w.trim()).filter(Boolean);
    if (list.length !== 2048) throw new Error('the word list is incomplete');
    wordList = list;
    return list;
  }

  // Same derivation the daemon uses: Poseidon2b KDF -> address. Runs in wasm so
  // the seed is never handed to page JavaScript beyond this call.
  async function deriveAddress(master, index) {
    const wasm = await loadEngine();
    const inPtr = wasm.noid_alloc(32);
    const outPtr = wasm.noid_alloc(128);
    try {
      new Uint8Array(wasm.memory.buffer, inPtr, 32).set(master);
      const len = wasm.noid_wallet_address_text(inPtr, index >>> 0, outPtr);
      if (!len) throw new Error('address derivation failed');
      return new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, outPtr, len).slice());
    } finally {
      wasm.noid_free(inPtr, 32);
      wasm.noid_free(outPtr, 128);
    }
  }

  async function isValidAddress(address) {
    const wasm = await loadEngine();
    const bytes = new TextEncoder().encode(String(address || ''));
    const ptr = wasm.noid_alloc(bytes.length);
    try {
      new Uint8Array(wasm.memory.buffer, ptr, bytes.length).set(bytes);
      return wasm.noid_validate_address(ptr, bytes.length) === 1;
    } finally {
      wasm.noid_free(ptr, bytes.length);
    }
  }

  // ------------------------------------------------------------ seed words ---
  // BIP39: 256 bits of entropy plus an 8-bit checksum, cut into 24 eleven-bit
  // indices. Same bytes the daemon keeps in wallet.key, so a phrase restores
  // the same addresses in either wallet.
  async function entropyToWords(entropy) {
    const list = await loadWords();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', entropy));
    const bits = [...entropy].map((b) => b.toString(2).padStart(8, '0')).join('')
      + digest[0].toString(2).padStart(8, '0');
    const words = [];
    for (let i = 0; i < 24; i++) words.push(list[parseInt(bits.slice(i * 11, i * 11 + 11), 2)]);
    return words;
  }

  async function wordsToEntropy(words) {
    const list = await loadWords();
    const index = new Map(list.map((w, i) => [w, i]));
    if (words.length !== 24) throw new Error('a No1d seed is 24 words');
    let bits = '';
    for (const word of words) {
      const at = index.get(word.toLowerCase().trim());
      if (at == null) throw new Error(`"${word}" is not in the word list`);
      bits += at.toString(2).padStart(11, '0');
    }
    const entropy = new Uint8Array(32);
    for (let i = 0; i < 32; i++) entropy[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', entropy));
    if (parseInt(bits.slice(256), 2) !== digest[0]) {
      throw new Error('that seed has a typo: the checksum does not match');
    }
    return entropy;
  }

  // -------------------------------------------------------------- keystore ---
  const PBKDF2_ROUNDS = 600000;

  async function passKey(passphrase, salt) {
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ROUNDS, hash: 'SHA-256' },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  async function encryptSeed(master, passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await passKey(passphrase, salt);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, master);
    return { v: 1, kdf: `PBKDF2-SHA256-${PBKDF2_ROUNDS}`, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
  }

  async function decryptSeed(blob, passphrase) {
    const key = await passKey(passphrase, unb64(blob.salt));
    const master = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) }, key, unb64(blob.ct));
    const bytes = new Uint8Array(master);
    if (bytes.length !== 32) throw new Error('the stored wallet is not a 32-byte seed');
    return bytes;
  }

  const storedBlob = () => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const blob = raw ? JSON.parse(raw) : null;
      return blob && blob.v === 1 && blob.ct ? blob : null;
    } catch { return null; }
  };
  const writeBlob = (blob) => { try { localStorage.setItem(STORE_KEY, JSON.stringify(blob)); } catch {} };
  const clearBlob = () => { try { localStorage.removeItem(STORE_KEY); } catch {} };

  // The address is public, so it is remembered in the clear: the account page, the header and the portfolio can read
  // it without the passphrase. The seed stays encrypted and is never written anywhere else.
  const ID_KEY = 'no1d_wallet_identity_v1';
  const readIdentity = () => {
    try {
      const blob = JSON.parse(localStorage.getItem(ID_KEY) || 'null');
      return blob && /^o1[02-9ac-hj-np-z]{6,120}$/.test(blob.address || '') ? blob : null;
    } catch { return null; }
  };
  const writeIdentity = (address, index) => {
    try { localStorage.setItem(ID_KEY, JSON.stringify({ v: 1, address, index, at: Date.now() })); } catch {}
  };
  const clearIdentity = () => { try { localStorage.removeItem(ID_KEY); } catch {} };

  // ---------------------------------------------------------------- public ---
  const locked = () => !SESSION.master;

  async function addressAt(index) {
    if (locked()) throw new Error('the wallet is locked');
    return deriveAddress(SESSION.master, index);
  }

  // Ask the explorer which of the first 200 indices have been used, so the
  // receive card offers an unused address without a server doing key work.
  async function firstUnusedIndex() {
    for (let index = 0; index < 200; index++) {
      const address = await addressAt(index);
      const data = await fetch(`/api/address/${address}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const empty = !data || ((data.balance_micronoid === '0' || data.balance_micronoid === 0)
        && !(data.slots || []).length && !(data.activity?.transactions || []).length
        && !(data.blocks_mined > 0));
      if (empty) return index;
    }
    return 200;
  }

  // ---------------------------------------------------------------- trades ---
  // Mainnet identity: Core's native_chain_id() is the hash of the genesis header, i.e. block 0's hash.
  // A plan for any other chain is refused by the engine.
  const MAINNET_CHAIN = '860e70453390bf815718e933aa4927167a13d098b0151391eefd722ee1add610';
  const TRADES = new Map(); // review id -> { plan, address, index }

  // One fresh worker per call, terminated afterwards, so a key never outlives the trade.
  function engineCall(msg) {
    return new Promise((resolve, reject) => {
      const w = new Worker('/trade-worker.js?v=2');
      const done = (fn, v) => { w.terminate(); fn(v); };
      w.onmessage = ({ data }) => (data.ok ? done(resolve, data) : done(reject, new Error(data.error)));
      w.onerror = (e) => { e.preventDefault?.(); done(reject, new Error(e.message || 'the trade engine could not start')); };
      w.postMessage(msg, msg.master ? [msg.master.buffer] : []);
    });
  }

  // Built here from what the user typed, not copied from the server, so the engine can
  // refuse a plan that differs from the trade the user asked for. Same units as the API:
  // NOID (6 decimals) to buy, whole tokens to sell; both are micro-units on chain.
  function tradeRequest({ token, side, amount, slippage }) {
    if (!/^[0-9a-f]{64}$/.test(token || '')) throw new Error('pick a token first');
    if (side !== 'buy' && side !== 'sell') throw new Error('choose buy or sell');
    const raw = String(amount ?? '').trim();
    if (side === 'buy' ? !/^\d{1,12}(\.\d{1,6})?$/.test(raw) : !/^\d{1,24}$/.test(raw)) {
      throw new Error(side === 'buy' ? 'enter a NOID amount with up to 6 decimals' : 'enter a whole number of tokens to sell');
    }
    const [w, f = ''] = raw.split('.');
    const gross = (BigInt(w) * 1000000n + BigInt((f + '000000').slice(0, 6))).toString();
    if (gross === '0') throw new Error('the amount must be more than zero');
    const slip = Number(slippage ?? 1);
    if (!(slip >= 0 && slip <= 50)) throw new Error('slippage must be 0 to 50%');
    return { action: 'trade', asset_id: token, buy: side === 'buy', gross_input: gross, minimum_output: null, slippage_bps: Math.round(slip * 100), valid_until: null };
  }

  // Asks the node for a plan for this wallet's address, then checks it in the engine.
  // Returns the engine's review; nothing is signed or sent.
  async function prepareTrade(params) {
    const id = readIdentity();
    if (!id) throw new Error('create or open your No1d wallet first');
    const request = tradeRequest(params);
    const q = new URLSearchParams({ sender: id.address, token: request.asset_id, side: request.buy ? 'buy' : 'sell', amount: String(params.amount).trim(), slippage: String(request.slippage_bps / 100) });
    const res = await fetch(`/api/swap/intent?${q}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'the node refused that trade');
    if (body.mock) throw new Error('this is sample data: nothing here can be traded');
    const native = body.detail;
    if (!native || native.owner !== id.address) throw new Error('the node built this trade for a different address');
    const plan = {
      native_plan: native,
      expected_request: request,
      expected_chain: MAINNET_CHAIN,
      expected_parent_hash: String(native.review?.parent_hash || ''),
      // The engine refuses the plan if its fee limit is above this; it is the figure shown as "Network fee, at most".
      maximum_fee_micronoid: String(native.review?.fee_limit_micronoid ?? native.review?.fee_micronoid ?? '0'),
    };
    const { review } = await engineCall({ cmd: 'review', plan });
    const key = crypto.randomUUID();
    TRADES.clear();
    TRADES.set(key, { plan, address: id.address, index: Number(id.index) || 0 });
    return { id: key, address: id.address, review };
  }

  // Proves the reviewed trade on this device and submits it. Needs the wallet unlocked.
  async function confirmTrade({ id, ticker = '' } = {}) {
    const t = TRADES.get(id);
    if (!t) throw new Error('that quote expired: review the trade again');
    if (locked()) throw new Error('unlock your wallet first');
    if (await addressAt(t.index) !== t.address) throw new Error('the unlocked wallet does not own the trading address');
    TRADES.delete(id);
    // What this address held before the trade, so the chain view can be compared against it.
    const rev = t.plan?.native_plan?.review || {};
    const req = rev.request || {};
    const tokenId = String(rev.asset_id || req.asset_id || '');
    let heldBefore = '0';
    try {
      const before = await fetch(`/api/wallet/${t.address}`).then((r) => (r.ok ? r.json() : null));
      heldBefore = unitsOf(before?.holdings, tokenId);
    } catch {}
    const { intent } = await engineCall({ cmd: 'authorize', master: SESSION.master.slice(), index: t.index, plan: t.plan });
    const res = await fetch('/api/swap-submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signed: intent }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) {
      const msg = body.error || 'the node did not accept the trade';
      throw new Error(/state|parent|stale|changed/i.test(msg) ? `A new block arrived before the trade was sent, so the node refused it. Nothing was spent. Review it again. (${msg})` : msg);
    }
    const r = body.result;
    const txid = typeof r === 'string' ? r : (r?.txid || r?.intent_id || '');
    // Pending from here: the next render shows it in yellow and watches for the block.
    writePending({
      v: 1, address: t.address, token_id: tokenId, ticker: String(ticker || ''),
      side: req.buy === false ? 'sell' : 'buy', units_before: heldBefore,
      minimum_output: String(rev.minimum_output || '0'), gross_in: String(req.gross_input || '0'),
      txid, at: Date.now(), status: 'pending',
    });
    return { txid, result: r };
  }

  // The engine-checked review as label/value rows. Buy: NOID in, token units out. Sell: token units in, NOID out.
  function tradeRows(review, { side, ticker = 'tokens' } = {}) {
    const units = (s) => { const n = BigInt(String(s ?? '0')); const w = (n / 1000000n).toLocaleString('en-US'); const f = String(n % 1000000n).padStart(6, '0').replace(/0+$/, ''); return `${w}${f ? '.' + f : ''}`; };
    const tok = (s) => `${units(s)} ${ticker}`;
    const r = review || {};
    const gross = r.request?.gross_input;
    const buy = side ? side === 'buy' : !!r.request?.buy;
    return [
      ['You pay', buy ? fmtNoid(r.noid_debit_micronoid || gross) : tok(gross)],
      ['You get, quoted', buy ? tok(r.quoted_output) : fmtNoid(r.quoted_output)],
      ['You get, at least', buy ? tok(r.minimum_output) : fmtNoid(r.minimum_output)],
      ['Network fee', fmtNoid(r.fee_micronoid)],
      ['Network fee, at most', fmtNoid(r.fee_limit_micronoid ?? r.fee_micronoid)],
      ['Valid until block', r.valid_until == null ? '–' : Number(r.valid_until).toLocaleString('en-US')],
      ['Paid to', 'your own address'],
    ];
  }

  async function unlockWith(passphrase) {
    const blob = storedBlob();
    if (!blob) throw new Error('there is no wallet in this browser yet');
    let master;
    try { master = await decryptSeed(blob, passphrase); } catch { throw new Error('that passphrase did not open the wallet'); }
    SESSION.master = master;
    const id = readIdentity();
    SESSION.index = id ? Number(id.index) || 0 : 0;
  }

  const provider = {
    isNo1dWallet: true,
    version: '0.2.0',
    async request({ method, params = {} } = {}) {
      if (method === 'account' || method === 'wallet_getAddress') {
        if (locked()) throw new Error('open the No1d Wallet page and unlock it first');
        return { address: await addressAt(params.index || 0) };
      }
      if (method === 'wallet_getBalance') {
        const address = params.address || await addressAt(0);
        const data = await fetch(`/api/address/${address}`).then((r) => r.json());
        return { address, micronoid: String(data.balance_micronoid ?? '0') };
      }
      if (method === 'wallet_deriveAddress') {
        if (locked()) throw new Error('open the No1d Wallet page and unlock it first');
        return { address: await addressAt(params.index || 0) };
      }
      if (method === 'trade_prepare') return prepareTrade(params);
      if (method === 'trade_confirm') return confirmTrade(params);
      if (method === 'signAndSubmit') {
        throw new Error('this wallet signs only plans it has checked itself: use trade_prepare, then trade_confirm. Nothing was sent.');
      }
      throw new Error(`unsupported method: ${method}`);
    },
  };
  window.parano1d = provider;

  // ------------------------------------------------------- pending trades ---
  // A submitted trade is not in the chain view until the next block lands (~30 s), so a wallet
  // that just bought looks unchanged and reads as if the money went nowhere. Keep the receipt in
  // this browser, say pending in yellow, and watch the address until the node shows the trade.
  const PEND_KEY = 'no1d_wallet_pending_v1';
  const PEND_MAX_WAIT_MS = 150000;
  const readPending = () => {
    try {
      const p = JSON.parse(localStorage.getItem(PEND_KEY) || 'null');
      const id = readIdentity();
      if (!p || !id || p.address !== id.address) return null;
      if (p.status === 'confirmed' && Date.now() - (p.seen_at || 0) > 600000) return null;
      return p;
    } catch { return null; }
  };
  const writePending = (p) => { try { if (p) localStorage.setItem(PEND_KEY, JSON.stringify(p)); else localStorage.removeItem(PEND_KEY); } catch {} };
  const unitsOf = (list, id) => { const h = (list || []).find((x) => (x.token_id || x.asset_id) === id); return h ? String(h.units || '0') : '0'; };
  // Did the chain take the trade? Compare the token page with what the address held before it.
  function settled(p, unitsNow) {
    const before = BigInt(p.units_before || '0');
    const now = BigInt(unitsNow || '0');
    if (p.side === 'sell') {
      const sold = BigInt(p.gross_in || '0');
      return sold > 0n ? now <= before - sold : now < before;
    }
    const least = BigInt(p.minimum_output || '0');
    return now >= before + (least > 0n ? least : 1n);
  }
  // Watches the address after a submit: yellow while it waits, then repaints once it lands.
  // The hash the node hands back at submit time is the mempool's own, and it does not become the chain's txid - so
  // the code written down at submit time cannot be searched. Once the block lands, the trade row carries the real
  // one, and the banner shows that instead, with a link to it.
  const chainTxidOf = (seen, p) => {
    const row = (seen?.trades || []).find((t) => t.token_id === p.token_id && Number(t.ts) * 1000 >= p.at - 120000);
    const id = String(row?.txid || '');
    return /^[0-9a-f]{64}/i.test(id) ? id.split(':')[0] : '';
  };

  async function pollPending(box, tries = 0) {
    const p = readPending();
    if (!p || p.status !== 'pending') return;
    let seen = null;
    try { seen = await fetch(`/api/wallet/${p.address}`).then((r) => (r.ok ? r.json() : null)); } catch {}
    if (seen && settled(p, unitsOf(seen.holdings, p.token_id))) {
      writePending({ ...p, status: 'confirmed', seen_at: Date.now(), chain_txid: chainTxidOf(seen, p) || p.chain_txid || '' });
      return render(box);
    }
    if (Date.now() - p.at > PEND_MAX_WAIT_MS) {
      writePending({ ...p, status: 'waiting', checked_at: Date.now() });
      return render(box);
    }
    const w = $('pwatch');
    if (w) w.textContent = ` · checked ${tries + 1} time${tries ? 's' : ''}, still waiting for the block...`;
    setTimeout(() => pollPending(box, tries + 1), 4000);
  }

  // ------------------------------------------------------------------ view ---
  const fmtNoid = (micronoid) => {
    const n = BigInt(String(micronoid ?? '0'));
    const whole = (n / 1000000n).toLocaleString('en-US');
    const frac = String(n % 1000000n).padStart(6, '0').replace(/0+$/, '');
    return `${whole}${frac ? '.' + frac : ''} NOID`;
  };
  const short = (s, n = 18) => (s && s.length > n * 2 ? `${s.slice(0, n)}…${s.slice(-6)}` : s);

  function field(label, value, copyable) {
    return `<div class="wfield"><small>${esc(label)}</small><b class="mono">${esc(value)}</b>${
      copyable ? `<button type="button" class="copy" data-copy="${esc(value)}" aria-label="Copy ${esc(label)}">⧉</button>` : ''}</div>`;
  }

  async function render(box) {
    box.innerHTML = `<div class="skel"></div>`;
    const blob = storedBlob();

    if (locked()) {
      if (!blob) return renderCreate(box);
      return renderUnlock(box);
    }

    const index = SESSION.index;
    let address = '–';
    try { address = await addressAt(index); }
    catch (error) { box.innerHTML = `<div class="card"><h2>Wallet</h2><p class="msg err">${esc(error.message)}</p></div>`; return; }
    writeIdentity(address, index);

    const [account, positions, stats, book] = await Promise.all([
      fetch(`/api/address/${address}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`/api/wallet/${address}?quote=1`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/api/stats').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/api/tokens?limit=24&sort=volume').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);

    const balance = account ? fmtNoid(account.balance_micronoid) : 'unavailable';
    const slots = account?.slots || [];
    const txs = account?.activity?.transactions || [];
    const holdings = positions?.holdings || [];
    const pend = readPending();
    const pendChain = pend && pend.chain_txid ? ` &middot; tx <a href="/tx/${esc(pend.chain_txid)}" data-link class="mono">${esc(short(pend.chain_txid, 12))}</a>` : '';
    const pendTx = pend && pend.txid
      ? ` <span class="mono">${esc(short(pend.txid, 12))}</span><small class="muted"> (the code the node gave this trade when it was sent${pend.chain_txid ? ' - the chain txid is below' : '; the chain txid appears here once the block lands'})</small>`
      : '';
    const pendWatch = '<small id="pwatch" class="muted"></small>';
    const pendLine = !pend ? '' : pend.status === 'confirmed'
      ? `<div class="pending ok"><b>Confirmed</b> &mdash; the block landed and the chain shows your ${esc(pend.side)}${pend.ticker ? ` of ${esc(pend.ticker)}` : ''}. The figures below are read straight from the node.${pendChain}${pendWatch}</div>`
      : pend.status === 'waiting'
      ? `<div class="pending"><b>Still pending</b> &mdash; the node accepted your ${esc(pend.side)} and it is queued for a block. Nothing is lost by leaving this page: open it again and this banner is still here.${pendTx}${pendWatch}</div>`
      : `<div class="pending"><b>Pending</b> &mdash; your ${esc(pend.side)} was accepted and it settles in the next block, about 30 seconds. Your portfolio updates the moment it lands; this page is watching.${pendTx}${pendWatch}</div>`;
    const fmtUnits = (s) => { const v = Number(s); return Number.isFinite(v) ? v.toLocaleString('en-US', { maximumFractionDigits: 6 }) : String(s ?? ''); };
    const usd = (v) => (v == null || !Number.isFinite(Number(v)) ? '–' : `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    const noidMicro = BigInt(String(account?.balance_micronoid ?? '0'));
    const noidUsd = Number(stats?.price?.usd) || null;
    const noidValueUsd = noidUsd ? (Number(noidMicro) / 1e6) * noidUsd : null;
    const tokenUsdTotal = holdings.reduce((s, h) => s + (h.value_usd || 0), 0);
    const totalUsd = noidValueUsd == null && !holdings.length ? null : (noidValueUsd || 0) + tokenUsdTotal;

    box.innerHTML = `
      <div class="card">
        <h2>No1d Wallet <small class="muted">self-custody · ${esc(provider.version)}</small></h2>
        <p class="muted">Your seed stayed in this browser. This page never sent it anywhere.</p>
        ${field('Your address', address, true)}
        <div class="wrow">
          <button type="button" id="wcopy2">Copy address</button>
          <button type="button" id="wnew">New receive address</button>
          <button type="button" id="wlock">Lock</button>
        </div>
        <p class="fine">Receive address index ${index}. Parano1d wallets derive addresses in order, so keep using them in order and a desktop wallet will find them all when you restore the seed.</p>
      </div>

      <div class="card">
        <h2>Balance <small class="muted">live from this explorer's node</small></h2>
        <div class="wbig">${esc(balance)}</div>
        <p class="muted">${slots.length} unspent output${slots.length === 1 ? '' : 's'}${account?.blocks_mined ? ` · ${account.blocks_mined} block${account.blocks_mined === 1 ? '' : 's'} mined` : ''}</p>
        <p class="fine">Explorer index as of block ${esc(String(account?.activity?.tip_height == null ? '-' : account.activity.tip_height))}.${pend && pend.status !== 'confirmed' ? ' A trade is not in this index until the block carrying it is indexed, so this figure can lag a moment behind the portfolio below.' : ''}</p>
        <h3 class="wh3">Unspent outputs</h3>
        ${slots.length
          ? `<div class="wlist">${slots.slice(0, 12).map((s) => `<div><span class="mono">slot ${esc(String(s.slot_index))}</span><b>${esc(fmtNoid(s.value))}</b></div>`).join('')}</div>`
          : '<p class="muted">Nothing here yet. Send NOID to the address above to fund it.</p>'}
      </div>

      <div class="card">
        <h2>Portfolio <small class="muted">quantities and prices straight from the chain</small></h2>
        ${pendLine}
        <table class="price">
          <tr><th>Asset</th><th class="num">You hold</th><th class="num">Price</th><th class="num">Value</th><th></th></tr>
          <tr>
            <td><b>NOID</b> <span class="muted">native</span></td>
            <td class="num">${esc(fmtNoid(String(account?.balance_micronoid ?? '0')))}</td>
            <td class="num">${esc(usd(noidUsd))}</td>
            <td class="num">${esc(usd(noidValueUsd))}</td>
            <td><span class="row"><button type="button" data-buy="">Buy tokens</button></span></td>
          </tr>
          ${holdings.map((h) => {
            const id = h.token_id || h.asset_id || '';
            const label = h.ticker || h.name || short(id, 10);
            const value = h.value_usd != null ? usd(h.value_usd) : (h.value_micronoid != null ? `${esc(fmtNoid(h.value_micronoid))}` : '–');
            const per = h.price_micronoid != null ? `${fmtUnits(Number(h.price_micronoid) / 1e6)} NOID` : '–';
            // The mark price and the sale offer are different numbers: the curve takes its fee and moves with size.
            const sell = h.sell_now && h.sell_now.net_micronoid ? `<br><small class="muted">sell now ≈ ${esc(fmtNoid(h.sell_now.net_micronoid))}</small>` : '';
            return `<tr>
              <td><a href="/token/${esc(id)}" data-link>${esc(label)}</a> <span class="muted">${esc((h.name || '').slice(0, 22))}</span></td>
              <td class="num">${esc(fmtUnits(h.balance ?? '0'))}</td>
              <td class="num">${esc(per)}</td>
              <td class="num">${value}${sell}</td>
              <td><span class="row"><button type="button" data-trade="${esc(id)}">Trade</button><button type="button" class="copy" data-copy="${esc(id)}" title="Copy the token's id" aria-label="Copy token id">⧉</button>${typeof starBtn === 'function' ? starBtn(id, label) : ''}</span></td>
            </tr>`;
          }).join('')}
          ${holdings.length ? '' : '<tr><td colspan="5" class="muted">No native tokens held by this address right now. The NOID balance above is spendable.</td></tr>'}
        </table>
        <p class="fine"><b id="wtotal">Total ${esc(usd(totalUsd))}</b>${positions?.pnl ? ` · ${positions.pnl.txns || 0} trades · bought ${esc(fmtNoid(positions.pnl.bought_noid_micronoid))} · sold ${esc(fmtNoid(positions.pnl.sold_noid_micronoid))}` : ''}${book?.tokens?.length ? '' : ''}</p>
        <p class="fine">Tap a token to open its page, ⧉ copies its id (the contract address trades are addressed to), Trade opens the panel below.</p>
      </div>

      <div class="card" id="tpane" hidden>
        <h2>Trade <small class="muted" id="twhat">pick a token</small></h2>
        <div class="wrow">
          <select id="tasset" aria-label="Token"></select>
          <button type="button" id="tsidebuy" class="on">Buy</button><button type="button" id="tsidesell">Sell</button>
        </div>
        <p class="avail" id="tavail"></p>
        <div class="wrow">
          <input id="tamt" inputmode="decimal" placeholder="Amount in NOID" autocomplete="off">
          <button type="button" id="tmax">Max</button>
        </div>
        <input id="trange" type="range" min="0" max="1000" value="0" step="1" aria-label="How much of your balance to use">
        <p class="est" id="test" aria-live="polite"></p>
        <div class="wrow">
          <input id="tslip" inputmode="decimal" value="1" size="3" aria-label="Slippage percent"> <span class="muted">% slippage</span>
          <button type="button" id="tquote">Get quote</button>
        </div>
        <div id="tres"></div>
        <p class="fine">Trading is not investment advice: a token can go to zero and a sent trade cannot be reversed.</p>
      </div>

      <div class="card">
        <h2>Spending <small class="muted">what this build can and cannot do</small></h2>
        <p>Parano1d has no signatures. Spending is authorized by a zero-knowledge proof that you know the secret behind the input address, and that proof runs here, on your device. The seed never leaves this browser.</p>
        <p>Buying and selling tokens works in this build. The trade panel below asks the node for a plan for your address, checks that plan here before proving anything, proves it, and sends it. A sent trade shows as pending (yellow) until the next block lands, about 30 seconds.</p>
        <p class="fine">Not built yet: sending plain NOID to another address by hand. That needs the same proof with a payment statement instead of a trade.</p>
      </div>

      <div class="card">
        <h2>Recent activity <small class="muted">last ${txs.length}</small></h2>
        ${txs.length
          ? `<div class="wlist">${txs.slice(0, 12).map((t) => `<div><span class="mono">${esc(short(t.txid || '', 14))}</span><b>${esc(t.direction || t.kind || '')} ${esc(t.value_micronoid != null ? fmtNoid(t.value_micronoid) : '')}</b></div>`).join('')}</div>`
          : '<p class="muted">No activity this explorer has retained for this address.</p>'}
        <p><a href="/address/${esc(address)}" data-link>Full address page →</a></p>
      </div>

      <div class="card">
        <h2>Backup</h2>
        <p>Your 24 words are the wallet. Write them down and keep them offline. Anyone who has them, or the <span class="mono">wallet.key</span> file this seed writes on a full node, can spend everything.</p>
        <div class="wrow"><button type="button" id="wreveal">Reveal words</button><button type="button" id="wexport">Export daemon key file</button><button type="button" id="wreset" class="danger">Delete from this browser</button></div>
        <p class="fine" id="wbackupnote"></p>
      </div>`;

    $('wcopy2').onclick = async () => { await copyText(address, $('wcopy2')); };
    $('wlock').onclick = () => { SESSION.master = null; SESSION.seedWords = null; render(box); };
    $('wnew').onclick = async () => {
      SESSION.index += 1;
      render(box);
    };
    $('wreveal').onclick = async () => {
      const note = $('wbackupnote');
      if (SESSION.seedWords) {
        note.innerHTML = `<b class="mono">${esc(SESSION.seedWords.join(' '))}</b><br>Anyone who reads this can take the funds. Close the page when you are done.`;
        $('wreveal').textContent = 'Hide words';
        $('wreveal').onclick = () => render(box);
        return;
      }
      note.innerHTML = `<div class="wrow"><input type="password" id="wrevealpass" placeholder="Passphrase"><button type="button" id="wrevealgo">Show words</button></div>`;
      $('wrevealgo').onclick = async () => {
        try {
          const master = await decryptSeed(storedBlob(), $('wrevealpass').value);
          SESSION.seedWords = await entropyToWords(master);
          note.innerHTML = `<b class="mono">${esc(SESSION.seedWords.join(' '))}</b><br>Anyone who reads this can take the funds. Close the page when you are done.`;
        } catch { note.textContent = 'That passphrase did not decrypt the seed.'; }
      };
    };
    $('wexport').onclick = async () => {
      const note = $('wbackupnote');
      note.innerHTML = '<div class="wrow"><input type="password" id="wexportpass" placeholder="Passphrase"><button type="button" id="wexportgo">Export key file</button></div>';
      $('wexportgo').onclick = async () => {
        try {
          const master = await decryptSeed(storedBlob(), $('wexportpass').value);
          const blob = new Uint8Array(48);
          blob.set(new TextEncoder().encode('noid_plain_key_1'), 0);
          blob.set(master, 16);
          note.innerHTML = `This is the exact <span class="mono">wallet.key</span> a Parano1d node reads. Save it as <span class="mono">wallet.key</span> beside the node and it controls the same addresses.<br><b class="mono" style="word-break:break-all">${esc(hex(blob))}</b>`;
        } catch { note.textContent = 'That passphrase did not decrypt the seed.'; }
      };
    };
    // ---- trade panel -------------------------------------------------------------------
    const pane = $('tpane');
    const picks = [];
    for (const h of holdings) {
      const id = h.token_id || h.asset_id || '';
      if (id && !picks.some((p) => p.id === id)) picks.push({ id, label: h.ticker || h.name || short(id, 8) });
    }
    for (const tk of (book?.tokens || [])) {
      const id = tk.id || '';
      if (id && !picks.some((p) => p.id === id)) picks.push({ id, label: tk.ticker || tk.name || short(id, 8) });
    }
    $('tasset').innerHTML = picks.length ? picks.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('') : '<option value="">nothing listed yet</option>';
    // Spendable now: NOID from the explorer index, the selected token's page read from the node.
    const MICRO = 1000000n;
    const FEE_RESERVE_MICRO = 20000n;
    const dec = (micro) => {
      const n = BigInt(micro || 0);
      const w = (n / MICRO).toLocaleString('en-US');
      const f = String(n % MICRO).padStart(6, '0').replace(/0+$/, '');
      return `${w}${f ? '.' + f : ''}`;
    };
    const noidHeld = BigInt(String(account?.balance_micronoid || '0'));
    const unitsHeld = (tokenId) => {
      const h = holdings.find((x) => (x.token_id || x.asset_id) === tokenId);
      return BigInt(String(h?.units || '0'));
    };
    let side = 'buy';
    const picked = () => $('tasset').value || '';
    const availMax = () => (side === 'buy'
      ? (noidHeld > FEE_RESERVE_MICRO ? noidHeld - FEE_RESERVE_MICRO : 0n)
      : (unitsHeld(picked()) / MICRO) * MICRO); // a sell is whole tokens
    function paintAvail() {
      const el = $('tavail');
      if (!el) return;
      const id = picked();
      el.innerHTML = side === 'buy'
        ? `Available <b>${esc(dec(noidHeld))} NOID</b>`
        : `Available <b>${esc(dec(unitsHeld(id)))} ${esc((holdings.find((x) => (x.token_id || x.asset_id) === id)?.ticker) || 'tokens')}</b>`;
      $('tmax').disabled = availMax() <= 0n;
    }
    // What the amount you typed buys or sells, so nobody has to guess the other side of the trade. A sale uses the
    // node's own payout for the whole balance when the server could quote it - the curve's price is not the mark.
    const rowOf = (id) => holdings.find((x) => (x.token_id || x.asset_id) === id) || null;
    const tickOf = (id) => rowOf(id)?.ticker || rowOf(id)?.name || 'tokens';
    const num = (v, d) => Number(v).toLocaleString('en-US', { maximumFractionDigits: d });
    function paintEst() {
      const el = $('test');
      if (!el) return;
      const n = Number($('tamt').value.trim());
      const id = picked();
      if (!Number.isFinite(n) || n <= 0) { el.textContent = ''; return; }
      const mark = Number(rowOf(id)?.price_micronoid || 0) / 1e6;
      const sell = side === 'sell' ? rowOf(id)?.sell_now : null;
      const whole = Number(BigInt(String(rowOf(id)?.units || '0')) / MICRO);
      if (sell && sell.net_micronoid && whole > 0) {
        const per = Number(sell.net_micronoid) / whole / 1e6;
        el.textContent = `\u2248 ${num(n * per, 4)} NOID at ${num(per, 6)} NOID a token \u2014 the node's payout for your whole balance. The exact figure comes from the node when you quote.`;
      } else if (mark > 0) {
        const per = `at the last traded price ${num(mark, 6)} NOID`;
        el.textContent = side === 'buy'
          ? `\u2248 ${num(n / mark, 4)} ${tickOf(id)} ${per}. The node quotes the exact fill when you quote.`
          : `\u2248 ${num(n * mark, 4)} NOID ${per}. The node quotes the exact payout when you quote.`;
      } else {
        el.textContent = '';
      }
    }
    function syncSlider() {
      const max = availMax();
      const raw = $('tamt').value.trim();
      if (max <= 0n || !/^\d+(\.\d+)?$/.test(raw)) { $('trange').value = '0'; paintEst(); return; }
      const got = side === 'buy' ? BigInt(Math.round(Number(raw) * 1e6)) : BigInt(Math.floor(Number(raw))) * MICRO;
      $('trange').value = got >= max ? '1000' : String(Number((got * 1000n) / max));
      paintEst();
    }
    const setSide = (s) => {
      side = s;
      $('tsidebuy').classList.toggle('on', s === 'buy');
      $('tsidesell').classList.toggle('on', s === 'sell');
      $('tamt').placeholder = s === 'buy' ? 'Amount in NOID' : 'Whole tokens';
      $('tamt').value = '';
      $('trange').value = '0';
      $('tres').innerHTML = '';
      paintAvail();
      paintEst();
    };
    $('tamt').addEventListener('input', syncSlider);
    $('trange').oninput = () => {
      const max = availMax();
      if (max <= 0n) return;
      const part = (max * BigInt($('trange').value)) / 1000n;
      $('tamt').value = side === 'buy' ? dec(part) : String(Number(part / MICRO));
      paintEst();
      $('tres').innerHTML = '';
    };
    $('tmax').onclick = () => {
      const max = availMax();
      if (max <= 0n) return;
      $('tamt').value = side === 'buy' ? dec(max) : String(Number(max / MICRO));
      $('trange').value = '1000';
      paintEst();
      $('tres').innerHTML = '';
    };
    const openPane = (id) => {
      pane.hidden = false;
      if (id && $('tasset').querySelector(`option[value="${id}"]`)) $('tasset').value = id;
      $('twhat').textContent = $('tasset').selectedOptions[0]?.textContent || '';
      pane.scrollIntoView({ block: 'nearest' });
    };
    box.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-trade], [data-buy], [data-copy]');
      if (!btn) return;
      if (btn.dataset.copy) {
        const was = btn.textContent;
        navigator.clipboard?.writeText(btn.dataset.copy).then(() => { btn.textContent = '✓'; setTimeout(() => { btn.textContent = was; }, 1200); }).catch(() => {});
        return;
      }
      openPane(btn.dataset.trade || '');
    });
    $('tsidebuy').onclick = () => setSide('buy');
    $('tsidesell').onclick = () => setSide('sell');
    $('tasset').onchange = () => { $('twhat').textContent = $('tasset').selectedOptions[0]?.textContent || ''; $('tres').innerHTML = ''; paintAvail(); syncSlider(); paintEst(); };
    setSide('buy');
    $('tquote').onclick = async () => {
      const token = $('tasset').value, amount = $('tamt').value.trim(), slip = $('tslip').value.trim() || '1';
      const out = $('tres');
      if (!token) { out.innerHTML = '<p class="msg err">No token to trade yet. Create or pick one on Explore.</p>'; return; }
      if (!amount) { out.innerHTML = '<p class="msg err">Enter an amount first.</p>'; return; }
      out.innerHTML = '<p class="muted">Asking the node for a plan, then checking it on this device…</p>';
      let t;
      try { t = await prepareTrade({ token, side, amount, slippage: slip }); }
      catch (err) {
        out.innerHTML = `<p class="msg err">${esc(err.message)}</p>`
          + (/trading is off/i.test(err.message) ? '<p class="fine">Trading is switched off on this explorer right now. Nothing was sent.</p>' : '');
        return;
      }
      const tick = $('tasset').selectedOptions[0]?.textContent || 'tokens';
      out.innerHTML = `<div class="wlist">${tradeRows(t.review, { side, ticker: tick }).map(([k, v]) => `<div><span class="muted">${esc(k)}</span> <b>${esc(v)}</b></div>`).join('')}</div>
        <div class="wrow"><button type="button" id="tsign" class="primary">Confirm ${side === 'buy' ? 'buy' : 'sell'}</button></div>
        <p class="fine" id="tnote">Checked on this device: the amount, your slippage limit, the fee cap and that the tokens come back to your own address. Confirming proves the trade here and sends it.</p>`;
      $('tsign').onclick = async () => {
        const note = $('tnote');
        $('tsign').disabled = true;
        note.className = 'fine';
        note.textContent = 'Approving on this device. This takes about 10 to 30 seconds…';
        try {
          await confirmTrade({ id: t.id, ticker: tick });
          // Repaint: the wallet view is what has to say pending, not the panel below it.
          await render(box);
        } catch (err) {
          note.className = 'msg err';
          note.textContent = err.message;
          $('tsign').disabled = false;
        }
      };
    };

    const watch = readPending();
    if (watch && watch.status === 'pending') setTimeout(() => pollPending(box), 4000);

    $('wreset').onclick = () => {
      if (!confirm('Delete the encrypted seed from this browser? Without your written words the funds are unrecoverable.')) return;
      clearBlob();
      clearIdentity();
      SESSION.master = null; SESSION.seedWords = null;
      render(box);
    };
  }

  async function copyText(text, btn) {
    try { await navigator.clipboard.writeText(text); } catch {}
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = 'Copy address'; }, 1200);
  }

  function renderCreate(box) {
    box.innerHTML = `
      <div class="card">
        <h2>Make a No1d wallet</h2>
        <p>Your wallet is 24 words, made here in your browser from your own device's randomness. Nothing is created on a server, and the words never leave this page except as an encrypted blob only your passphrase opens.</p>
        <div class="wrow">
          <button type="button" id="wcreate">Create a new wallet</button>
          <button type="button" id="wimport">I already have 24 words</button>
        </div>
        <p class="fine">Prefer your own key? A Parano1d node's <span class="mono">wallet.key</span> file can be pasted in on import, and the same addresses come back.</p>
      </div>
      <div id="wstep"></div>`;

    $('wcreate').onclick = async () => {
      const step = $('wstep');
      step.innerHTML = '<p class="muted">Making your words…</p>';
      const entropy = crypto.getRandomValues(new Uint8Array(32));
      const words = await entropyToWords(entropy);
      SESSION.pendingMaster = entropy;
      SESSION.pendingWords = words;
      step.innerHTML = `
        <div class="card">
          <h2>Write these 24 words down</h2>
          <p class="muted">In order, on paper, somewhere safe. This is the only backup; nobody can reset it for you.</p>
          <div class="wseed">${words.map((w, i) => `<span><i>${i + 1}</i>${esc(w)}</span>`).join('')}</div>
          <label class="wcheck"><input type="checkbox" id="wsaved"> I have written the words down</label>
          <div id="wpassrow" hidden>
            <input type="password" id="wpassinput" placeholder="Passphrase (8+ characters)" autocomplete="new-password">
            <input type="password" id="wpassinput2" placeholder="Type it again" autocomplete="new-password">
            <div class="wrow"><button type="button" id="wpass">Encrypt and open my wallet</button></div>
          </div>
          <p class="fine" id="wpassnote">The passphrase encrypts the seed in this browser. It is not your words, it is not sent anywhere, and it cannot be reset: if you forget it, restore from the words instead.</p>
        </div>`;
      $('wsaved').onchange = (e) => { $('wpassrow').hidden = !e.target.checked; };
      $('wpass').onclick = async () => {
        const passphrase = $('wpassinput').value;
        if (!passphrase || passphrase.length < 8) { $('wpassnote').textContent = 'Use at least 8 characters.'; return; }
        if ($('wpassinput2').value !== passphrase) { $('wpassnote').textContent = 'Those did not match. Try again.'; return; }
        writeBlob(await encryptSeed(SESSION.pendingMaster, passphrase));
        SESSION.master = SESSION.pendingMaster;
        SESSION.seedWords = SESSION.pendingWords;
        SESSION.pendingMaster = null; SESSION.pendingWords = null;
        SESSION.index = 0;
        render(box);
      };
    };

    $('wimport').onclick = async () => {
      const step = $('wstep');
      step.innerHTML = `
        <div class="card">
          <h2>Restore a wallet</h2>
          <p class="muted">Paste your 24 words, or the contents of a node's <span class="mono">wallet.key</span> file (the 48 bytes as hex, or the file itself).</p>
          <textarea id="wim" rows="4" placeholder="word1 word2 … word24"></textarea>
          <input type="password" id="wimpass" placeholder="Passphrase for this browser (8+ characters)" autocomplete="new-password">
          <p class="fine" id="wimnote"></p>
          <div class="wrow"><button type="button" id="widob">Restore and open</button></div>
        </div>`;
      $('widob').onclick = async () => {
        const note = $('wimnote');
        const raw = $('wim').value.trim();
        let master = null;
        try {
          if (/^[0-9a-fA-F]{48}$/.test(raw.replace(/\s+/g, ''))) {
            const bytes = Uint8Array.from(raw.replace(/\s+/g, '').match(/../g).map((h) => parseInt(h, 16)));
            if (new TextDecoder().decode(bytes.slice(0, 16)) !== 'noid_plain_key_1') throw new Error('that hex is not a wallet.key file');
            master = bytes.slice(16, 48);
          } else if (/^[0-9a-fA-F]{64}$/.test(raw.replace(/\s+/g, ''))) {
            master = Uint8Array.from(raw.replace(/\s+/g, '').match(/../g).map((h) => parseInt(h, 16)));
          } else {
            master = await wordsToEntropy(raw.split(/\s+/));
          }
        } catch (error) { note.textContent = error.message; return; }
        const passphrase = ($('wimpass') || {}).value || '';
        if (passphrase.length < 8) { note.textContent = 'Choose a passphrase of at least 8 characters in the field above.'; return; }
        writeBlob(await encryptSeed(master, passphrase));
        SESSION.master = master;
        SESSION.seedWords = await entropyToWords(master);
        SESSION.index = 0;
        render(box);
      };
    };
  }

  function renderUnlock(box) {
    box.innerHTML = `
      <div class="card">
        <h2>Unlock your No1d wallet</h2>
        <p class="muted">Stored encrypted in this browser. Your passphrase opens it; nothing is sent anywhere.</p>
        <input type="password" id="wpass" placeholder="Passphrase" autocomplete="current-password">
        <div class="wrow"><button type="button" id="wgo">Unlock</button><button type="button" id="wforget">Delete stored wallet</button></div>
        <p class="fine" id="wnote"></p>
      </div>`;
    const unlock = async () => {
      try {
        SESSION.master = await decryptSeed(storedBlob(), $('wpass').value);
        SESSION.index = 0;
        render(box);
      } catch { $('wnote').textContent = 'That passphrase did not open the wallet.'; }
    };
    $('wgo').onclick = unlock;
    $('wpass').onkeydown = (e) => { if (e.key === 'Enter') unlock(); };
    $('wforget').onclick = () => {
      if (!confirm('Delete the stored wallet from this browser? Without your written words it cannot be restored.')) return;
      clearBlob();
      clearIdentity();
      render(box);
    };
  }

  window.No1dWallet = {
    async render(box) { try { return await render(box); } catch (error) { box.innerHTML = `<div class="card"><h2>Wallet</h2><p class="msg err">${esc(error.message)}</p></div>`; } },
    isUnlocked: () => !locked(),
    hasWallet: () => !!storedBlob(),
    unlock: unlockWith,
    prepareTrade,
    confirmTrade,
    tradeRows,
    // Proves a random throwaway statement, to check the engine runs on this device.
    selftest: () => engineCall({ cmd: 'selftest' }).then((r) => r.result),
    identity: readIdentity,
    clearIdentity,
    async address(index = 0) { return addressAt(index); },
    isValidAddress,
    // Test hook: derive from an explicit 32-byte seed, used by the test page.
    async addressFromSeed(seedHex, index = 0) {
      const master = Uint8Array.from(seedHex.match(/../g).map((h) => parseInt(h, 16)));
      return deriveAddress(master, index);
    },
    firstUnusedIndex,
  };
})();
