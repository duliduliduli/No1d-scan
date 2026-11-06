# NOID Scan: handoff for the next agent

Written 2026-11-02 for an agent taking over the whole project. Read this, then `README.md`, the authoritative reference for routes, env vars and deploy. Verify anything time-sensitive yourself (live SHA, node version, owner settings): this is a snapshot.

## 1. What this is

- **Product:** a public block explorer plus paid API for the **Parano1d (NOID)** proof-of-work chain, competing with noidexplorer.org and noidexplorer.space.
- **Site:** https://parano1d-scan.com
- **Repo:** https://github.com/duliduliduli/No1d-scan (default branch `main`)
- **Owner:** Duli Media LLC (dulimediallc@gmail.com). The owner is not a developer. They work from a phone/laptop and paste commands into the DigitalOcean web console. Give them exact, copy-paste commands and plain-language summaries: what changed, what they must do, and what they should see after doing it.
- **Stack:** one Node 22 process (`server.js`), **zero npm dependencies**, `node:sqlite` (WAL) and `node:http`. The UI is a single static SPA (`public/index.html`, vanilla JS). Tests use `node:test` with a fake JSON-RPC node.

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
| `billing.js` | Accounts (`nk_` API keys, only SHA-256 stored), append-only `ledger`, prepaid credits bought with NOID only (Starter 5 / Pro 10 / Scale 20 NOID), plus checkout wiring for profiles and boosts |
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
- **Secrets:** only in `/etc/noid-scan.env` (root, chmod 600), loaded through `EnvironmentFile`. They include `PAY_ADDRESS`, `ADMIN_TOKEN` and the USDC addresses/RPCs. Never put secrets in the repo, chat, GitHub or URLs, and never print them.
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
- **API billing:** a keyed request counts only when it returns 200. Errors, 404s, `/live` and account routes are free. 1 credit = 1,000 requests.
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
3. **`SUPPORT_EMAIL`:** add it to `/etc/noid-scan.env` so checkout shows a help contact.
4. **Real payment test:** one small (about $5) NOID test purchase end to end. Credits should land about 9 minutes after the payment confirms.
5. **Backups:** confirm `noid-scan-backup.timer` is enabled (`systemctl list-timers | grep noid`) and set `BACKUP_DEST` for an off-machine copy. Today the archive may exist only on the droplet.
6. **Auto-deploy secrets:** decide whether to set `DEPLOY_HOST` / `DEPLOY_KEY` (see the README "Auto-deploy" section) or keep deploying by `git pull`.
7. **Credential hygiene:** a temporary site password was once shared in chat during setup. It has been removed from the site; it must not be reused anywhere.
8. **`ADMIN_TOKEN` is unset in production** (checked 2026-11-02: `GET /api/admin` is 404), so an approved enhanced profile or promoted slot has no route to be approved. Set it in `/etc/noid-scan.env` and restart; then open `https://parano1d-scan.com/admin` and paste the token. Console block in section 10.

**Code and tech debt:**
- ~~Globe geolocation uses ip-api.com's free (non-commercial) tier~~ — done 2026-11-02, back on country.is.
- ~~`deploy/noid-scan.service` still has stale commented env names~~ — done 2026-11-02.
- Header backfill stops retrying a height the node can't serve (`stuckGap`) until the process restarts. That is fine unless the node later regains it.
- `labels.json` `_unresolved`: several known entities (SafeTrade, Parano1d Lab and others) have only partial addresses.
- **v2.1 activation (~block 279,370):** watch logs and Explore for snapshot-shape mismatches, and confirm the native intent flow with real node responses before enabling `SWAP_ENABLED`.
- **Card + NOID price for profiles:** `ENHANCED_PROFILE_USD` defaults to the USDC price.
- **Rate limiter and caches** are in-memory and per-process. That is fine for one droplet; move them to the proxy if the site ever scales out.

## 10. Browser wallet (added 2026-11-05)

`public/wallet.js` + `public/noid-wallet.wasm` + `public/bip39.txt` behind the
`/wallet` route (the SPA's `pages.wallet(id)`; `id` present still renders the
address page, which is now `pages.addressWallet`).

