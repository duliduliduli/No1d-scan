# NOID Scan

A public explorer for the Parano1d (NOID) chain. It runs as one Node.js process with no dependencies and contains:

- **Indexer:** every 10 s it saves the block bodies the node still retains (the last ~42 blocks) and records a stats snapshot for each new tip. The node prunes bodies after that window, so this is the only data the explorer needs to keep.
- **API:** a JSON API under `/api/*`. Headers, tx pointers and Live State are permanent on the node, so the API reads those live.
- **UI:** one static page (`public/index.html`) with shareable URLs such as `/block/220800`, `/tx/<txid>` and `/address/o1…`.

Requires Node ≥ 22.13 (for the built-in `node:sqlite`) and a synced `parano1d` node with RPC on `127.0.0.1:9601`.

```sh
npm test      # indexer + API against a fake node
npm start     # http://127.0.0.1:8080
```

| Env | Default | |
|---|---|---|
| `RPC_URL` | `http://127.0.0.1:9601` | Node JSON-RPC |
| `RPC_TOKEN` | – | Bearer token, only for a remote node |
| `DB_PATH` | `./noid.db` | SQLite file. Sort spill files go in this file's directory unless `SQLITE_TMPDIR` is set |
| `DB_QUICK_CHECK` | on | Set to `0` to skip the startup `PRAGMA quick_check` |
| `PORT` / `HOST` | `8080` / `127.0.0.1` | |
| `RATE_LIMIT` | `120` | API requests per IP per minute |
| `CACHE_MS` | `5000` | How long an API response is reused in server memory (and by the visitor's browser) |
| `TRUST_PROXY` | – | Set it behind Caddy/nginx so rate limiting uses `X-Forwarded-For` |
| `DONATE_ADDRESS` | – | `o1…` address shown in the footer |
| `ARCHIVE_PEERS` | – | Comma-separated archive nodes. A gap retries this node, then each peer (`paranoid_getBlockDetails`, else `GET /api/block/:height`) |
| `COLD_DIR` / `COLD_AFTER` | beside the db / `20000` | Finalized bodies (at least 18 confirmations, and this many blocks behind the tip) move to `height-hash.zst`. `off` keeps them in SQLite. `:memory:` skips cold storage unless `COLD_DIR` is set |
| `STALL_MS` | `120000` | `/api/health` is 503 when the last good indexer pass is older than this, or indexing is paused |
| `LABELS_FILE` | `./labels.json` | `{"o1…":{"entity":"Name","note":"…"}}`, re-read every 30 minutes. Keys that are not addresses are ignored |
| `BACKUP_DIR` / `BACKUP_DEST` / `BACKUP_KEEP` | beside the db / – / `14` | `node scripts/backup.js`. `BACKUP_DEST` is an rsync target |

## API

`/api/stats` · `/api/health` (no key: database `quick_check` plus indexer status; 503 when indexing is stalled or paused) · `/api/blocks?before=H&limit=N` · `/api/block/:height|:hash` · `/api/tx/:txid` · `/api/address/:o1…?page=N` · `/api/txs?page=N` · `/api/charts` · `/api/search?q=…` · `/api/history?window=24h|7d|30d|all` · `/api/miners?window=…` · `/api/mempool` · `/api/network` · `/api/price?window=…` (3-minute ticks, market cap, volume, markets) or `/api/price?before=&limit=` (pages the full stored history, newest page when `before` is omitted; `more` is false at the oldest daily close) · `/api/holders?window=…` · `/api/richlist?limit=N` · `/api/supply?window=1h|24h|7d|30d|all` · `/api/candles?interval=15m|1h|4h|1d|1w` (OHLC from the 3-minute samples; without `before`/`limit`, the recent fixed window) and `&before=&limit=` (pages the full stored history at that candle size; `approx` candles are older daily/hourly closes) · `/api/gaps` · `/api/orphans` · `/api/economics` · `/api/receipts` · `/api/contracts` · `/api/tokens` · `/api/token/:id` · `/api/collections` · `/api/collection/:id` · `/api/swap/quote` · `/api/swap/build` · `/api/stars` · `/api/live` (server-sent events)

**Explore (tokens and NFTs).** Parano1d v2.1 has not published token, pool or NFT RPC yet, so these routes are empty and the page says “Tokens coming with v2.1”. A node `getAssetSnapshot` turns the screener on by itself. Trades are stored on `(token_id, ts)` and rolled into 1-minute OHLCV (`token_candles`); `/api/tokens/:id/candles?tf=1m|5m|15m|1h|4h|1d|1w&before=&limit=` pages those candles (weekly buckets start Monday UTC) with per-candle volume. `/trades`, `/holders` and `/transfers` read the same tables. `?demo=1` (or `TOKENS_DEMO=1`) returns an in-memory sample labeled `demo: true` and does not write it. List filters: `q`, `sort` (`liquidity|volume|age|mcap|fdv|txns|makers|buys|sells|change|progress`), `dir`, `preset` (`trending|new|gainers|graduating|watch`), `window` (`5m|1h|6h|24h`), `page` (25 rows), `ids` (with `preset=watch`), and `min_`/`max_` on `liq`, `vol`, `age` (hours), `mcap`, `txns`, `buys`, `sells`. Amounts in those filters are NOID, not μNOID. `/?demo=1` shows the same sample on the homepage. If the node is unreachable the homepage still shows the Explore card. Collection filters use `sort=volume|floor|items|owners|age` and `min_`/`max_` on `vol`, `floor`, `items`, `owners`, `age`. USD fields use the CoinPaprika NOID price.

A starred token is kept in `localStorage` until the visitor logs in with the account key from `/account`. `GET/POST /api/stars` then stores the list on that account and the browser merges the two.

The indexer calls `paranoid_getAssetSnapshot` and, once that exists, `paranoid_quoteSwap` / `paranoid_buildSwap`. Until then it logs nothing and leaves the tables empty. Snapshot shape and the wallet provider the page expects (`window.parano1d.request`) are documented at the top of `assets.js`.

**Enhanced token info** costs `ENHANCED_PROFILE_USDC` (default 100 USDC), paid by sending that exact amount plus a unique reference suffix to `USDC_PAY_ADDRESS`. USDC stays off until that address is set. `USDC_CHAIN` is `base` (default) or `solana`, and `USDC_RPC_URL` is the RPC the explorer polls. Base matches a confirmed USDC `Transfer` log. Solana matches a finalized balance increase for the wallet, or a transfer into that token account. A different amount does not match, and the payment does not add API credits. Card checkout and the NOID dust payment stay as secondary choices at `ENHANCED_PROFILE_USD` (default: the same number as the USDC price). After payment the row is `pending`. `GET/POST /api/admin` (header `x-admin-token`) approves or rejects it; the route is 404 when `ADMIN_TOKEN` is unset. Only an approved profile is returned as `token.enhanced`. The token page also shows a book beside the chart: `getOpenOrders` when the node has it, otherwise a ladder derived from pool or curve reserves. The label says which. `?demo=1` derives the sample book and does not take payment.

**Swaps are non-custodial and off by default.** The server never holds a key and never signs. `/api/swap/quote` returns `{enabled:false}` unless `SWAP_ENABLED=true`, `SWAP_FEE_ADDRESS` is a valid `o1…` address, and the node exposes both swap methods. The fee (`SWAP_FEE_BPS`, default 50 = 0.50%, maximum 1000) is sent as its own output when `buildSwap` sets `fee_in_tx`; otherwise the quote only itemizes it. `/api/swap/build` returns an unsigned payload for the wallet, and refuses anything that already has a signature. `?demo=1` returns a preview quote from sample reserves and `/api/swap/build` rejects it. A token page shows a locked trade card until that is true. When trading is on, the quote lists the fee and the total before the wallet signs, and the sign button stays off until `window.parano1d` is present. `?demo=1` shows a preview quote and cannot submit.

Errors are JSON `{"error": "…"}`: 400 bad input, 401 missing/unknown key, 402 out of credits (AI), 404 not found, 429 rate limited (`retry-after`), 502 node or upstream unavailable. `/api/stats` has `coverage` (which heights have captured bodies) and `indexer.error`. Holder counts and the rich list are approximate: a sweep reads the Live State over ~20 minutes while blocks keep arriving.

**Reorgs.** The indexer re-reads the last 42 heights each pass. A replaced block is copied into `orphans` in the same transaction before the canonical row is overwritten, and block lists only show a body's tx count/fees when its hash matches the header. If the node's tip goes down by up to 18 blocks, those rows are copied to `orphans` and then removed. A bigger drop is not a normal reorg (node reset or resync): indexing pauses with an error in `/api/stats` and `/api/health`, and nothing is deleted. Heights the node pruned before a body was stored are `gaps`; each pass retries a few against this node and then `ARCHIVE_PEERS`.

**Archive layout.** Block hashes are 32-byte blobs. The body is zstd-compressed JSON. Reward, fees, tx count and time are columns, so a block list does not decompress. An existing text-hash database is migrated on startup. Address totals, the hourly net and miner payout destinations are computed only from stored bodies and are marked partial. `/api/receipts` and `/api/contracts` describe CLI verification; they do not verify anything themselves.

**Full history.** Block headers are never pruned, so the indexer stores every header since genesis (height, hash, time, miner, expected work) and keeps the newest in step, 25 × 200 headers per pass via JSON-RPC batches (`HEADER_BATCH`). On a fresh database the first ~221k headers take a few minutes. Hashrate = expected work per block (`2^256 / target`, target read little-endian) ÷ observed block time; every block hash becomes searchable.

All amounts are integers in μNOID (1 NOID = 1,000,000 μNOID); large values come as decimal strings.

## Deploy (one VPS)

1. **Node:** download the Core release and verify its SHA256. `./parano1d --check-hardware` must report `NODE READY`. Install to `/usr/local/bin`, then `cp deploy/parano1d.service /etc/systemd/system/` and `systemctl enable --now parano1d` (it runs as its own `parano1d` user, data in `/var/lib/parano1d`, RPC on `127.0.0.1:9601`). Never expose the RPC port publicly. Check it with `parano1d-cli status`.
2. **Explorer:** install Node 22+ (Ubuntu's own package is too old: use NodeSource or `nvm`), put this repo in `/opt/noid-scan`, then `useradd -r noidscan`, `cp deploy/noid-scan.service /etc/systemd/system/` and `systemctl enable --now noid-scan`.
3. **TLS:** install Caddy and copy `deploy/Caddyfile` to `/etc/caddy/Caddyfile`. In Cloudflare add A records for `@` and `www` pointing at the droplet, first with the proxy **off** (grey cloud) so Caddy can obtain its certificate; once `https://parano1d-scan.com` loads, set Cloudflare SSL mode to **Full (strict)** and turn the proxy **on** (orange cloud).
4. **Backups:** `cp deploy/noid-scan-backup.service deploy/noid-scan-backup.timer /etc/systemd/system/` and `systemctl enable --now noid-scan-backup.timer`. That runs `scripts/backup.js` daily: `VACUUM INTO` a snapshot under `/var/lib/noid-scan/backups` and keeps 14. Set `BACKUP_DEST=user@host:/path/` in the service to rsync each snapshot off the machine. The snapshot is the only copy of pruned block bodies.
5. **Monitoring:** point an uptime check at `/api/health` (503 when `quick_check` failed, or the indexer is stalled or paused). `/api/stats` still has `indexer.at`, `coverage.gaps` and `coverage.reorgs`. Set `DB_QUICK_CHECK=0` to skip the startup check.

### "disk I/O error" on a long window

`ProtectSystem=strict` makes `/tmp`, `/var/tmp` and the working directory (`/opt/noid-scan`) read-only. A grouped query that no longer fits in memory (supply from 7 days, miners and history from 30 days) asks SQLite for a sort file, the create fails, and the API returns `{"error":"disk I/O error"}`. A 24 h window is small enough to stay in memory, so it still works. The database is not full and a reboot does not change this. The process keeps sorts in memory and, if one still spills, writes it next to `noid.db`. Token charts read `(token_id, time)` indexes instead of grouping.

Check the file (read-only; nothing is deleted) after the new code is on the droplet:

```sh
sudo node /opt/noid-scan/scripts/db-check.js /var/lib/noid-scan/noid.db
curl -fsS http://127.0.0.1:8080/api/health
curl -fsS -H 'sec-fetch-site: same-origin' 'http://127.0.0.1:8080/api/supply?window=7d' | head -c 200
```

`quick_check: ok` means it was the temp directory, not corruption. If the check fails, stop the service and rebuild a **copy** (the live file is not modified):

```sh
sudo systemctl stop noid-scan
sudo node /opt/noid-scan/scripts/db-check.js --repair /var/lib/noid-scan/noid.db
```

The script prints the copy path and the commands to keep a backup and swap it in. Do not delete `noid.db`. `REINDEX` only rebuilds indexes; if the copy is still damaged, the script prints a `sqlite3 .recover` command, which can drop unreadable pages and must land in a new file.
6. **Cloudflare:** do *not* add a cache rule for `/api/*`: API responses are `private` so the CDN cannot hand keyed data to keyless scripts; the server's own 5 s cache and the shared live feed already keep node load flat. In the DigitalOcean cloud firewall allow ports 80/443 only from [Cloudflare's IP ranges](https://www.cloudflare.com/ips/), plus 9600 from anywhere (node peers) and 22 from your IP. That keeps the rate limiter's client IPs honest.

Run the indexer continuously. Any block body it misses is gone once the node prunes it.

### Auto-deploy

`.github/workflows/deploy.yml` runs the tests on every push to `main` and, if they pass, copies the code to the droplet and restarts `noid-scan`. One-time setup on the droplet (as root):

```bash
useradd -m -s /bin/bash deploy
chown -R deploy:deploy /opt/noid-scan
echo 'deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart noid-scan' > /etc/sudoers.d/deploy && chmod 440 /etc/sudoers.d/deploy
sudo -u deploy sh -c 'mkdir -p -m 700 ~/.ssh && ssh-keygen -q -t ed25519 -N "" -C github-deploy -f ~/.ssh/id_deploy && cat ~/.ssh/id_deploy.pub >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'
cat /home/deploy/.ssh/id_deploy
```

Copy the printed private key (all of it, including the `BEGIN`/`END` lines) into the GitHub secret `DEPLOY_KEY`, put the droplet IP in `DEPLOY_HOST`, then delete the server copy: `rm /home/deploy/.ssh/id_deploy`. GitHub's runners connect over SSH, so port 22 must be open to them (key-only login).

## Payments and AI

**Accounts** are API keys (`nk_…`): no email or password. Only the key's SHA-256 is stored. Anyone can create one free on the **API & Credits** page; the key is shown once.

**Prepaid credits**: 1,000 credits = $1, sold in $5 / $20 / $100 packs, never expire. With credits a key gets `PAID_RATE_LIMIT` requests/min and pays 1 credit per 1,000 requests; the AI assistant costs `CHAT_COST` credits per question. Without credits everyone keeps the free tier, including `FREE_CHATS_PER_DAY` AI questions per IP.

**What a request costs.** A keyed request counts only when it returns data (HTTP 200, cached or not). Errors, 404s, the `/live` stream and account/payment routes are free. AI questions are charged separately and refunded when the model call fails. Every request, billed or not, counts toward the per-minute rate limit. `/live` allows 10 streams per IP; a viewer that stops reading is dropped once 256 KB is queued for it (the browser reconnects).

- **Card** (Stripe Checkout): credits are added only by Stripe's signed webhook, never by the browser redirect. Replays are ignored.
- **NOID**: the buyer gets a quote whose last 4 μNOID digits ("dust", e.g. `25.004217 NOID`) identify the order; NOID has no payment memo, so the digits are the link. An output on `PAY_ADDRESS` pays the unpaid order with the same digits only if the order was quoted before the output first appeared (outputs already on the address can never pay a new order) and only after `NOID_CONFIRMATIONS` blocks (default 18: Parano1d consensus can replace up to 18 blocks, `CONSENSUS_FINALITY_DEPTH` in Core; about 9 minutes). A payment that disappears in a reorg before then is never credited. Credits scale with the amount received at the quoted rate. Each output pays once. Claiming the order, the ledger entry and the balance change are one database transaction. Quotes are valid 24 h; an expired order is kept, and its digits stay reserved for 7 more days so a late payment can't match someone else's order: a late payment is credited to the account that ordered it, at the quoted rate. Anything that fails to settle is marked `review` in `noid_seen` and logged. New quotes pause when the live price is older than `PRICE_MAX_AGE_MS` (15 min); orders already quoted keep their price and still settle.
- **AI assistant** (`/chat`): OpenRouter, default `qwen/qwen3.5-flash-02-23`. The model answers by calling the explorer's own routes as tools, so numbers come from the node. A question costs you roughly $0.0005; credits are refunded if the model call fails.

Put secrets in `/etc/noid-scan.env` (`chmod 600`, owned by root), one per line, then `systemctl restart noid-scan`:

```
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
OPENROUTER_API_KEY=sk-or-...
PAY_ADDRESS=o1...
SITE_URL=https://parano1d-scan.com
```

| Env | Default | |
|---|---|---|
| `PAY_ADDRESS` | – | Enables NOID top-ups. Watch-only: the server never holds a wallet secret. Quotes use the live NOID price |
| `USD_PER_NOID` | live price | Pin a fixed NOID price for top-up quotes instead of the live one |
| `NOID_CONFIRMATIONS` / `PRICE_MAX_AGE_MS` | `18` / `900000` | Blocks before a NOID payment is credited; how old the live price may be for new quotes |
| `PRICE_ID` | `noid-parano1d` | CoinPaprika coin id for the price panel (free API, no key; ticker every 3 min, history hourly) |
| `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` | – | Enable card top-ups. In Stripe: Developers → Webhooks → endpoint `https://<site>/api/stripe-webhook`, event `checkout.session.completed` |
| `OPENROUTER_API_KEY` | – | Enables the AI assistant. Set a monthly spending limit on the key in OpenRouter as a hard cap |
| `OPENROUTER_MODEL` | `qwen/qwen3.5-flash-02-23` | Any OpenRouter model with tool calling |
| `CHAT_COST` / `FREE_CHATS_PER_DAY` | `5` / `3` | |
| `PAID_RATE_LIMIT` | `3000` | Requests/min for accounts with credits |
| `LIVE_MS` | `2000` | How often the live feed polls the node (shared by all viewers) |
| `SITE_URL` | `https://parano1d-scan.com` | Where Stripe sends buyers back to |
| `DONATE_ADDRESS` | – | `o1…` address shown in the footer |
| `P2P_PORT` | `9600` | Node P2P port, used to find peer connections for the globe |
| `HOLDERS_EVERY_MS` | `7200000` | How often the Live State is swept (every slot via batched `getSlot`, `SWEEP_BATCH` per request) for the holders count, concentration and rich list. Takes ~20 min on a 2-vCPU droplet with the real state; `/api/holders` reports progress |
| `TOKENS_DEMO` | – | `1` serves the sample token and NFT catalog on every Explore request, still labeled demo, still not written to the database |
| `SWAP_ENABLED` | – | must be the string `true` or the swap panel stays hidden |
| `SWAP_FEE_BPS` | `50` | Front-end fee in basis points (50 = 0.50%). Allowed range 0–1000. A non-integer disables swaps |
| `SWAP_FEE_ADDRESS` | – | `o1…` address that receives the fee output. Swaps stay hidden until this is a valid address |
| `ENHANCED_PROFILE_USDC` | `100` | One-time enhanced-profile price in USDC. Integer from 1 to 1000000; anything else stays 100 |
| `USDC_CHAIN` | `base` | `base` or `solana` |
| `USDC_PAY_ADDRESS` | – | Wallet that receives USDC. Unset keeps USDC payments off |
| `USDC_RPC_URL` | – | HTTPS JSON-RPC for that chain. Required together with the address |
| `USDC_CONFIRMATIONS` | `12` on Base, `0` on Solana | Base logs are read only once they are this many blocks behind the head. Solana uses `finalized` |
| `USDC_LOOKBACK` | `2000` | How many confirmed blocks a Base poll scans |
| `ENHANCED_PROFILE_USD` | same as USDC | Card and NOID price for the same profile. Integer dollars |
| `ADMIN_TOKEN` | – | Secret for `/admin`. Unset hides the review routes |

**Network globe** (home page): countries of peers connected to this explorer's node, read from established TCP connections on `P2P_PORT` in `/proc/net` and resolved to a country with [country.is](https://country.is) (free, no key, cached per IP). Only country codes and counts leave the server. It is one node's view of the network at country level: not miner or user locations, which the chain does not reveal. Each new block draws arcs from the peer countries into the node. The globe is [globe.gl](https://globe.gl) 2.46.2, loaded from jsDelivr only on the home page.

**Checking the books** (read-only; run it any time, nothing is changed):

```sh
sqlite3 /var/lib/noid-scan/noid.db "
  select 'balance differs from ledger', a.id, a.credits, coalesce(sum(l.delta),0) from accounts a left join ledger l on l.account = a.id group by a.id having a.credits != coalesce(sum(l.delta),0);
  select 'paid order without ledger entry', t.id, t.paid_ref from noid_topups t left join ledger l on l.ref = t.paid_ref where t.paid_ref is not null and l.id is null;
  select 'payment needs review', ref, value, topup from noid_seen where status = 'review';"
```

No output means everything matches. The ledger is append-only: fix a mistake with a new entry, never by editing or deleting rows.

Crypto received for a service is ordinary income at its dollar value when received; keep the History tab or `select * from ledger` as your record.
