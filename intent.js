// Native token trades through Parano1d v2.1 intents. Non-custodial: the node builds an UNSIGNED intent for the
// buyer's own address (paranoid_prepareNativeIntent), the buyer's wallet signs it, and the signed bytes go to
// paranoid_submitTxIntent (from the wallet, or relayed here as-is). This process never sees or holds a key.
// On by default (the wallet proves and checks every trade on the user's device); SWAP_ENABLED=false turns it off.
// Before the native activation height the node refuses; demo mode returns a mock.
const ADDR = /^o1[02-9ac-hj-np-z]{6,120}$/;
const ID = /^[A-Za-z0-9:_-]{1,80}$/;
const bad = (m, status = 400) => Object.assign(new Error(m), { status });

module.exports = function intents(rpc, tipNow = () => null) {
  const activation = () => Number(process.env.NATIVE_ACTIVATION_HEIGHT || 279370);
  const enabled = () => process.env.SWAP_ENABLED !== 'false';
  const notActive = (e) => /not active/i.test(e?.message || '');

  function info() {
    const tip = tipNow();
    return {
      enabled: enabled(), method: 'prepareNativeIntent', submit: 'submitTxIntent', activation_height: activation(),
      active: tip != null && tip >= activation(), blocks_left: tip == null ? null : Math.max(0, activation() - tip),
    };
  }

  // amount: NOID for a buy (converted to μNOID), whole tokens for a sell. slippage in percent (0–50).
  function request(params) {
    const token = params.get('token') || '';
    if (!ID.test(token)) throw bad('expected a token id');
    const side = params.get('side');
    if (side !== 'buy' && side !== 'sell') throw bad('side must be buy or sell');
    const raw = String(params.get('amount') || '').trim();
    if (side === 'buy' ? !/^\d{1,12}(\.\d{1,6})?$/.test(raw) : !/^\d{1,24}$/.test(raw)) throw bad(side === 'buy' ? 'amount must be NOID with up to 6 decimals' : 'sell whole tokens');
    // Both sides are sized in micro-units on chain: NOID for a buy, token units (1e6 per whole token) for a sell.
    const [w, f = ''] = raw.split('.');
    const gross = side === 'buy' ? (BigInt(w) * 1_000_000n + BigInt((f + '000000').slice(0, 6))).toString() : (BigInt(raw) * 1_000_000n).toString();
    if (gross === '0') throw bad('amount must be positive');
    const slip = Number(params.get('slippage') ?? 1);
    if (!(slip >= 0 && slip <= 50)) throw bad('slippage must be 0–50%');
    const req = { action: 'trade', asset_id: token, buy: side === 'buy', gross_input: gross, slippage_bps: Math.round(slip * 100) };
    const min = params.get('min_out');
    if (min != null && min !== '') {
      if (!/^\d{1,30}$/.test(min)) throw bad('min_out must be a whole number');
      req.minimum_output = min;
    }
    return req;
  }

  const submitHint = '{"jsonrpc":"2.0","id":1,"method":"paranoid_submitTxIntent","params":{"hex":"<signed intent hex>"}}';

  async function prepare(params) {
    if (!enabled()) throw bad('trading is off', 403);
    const sender = params.get('sender') || '';
    if (!ADDR.test(sender)) throw bad('expected your o1… wallet address');
    const req = request(params);
    if (params.get('demo') === '1') {
      return {
        mock: true, signable: false, sender, request: req,
        unsigned: Buffer.from(JSON.stringify({ mock: true, sender, ...req })).toString('hex'),
        note: `Mock intent for layout testing. Native tokens activate at block ${activation().toLocaleString('en-US')}; nothing here can be signed or sent.`,
        submit_rpc: submitHint,
      };
    }
    let out;
    try {
      out = await rpc('prepareNativeIntent', { owner: sender, request: req }, 30_000);
    } catch (e) {
      if (notActive(e)) throw bad(`Native token trading activates at block ${activation().toLocaleString('en-US')}. The node refuses intents until then.`, 409);
      throw e;
    }
    if (out && typeof out === 'object' && (out.signature || out.signed || out.signed_tx)) throw bad('refusing a signed payload', 502);
    return {
      mock: false, signable: true, sender, request: req,
      unsigned: typeof out === 'string' ? out : out?.unsigned_intent_hex ?? out?.intent ?? out?.unsigned ?? out?.hex ?? null,
      detail: out && typeof out === 'object' ? out : null,
      note: 'Unsigned. Sign it in your own wallet, then submit the signed bytes. This site never holds keys.',
      submit_rpc: submitHint,
    };
  }

  // Relays already-signed bytes. It cannot create, alter or sign anything.
  async function submit(body) {
    if (!enabled()) throw bad('trading is off', 403);
    const hex = typeof body?.signed === 'string' ? body.signed.replace(/\s+/g, '') : '';
    if (!hex || !/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 || hex.length > 4_000_000) throw bad('paste the signed intent as hex');
    try {
      return { submitted: true, result: await rpc('submitTxIntent', { hex }, 30_000) };
    } catch (e) {
      if (notActive(e)) throw bad(`Native token trading activates at block ${activation().toLocaleString('en-US')}.`, 409);
      throw bad(e.message, 400);
    }
  }

  // Builds an UNSIGNED CreateToken intent for the owner's wallet, exactly like prepare() does for a
  // trade. whole_tokens = how many whole tokens to mint; metadata_hash = 64-hex manifest digest ('' or
  // '0' for none, like NOIDCAT which has no published manifest); initial_buy_units = optional micro-units
  // (1e6 per whole token) of an immediate launchpad buy. The node's plan carries the real fee, NOID debit,
  // liquidity reserve and initial-buy cost; the wallet proves it and submits the same as a trade.
  async function launch(params) {
    if (!enabled()) throw bad('trading is off', 403);
    const sender = params.get('sender') || '';
    if (!ADDR.test(sender)) throw bad('expected your o1… wallet address');
    const raw = String(params.get('whole_tokens') || '').trim();
    if (!/^\d{1,18}$/.test(raw)) throw bad('whole_tokens must be a positive whole number');
    const w = BigInt(raw);
    if (w < 100000n) throw bad('whole_tokens must be at least 100,000: every token is backed by 1,000 µNOID, so the smallest launch carries the 100 NOID curve reserve');
    if (w > 10248191152n) throw bad('whole_tokens exceeds the chain maximum of 10,248,191,152');
    const mh = String(params.get('metadata_hash') || '').trim().toLowerCase();
    if (mh !== '' && mh !== '0' && !/^[0-9a-f]{64}$/.test(mh)) throw bad('metadata_hash must be 64 hex characters, or empty');
    const req = { action: 'create_token', whole_tokens: raw, metadata_hash: mh === '0' ? '0'.repeat(64) : mh };
    const ib = String(params.get('initial_buy_units') || '').trim();
    if (ib !== '') {
      if (!/^\d{1,30}$/.test(ib) || ib === '0') throw bad('initial_buy_units must be a positive whole number of micro-units');
      if (BigInt(ib) > (w * 60n) / 100n * 1_000_000n) throw bad('initial_buy_units can be at most 60% of supply — the most the curve can sell in one launch');
      req.initial_buy_units = ib;
    }
    if (params.get('demo') === '1') {
      return {
        mock: true, signable: false, sender, request: req,
        unsigned: Buffer.from(JSON.stringify({ mock: true, sender, ...req })).toString('hex'),
        note: 'Mock intent for layout testing. Nothing here can be signed or sent.', submit_rpc: submitHint,
      };
    }
    let out;
    try {
      out = await rpc('prepareNativeIntent', { owner: sender, request: req }, 30_000);
    } catch (e) {
      if (notActive(e)) throw bad(`Native token creation activates at block ${activation().toLocaleString('en-US')}.`, 409);
      throw e;
    }
    if (out && typeof out === 'object' && (out.signature || out.signed || out.signed_tx)) throw bad('refusing a signed payload', 502);
    return {
      mock: false, signable: true, sender, request: req,
      unsigned: typeof out === 'string' ? out : out?.unsigned_intent_hex ?? out?.intent ?? out?.unsigned ?? out?.hex ?? null,
      detail: out && typeof out === 'object' ? out : null,
      note: 'Unsigned. Sign it in your own wallet, then submit the signed bytes. This site never holds keys.',
      submit_rpc: submitHint,
    };
  }

  return { info, request, prepare, submit, launch };
};