The engine is built from the chain source in `~/noid-wallet-wasm`
(`cargo build --release --target wasm32-unknown-unknown`; `getrandom` needs its
`js` feature). It exposes `noid_alloc`, `noid_free`, `noid_wallet_address`,
`noid_wallet_address_text`, `noid_validate_address` — a hand-rolled ABI, so no
wasm-bindgen toolchain is needed to build or ship it.

Verified: index 13 of the node's own `wallet.key.backup` derives exactly the
address `paranoid_walletStatus` reports, and a 24-word phrase round-trips
through the page (create -> wipe -> restore -> same address). `paranoid_validateAddress`
accepts the derived addresses.

Not built yet: spending. `noid_gkr` (the witness-hiding authorization prover)
also compiles for wasm32, and the prove path is rayon-free, so the prover can be
bundled next; until then `signAndSubmit` throws an explicit error instead of
faking a signature. The seed holds the same bytes a node keystore does, so a
wallet created here can be exported as `wallet.key` and driven by the daemon.

## 11. Wallet as the account, portfolio and the trade panel (added 2026-11-05)

The wallet in a browser is now the account, and the account page leads with it
instead of a sign-up wall:

- `public/wallet.js` remembers the **public** address in `localStorage`
  (`no1d_wallet_identity_v1`, `{v, address, index, at}`) whenever the wallet is
  seen unlocked, and clears it with the wallet. `window.No1dWallet.identity()`
  reads it; `WalletDex.identity()` in the SPA wraps it (with a localStorage
  fallback) and the menu shows `Wallet o1ab…1234 · API & Credits`.
- `POST /api/link {address}` stores the address on the account
  (`accounts.wallet`, additive column), `POST /api/unlink` clears it,
  `GET /api/me` returns `wallet`. One account per address: a second account
  linking the same address gets `409`. Only the address is stored — never a
  seed, never a signature.
- The account page (`pages.account`) shows the wallet card first: address, NOID
  and USD, token count and USD, wallet total, receive index, a token table with
  copy buttons, `Open the wallet`, `Full address page`, and link/unlink. With no
  key it offers "Create a key for this wallet", which mints a key, saves it and
  links the address in one go.
- `pages.wallet` (the `/wallet` page) has the portfolio table: NOID plus every
  native token with quantity, per-token price, USD value, total, a ⧉ button that
  copies the **token id** (the contract address trades are addressed to), a
  click-through to `/token/<id>`, and a Trade button that opens the trade panel
  below it.

### Where balances come from

`assets.js` reads them from the node, not from the indexer. `paranoid_getNativeHoldings
{owner, limit}` lists the state pages an address owns; **kind 2 is one token
balance** whose `opening_hex` carries the `NOIDAS21` magic, the 32-byte asset id
at hex offset 24 and a little-endian u64 of micro-units at byte 76 (hex 152).
Several pages of the same token (one per output) are summed. Kinds 1, 4, 5 and
65 are market, listing, collection and other pages and are ignored. The indexed
`token_holders` table is empty in practice and is only the fallback for a node
that does not answer the method — the wallet route is `async` for this reason.
Verified against live chain data: `o1f8z7z298…` sums to 7 tokens, `o1exn9t45…`
sums 14 pages down to 4.

### The trade panel

`/api/swap/intent` (GET, `intent.js`) prepares a real unsigned intent for the
visitor's own address; the panel shows pay/get/min-out/fee/valid-until from the
node's `review` object, then either asks the browser wallet to sign (which still
throws until the prover ships) or relays already-signed bytes through
`POST /api/swap-submit`. Two bugs were fixed while wiring it: a **sell** amount
is whole tokens in the API and micro-units on chain (`× 1e6`), and the node
returns the payload as `unsigned_intent_hex`, not `unsigned`.

Still off: `SWAP_ENABLED` is not set on the droplet, so the panel answers
"trading is off" in production until the operator turns it on. The prover is
still the one thing between a quote and a real trade.

## 12. Favorites (added 2026-11-05)

