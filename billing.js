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

module.exports = function billing(db, rpc) {
  const NOID = process.env.PAY_ADDRESS && Number(process.env.USD_PER_NOID) > 0 && { address: process.env.PAY_ADDRESS, usdPerNoid: Number(process.env.USD_PER_NOID) };
  const STRIPE = process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET && { key: process.env.STRIPE_SECRET_KEY, whsec: process.env.STRIPE_WEBHOOK_SECRET };
  const SITE = process.env.SITE_URL || 'https://parano1d-scan.com';

  db.exec(`
    create table if not exists accounts (id text primary key, key_hash text unique not null, credits integer not null default 0, requests integer not null default 0, created integer not null);
    create table if not exists ledger (id integer primary key, account text not null, delta integer not null, reason text not null, ref text unique, at integer not null);
    create index if not exists ledger_account on ledger(account, at);
    create table if not exists usage (account text not null, day text not null, requests integer not null default 0, chats integer not null default 0, primary key (account, day));
    create table if not exists noid_topups (id text primary key, account text not null, amount integer not null, credits integer not null, created integer not null, paid_ref text unique);
    create unique index if not exists noid_topups_open on noid_topups(amount) where paid_ref is null;
    create table if not exists free_chat (who text not null, day text not null, n integer not null, primary key (who, day));
  `);
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
    newTopup: db.prepare('insert into noid_topups (id, account, amount, credits, created) values (?, ?, ?, ?, ?)'),
    topup: db.prepare('select id, account, amount, credits, created, paid_ref from noid_topups where id = ?'),
    openTopups: db.prepare('select count(*) n from noid_topups where paid_ref is null'),
    expireTopups: db.prepare('delete from noid_topups where paid_ref is null and created < ?'),
    openByAmount: db.prepare('select id, account, credits from noid_topups where amount = ? and paid_ref is null'),
    markTopup: db.prepare('update noid_topups set paid_ref = ? where id = ?'),
    freeUsed: db.prepare('select n from free_chat where who = ? and day = ?'),
    freeUse: db.prepare('insert into free_chat (who, day, n) values (?, ?, 1) on conflict (who, day) do update set n = n + 1'),
  };

  const tx = (fn) => { db.exec('begin'); try { const r = fn(); db.exec('commit'); return r; } catch (e) { db.exec('rollback'); throw e; } };
  // `ref` is unique, so replaying the same payment (webhook retry, second indexer pass) is a no-op.
  function credit(account, delta, reason, ref = null) {
    try {
      return tx(() => { q.ledger.run(account, delta, reason, ref, Date.now()); q.addCredits.run(delta, account); return true; });
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

  // shortcut: matches any slot on PAY_ADDRESS with the exact quoted amount; the micro-NOID "dust" makes accidental matches ~1 in 10,000 per open quote.
  async function settleNoid() {
    if (!NOID) return;
    q.expireTopups.run(Date.now() - 24 * 3600_000);
    for (const slot of await rpc('getSlotsByOwner', [NOID.address])) {
      const t = q.openByAmount.get(Number(slot.value));
      if (!t) continue;
      const ref = `noid:${slot.creation_id}`;
      // A slot already used for an earlier top-up must never pay a second one.
      try { q.markTopup.run(ref, t.id); } catch { continue; }
      credit(t.account, t.credits, `NOID top-up (${(Number(slot.value) / 1e6).toFixed(6)} NOID)`, ref);
    }
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
    const parts = Object.fromEntries(String(sigHeader || '').split(',').map((p) => p.split('=')));
    const want = createHmac('sha256', STRIPE.whsec).update(`${parts.t}.${raw}`).digest();
    const got = Buffer.from(parts.v1 || '', 'hex');
    if (got.length !== want.length || !timingSafeEqual(got, want) || Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) throw bad('bad signature', 400);
    const evt = JSON.parse(raw);
    const s = evt.data?.object;
    if (evt.type === 'checkout.session.completed' && s?.payment_status === 'paid' && q.byId.get(s.client_reference_id)) {
      credit(s.client_reference_id, Number(s.metadata?.credits), `Card top-up ($${(s.amount_total / 100).toFixed(2)})`, `stripe:${s.id}`);
    }
    return { received: true };
  }

  const pricing = () => ({
    credits_per_usd: CREDITS_PER_USD, packs_usd: PACKS_USD, chat_cost: CHAT_COST, free_chats_per_day: FREE_CHATS_PER_DAY,
    requests_per_credit: REQUESTS_PER_CREDIT,
    card: !!STRIPE, noid: NOID ? { address: NOID.address, usd_per_noid: NOID.usdPerNoid } : null,
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
      return { ...acct, usage: q.usage.all(acct.id), history: q.history.all(acct.id), pricing: pricing() };
    },
    'GET pricing': () => pricing(),
    'POST topup': async (acct, body) => {
      if (!acct) throw bad('missing or unknown API key', 401);
      const usd = Number(body.usd);
      if (!PACKS_USD.includes(usd)) throw bad(`amount must be one of ${PACKS_USD.join(', ')} USD`);
      if (body.method === 'card') {
        if (!STRIPE) throw bad('card payments are not enabled', 404);
        return stripeCheckout(acct, usd);
      }
      if (body.method !== 'noid' || !NOID) throw bad('NOID payments are not enabled', 404);
      if (q.openTopups.get().n >= 1000) throw bad('too many open payments, try again later', 503);
      const base = Math.round((usd / NOID.usdPerNoid) * 1e6);
      for (let i = 0; i < 5; i++) {
        const id = randomBytes(6).toString('hex');
        try { q.newTopup.run(id, acct.id, base + randomInt(1, 10_000), usd * CREDITS_PER_USD, Date.now()); } catch { continue; } // amount taken by another open quote
        return routes['GET topup'](acct, null, id);
      }
      throw bad('could not allocate a payment amount, try again', 503);
    },
    'GET topup': (acct, _, id) => {
      const t = q.topup.get(id);
      if (!t || !acct || t.account !== acct.id) return null;
      return { id: t.id, address: NOID?.address, amount_noid: (t.amount / 1e6).toFixed(6), credits: t.credits, paid: !!t.paid_ref, expires: t.created + 24 * 3600_000 };
    },
  };

  return { account, countRequest, chargeChat, settleNoid, stripeWebhook, routes, pricing };
};
