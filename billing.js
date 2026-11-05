// Accounts and prepaid credits. An account *is* its API key: no email, no password.
// Only the key's SHA-256 is stored, so a leaked database cannot be used to log in.
// Credits are bought with NOID only: an exact amount on the site address, matched on chain. No cards, no Stripe anywhere.
const { createHash, randomBytes, randomInt } = require('node:crypto');

// API plans are priced directly in NOID, so quoting a plan never depends on the USD price feed: payments keep
// working while the feed is down. Credits never expire and there is no subscription.
const PLANS = [
  { id: 'starter', label: 'Starter', noid: 5, credits: 1000 },
  { id: 'pro', label: 'Pro', noid: 10, credits: 3000 },
  { id: 'scale', label: 'Scale', noid: 20, credits: 8000 },
];
const PLAN_BY_ID = new Map(PLANS.map((p) => [p.id, p]));
const planMicronoid = (noid) => Math.round(noid * 1e6); // μNOID owed for a plan, before the unique dust digits
const REQUESTS_PER_CREDIT = 1000; // keyed API requests

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const today = () => new Date().toISOString().slice(0, 10);
const hashKey = (key) => createHash('sha256').update(key).digest('hex');

// A NOID payment is credited only once the tip is this many blocks above the tip when it was first seen (which is
// at or above its inclusion block). Consensus allows replacing up to 18 blocks (CONSENSUS_FINALITY_DEPTH in Parano1d
// Core, noid_chain/src/consensus/params.rs; the docs' "17" is out of date), so tip >= inclusion + 18 is final.
const CONFIRMATIONS = Number(process.env.NOID_CONFIRMATIONS ?? 18);
const QUOTE_MS = 24 * 3600_000; // a quote is valid this long
const HOLD_MS = 7 * 86400_000; // after expiry its last digits stay reserved this long, so a late payment can't match a newer order
const PRICE_MAX_AGE_MS = Number(process.env.PRICE_MAX_AGE_MS || 15 * 60_000);