One list, one page, one vocabulary. Before this there were two systems: stars
(tokens and collections, synced to the account) and a browser-only
`noid-addr-watch` list for addresses that nothing could display. Addresses are
now stars too, stored as `addr:o1…` in the same table, and
`migrateAddrWatch()` folds the old key into stars once at boot and deletes it.

- `pages.favorites` (`/favorites`, in the header nav and the ☰ menu, both with a
  live count badge) shows a token table — price, 24h, volume, mcap, Open — then
  an address list with balance, blocks mined, Open and remove. Empty state points
  at the ☆ Save button.
- The header link sits directly after `a.explore`, and on phones `a.explore` is
  no longer `display:none` so the two travel together: one row of
  `brand · Explore · Favorites · ☰` with the search on its own row, down to
  360px. The mobile dock is Screener / Search / Alerts / Menu — Favorites is not
  a footer tab. Under 430px the header Wallet button is dropped (it is still in
  the ☰ menu) because three buttons plus the brand do not fit. Size overrides for
  these buttons are declared at the **end** of the stylesheet: the base
  `a.explore` / `a.favlink` rules are set further down than the header block, so
  an override declared beside them loses the cascade.
- `starBtn(id, name, { label: true })` renders `☆ Save` / `★ Saved` instead of
  the bare glyph; it is used in the token page header row (no longer desktop
  only), on address and wallet pages where the old `☆ Watch` button used to be,
  and repainted by `paintStars`, which also updates every `.favcount` badge.
- Adding and removing is one tap anywhere: screener row, token page, mobile
  action bar, address page, wallet portfolio row (`wallet.js` calls the page's
  global `starBtn`). Removing a favorite on `/favorites` re-renders the list.
- **Bug this exposed:** `/api/tokens` only honored `ids` when
  `preset=watch` was also present, so the old watchlist tab listed the entire
  catalog. `ids` now filters on its own; `preset=watch` with no `ids` returns an
  empty list, which is the honest answer.

## 13. Native token names, tickers and logos (added 2026-11-05)

**The bug that hid the names.** `assets.js` read the native catalogue with
`rpc('getNativeCatalog', { kind, limit })`. The node takes **positional** params
`(kind, cursor, limit)` and refuses the object form ("unknown variant `kind`"),
so `nativeSnapshot()` threw on every sync, `sync()` swallowed it behind
`status.error`, and the screener fell back to whatever the `tokens` table already
held: stale rows, prices from indexed trades, and a five-entry hand-curated file
(`tokens-extra.json`) for labels. Sixteen of seventeen tokens therefore showed
`Token <hex>`. Fix: `[kind, cursor || null, 64]`. Re-check with
`curl` — see the verification commands below.

**Where a name comes from.** The chain stores no label, only a metadata digest in
the kind-1 FungibleDefinition opening (`opening_hex[184:248]`, fields 5 and 6
little-endian). That digest addresses a manifest on the protocol's own media
service, `https://tradedata.parano1d.org/metadata/<hash>.json` — the origin the
official wallet GUI ships with (`noid_gui/src/assets/media/transport.rs`).

**Why we verify.** The manifest is content addressed: the hash is BLAKE3 over
`b"Parano1d/native-metadata/v1\0" || canonical_bytes`, where canonical bytes are
serde JSON in struct order plus a trailing newline. `blake3.js` implements that
in pure JS because Node's crypto has no BLAKE3 and this repo takes no
dependencies. It is cross-checked two ways: against the reference `blake3` crate
(1.8.5) for lengths 0-5000 (so the chunk/parent tree is covered, not just the
single-chunk path, where merging the last chunk eagerly produces a plausible
wrong hash), and against 16 live manifests. A manifest that fails verification is
cached as unusable and the token keeps its placeholder.

**Files.** `blake3.js` (the hash), `metadata.js` (catalogue decode -> fetch ->
verify -> `asset_meta` / `asset_label` / `asset_image`), `test-meta.js` (the
suite), and in `server.js`: the module mount, `meta.start()` under
`require.main`, `GET /api/asset-image/<hash>.png`, and `metadata` in
`/api/stats`.

