// USDC for an enhanced profile or a promoted slot. The reference is the exact base-unit amount (the price plus a unique suffix).
// A different amount does not match. One transaction can settle only one order. Card and NOID stay separate.
// EVM chains read native Circle USDC Transfer logs that are already USDC_<CHAIN>_CONFIRMATIONS behind the head.
// Solana reads a finalized balance increase for the wallet owner, or a transfer into the token account.
// shortcut: each poll looks back USDC_LOOKBACK blocks (default 2000) and 20 Solana signatures. Raise the lookback if a quote can outlive a process restart.
const { randomBytes, randomInt } = require('node:crypto');

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// Native Circle USDC only. The mint is not configurable, so a bridged token cannot be watched by setting an env var.
const CHAINS = [
  { id: 'ethereum', label: 'Ethereum', env: 'ETHEREUM', kind: 'evm', mint: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', confirmations: 12 },
  { id: 'base', label: 'Base', env: 'BASE', kind: 'evm', mint: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', confirmations: 12 },
  { id: 'arbitrum', label: 'Arbitrum', env: 'ARBITRUM', kind: 'evm', mint: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', confirmations: 12 },
  { id: 'optimism', label: 'Optimism', env: 'OPTIMISM', kind: 'evm', mint: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', confirmations: 12 },
  { id: 'polygon', label: 'Polygon', env: 'POLYGON', kind: 'evm', mint: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', confirmations: 128 },
  { id: 'avalanche', label: 'Avalanche', env: 'AVALANCHE', kind: 'evm', mint: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', confirmations: 1 },
  { id: 'solana', label: 'Solana', env: 'SOLANA', kind: 'solana', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', confirmations: 0 },
];
const ADDR = {
  evm: /^0x[a-fA-F0-9]{40}$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
};

function priceUsdc() {
  const n = Number(process.env.ENHANCED_PROFILE_USDC ?? 100);
  return Number.isInteger(n) && n >= 1 && n <= 1_000_000 ? n : 100;
}
function chainState(spec) {
  const address = String(process.env[`USDC_${spec.env}_ADDRESS`] || '').trim();
  const rpc = String(process.env[`USDC_${spec.env}_RPC_URL`] || '').trim();
  const raw = process.env[`USDC_${spec.env}_CONFIRMATIONS`];
  let confirmations = spec.confirmations;
  if (raw != null && raw !== '') {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0 && n <= 1000) confirmations = n;
  }
  const enabled = !!address && ADDR[spec.kind].test(address);
  return { ...spec, address, rpc, confirmations, enabled };
}
function enabled() {
  return CHAINS.map(chainState).filter((c) => c.enabled);
}
function publicChains() {
  return enabled().map((c) => ({ id: c.id, label: c.label, confirmations: c.confirmations }));
}
function formatUnits(amount) {
  const s = amount.toString().padStart(7, '0');
  const frac = s.slice(-6).replace(/0+$/, '');
  return frac ? `${s.slice(0, -6)}.${frac}` : s.slice(0, -6);
}

// Pure: finalized Solana tx -> USDC credits to this owner or token account.
function solanaCredits(tx, cfg) {
  if (!tx || tx.meta?.err) return [];
  const sig = tx.transaction?.signatures?.[0];
  if (!sig) return [];
  const out = [];
  const pre = new Map();
  for (const row of tx.meta?.preTokenBalances || []) {
    if (row.mint === cfg.mint && row.owner === cfg.address) pre.set(row.accountIndex, BigInt(row.uiTokenAmount?.amount || '0'));
  }
  let delta = 0n;
  let saw = false;
  for (const row of tx.meta?.postTokenBalances || []) {
    if (row.mint !== cfg.mint || row.owner !== cfg.address) continue;
    saw = true;
    delta += BigInt(row.uiTokenAmount?.amount || '0') - (pre.get(row.accountIndex) || 0n);
  }
  if (saw && delta > 0n) out.push({ tx: sig, amount: delta.toString() });
  const groups = [...(tx.transaction?.message?.instructions || []), ...(tx.meta?.innerInstructions || []).flatMap((g) => g.instructions || [])];
  for (const ix of groups) {
    const p = ix.parsed;
    if (!p || (p.type !== 'transfer' && p.type !== 'transferChecked')) continue;
    const info = p.info || {};
    if (info.destination !== cfg.address) continue;
    if (p.type === 'transferChecked' && info.mint && info.mint !== cfg.mint) continue;
    const raw = info.tokenAmount?.amount || info.amount;
    if (raw && /^\d+$/.test(String(raw))) out.push({ tx: sig, amount: String(raw) });
  }
  return out;
}

function usdc(db, profiles, boosts = null) {
  db.exec(`
    create table if not exists usdc_orders (
      id text primary key, account text not null, profile_id text not null,
      chain text not null, address text not null, amount text not null,
      created integer not null, paid_tx text unique);
    create unique index if not exists usdc_orders_open on usdc_orders(chain, amount) where paid_tx is null;
  `);
  const q = {
    open: db.prepare('select id, account, profile_id, amount from usdc_orders where chain = ? and amount = ? and paid_tx is null'),
    byId: db.prepare('select id, account, profile_id, chain, address, amount, created, paid_tx from usdc_orders where id = ?'),
    insert: db.prepare('insert into usdc_orders (id, account, profile_id, chain, address, amount, created) values (?, ?, ?, ?, ?, ?, ?)'),
    claim: db.prepare('update usdc_orders set paid_tx = ? where id = ? and paid_tx is null'),
    used: db.prepare('select paid_tx from usdc_orders where paid_tx = ?'),
  };

  function view(acct, id) {
    const row = q.byId.get(id || '');
    if (!row || !acct || row.account !== acct.id) return null;
    const amount = BigInt(row.amount);
    return {
      id: row.id, kind: 'profile', method: 'usdc', chain: row.chain, address: row.address,
      usdc: Number(amount / 1_000_000n), amount_base: amount.toString(), amount_usdc: formatUnits(amount),
      reference: (amount % 1_000_000n).toString().padStart(6, '0'),
      paid: !!row.paid_tx, paid_tx: row.paid_tx, profile_id: row.profile_id, status: row.paid_tx ? 'paid' : 'waiting',
    };
  }

  function quote(acct, subjectId, usdcWhole, chainId) {
    const list = enabled();
    if (!list.length) throw Object.assign(new Error('USDC is off until a USDC_<CHAIN>_ADDRESS is set'), { status: 503 });
    const cfg = list.find((c) => c.id === chainId) || (chainId == null && list.length === 1 ? list[0] : null);
    if (!cfg) throw Object.assign(new Error('pick an enabled USDC chain'), { status: 400 });
    if (!cfg.rpc) throw Object.assign(new Error(`USDC_${cfg.env}_RPC_URL is not set`), { status: 503 });
    const whole = usdcWhole == null ? priceUsdc() : Number(usdcWhole);
    if (!Number.isInteger(whole) || whole < 1 || whole > 1_000_000) throw Object.assign(new Error('bad USDC amount'), { status: 400 });
    const base = BigInt(whole) * 1_000_000n;
    for (let i = 0; i < 5; i++) {
      const amount = base + BigInt(randomInt(1, 1_000_000));
      const id = randomBytes(6).toString('hex');
      try { q.insert.run(id, acct.id, subjectId, cfg.id, cfg.address, amount.toString(), Date.now()); }
      catch { continue; }
      return view(acct, id);
    }
    throw Object.assign(new Error('could not allocate a USDC amount, try again'), { status: 503 });
  }

  function settle(chain, transfers) {
    const byTx = new Map();
    for (const tr of transfers || []) {
      if (!tr?.tx || !/^\d+$/.test(String(tr.amount || ''))) continue;
      const list = byTx.get(tr.tx) || [];
      list.push(String(tr.amount));
      byTx.set(tr.tx, list);
    }
    let n = 0;
    for (const [tx, amounts] of byTx) {
      const txid = `${chain}:${tx}`;
      if (q.used.get(txid)) continue;
      let row = null;
      for (const amount of amounts) {
        row = q.open.get(chain, amount);
        if (row) break;
      }
      if (!row) continue;
      db.exec('begin');
      try {
        if (q.claim.run(txid, row.id).changes !== 1) throw new Error('already paid');
        const paid = (profiles && profiles.markPaid(row.profile_id, txid, row.account))
          || (boosts && boosts.markPaid(row.profile_id, txid, row.account));
        if (!paid) throw new Error('nothing was waiting');
        db.exec('commit');
        n++;
      } catch { db.exec('rollback'); }
    }
    return n;
  }

  async function rpcCall(url, method, params) {
    const r = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body.error) throw new Error(body.error?.message || `usdc rpc ${r.status}`);
    return body.result;
  }

  async function evmTransfers(cfg) {
    const head = Number(BigInt(await rpcCall(cfg.rpc, 'eth_blockNumber', [])));
    const to = head - cfg.confirmations;
    if (to < 0) return [];
    const look = Number(process.env.USDC_LOOKBACK ?? 2000);
    const span = Number.isFinite(look) && look > 0 ? Math.min(look, 50_000) : 2000;
    const from = Math.max(0, to - span);
    const topic = '0x' + cfg.address.slice(2).toLowerCase().padStart(64, '0');
    const logs = await rpcCall(cfg.rpc, 'eth_getLogs', [{
      address: cfg.mint,
      fromBlock: '0x' + from.toString(16),
      toBlock: '0x' + to.toString(16),
      topics: [TRANSFER, null, topic],
    }]);
    return (Array.isArray(logs) ? logs : []).map((log) => ({
      tx: log.transactionHash,
      amount: log.data ? BigInt(log.data).toString() : '',
    }));
  }

  async function solanaTransfers(cfg) {
    const sigs = await rpcCall(cfg.rpc, 'getSignaturesForAddress', [cfg.address, { limit: 20, commitment: 'finalized' }]);
    const out = [];
    for (const s of Array.isArray(sigs) ? sigs : []) {
      if (!s?.signature || s.err) continue;
      const tx = await rpcCall(cfg.rpc, 'getTransaction', [s.signature, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
      out.push(...solanaCredits(tx, cfg));
    }
    return out;
  }

  async function poll() {
    if (!profiles && !boosts) return 0;
    let n = 0;
    for (const cfg of enabled()) {
      if (!cfg.rpc) continue;
      try {
        const transfers = cfg.kind === 'solana' ? await solanaTransfers(cfg) : await evmTransfers(cfg);
        n += settle(cfg.id, transfers);
      } catch (e) { console.error(`usdc ${cfg.id}: ${e.message}`); }
    }
    return n;
  }

  return { quote, view, settle, poll, chains: publicChains, priceUsdc };
}

usdc.solanaCredits = solanaCredits;
usdc.priceUsdc = priceUsdc;
usdc.mints = Object.fromEntries(CHAINS.map((c) => [c.id, c.mint]));
module.exports = usdc;
