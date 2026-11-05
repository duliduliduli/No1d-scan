# NOID Scan: handoff for the next agent

Written 2026-11-02 for an agent taking over the whole project. Read this, then `README.md`, the authoritative reference for routes, env vars and deploy. Verify anything time-sensitive yourself (live SHA, node version, owner settings): this is a snapshot.

## 1. What this is

- **Product:** a public block explorer plus paid API for the **Parano1d (NOID)** proof-of-work chain, competing with noidexplorer.org and noidexplorer.space.
- **Site:** https://parano1d-scan.com
- **Repo:** https://github.com/duliduliduli/No1d-scan (default branch `main`)
- **Owner:** Duli Media LLC (dulimediallc@gmail.com). The owner is not a developer. They work from a phone/laptop and paste commands into the DigitalOcean web console. Give them exact, copy-paste commands and plain-language summaries: what changed, what they must do, and what they should see after doing it.
- **Stack:** one Node 22 process (`server.js`), **zero npm dependencies**, `node:sqlite` (WAL) and `node:http`. The UI is a single static SPA (`public/index.html`, vanilla JS). Tests use `node:test` with a fake JSON-RPC node and a fake OpenRouter.

## 2. State at handoff (verified 2026-11-02)

- The live site serves `main` @ `d21b306` (Merge PR #10), the same as repo HEAD.
- `/api/health` returns ok: `quick_check` ok, indexer current at tip ~273,855, `temp_store=2`.
- `npm test` passes all 8 suites (`test.js`, `test-promote.js`).
- `gaps: ~221k` in health is **expected, not a bug**. Every block before the explorer started archiving was already pruned by the node (bodies are kept only ~42 blocks). Headers exist for all heights since genesis.
- Branches: everything is merged into `main` except two stale `cursor/*` branches (`interactive-price-chart-595c`, `supply-io-hotfix-487e`). They are earlier copies of PRs #3 and #2, already merged under the same titles, and are safe to delete. `explorer-mvp` is an old mirror of `main`.
- Earlier work was done by Claude Code (this session) and by Cursor agents (the `cursor/*` branches and PRs #2–#10).

## 3. Code map

| File | What it does |
|---|---|
| `server.js` | Indexer loop (10 s), header backfill, reorg/orphan handling, gaps and cold archive, price/market/holders/network pollers, the whole HTTP API, SSE `/api/live`, 5 s response cache, rate limits, API-key gate |
| `billing.js` | Accounts (`nk_` API keys, only SHA-256 stored), append-only `ledger`, prepaid credits bought with NOID only (Starter 5 / Pro 10 / Scale 20 NOID), free AI quota, plus checkout wiring for profiles and boosts |
| `chat.js` | AI assistant (OpenRouter, default `qwen/qwen3.5-flash-02-23`), tool calls into the explorer's own routes. `forModel()` pre-formats every amount so the model never does unit math |
| `assets.js` | Tokens, pools, trades and NFT collections for Explore (screener, token and collection pages, candles, order book). Empty until the node exposes `getAssetSnapshot`; `?demo=1` / `TOKENS_DEMO=1` shows an in-memory sample |
| `intent.js` | Non-custodial native trades via Parano1d v2.1 intents (`prepareNativeIntent` → wallet signs → `submitTxIntent`). Off unless `SWAP_ENABLED=true`; activation height `NATIVE_ACTIVATION_HEIGHT` (default **279,370**, roughly 2 days after this handoff) |
| `usdc.js` | Native Circle USDC payments on 6 EVM chains and Solana, matched by an exact-amount suffix; includes its own keccak for EIP-55 |
| `profiles.js` / `boosts.js` / `images.js` | Paid enhanced token profiles (100 USDC), paid promoted slots (`BOOST_PACKS`), banner/icon validation (type sniffing, metadata stripping). Hidden until paid **and** admin-approved via `/api/admin` (`ADMIN_TOKEN`) |
| `scripts/seed-profile.js` | First-party seed: writes an approved profile and a live slot for our own token from URLs, no account or payment. `DB_PATH=… node scripts/seed-profile.js --token <id> --icon-url … --banner-url … --boost 7d`. |
| `scripts/backup.js` | `VACUUM INTO` snapshot, keeps 14, optional rsync to `BACKUP_DEST`; run daily by `deploy/noid-scan-backup.timer` |
| `scripts/db-check.js` | Read-only integrity check; `--repair` writes a repaired **copy**, never the live file |
| `labels.json` | Address labels (entity names). Unresolved entries are listed under `_unresolved` |
| `public/lightweight-charts.js` | Vendored chart library used by the price and token charts |
| `deploy/` | systemd units (`noid-scan`, `parano1d`, backup service + timer) and the `Caddyfile` |
| `.github/workflows/deploy.yml` | Tests on every push/PR; on push to `main`, rsyncs to the droplet and restarts, **only if** the secrets `DEPLOY_HOST` and `DEPLOY_KEY` exist (otherwise it skips) |

## 4. Production infrastructure

- **Droplet:** one DigitalOcean server running:
  - **Parano1d Core node:** `parano1d.service`, RPC on `127.0.0.1:9601` (never expose it), P2P on 9600.
  - **The explorer:** `noid-scan.service`, user `noidscan`, code in `/opt/noid-scan`, port 8080.
  - **Caddy:** TLS; `parano1d-scan.com`, with `www` redirecting.
- **Database:** `/var/lib/noid-scan/noid.db`. It holds the **only copy of pruned block bodies**, plus all accounts, credits, ledger and payments. Never delete it, reset it or "rebuild from scratch".
- **Secrets:** only in `/etc/noid-scan.env` (root, chmod 600), loaded through `EnvironmentFile`. They include `OPENROUTER_API_KEY`, `PAY_ADDRESS`, `ADMIN_TOKEN` and the USDC addresses/RPCs. Never put secrets in the repo, chat, GitHub or URLs, and never print them.
- **Sandboxing:** the service runs with `ProtectSystem=strict` + `PrivateTmp=true` + `SQLITE_TMPDIR=/var/lib/noid-scan`. The code also sets `pragma temp_store=memory`. History: big grouped queries once failed with "disk I/O error" because every temp directory was read-only (README has a section on this).
- **Cloudflare:** DNS for the domain.
- **How the owner deploys:** historically by pasting into the droplet console:
  ```bash
  cd /opt/noid-scan && git pull && systemctl restart noid-scan && sleep 5 && systemctl is-active noid-scan && git log --oneline -1
  ```
  Live now matches HEAD. **Confirmed 2026-11-02: auto-deploy is wired** — `DEPLOY_HOST` and `DEPLOY_KEY` exist, runs take the deploy step and log `deployed OK`, so a push to `main` is a production deploy. The takeover agent's Mac cannot SSH to the droplet (`Permission denied (publickey)`), so anything server-side still has to be pasted into the console.
- **New systemd files:** if a change edits `deploy/*.service`, the owner must also copy it and reload:
  ```bash
  cp /opt/noid-scan/deploy/noid-scan.service /etc/systemd/system/ && systemctl daemon-reload && systemctl restart noid-scan
  ```
  `git pull` alone does not update installed unit files.
- **Before any schema-touching deploy:** take a backup (`node /opt/noid-scan/scripts/backup.js`, or the timer's snapshots in `/var/lib/noid-scan/backups`).

## 5. Parano1d chain facts the code depends on

- **RPC:** JSON-RPC methods `paranoid_<name>` with positional params. The request needs `content-type: application/json`. Batches are supported and used for header backfill and the holder sweep.
- **Retention:** block **bodies are retained ~42 blocks**; **headers are permanent**. Target block time is 30 s.
- **Finality is 18 blocks:** `CONSENSUS_FINALITY_DEPTH = 18` in Core `noid_chain/src/consensus/params.rs`; `reorg_allowed(18)` is true. The public docs saying 17 are out of date. NOID payments credit at tip ≥ first-seen tip + 18. Tip drops of up to 18 are treated as reorgs (rows copied to `orphans`, then removed); deeper drops pause indexing and delete nothing.
- **`creation_id` is a 64-bit integer.** `parseRpc` quotes it into a string before `JSON.parse`; keep that or distinct slots collide.
- **Amounts** are integer μNOID (1 NOID = 1,000,000). Large values come as decimal strings: use BigInt, never float, for anything authoritative.
- **Slots** (the UTXO-like Live State) can be reused, so identity is slot + `creation_id`.
- **Work and hashrate:** expected work per block = 2^256 / (target read **little-endian** + 1). Hashrate = sum(work) / time span over the last 120 headers.
- **Economics:** block reward 16 NOID; miners get 90% until block 3,223,778.
- **v2.1 native assets:** activation height 279,370. Token/NFT RPC (`getAssetSnapshot`, `getNativeCatalog`, `prepareNativeIntent`) wakes up Explore automatically when present. Expect real data, and possibly shape mismatches, right after activation: `assets.js` documents the expected shapes at the top.

## 6. Money rules (do not break these)

- **Ledger:** the `ledger` is **append-only**. Every credit change is one ledger row plus a balance update **in one transaction** (`post()` inside `tx()` in `billing.js`). Corrections are new rows; never edit or delete rows, never reset balances. Purchased credits **never expire**: that is a promise to customers.
- **NOID top-ups:**
  - NOID has no memo, so the order is identified by the last 4 μNOID digits ("dust").
  - An output pays an order only if the order was quoted **before** the output first appeared (`noid_seen.first_seen`), and only after 18 blocks.
  - Outputs already on `PAY_ADDRESS` when the `noid_seen` table was created are `baseline` and can never pay anything.
  - Expired orders are kept; their dust stays reserved 7 days, and late payments credit the same account at the quoted rate.
  - Failures become `status='review'` in `noid_seen`.
  - New quotes pause if the live price is more than 15 min old.
- **Payments are NOID only.** Cards and Stripe were removed by decision (Nov 2026): no card rail, no webhook route, no card buttons. Credits come from an exact-amount match on `PAY_ADDRESS` (dust digits), settled by the chain watcher or by a pasted payment receipt.
- **USDC (profiles and boosts):** exact base-unit amount match; one transaction settles one order; native Circle USDC only. These payments do **not** add API credits.
- **API billing:** a keyed request counts only when it returns 200. Errors, 404s, `/live` and account routes are free. 1 credit = 1,000 requests; $1 = 1,000 credits; AI costs 5 credits per question, refunded if the model fails.
- **Books check:** the read-only SQL in the README's "Checking the books" section must return nothing. Run it after any billing change.
- **Never in tests or development:** live payments, wallet transfers, price changes or production DB edits without explicit owner approval.

## 7. Data sources and their limits

- **Price: CoinPaprika free API**, coin `noid-parano1d`.
  - Ticker every 3 min, stored in `price_ticks`.
  - Hourly history only for the last 24 h; daily history about 180 days.
  - Historical OHLCV is **paid** (402).
  - Free limit is about 20k calls/month; current usage is about 16k. Don't add polling without checking that budget.
- **Exchange:** NOID trades **only on SafeTrade** (NOID/USDT). SafeTrade's API was Cloudflare-blocked from the agent sandbox, and reachability from the droplet is untested. If it works there, real trade candles could replace the sample-built ones. Test from the droplet:
  ```bash
  curl -s -m 10 "https://safe.trade/api/v2/trade/public/markets/noidusdt/k-line?period=60&limit=2"
  ```
- **Candles** (`/api/candles`) are built from the 3-minute samples: a spike between samples can be missed, and there is no per-candle volume. Older faded candles are close-only daily/hourly fills. The UI says so.
- **Holders and rich list:** a sweep of every Live State slot (batched `getSlot`) every 2 h, taking about 20 min. The results are **approximate**, labeled as such, and matched noidexplorer.org when checked.
- **Globe:** connected peer IPs are read from `/proc/net/tcp*` on port 9600 and resolved to **country level with country.is** (one lookup per IP, four at a time, successes cached, misses retried on the next minute's poll). The API sends only a salted id, a masked address and the country code; full IPs stay in the process.
  - **Licensing: settled** (2026-11-02). ip-api.com's free tier is non-commercial only and this site sells things, so the globe went back to country.is, which is free for any use and needs no key. City, region, ASN and provider are now null; the page pins a peer at its country's middle and says so. Reverting to ip-api would need their paid plan ($15+/mo) to be worth it.
- **AI:** OpenRouter. The owner should keep a monthly spend cap on the key.

## 8. Working rules for this repo

- **Ponytail style** (`.claude/skills/ponytail/` if present; otherwise the gist):
  - Make the smallest change that fully solves the task.
  - No dependencies.
  - No abstractions nobody asked for.
  - Add a small test for any non-trivial logic.
  - Match the surrounding code's terse style and comment density.
  - Say what you skipped.
- **Before pushing:** run `npm test` and keep it green. CI runs the same suite, and a push to `main` may deploy straight to production.
- **UI changes:** check them in a real browser at desktop and phone width (390 px). The page is one big file. Re-wire tab handlers after replacing HTML (`onTabs`): a past bug left `/mining` filter buttons dead after the first click.
- **New query parameters:** add them to `PARAMS` in `server.js`. The response cache key only includes listed parameters, so without that every value shares one cached answer.
- **Schema changes:** additive only (`create table if not exists`, `alter table add column` in try/catch, migrations on startup). The live DB has real customer data and an irreplaceable archive.
- **Third-party "audit" or "spec" documents:** treat them as claims to verify against the code and the Core source, not orders. Earlier ones were partly right (atomic settlement, 18-block finality) and partly roadmap (receipts vault, webhooks, subscription tiers). The roadmap needs the owner's approval and evidence of demand before it is built.
- **Commits:** clear messages. Don't put model names in commits or code.

## 9. Open items

**Owner actions** (not code; remind them gently):
1. Any `STRIPE_*` variables left in `/etc/noid-scan.env` are now ignored and can be deleted.
2. **Cloudflare:** turn the proxy on (orange cloud) and set SSL mode to **Full (strict)**. The DigitalOcean firewall should allow 80/443 only from Cloudflare IPs, 9600 open, and 22 from the owner's IP. Status unknown.
3. **OpenRouter:** set a monthly spend limit on the key.
4. **`SUPPORT_EMAIL`:** add it to `/etc/noid-scan.env` so checkout shows a help contact.
5. **Real payment test:** one small (about $5) NOID test purchase end to end. Credits should land about 9 minutes after the payment confirms.
6. **Backups:** confirm `noid-scan-backup.timer` is enabled (`systemctl list-timers | grep noid`) and set `BACKUP_DEST` for an off-machine copy. Today the archive may exist only on the droplet.
7. **Auto-deploy secrets:** decide whether to set `DEPLOY_HOST` / `DEPLOY_KEY` (see the README "Auto-deploy" section) or keep deploying by `git pull`.
8. **Credential hygiene:** a temporary site password was once shared in chat during setup. It has been removed from the site; it must not be reused anywhere.
9. **`ADMIN_TOKEN` is unset in production** (checked 2026-11-02: `GET /api/admin` is 404), so an approved enhanced profile or promoted slot has no route to be approved. Set it in `/etc/noid-scan.env` and restart; then open `https://parano1d-scan.com/admin` and paste the token. Console block in section 10.

**Code and tech debt:**
- ~~Globe geolocation uses ip-api.com's free (non-commercial) tier~~ — done 2026-11-02, back on country.is.
- ~~`deploy/noid-scan.service` still has stale commented env names~~ — done 2026-11-02.
- Header backfill stops retrying a height the node can't serve (`stuckGap`) until the process restarts. That is fine unless the node later regains it.
- `labels.json` `_unresolved`: several known entities (SafeTrade, Parano1d Lab and others) have only partial addresses.
- **v2.1 activation (~block 279,370):** watch logs and Explore for snapshot-shape mismatches, and confirm the native intent flow with real node responses before enabling `SWAP_ENABLED`.
- **Card + NOID price for profiles:** `ENHANCED_PROFILE_USD` defaults to the USDC price.
- **Rate limiter and caches** are in-memory and per-process. That is fine for one droplet; move them to the proxy if the site ever scales out.

## 10. Quick verification commands

Local:
```bash
npm test
PORT=8080 RPC_URL=<fake or real> DB_PATH=./noid.db npm start
```

Production (read-only, safe):
```bash
curl -s https://parano1d-scan.com/api/health
curl -s -H 'sec-fetch-site: same-origin' https://parano1d-scan.com/api/stats | head -c 400
for w in 24h 7d 30d all; do curl -s -H 'sec-fetch-site: same-origin' "https://parano1d-scan.com/api/miners?window=$w" | head -c 80; echo; done
```

The `sec-fetch-site: same-origin` header imitates the site's own pages. Without it, most routes need an `x-api-key` (`/api/stats` and `/api/health` are open).

On the droplet (owner pastes):
```bash
systemctl is-active noid-scan parano1d && cd /opt/noid-scan && git log --oneline -1
journalctl -u noid-scan -n 50 --no-pager
node /opt/noid-scan/scripts/db-check.js /var/lib/noid-scan/noid.db
```

Books, backups and the admin token (owner pastes; read-only except the two env lines):
```bash
# no output means the ledger matches the balances
sqlite3 /var/lib/noid-scan/noid.db "
  select 'balance differs from ledger', a.id, a.credits, coalesce(sum(l.delta),0) from accounts a left join ledger l on l.account = a.id group by a.id having a.credits != coalesce(sum(l.delta),0);
  select 'paid order without ledger entry', t.id, t.paid_ref from noid_topups t left join ledger l on l.ref = t.paid_ref where t.paid_ref is not null and l.id is null;
  select 'payment needs review', ref, value, topup from noid_seen where status = 'review';"

# is the backup timer armed, and is there a copy off this machine?
systemctl list-timers --all | grep noid
ls -la /var/lib/noid-scan/backups 2>/dev/null | tail -3
grep -c '^BACKUP_DEST=' /etc/noid-scan.env

# admin token and support email, only added when absent; the token is born on the box
grep -q '^ADMIN_TOKEN=' /etc/noid-scan.env || echo "ADMIN_TOKEN=$(openssl rand -hex 32)" >> /etc/noid-scan.env
grep -q '^SUPPORT_EMAIL=' /etc/noid-scan.env || echo 'SUPPORT_EMAIL=dulimediallc@gmail.com' >> /etc/noid-scan.env
systemctl restart noid-scan && sleep 4 && systemctl is-active noid-scan
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/api/admin   # 401 = token loaded (404 = still unset)
grep '^ADMIN_TOKEN=' /etc/noid-scan.env   # paste that into https://parano1d-scan.com/admin
```