**Caching and cost.** One fetch per asset, ever: `asset_meta` is keyed by hash,
images live in `asset_image`, labels in `asset_label` keyed by asset id. Budget 4
manifests per pass (8 on the two boot passes, 8 s / 40 s / 120 s), 8 s timeout,
16 KiB manifests, 1.5 MiB images. Images are proxied so visitors never touch the
media service. `MEDIA_ORIGIN` / `METADATA_EVERY_MS` / `METADATA_PER_PASS` /
`METADATA_OFF` tune it.

**Label precedence** (in `nativeSnapshot`): verified label -> catalogue
`metadata`/`name` -> curated file -> `Token <hex>`. `assets.js` ignores a label
whose name looks synthetic, so one sync cannot freeze a placeholder in as if it
were real, and reads `asset_label` inside a `try` so a database where
`metadata.js` has not run yet still syncs.

**Still open.** `created_height` and per-token `holders` are `null` for tokens
that came from the catalogue: the catalogue item carries neither (only
`key`/`primary`/`related`), and no curated entry exists for them. Deriving them
needs a create-transaction lookup (the launch definition, kind 48) — not
attempted here. `NOIDCAT` has no published manifest, so its name comes from the
curated file.

## 14. Trading with the built-in wallet (added 2026-11-05)

The engine's final self-check used to refuse every native trade as `Wire(BadMarker)` (it ran the
SDK's `verify_intent`, which only knows the paged-spend and object families). Fixed 2026-11-05:
`authorize` decodes with the decoder matching the plan's `intent_kind`. Re-check the real proof
path without spending anything with `node scripts/check-trade-authorize.mjs <wallet.key> <index>`
(it ends `authorize OK ... magic: NOIDTO21` and does not submit).

The missing prover is now bundled. `public/noid-trade.wasm` is built from
`wasm/noid-trade` (source, provenance and build steps in its README), on top of the
official Parano1d SDK, whose vendored code is Core v2.1.0 byte for byte plus its
browser proving adapter.

Flow: `No1dWallet.prepareTrade` builds the request from the user's inputs, gets the
node's plan from `/api/swap/intent`, and has the engine check it (mainnet chain,
parent, plan ID, exact request, slippage minimum, fee cap, output to the owner).
`confirmTrade` derives the spend secret for the identity's index, proves and verifies
in a fresh worker (`public/trade-worker.js`, about 7 s in desktop Chromium) and posts
the intent to `/api/swap-submit`. The token page's Trade card (`mountTrade`) and the
wallet page's panel both use it; the passphrase can be entered on the token page.

Verified: addresses match `noid-wallet.wasm` (1,050 random seed/index pairs, and in
`npm test`); a full owner proof passes the chain verifier in Node and in Chromium;
malformed plans are refused before proving. Not yet verified: one real plan from the
live node through `authorize` and `submitTxIntent`. Native trades are on by default;
`SWAP_ENABLED=false` in `/etc/noid-scan.env` on the droplet switches them off (the old
quote/build path still needs `SWAP_ENABLED=true` plus its fee settings).

The v2.1 intent flow pays no explorer fee: the native request has no fee output, so
`SWAP_FEE_BPS` and `SWAP_FEE_ADDRESS` only apply to the old quote/build path.

## 14a. Trading UI: what you can spend, and pending trades (added 2026-11-05)

- **Available, Max and a slider.** The token page trade card and the wallet trade panel both open with a balance line: `Available 6.9902 NOID` when buying, `Available 53.994091 PCAT` when selling. `Max` fills the amount (a buy stops at the balance less `FEE_RESERVE_MICRO` = 0.02 NOID, so the fee is always covered; a sell stops at whole tokens, which is what the chain accepts). A range input under the amount is two-way: dragging sets the amount, typing moves the slider. The NOID figure comes from the explorer index (`/api/address/:a`), the token figure from the node (`/api/wallet/:a`), so a token you just bought appears even when the index lags.
- **Pending until the block lands.** A trade is accepted by the node and settles in the next block (~30 s), so a wallet that just traded looks unchanged and reads as a failure. `public/wallet.js` now keeps the receipt in `localStorage` under `no1d_wallet_pending_v1` (`{address, token_id, ticker, side, units_before, minimum_output, gross_in, txid, at, status}`), writes it in `confirmTrade` (after capturing the pre-trade units), and renders a banner at the top of the portfolio: amber **Pending** with the txid while it waits, green **Confirmed** once it lands. `pollPending` re-reads `/api/wallet/:a` every 4 s and confirms when the token page moved the way the trade said (`settled()`: a buy needs `units_now >= units_before + minimum_output`, a sell `units_now <= units_before - gross_in`). After 150 s it stops and says **Still pending** rather than pretending. `readPending()` drops a confirmed record after 10 minutes and ignores one belonging to another address.
- **Disclaimer style.** The yellow-bordered bulleted risk box ("Before you confirm" / "Before you sign") is gone from both swap cards: one plain `.fine` line instead. No `.risk` markup remains in `public/index.html`.

