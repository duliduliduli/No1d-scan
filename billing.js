// Accounts and prepaid credits. An account *is* its API key: no email, no password.
// Only the key's SHA-256 is stored, so a leaked database cannot be used to log in.
// Credits come in by card (Stripe Checkout + signed webhook) or NOID (exact-amount match on chain).
const { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } = require('node:crypto');

const CREDITS_PER_USD = 1000;
const PACKS_USD = [5, 20, 100];
const CHAT_COST = Number(process.env.CHAT_COST || 5); // credits per chatbot question
const REQUESTS_PER_CREDIT = 1000; // keyed API requests
const FREE_CHATS_PER_DAY = Number(process.env.FREE_CHATS_PER_DAY || 3);

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const today = () => new Date().toISOString().slice(0, 10);
const hashKey = (key) => createHash('sha256').update(key).digest('hex');

// A NOID payment is credited only after this many blocks on top of the one it was first seen in.
// Parano1d never reorganizes deeper than 17 blocks, so 17 confirmations is final.
const CONFIRMATIONS = Number(process.env.NOID_CONFIRMATIONS ?? 17);
const QUOTE_MS = 24 * 3600_000; // a quote is valid this long
const HOLD_MS = 7 * 86400_000; // after expiry its last digits stay reserved this long, so a late payment can't match a newer order
const PRICE_MAX_AGE_MS = Number(process.env.PRICE_MAX_AGE_MS || 15 * 60_000);