// livePrice() -> { usd, at } (at = when the price was fetched) or null; tipNow() -> current chain height.
module.exports = function billing(db, rpc, livePrice = () => null, tipNow = () => null, profiles = null, boosts = null) {
  const usdcPay = require('./usdc.js')(db, profiles, boosts);
  // USD_PER_NOID pins the price. Otherwise new quotes use the live market price, and pause when it is older than
  // PRICE_MAX_AGE_MS. Orders already quoted keep their price and are still settled while the feed is down.
  const priceNow = () => {
    if (Number(process.env.USD_PER_NOID) > 0) return { usd: Number(process.env.USD_PER_NOID), live: false };
    const p = livePrice();
    if (!(p?.usd > 0)) return { paused: 'the NOID price feed is unavailable' };
    if (!(Date.now() - p.at <= PRICE_MAX_AGE_MS)) return { paused: 'the NOID price feed is out of date' };
    return { usd: p.usd, live: true, at: p.at };
  };
  const noid = () => {
    const p = priceNow();
    return process.env.PAY_ADDRESS && p.usd ? { address: process.env.PAY_ADDRESS, usdPerNoid: p.usd, live: p.live } : null;
  };
  db.exec(`
    create table if not exists accounts (id text primary key, key_hash text unique not null, credits integer not null default 0, requests integer not null default 0, created integer not null, wallet text);
    create table if not exists ledger (id integer primary key, account text not null, delta integer not null, reason text not null, ref text unique, at integer not null);
    create index if not exists ledger_account on ledger(account, at);
    create table if not exists usage (account text not null, day text not null, requests integer not null default 0, chats integer not null default 0, primary key (account, day));
    create table if not exists noid_topups (id text primary key, account text not null, amount integer not null, credits integer not null, created integer not null, paid_ref text unique);
    create table if not exists token_stars (account text not null, token_id text not null, created integer not null, primary key (account, token_id));
    create index if not exists token_stars_acct on token_stars(account, created desc, token_id);
  `);
  // The last 4 digits (μNOID "dust") identify an order, so a buyer may send more than quoted and still match;
  // extra is credited at the same rate. Dust is unique among open orders.
  try { db.exec('alter table noid_topups add column dust integer'); } catch {}
  // The o1… address a browser wallet derives is the account's public identity. Only the address is stored, never a
  // seed or a secret: it is public chain data, and a key can be linked to at most one address at a time.
  try { db.exec('alter table accounts add column wallet text'); } catch {}
  // API time bought with a NOID contract: while this is in the future the account is a paid account,
  // so requests do not draw down prepaid credits and the higher rate limit applies.
  try { db.exec('alter table accounts add column api_until integer'); } catch {}
  db.exec('update noid_topups set dust = amount % 10000 where dust is null');
  try { db.exec('drop index if exists noid_topups_open; create unique index if not exists noid_topups_dust on noid_topups(dust) where paid_ref is null'); } catch {}
  // Expired orders are kept as records (expired_at). Their dust is cleared HOLD_MS later so the digits can be reused;
  // amount keeps the full quote. height = chain tip when quoted.
  for (const col of ['expired_at integer', 'height integer', 'purpose text', 'subject text', 'plan text']) try { db.exec(`alter table noid_topups add column ${col}`); } catch {}
  // Every output ever seen on PAY_ADDRESS, with when and at which tip it first appeared. An output can only pay an
  // order quoted before it appeared, and only once it has CONFIRMATIONS blocks on top. On a fresh table, outputs
  // already sitting on the address are recorded as 'baseline' and never pay anything.
  const freshSeen = !db.prepare("select 1 from sqlite_master where name = 'noid_seen'").get();
  db.exec(`create table if not exists noid_seen (ref text primary key, value integer not null, first_seen integer not null, height integer not null,
    status text not null, topup text)`);
  let baseline = freshSeen;
  const q = {
    insertAccount: db.prepare('insert into accounts (id, key_hash, created) values (?, ?, ?)'),
    byKey: db.prepare('select id, credits, requests, created, wallet, api_until from accounts where key_hash = ?'),
    byId: db.prepare('select id, credits, requests, created, wallet, api_until from accounts where id = ?'),
    setWallet: db.prepare('update accounts set wallet = ? where id = ?'),
    byWallet: db.prepare('select id, credits, requests, created, wallet, api_until from accounts where wallet = ? limit 1'),
    addTime: db.prepare('update accounts set api_until = ? where id = ?'),
    addCredits: db.prepare('update accounts set credits = credits + ? where id = ?'),
    takeCredits: db.prepare('update accounts set credits = credits - ? where id = ? and credits >= ?'),
    ledger: db.prepare('insert into ledger (account, delta, reason, ref, at) values (?, ?, ?, ?, ?)'),
    history: db.prepare('select delta, reason, at from ledger where account = ? order by at desc, id desc limit 50'),
    countReq: db.prepare('update accounts set requests = requests + 1 where id = ? returning requests'),
    useDay: db.prepare(`insert into usage (account, day, requests, chats) values (?, ?, ?, ?)
      on conflict (account, day) do update set requests = requests + excluded.requests, chats = chats + excluded.chats`),
    usage: db.prepare('select day, requests from usage where account = ? order by day desc limit 30'),
    newTopup: db.prepare('insert into noid_topups (id, account, amount, credits, created, dust) values (?, ?, ?, ?, ?, ? % 10000)'),
    topup: db.prepare('select id, account, amount, credits, created, paid_ref, expired_at, plan from noid_topups where id = ?'),
    paidAt: db.prepare('select at from ledger where ref = ?'),
    openTopups: db.prepare('select count(*) n from noid_topups where paid_ref is null and dust is not null'),
    expireTopups: db.prepare('update noid_topups set expired_at = ? where paid_ref is null and expired_at is null and created < ?'),
    releaseDust: db.prepare('update noid_topups set dust = null where paid_ref is null and expired_at < ?'),
    byDust: db.prepare('select id, account, amount, credits, created, expired_at, purpose, subject from noid_topups where dust = ? and paid_ref is null'),
    claimTopup: db.prepare('update noid_topups set paid_ref = ? where id = ? and paid_ref is null'),
    seen: db.prepare('select ref, value, first_seen, height, status, topup from noid_seen where ref = ?'),
    addSeen: db.prepare('insert into noid_seen (ref, value, first_seen, height, status) values (?, ?, ?, ?, ?)'),
    setSeen: db.prepare('update noid_seen set status = ?, topup = ? where ref = ?'),
    seenFor: db.prepare("select height from noid_seen where topup = ? and status = 'confirming'"),
    starList: db.prepare('select token_id from token_stars where account = ? order by created desc, token_id'),
    starAdd: db.prepare('insert into token_stars (account, token_id, created) values (?, ?, ?) on conflict (account, token_id) do nothing'),
    starDel: db.prepare('delete from token_stars where account = ? and token_id = ?'),
    starCount: db.prepare('select count(*) n from token_stars where account = ?'),
  };

  const tx = (fn) => { db.exec('begin'); try { const r = fn(); db.exec('commit'); return r; } catch (e) { db.exec('rollback'); throw e; } };
  // Ledger entry + balance change; call inside tx(). The ledger is append-only: corrections are new entries.
  function post(account, delta, reason, ref) {
    q.ledger.run(account, delta, reason, ref, Date.now());
    if (q.addCredits.run(delta, account).changes !== 1) throw new Error(`no account ${account}`);
  }
  // `ref` is unique, so replaying the same payment (webhook retry, second indexer pass) is a no-op.
  function credit(account, delta, reason, ref = null) {
    try {
      return tx(() => { post(account, delta, reason, ref); return true; });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return false;
      throw e;
    }
  }
  function spend(account, n, reason) {
    return tx(() => {
      if (q.takeCredits.run(n, account, n).changes !== 1) return false;
      q.ledger.run(account, -n, reason, null, Date.now());
      return true;
    });
  }

  const account = (key) => (typeof key === 'string' && /^nk_[0-9a-f]{40}$/.test(key) ? q.byKey.get(hashKey(key)) : undefined);

  // Called for every keyed data request: 1 credit per REQUESTS_PER_CREDIT. An account with bought
  // API time is paid until that moment, so its requests are counted but they do not draw credits down.
  function countRequest(acct) {
    const { requests } = q.countReq.get(acct.id);
    q.useDay.run(acct.id, today(), 1, 0);
    if (paid(acct)) return;
    if (requests % REQUESTS_PER_CREDIT === 0) spend(acct.id, 1, `API usage (${REQUESTS_PER_CREDIT.toLocaleString()} requests)`);
  }
  // Paid means either prepaid credits or API time bought through a NOID contract.
  function paid(acct) {
    if (!acct) return false;
    if (Number(acct.credits) > 0) return true;
    const row = q.byId.get(acct.id);
    return !!(row && row.api_until > Date.now());
  }
  // API time is granted from the chain, not from a webhook: `ref` is the contract order id, so a
  // second pass over the same paid contract is a no-op.
  function grantTime(account, secs, ref) {
    const row = q.byId.get(account);
    if (!row) return false;
    const days = Math.round(secs / 86400);
    try {
      tx(() => {
        const from = Math.max(Date.now(), Number(row.api_until) || 0);
        q.ledger.run(account, 0, `API time bought with NOID (${days} day${days === 1 ? '' : 's'})`, ref, Date.now());
        q.addTime.run(from + secs * 1000, account);
      });
      return true;
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return false; // already granted for this contract
      throw e;
    }
  }

  // NOID has no payment memo, so an output on PAY_ADDRESS pays the order whose last 4 digits ("dust") match, if:
  //  - the order was quoted before the output first appeared (an older output can never pay a newer order),
  //  - the output has CONFIRMATIONS blocks on top and is still on the address (a reorged-out payment never credits),
  //  - the order is unpaid. Late payments (after the 24 h quote, within the 7-day hold) go to the same order's account.
  // Credits scale with the amount received at the quoted rate (send more, get more), never below 1.
  // Claiming the order, the ledger entry and the balance change commit together or not at all.
  // shortcut: an unrelated payment of a random amount has a 1-in-10,000 chance per open order of matching.
  async function settleNoid(tip) {
    if (!process.env.PAY_ADDRESS) return;
    const now = Date.now();
    q.expireTopups.run(now, now - QUOTE_MS);
    q.releaseDust.run(now - HOLD_MS);
    for (const slot of await rpc('getSlotsByOwner', [process.env.PAY_ADDRESS])) {
      const value = Number(slot.value);
      const ref = `noid:${slot.creation_id}`;
      let s = q.seen.get(ref);
      if (!s) {
        q.addSeen.run(ref, value, now, tip, baseline ? 'baseline' : 'new');
        s = q.seen.get(ref);
      }
      if (!['new', 'confirming'].includes(s.status)) continue;
      const t = q.byDust.get(value % 10000);
      if (!t || t.created > s.first_seen) continue;
      if (tip - s.height < CONFIRMATIONS) { q.setSeen.run('confirming', t.id, ref); continue; }
      if (t.purpose === 'profile' || t.purpose === 'boost') {
        try {
          tx(() => {
            if (q.claimTopup.run(ref, t.id).changes !== 1) throw new Error('order already paid');
            if (!orderMarkPaid(t.purpose, t.subject, ref, t.account)) throw new Error(`${t.purpose} was not waiting for payment`);
            q.setSeen.run('credited', t.id, ref);
          });
        } catch (e) {
          q.setSeen.run('review', t.id, ref);
          console.error(`noid payment ${ref} for order ${t.id} needs review: ${e.message}`);
        }
        continue;
      }
      const late = t.expired_at != null && s.first_seen > t.expired_at;
      const credits = Math.max(1, Math.round((t.credits * value) / t.amount));
      try {
        tx(() => {
          if (q.claimTopup.run(ref, t.id).changes !== 1) throw new Error('order already paid');
          post(t.account, credits, `NOID top-up (${(value / 1e6).toFixed(6)} NOID)${late ? ', paid after the quote expired' : ''}`, ref);
          q.setSeen.run('credited', t.id, ref);
        });
      } catch (e) {
        // Nothing was written. Flag it for a manual look instead of retrying forever.
        q.setSeen.run('review', t.id, ref);
        console.error(`noid payment ${ref} for order ${t.id} needs review: ${e.message}`);
      }
    }
    baseline = false;
  }

  const orderMarkPaid = (purpose, subject, ref, account) => (purpose === 'boost' ? boosts?.markPaid(subject, ref, account) : profiles?.markPaid(subject, ref, account));



  // NOID quote for a Promote order: a unique amount (last 4 digits) on PAY_ADDRESS, settled by the chain watcher
  // or at once by a pasted payment receipt (POST order-receipt).
  function noidOrder(acct, usd, purpose, subject) {
    const NOID = noid();
    if (!NOID) throw bad(process.env.PAY_ADDRESS ? `NOID payments are paused: ${priceNow().paused}. Try again in a few minutes.` : 'NOID payments are not enabled right now', 503);
    if (q.openTopups.get().n >= 1000) throw bad('too many open payments, try again later', 503);
    const base = Math.round((usd / NOID.usdPerNoid) * 1e6);
    for (let i = 0; i < 5; i++) {
      const id = randomBytes(6).toString('hex');
      const amount = base + randomInt(1, 10_000);
      try {
        db.prepare('insert into noid_topups (id, account, amount, credits, created, dust, purpose, subject) values (?, ?, ?, 0, ?, ? % 10000, ?, ?)').run(id, acct.id, amount, Date.now(), amount, purpose, subject);
      } catch { continue; }
      db.prepare('update noid_topups set height = ? where id = ?').run(tipNow(), id);
      return { ...routes['GET topup'](acct, null, id), [`${purpose}_id`]: subject, usd, kind: purpose, method: 'noid' };
    }
    throw bad('could not allocate a payment amount, try again', 503);
  }

  // A pasted payment receipt (paranoid_verifyReceipt) settles a NOID order without waiting for the watcher.
  // The receipt must be valid on the canonical chain, CONFIRMATIONS deep, and pay PAY_ADDRESS at least the quote.
  // The receipt's txid becomes the order's paid_ref (unique), so one payment can never pay two orders.
  async function orderReceipt(acct, body) {
    if (!acct) throw bad('missing or unknown API key', 401);
    const t = q.topup.get(String(body?.order || ''));
    const meta = t && db.prepare('select purpose, subject from noid_topups where id = ?').get(t.id);
    if (!t || t.account !== acct.id || !['profile', 'boost'].includes(meta?.purpose)) return null;
    if (t.paid_ref) return { status: 'paid', order: t.id, kind: meta.purpose };
    const hex = typeof body?.receipt === 'string' ? body.receipt.replace(/\s+/g, '') : '';
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 || hex.length > 262144) throw bad('paste the payment receipt as hex');
    const r = await rpc('verifyReceipt', [hex], 20_000);
    const sum = r?.authenticated_summary;
    if (!r || !r.merkle_valid || !r.canonical || !r.confirmed || !sum?.txid) throw bad(`receipt did not verify${r?.error ? `: ${r.error}` : ''}`);
    const paid = (sum.outputs || []).filter((o) => o.owner === process.env.PAY_ADDRESS).reduce((a, o) => a + Number(o.amount_micronoid || 0), 0);
    if (paid < t.amount) throw bad(`receipt pays ${(paid / 1e6).toFixed(6)} NOID to the site address; the order needs ${(t.amount / 1e6).toFixed(6)}`);
    const tip = tipNow();
    const h = Number(sum.claimed_height);
    if (!Number.isFinite(h) || tip == null || tip - h < CONFIRMATIONS) {
      return { status: 'confirming', order: t.id, confirmations: { have: Math.max(0, (tip ?? h) - h), need: CONFIRMATIONS } };
    }
    const ref = `noid:rcpt:${sum.txid}`;
    try {
      tx(() => {
        if (q.claimTopup.run(ref, t.id).changes !== 1) throw new Error('order already paid');
        if (!orderMarkPaid(meta.purpose, meta.subject, ref, t.account)) throw new Error(`${meta.purpose} was not waiting for payment`);
      });
    } catch (e) {
      throw bad(String(e.message).includes('UNIQUE') ? 'that receipt already paid another order' : e.message, 409);
    }
    return { status: 'paid', order: t.id, kind: meta.purpose, txid: sum.txid, note: 'Paid. It stays hidden until an admin approves it.' };
  }

  const pricing = () => {
    const px = priceNow();
    const usd = px.usd || null;
    return {
      payment: 'noid',
      plans: PLANS.map((p) => ({ id: p.id, label: p.label, noid: p.noid, micronoid: planMicronoid(p.noid), credits: p.credits, requests: p.credits * REQUESTS_PER_CREDIT, usd_at_market: usd ? +(p.noid * usd).toFixed(2) : null })),
      requests_per_credit: REQUESTS_PER_CREDIT,
      enhanced_profile_usd: profiles ? profiles.priceUsd() : 100, enhanced_profile_usdc: profiles ? profiles.priceUsdc() : 100, usdc_chains: usdcPay.chains(), support: process.env.SUPPORT_EMAIL || null,
      noid: process.env.PAY_ADDRESS ? { address: process.env.PAY_ADDRESS, usd_per_noid: usd ? +usd.toFixed(6) : null, live: !!px.live, confirmations: CONFIRMATIONS } : null,
      noid_paused: process.env.PAY_ADDRESS && !noid() ? priceNow().paused : null,
    };
  };

  // shortcut: in-memory, per process; enough to stop casual account spam.
  const signups = new Map();
  setInterval(() => signups.clear(), 3600_000).unref();

  // Routes that need a body or an account. Each gets (acct, body, id, ip).
  const routes = {
    'POST account': (_, __, ___, ip) => {
      const n = (signups.get(ip) || 0) + 1;
      signups.set(ip, n);
      if (n > 5) throw bad('too many new accounts from your network, try again in an hour', 429);
      const key = `nk_${randomBytes(20).toString('hex')}`;
      const id = randomBytes(8).toString('hex');
      q.insertAccount.run(id, hashKey(key), Date.now());
      return { key, id, note: 'Save this key now. It is your login and is shown only once.' };
    },
    'GET stars': (acct) => {
      if (!acct) throw bad('missing or unknown API key', 401);
      return { ids: q.starList.all(acct.id).map((r) => r.token_id) };
    },
    'POST stars': (acct, body) => {
      if (!acct) throw bad('missing or unknown API key', 401);
      const okId = (id) => typeof id === 'string' && /^[A-Za-z0-9:_-]{1,80}$/.test(id);
      const add = (id) => { if (q.starCount.get(acct.id).n >= 200) return; q.starAdd.run(acct.id, id, Date.now()); };
      if (Array.isArray(body?.ids)) {
        for (const id of [...new Set(body.ids.filter(okId))].slice(0, 200)) add(id);
      } else {
        if (!okId(body?.id)) throw bad('expected a token id');
        if (body.on === false) q.starDel.run(acct.id, body.id);
        else add(body.id);
      }
      return { ids: q.starList.all(acct.id).map((r) => r.token_id) };
    },
    'GET me': (acct) => {
      if (!acct) throw bad('missing or unknown API key', 401);
      const time = Number(q.byId.get(acct.id)?.api_until) || 0;
      return { ...acct, tier: acct.credits > 0 || time > Date.now() ? 'paid' : 'free', api_until: time || null, rate_limit_per_min: paid(acct) ? Number(process.env.PAID_RATE_LIMIT || 3000) : Number(process.env.RATE_LIMIT || 120), usage: q.usage.all(acct.id), history: q.history.all(acct.id), pricing: pricing() };
    },
    'GET pricing': () => pricing(),
    // Wallet-as-account: the browser wallet's o1… address is the public half of the login. Linking stores the address
    // on the account so the account page, the watchlist and (later) trade relay belong to the wallet the visitor holds,
    // not to a throwaway key. No seed, no secret, no signature is ever sent here; possession is proven by the wallet
    // itself, and an address can only sit on one account.
    'POST link': (acct, body) => {
      if (!acct) throw bad('missing or unknown API key', 401);
      const address = String(body?.address || '').trim();
      if (!/^o1[02-9ac-hj-np-z]{6,120}$/.test(address)) throw bad('expected your o1… wallet address');
      const other = q.byWallet.get(address);
      if (other && other.id !== acct.id) throw bad('that wallet is already linked to another account', 409);
      q.setWallet.run(address, acct.id);
      return { wallet: address, note: 'Linked. This address is public; the seed behind it never leaves your browser.' };
    },
    'POST unlink': (acct) => {
      if (!acct) throw bad('missing or unknown API key', 401);
      q.setWallet.run(null, acct.id);
      return { wallet: null };
    },
    'POST profile-pay': async (acct, body) => {
      if (!acct) throw bad('missing or unknown API key', 401);
      const row = profiles?.ownedUnpaid(acct.id, body?.id);
      if (!row) return null;
      const usd = profiles.priceUsd();
      if (body.method === 'usdc') return usdcPay.quote(acct, row.id, null, body.chain);
      if (body.method !== 'noid') throw bad('method must be noid or usdc');
      return noidOrder(acct, usd, 'profile', row.id);
    },
    'POST boost': (acct, body) => {
      if (!acct) throw bad('missing or unknown API key', 401);
      if (!boosts) throw bad('promoted slots are off', 503);
      return boosts.create(acct, body);
    },
    'POST boost-pay': (acct, body) => {
      if (!acct) throw bad('missing or unknown API key', 401);
      const row = boosts?.ownedUnpaid(acct.id, body?.id);
      if (!row) return null;
      if (body?.method === 'noid') return noidOrder(acct, row.usdc, 'boost', row.id);
      if (body?.method && body.method !== 'usdc') throw bad('method must be noid or usdc');
      return usdcPay.quote(acct, row.id, row.usdc, body.chain);
    },
    'POST order-receipt': (acct, body) => orderReceipt(acct, body),
    'GET boost': (acct, _, id) => boosts ? boosts.view(acct, id) : null,
    'GET profile': (acct, _, id) => profiles ? profiles.view(acct, id) : null,
    'GET usdc-order': (acct, _, id) => usdcPay.view(acct, id),
    'POST topup': async (acct, body) => {
      if (!acct) throw bad('missing or unknown API key', 401);
      const plan = PLAN_BY_ID.get(String(body?.plan || ''));
      if (!plan) throw bad(`plan must be one of ${PLANS.map((p) => p.id).join(', ')}`);
      if (!process.env.PAY_ADDRESS) throw bad('NOID payments are not enabled right now', 503);
      if (q.openTopups.get().n >= 1000) throw bad('too many open payments, try again later', 503);
      const base = planMicronoid(plan.noid);
      for (let i = 0; i < 5; i++) {
        const id = randomBytes(6).toString('hex');
        const amount = base + randomInt(1, 10_000); // the last digits identify this order
        try { q.newTopup.run(id, acct.id, amount, plan.credits, Date.now(), amount); } catch { continue; } // dust taken by another open or held quote
        db.prepare('update noid_topups set height = ?, plan = ? where id = ?').run(tipNow(), plan.id, id);
        return routes['GET topup'](acct, null, id);
      }
      throw bad('could not allocate a payment amount, try again', 503);
    },
    'GET topup': (acct, _, id) => {
      const t = q.topup.get(id);
      if (!t || !acct || t.account !== acct.id) return null;
      const seen = !t.paid_ref && q.seenFor.get(t.id);
      const plan = PLAN_BY_ID.get(t.plan || '') || null;
      const usd = priceNow().usd;
      return {
        status: t.paid_ref ? 'paid' : seen ? 'confirming' : t.expired_at ? 'expired' : 'waiting',
        confirmations: seen ? { have: Math.max(0, tipNow() - seen.height), need: CONFIRMATIONS } : null,
        id: t.id, address: process.env.PAY_ADDRESS, amount_noid: (t.amount / 1e6).toFixed(6), credits: t.credits,
        plan: plan ? { id: plan.id, label: plan.label, noid: plan.noid } : null,
        requests: t.credits * REQUESTS_PER_CREDIT,
        usd_at_market: usd ? +((t.amount / 1e6) * usd).toFixed(2) : null, rate_usd_per_noid: usd ? +usd.toFixed(6) : null,
        created: t.created, expires: t.created + QUOTE_MS,
        paid: !!t.paid_ref, paid_at: t.paid_ref ? q.paidAt.get(t.paid_ref)?.at ?? null : null, paid_ref: t.paid_ref?.replace(/^noid:/, '') ?? null,
        credits_added: t.paid_ref ? db.prepare('select delta from ledger where ref = ?').get(t.paid_ref)?.delta ?? null : null,
        balance: q.byId.get(t.account)?.credits ?? null,
      };
    },
  };

  return { account, countRequest, paid, grantTime, settleNoid, routes, pricing, pollUsdc: () => usdcPay.poll(), usdcChains: () => usdcPay.chains() };
};