## 14b. PnL has to value what you still hold (added 2026-11-05)

- Drew bought 3 NOID of PCAT. His address page read **PnL -$0.87**, i.e. the whole stake gone, on a trade that was fine. The API showed why: `pnl_micronoid: "-3000000"` - exactly minus the NOID spent, with no credit for the 53.994091 PCAT still in the wallet.
- Cause: `pnlOf(trades, priceMicro, usd)` in `assets.js` took **one** price and only for a *focused* token, and `walletView` passed `focus ? findPresented(focus) : null`. The address view has no focused token, so the price was `null`, the remaining bag was valued at zero, and every buy on an address page read as a total loss. One price was also simply wrong for an address holding several tokens.
- Fix: `pnlOf(trades, priceFor, usd)` now takes a `priceFor(token_id)` lookup, tracks bought/sold per token, and values each token's remainder at **its own** price - the same price the screener quotes (last trade, then the stored column, one shared `realTokens(now)` pass for holdings and PnL alike). New fields: `held_micronoid` (what the bag is worth) and `unpriced_token` (held tokens with no quoted price, counted rather than silently dropped).
- Same numbers now: spent 3,000,000 uNOID, bag 53 x 55,561 = 2,944,733, PnL -55,267 uNOID (-0.055 NOID, about -$0.016) - the fee and the curve impact, not the stake.
- Limit worth knowing: the indexer stores `token_amount` as **whole tokens floored** (`assets.js` ~line 1469), so a bag computed from indexed trades understates a fractional holding by well under 1%. Cost basis and bag both come from the indexed trades on purpose, so the two sides stay consistent.
- Test: `test.js` covers it - a buy with a newer fill setting the price must give `held_micronoid` for the remainder and a PnL that is **not** just `-bought_noid_micronoid`, in both the address view and the focused view.

## 14c. Searching a txid, and what a sale would actually pay (added 2026-11-05)

- **The code the wallet shows at submit time is not the chain txid.** `submitTxIntent` returns the mempool hash of the encoded intent; the chain's txid is *derived from the body* (`Transaction::txid` = `hash_tx_body`). Drew's buy showed `77a51e68…`; the block that carried it (284205, tx position 3) holds `d1d8a727…`. `paranoid_getTx("77a51e68…")` answers null, so the code he wrote down could not be searched - by the node or by us.
  - The pending banner now says what the code is ("the code the node gave this trade when it was sent") and, once the block lands, `chainTxidOf()` picks the real txid out of the newest trade row in `/api/wallet/:a` and the banner links to `/tx/<id>`.
