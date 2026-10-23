// Native token trades through Parano1d v2.1 intents. Non-custodial: the node builds an UNSIGNED intent for the
// buyer's own address (paranoid_prepareNativeIntent), the buyer's wallet signs it, and the signed bytes go to
// paranoid_submitTxIntent (from the wallet, or relayed here as-is). This process never sees or holds a key.
// Off unless SWAP_ENABLED=true. Before the native activation height the node refuses; demo mode returns a mock.
const ADDR = /^o1[02-9ac-hj-np-z]{6,120}$/;
const ID = /^[A-Za-z0-9:_-]{1,80}$/;
const bad = (m, status = 400) => Object.assign(new Error(m), { status });

module.exports = function intents(rpc, tipNow = () => null) {
  const activation = () => Number(process.env.NATIVE_ACTIVATION_HEIGHT || 279370);
  const enabled = () => process.env.SWAP_ENABLED === 'true';
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
    const [w, f = ''] = raw.split('.');
    const gross = side === 'buy' ? (BigInt(w) * 1_000_000n + BigInt((f + '000000').slice(0, 6))).toString() : BigInt(raw).toString();
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

  const submitHint = '{"jsonrpc":"2.0","id":1,"method":"paranoid_submitTxIntent","params":["<signed intent hex>"]}';

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
      out = await rpc('prepareNativeIntent', [sender, req], 30_000);
    } catch (e) {
      if (notActive(e)) throw bad(`Native token trading activates at block ${activation().toLocaleString('en-US')}. The node refuses intents until then.`, 409);
      throw e;
    }
    if (out && typeof out === 'object' && (out.signature || out.signed || out.signed_tx)) throw bad('refusing a signed payload', 502);
    return {
      mock: false, signable: true, sender, request: req,
      unsigned: typeof out === 'string' ? out : out?.intent ?? out?.unsigned ?? out?.hex ?? null,
      detail: out && typeof out === 'object' ? out : null,
      note: 'Unsigned. Sign it in your own wallet, then submit the signed bytes. This site never holds keys.',
      submit_rpc: submitHint,
    };
  }

  // Relays already-signed bytes. It cannot create, alter or sign anything.
  async function submit(body) {
    if (!enabled()) throw bad('trading is off', 403);
    const hex = typeof body?.signed === 'string' ? body.signed.replace(/\s+/g, '') : '';
    if (!hex || !/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 || hex.length > 262144) throw bad('paste the signed intent as hex');
    try {
      return { submitted: true, result: await rpc('submitTxIntent', [hex], 30_000) };
    } catch (e) {
      if (notActive(e)) throw bad(`Native token trading activates at block ${activation().toLocaleString('en-US')}.`, 409);
      throw bad(e.message, 400);
    }
  }

  return { info, request, prepare, submit };
};