// livePrice() -> { usd, at } (at = when the price was fetched) or null; tipNow() -> current chain height.
module.exports = function billing(db, rpc, livePrice = () => null, tipNow = () => null) {
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
  const STRIPE = process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET && { key: process.env.STRIPE_SECRET_KEY, whsec: process.env.STRIPE_WEBHOOK_SECRET };
  const SITE = process.env.SITE_URL || 'https://parano1d-scan.com';
  // Card buttons appear only once Stripe reports card payments active for this account; checked every 10 minutes.
  let cardActive = false;
  async function checkStripe() {
    if (!STRIPE) return;
    const r = await fetch('https://api.stripe.com/v1/account', { headers: { authorization: `Bearer ${STRIPE.key}` }, signal: AbortSignal.timeout(15_000) });
    const a = await r.json();
    cardActive = r.ok && a.capabilities?.card_payments === 'active';
    if (r.ok && !cardActive) console.log(`stripe: card payments ${a.capabilities?.card_payments || 'not enabled'}; card buttons hidden`);
  }
  if (STRIPE && process.env.NODE_ENV !== 'test') { const run = () => checkStripe().catch((e) => console.error('stripe:', e.message)); run(); setInterval(run, 600_000).unref(); }

  db.exec(`
    create table if not exists accounts (id text primary key, key_hash text unique not null, credits integer not null default 0, requests integer not null default 0, created integer not null);
    create table if not exists ledger (id integer primary key, account text not null, delta integer not null, reason text not null, ref text unique, at integer not null);
    create index if not exists ledger_account on ledger(account, at);
    create table if not exists usage (account text not null, day text not null, requests integer not null default 0, chats integer not null default 0, primary key (account, day));
    create table if not exists noid_topups (id text primary key, account text not null, amount integer not null, credits integer not null, created integer not null, paid_ref text unique);
    create table if not exists free_chat (who text not null, day text not null, n integer not null, primary key (who, day));
  `);
  // The last 4 digits (μNOID "dust") identify an order, so a buyer may send more than quoted and still match;
  // extra is credited at the same rate. Dust is unique among open orders.
  try { db.exec('alter table noid_topups add column dust integer'); } catch {}
  db.exec('update noid_topups set dust = amount % 10000 where dust is null');
  try { db.exec('drop index if exists noid_topups_open; create unique index if not exists noid_topups_dust on noid_topups(dust) where paid_ref is null'); } catch {}
  // Expired orders are kept as records (expired_at). Their dust is cleared HOLD_MS later so the digits can be reused;
  // amount keeps the full quote. height = chain tip when quoted.
  for (const col of ['expired_at integer', 'height integer']) try { db.exec(`alter table noid_topups add column ${col}`); } catch {}
  // Every output ever seen on PAY_ADDRESS, with when and at which tip it first appeared. An output can only pay an
  // order quoted before it appeared, and only once it has CONFIRMATIONS blocks on top. On a fresh table, outputs
  // already sitting on the address are recorded as 'baseline' and never pay anything.
  const freshSeen = !db.prepare("select 1 from sqlite_master where name = 'noid_seen'").get();
  db.exec(`create table if not exists noid_seen (ref text primary key, value integer not null, first_seen integer not null, height integer not null,
    status text not null, topup text)`);
  let baseline = freshSeen;
  const q = {
    insertAccount: db.prepare('insert into accounts (id, key_hash, created) values (?, ?, ?)'),
    byKey: db.prepare('select id, credits, requests, created from accounts where key_hash = ?'),
    byId: db.prepare('select id, credits, requests, created from accounts where id = ?'),
    addCredits: db.prepare('update accounts set credits = credits + ? where id = ?'),
    takeCredits: db.prepare('update accounts set credits = credits - ? where id = ? and credits >= ?'),
    ledger: db.prepare('insert into ledger (account, delta, reason, ref, at) values (?, ?, ?, ?, ?)'),
    history: db.prepare('select delta, reason, at from ledger where account = ? order by at desc, id desc limit 50'),
    countReq: db.prepare('update accounts set requests = requests + 1 where id = ? returning requests'),
    useDay: db.prepare(`insert into usage (account, day, requests, chats) values (?, ?, ?, ?)
      on conflict (account, day) do update set requests = requests + excluded.requests, chats = chats + excluded.chats`),
    usage: db.prepare('select day, requests, chats from usage where account = ? order by day desc limit 30'),
    newTopup: db.prepare('insert into noid_topups (id, account, amount, credits, created, dust) values (?, ?, ?, ?, ?, ? % 10000)'),
    topup: db.prepare('select id, account, amount, credits, created, paid_ref, expired_at from noid_topups where id = ?'),
    paidAt: db.prepare('select at from ledger where ref = ?'),
    openTopups: db.prepare('select count(*) n from noid_topups where paid_ref is null and dust is not null'),
    expireTopups: db.prepare('update noid_topups set expired_at = ? where paid_ref is null and expired_at is null and created < ?'),
    releaseDust: db.prepare('update noid_topups set dust = null where paid_ref is null and expired_at < ?'),
    byDust: db.prepare('select id, account, amount, credits, created, expired_at from noid_topups where dust = ? and paid_ref is null'),
    claimTopup: db.prepare('update noid_topups set paid_ref = ? where id = ? and paid_ref is null'),
    seen: db.prepare('select ref, value, first_seen, height, status, topup from noid_seen where ref = ?'),
    addSeen: db.prepare('insert into noid_seen (ref, value, first_seen, height, status) values (?, ?, ?, ?, ?)'),
    setSeen: db.prepare('update noid_seen set status = ?, topup = ? where ref = ?'),
    seenFor: db.prepare("select height from noid_seen where topup = ? and status = 'confirming'"),
    freeUsed: db.prepare('select n from free_chat where who = ? and day = ?'),
    freeUse: db.prepare('insert into free_chat (who, day, n) values (?, ?, 1) on conflict (who, day) do update set n = n + 1'),
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

  // Called for every keyed data request: 1 credit per REQUESTS_PER_CREDIT.
  function countRequest(acct) {
    const { requests } = q.countReq.get(acct.id);
    q.useDay.run(acct.id, today(), 1, 0);
    if (requests % REQUESTS_PER_CREDIT === 0) spend(acct.id, 1, `API usage (${REQUESTS_PER_CREDIT.toLocaleString()} requests)`);
  }

  // Chatbot: paid accounts spend CHAT_COST credits, everyone else gets FREE_CHATS_PER_DAY per IP.
  // Returns a refund function to call if the model request fails.
  function chargeChat(acct, ip) {
    if (acct && spend(acct.id, CHAT_COST, 'AI question')) {
      q.useDay.run(acct.id, today(), 0, 1);
      return { paid: true, refund: () => credit(acct.id, CHAT_COST, 'AI question refund (model error)') };
    }
    const used = q.freeUsed.get(ip, today())?.n ?? 0;
    if (used >= FREE_CHATS_PER_DAY) {
      throw bad(acct ? `Not enough credits (a question costs ${CHAT_COST}). Top up on the API & Credits page.` : `You've used your ${FREE_CHATS_PER_DAY} free questions today. Create an account and add credits to keep asking.`, 402);
    }
    q.freeUse.run(ip, today());
    return { paid: false, free_left: FREE_CHATS_PER_DAY - used - 1, refund: () => db.prepare('update free_chat set n = n - 1 where who = ? and day = ?').run(ip, today()) };
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

  async function stripeCheckout(acct, usd) {
    const credits = usd * CREDITS_PER_USD;
    const form = new URLSearchParams({
      mode: 'payment',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': String(usd * 100),
      'line_items[0][price_data][product_data][name]': `${credits.toLocaleString()} NOID Scan credits`,
      client_reference_id: acct.id,
      'metadata[credits]': String(credits),
      success_url: `${SITE}/account?paid=card`,
      cancel_url: `${SITE}/account`,
    });
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST', body: form, signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${STRIPE.key}`, 'content-type': 'application/x-www-form-urlencoded' },
    });
    const s = await r.json();
    if (!r.ok) throw bad(`card payment unavailable: ${s.error?.message || r.status}`, 502);
    return { url: s.url };
  }

  // Stripe signs every webhook: header `t=<unix>,v1=<hex hmac of "t.body">`. Never trust the browser redirect.
  function stripeWebhook(raw, sigHeader) {
    if (!STRIPE) throw bad('stripe not configured', 404);
    const parts = String(sigHeader || '').split(',').map((p) => p.split('='));
    const t = Number(parts.find(([k]) => k === 't')?.[1]);
    const want = createHmac('sha256', STRIPE.whsec).update(`${t}.${raw}`).digest();
    // Stripe may send several v1 signatures while a secret is being rotated; any valid one is enough.
    const ok = Number.isFinite(t) && Math.abs(Date.now() / 1000 - t) <= 300
      && parts.some(([k, v]) => k === 'v1' && Buffer.from(v || '', 'hex').length === want.length && timingSafeEqual(Buffer.from(v, 'hex'), want));
    if (!ok) throw bad('bad signature', 400);
    const evt = JSON.parse(raw);
    const s = evt.data?.object;
    // Credits come from what Stripe says was paid, never from anything the buyer could have touched.
    const credits = s?.currency === 'usd' ? Math.round((Number(s.amount_total) / 100) * CREDITS_PER_USD) : 0;
    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(evt.type) && s?.payment_status === 'paid' && credits > 0 && q.byId.get(s.client_reference_id)) {
      credit(s.client_reference_id, credits, `Card top-up ($${(s.amount_total / 100).toFixed(2)})`, `stripe:${s.id}`);
    }
    return { received: true };
  }

  const pricing = () => ({
    credits_per_usd: CREDITS_PER_USD, packs_usd: PACKS_USD, chat_cost: CHAT_COST, free_chats_per_day: FREE_CHATS_PER_DAY,
    requests_per_credit: REQUESTS_PER_CREDIT, support: process.env.SUPPORT_EMAIL || null,
    card: !!STRIPE && cardActive, noid: noid() && { address: noid().address, usd_per_noid: +noid().usdPerNoid.toFixed(6), live: noid().live, confirmations: CONFIRMATIONS },
    noid_paused: process.env.PAY_ADDRESS && !noid() ? priceNow().paused : null,
  });

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
    'GET me': (acct) => {
      if (!acct) throw bad('missing or unknown API key', 401);
      return { ...acct, tier: acct.credits > 0 ? 'paid' : 'free', rate_limit_per_min: acct.credits > 0 ? Number(process.env.PAID_RATE_LIMIT || 3000) : Number(process.env.RATE_LIMIT || 120), usage: q.usage.all(acct.id), history: q.history.all(acct.id), pricing: pricing() };
    },
    'GET pricing': () => pricing(),
    'POST topup': async (acct, body) => {
      if (!acct) throw bad('missing or unknown API key', 401);
      const usd = Number(body.usd);
      if (!PACKS_USD.includes(usd)) throw bad(`amount must be one of ${PACKS_USD.join(', ')} USD`);
      if (body.method === 'card') {
        if (!STRIPE || !cardActive) throw bad('Card payments are not available yet. Please pay with NOID.', 404);
        return stripeCheckout(acct, usd);
      }
      const NOID = noid();
      if (body.method !== 'noid') throw bad('method must be noid or card');
      if (!NOID) throw bad(process.env.PAY_ADDRESS ? `NOID payments are paused: ${priceNow().paused}. Try again in a few minutes.` : 'NOID payments are not enabled right now', 503);
      if (q.openTopups.get().n >= 1000) throw bad('too many open payments, try again later', 503);
      const base = Math.round((usd / NOID.usdPerNoid) * 1e6);
      for (let i = 0; i < 5; i++) {
        const id = randomBytes(6).toString('hex');
        const amount = base + randomInt(1, 10_000);
        try { q.newTopup.run(id, acct.id, amount, usd * CREDITS_PER_USD, Date.now(), amount); } catch { continue; } // dust taken by another open or held quote
        db.prepare('update noid_topups set height = ? where id = ?').run(tipNow(), id);
        return routes['GET topup'](acct, null, id);
      }
      throw bad('could not allocate a payment amount, try again', 503);
    },
    'GET topup': (acct, _, id) => {
      const t = q.topup.get(id);
      if (!t || !acct || t.account !== acct.id) return null;
      const usd = t.credits / CREDITS_PER_USD;
      const seen = !t.paid_ref && q.seenFor.get(t.id);
      return {
        status: t.paid_ref ? 'paid' : seen ? 'confirming' : t.expired_at ? 'expired' : 'waiting',
        confirmations: seen ? { have: Math.max(0, tipNow() - seen.height), need: CONFIRMATIONS } : null,
        id: t.id, address: noid()?.address ?? process.env.PAY_ADDRESS, amount_noid: (t.amount / 1e6).toFixed(6), credits: t.credits, usd,
        rate_usd_per_noid: +(usd / (t.amount / 1e6)).toFixed(6), created: t.created, expires: t.created + QUOTE_MS,
        paid: !!t.paid_ref, paid_at: t.paid_ref ? q.paidAt.get(t.paid_ref)?.at ?? null : null, paid_ref: t.paid_ref?.replace(/^noid:/, '') ?? null,
        credits_added: t.paid_ref ? db.prepare('select delta from ledger where ref = ?').get(t.paid_ref)?.delta ?? null : null,
        balance: q.byId.get(t.account)?.credits ?? null,
      };
    },
  };

  return { account, countRequest, chargeChat, settleNoid, stripeWebhook, routes, pricing };
};