- **`/api/tx/:id` and `/api/search?q=` fall back to our own index.** The node serves only its retained window (`getTx` answered for height 284205 and 284226, null for 282676), so an older txid used to 404. `server.js` now checks `tx_index` (permanent: only the rolling 42-block window is ever re-inserted, older rows are never dropped) and returns `source: 'index'` with the height, position, fee, parties from `addr_tx`, and `effects` from `assets.txEffects(txid)` (trade and transfer rows carry the txid with a `:<n>` suffix). The tx page renders those, and says the body was pruned rather than that nothing is known. Constraint worth keeping: we only ever have what we saw - a block the explorer missed while it was down is gone from the chain too.
- **A wallet is valued at the mark price; a sale does not pay the mark price.** PCAT 53.994091 showed a mark value of 2.866 NOID (last trade 0.053085) while the node's own sell plan paid 2,694,975 µNOID net for the 53 whole tokens - 0.050849 each, about 6% less, because the curve takes its market fee (`market_fee` 159,000 in `pending_quote`) and moves with size. `/api/wallet/:a?quote=1` now attaches `holdings[].sell_now = { units, tokens, gross_micronoid, net_micronoid, fee_micronoid, net_usd }`, at most six holdings, cached 20 s per (address, token, whole amount), one read-only `prepareNativeIntent` per holding. `quote` is in `PARAMS` so the response cache keys on it.
- **The wallet total is stated in NOID, and it is the headline number.** The big figure on the balance card is the spendable NOID balance plus every token position at the price shown (`totalNoidMicro`, `id="walltotal"`); a muted line under it gives the spendable part and the USD equivalent, and the portfolio footer repeats the total (`id="wtotal"`). The account page's `Wallet total` stat is the same NOID number with USD underneath. USD stays the secondary figure: NOID is what the chain, the curve and the trades are denominated in.
- **The wallet stays unlocked for the tab.** Unlocking, creating or importing writes the seed to `sessionStorage['no1d_wallet_session_v1']`, so a refresh keeps you in without the passphrase. The browser drops sessionStorage when the tab closes, and the `Lock` button, `Delete stored wallet` and `Delete from this browser` clear it at once. Nothing about this changes what is stored on disk: the encrypted blob and the identity stay in localStorage, unchanged.
- **Favorites is a list of rows, one per saved id, and each token row opens the token and its trade panel.** The page never renders an empty card while ids exist: a token the catalogue missed is fetched one by one (`/api/token/<id>`), an address shows its balance, and anything else gets a row saying it is not a token on this chain. Each token row links to `/token/<id>` and a `Trade` link to `/token/<id>#trade`, which scrolls the trade panel into view. Every fetch is wrapped so one failure cannot blank the page.
- **The pages are dense: short boxes, no air.** Cards, tiles, list rows and table rows use the condensed spacing at the end of the stylesheet (`.card` padding `11px 13px`, stat/tile `7px 10px`, `th, td` `6px 8px`, bar tracks `6px`), and the four network plots render 92px tall on a phone, 112px under 900px, 130px wider. The owner asked for every box on the home page to be shorter; keep new panels to those numbers rather than re-introducing default spacing.
- **The owner trims copy, and the pages stay terse.** The wallet page keeps no wallet-intro card, no seed-reassurance line, no "Spending / what this build can and cannot do" card, no activity card, no "Explorer index as of block N" line, and no explanatory clause after the total - he asked for all of them gone. Before adding a paragraph of reassurance or a caption to a page he uses daily, assume it will be deleted; states, balances and buttons stay.
- **The amount field now says what it buys or sells.** Both trade panels show an estimate under the slider: buying divides by the mark price, selling uses the *implied* price from the node's payout for the whole balance when the server quoted one (honest number, since the curve's price is not the mark), and falls back to the mark price with the wording saying so. Both lines end by saying the node quotes the exact figure on review.

## 14d. Paid promotions and API time through a real contract (added 2026-11-05)

Trading has no fee and never will. Promotions and API time are the paid lines, and both are bought with
NOID through a real Parano1d contract, not a fee address with dust digits.

- **The chain has a contract runtime.** `paranoid_getContractProtocol` on the live node: ABI v3, 16
  instructions, 2 persistent registers, classes small/large/native, active since block 210,537.
  A contract is a *policy on an output*, not a program: a rule about when and to whom value may move.
- **`contracts.js`** builds a `refundable_payment` object for each order: payer = the buyer's address,
  payee = ours (`PROMO_PAYEE`, falling back to `PAY_ADDRESS`), expiry = now + the tier's duration + 120
  blocks of grace. `paranoid_createObject` returns an object with an ordinary `o1…` address
  (`pay_address`), and the buyer pays that address like any other NOID payment.
- **What the contract enforces:** before the deadline the payee can claim and close; after it the payer
  can recover. The chain holds the money, this site holds nothing. The page says exactly that.
- **What the site enforces:** the promotion window and the API days. A funded instance is the only proof
  of payment (`paranoid_getObjectInstances`), and `contracts.watch(tip)` runs on every indexer tick, so
  an order turns on by itself when the block carrying the payment lands. Unfunded past the deadline the
  order is marked `refundable`, and the buyer takes the money back on chain.
- **Tiers.** Promotions: 1 NOID = 1 hour, then 3/10/25/50/100 NOID = 6 h / 1 d / 4 d / 9 d / 20 d.
  API time is linear with volume rewards: 1 NOID = 1 day, then 3/10/25/50/100 NOID = 3 / 11 / 30 / 65 / 140 days.
- **Routes.** `POST /api/promo-contract { noid, asset_id, payer }`, `POST /api/api-time { noid, payer }`
  (key optional; API time attaches to the account whose linked wallet pays), `GET /api/noid-order?id=…`
  or `?payer=…`. Live promotions are merged into `/api/boosts` with `pack: 'noid'`, so the existing
  Promoted panel, the bolt mark and the paid-promotion disclaimer carry them unchanged.
- **API time is a real paid tier.** `accounts.api_until` (additive column). While it is in the future
  `billing.paid()` is true: requests do not draw down credits and the higher rate limit applies. The
  grant is idempotent: the contract id is the ledger ref, so a second pass over the same contract adds
  nothing.
- **UI.** `noidTierCard('promo')` on `/promote` and `noidTierCard('api')` on `/account`, both wired by
  `wireNoidTierCard`, both polling `/api/noid-order` every 8 s and remembering the order in
  `localStorage['no1d_noid_order_promo' | 'no1d_noid_order_api']`.
- **The order records the payee** (`noid_contracts.payee`, additive) and the card names it, so what the
  buyer can see on the page is checkable against the object. `GET /api/noid-order` returns `payee`.
- **Collecting.** Claiming our side is a wallet action on the machine that holds the payee key; a server
  cannot do it and must not pretend to. On the droplet that is the node's own wallet:
  `parano1d contracts call <object.json> <slot> <creation_id> --close --pay-to <address>`. **Set
  `PROMO_PAYEE` to an address whose key is on the droplet node** (the node wallet, index 13), or the
  orders will simply refund to the buyer after the deadline.
- **Open item.** A buyer pays from their own Parano1d wallet today, because the browser wallet cannot yet
  send a plain NOID payment. Funding the object address is an ordinary send, so the day the send screen
  lands, this flow becomes one-click from the site.

## 14e. Promotions and API time are bought with a slider, not a menu (added 2026-11-05)

- **One card, one button.** `noidTierCard(kind, {asset})` is the whole purchase UI for a promotion and
  for API time: a slider for the amount, the time it buys printed underneath, and `Start the contract`.
  The wallet in this browser is the payer, so there is no address to type.
- **Any whole NOID from 1 to 100** is for sale. `contracts.js` interpolates the seconds between the six
  published points (1 = 1 hour, 100 = 20 days for a promotion; 1 = 1 day, 100 = 140 days for API time),
  so the published points stay exact and nothing between them is cheaper per NOID. The suite pins
  2 NOID = 3.5 hours and 25 NOID = 4 days.
- **A promotion is chosen, not typed.** `Choose a token` opens a searchable list of the catalogue
  (`tokens?q=`), which needs no token-id paste.
- **API time is a token with a life.** `api_until` is the key's own lifetime: once it passes, keyed
  requests answer 402 with the date and the key is void until it is reloaded with more NOID on
  /account (the grant extends from `max(now, api_until)`, so a reload adds time rather than replacing
  it). A key that never bought time keeps running on credits exactly as before. Our own pages are
  exempt so the card can still offer the reload.
- **Removed:** the Alerts page and its dock/action links, the Verified page and menu entry, the
  `$100` promoted-listing form, and the USDC pack buttons. The server-side USDC/profile rails are
  still in place but nothing links to them.
- **The last mile is honest.** A contract is funded by a NOID payment from the buyer's wallet. The
  browser wallet can prove a trade today but has no send screen for a plain payment, so the pay button
  says exactly that in one line and the contract address is shown for any Parano1d wallet. This is the
  one piece of the paid flow that is not live; see the note at the end of §14d.
- **The block list grew its filters.** `/blocks` takes `q` (height, hash prefix or miner address),
  `window` (1h/6h/24h/7d/30d), `min_txs`/`max_txs` and `before`, answered from this explorer's own
  `headers` table with a `matched` count, so a search covers every header it kept rather than the page
  the node holds. A list with no filter still comes from the node. New params are in `PARAMS`.
- **Density and mobile fixes.** The five live tiles are one row; the globe sits left with the country
  list scrolling beside it, the two frames one height (`.gnsplit` sets `height:var(--gnh)` and stretches
  both cards, so they start and end together at every width; the list sizes its rows `max-content` or a
  definite height squashes them and the text overlaps); the zoom stack sits inside the globe frame;
  tapping a peer opens its detail card full width under the row, not inside the 161px globe frame where
  it clipped itself (callouts fall back to the country code past 12 characters); the mining
  calculator's three fields are plain fields, not bordered tiles that ran into each other; and every
  field is 16px so iOS does not zoom the page when one is focused.

## 14f. Launchpad: create tokens, non-custodial (added 2026-11-06)

- Menu item **Launchpad** → `/launch`. The API link in the menu now says just **API**
  (the wallet address shows on it when one is present).
- `/api/launch/intent` builds an UNSIGNED `CreateToken` intent via `prepareNativeIntent`
  (params: `sender`, `whole_tokens` (positive whole), `metadata_hash` (`''`/`'0'` for none,
  64-hex otherwise), optional `initial_buy_units` micro-units). `intent.js` `launch()`;
  `server.js` route + `launch` in the route table.
- `public/wallet.js` exposes `prepareLaunch` / `confirmLaunch` (and provider methods
  `launch_prepare` / `launch_confirm`): same engine-check → prove → relay path as trades,
  via `noid_trade_authorize` (the engine already handles `NativeClientIntentKind::Operation`).
- The page is `pages.launch()` + `wireLaunch()` in `public/index.html` (supply, optional
  initial buy in NOID → micro-units, review rows, confirm). CSS `.lfield` at the END of the
  stylesheet (cascade rule).
- **Intents are never cached.** `swap/intent` and `launch/intent` are excluded from the
  response cache (`cacheable` guard in `server.js`); a cached unsigned intent names one
  owner and another wallet would refuse it. Add `whole_tokens`/`metadata_hash`/
  `initial_buy_units` to `PARAMS` if the cache key ever needs them (already added).
- A launch without a metadata manifest is created unnamed (`Token …`) until the creator
  publishes a manifest on the protocol's media service; still fully tradeable.
- Next: real test mint (needs user go — spends NOID), and any launch fee gate.

## 15. Quick verification commands


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

Label and logo check (what the names should look like):
```bash
curl -s -H 'sec-fetch-site: same-origin' 'https://parano1d-scan.com/api/tokens?limit=40' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['count'], sum(1 for t in d['tokens'] if not t['name'].startswith('Token ')), 'named'); print(*[t['ticker'] for t in d['tokens']])"
curl -s -H 'sec-fetch-site: same-origin' https://parano1d-scan.com/api/stats \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['metadata'])"
# every token except NOIDCAT (no published manifest) must be named
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' -H 'sec-fetch-site: same-origin' \
  "https://parano1d-scan.com$(curl -s -H 'sec-fetch-site: same-origin' 'https://parano1d-scan.com/api/tokens?limit=40' | python3 -c "import sys,json; print([t['logo'] for t in json.load(sys.stdin)['tokens'] if t.get('logo')][0])")"
```

The catalogue itself, on the node (this is the call that must be positional):
```bash
curl -s -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"paranoid_getNativeCatalog","params":["markets",null,64]}' \
  http://127.0.0.1:9601 | python3 -c "import sys,json; r=json.load(sys.stdin)['result']; print(len(r['items']), 'markets at height', r['height'])"
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
