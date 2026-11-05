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

To check UI changes against real chain data without deploying, `node scripts/preview-live.js` serves this checkout's `public/` on http://127.0.0.1:8090 and forwards `/api/*` to the live explorer (`PREVIEW_API` to change it). Treat it as read-only: anything submitted there reaches the real server.

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

`/api/stats` · `/api/health` (no key: database `quick_check` plus indexer status; 503 when indexing is stalled or paused) · `/api/blocks?before=H&limit=N` · `/api/block/:height|:hash` · `/api/tx/:txid` · `/api/address/:o1…?page=N` · `/api/txs?page=N` · `/api/charts` · `/api/search?q=…` · `/api/history?window=24h|7d|30d|all` · `/api/miners?window=…` · `/api/mempool` · `/api/network` · `/api/price?window=…` (3-minute ticks, market cap, volume, markets) or `/api/price?before=&limit=` (pages the full stored history, newest page when `before` is omitted; `more` is false at the oldest daily close) · `/api/holders?window=…` · `/api/richlist?limit=N` · `/api/supply?window=1h|24h|7d|30d|all` · `/api/candles?interval=15m|1h|4h|1d|1w` (OHLC from the 3-minute samples; without `before`/`limit`, the recent fixed window) and `&before=&limit=` (pages the full stored history at that candle size; `approx` candles are older daily/hourly closes) · `/api/gaps` · `/api/orphans` · `/api/economics` · `/api/receipts` · `/api/contracts` · `/api/tokens` · `/api/token/:id` · `/api/collections` · `/api/collection/:id` · `/api/collections/:id/candles` · `/api/collections/:id/book` · `/api/collections/:id/activity` · `/api/swap/quote` · `/api/swap/build` · `/api/stars` · `/api/boosts` · `/api/live` (server-sent events)

**Explore (tokens and NFTs).** Parano1d v2.1 has not published token, pool or NFT RPC yet, so these routes are empty and the page says “Tokens coming with v2.1”. A node `getAssetSnapshot` turns the screener on by itself. Trades are stored on `(token_id, ts)` and rolled into 1-minute OHLCV (`token_candles`); `/api/tokens/:id/candles?tf=1m|5m|15m|1h|4h|1d|1w&before=&limit=` pages those candles (weekly buckets start Monday UTC) with per-candle volume. `/trades`, `/holders` and `/transfers` read the same tables. `?demo=1` (or `TOKENS_DEMO=1`) returns an in-memory sample labeled `demo: true` and does not write it. List filters: `q`, `sort` (`liquidity|volume|age|mcap|fdv|txns|makers|buys|sells|change|progress`), `dir`, `preset` (`trending|new|gainers|graduating|watch`), `window` (`5m|1h|6h|24h`), `page` (25 rows), `ids` (limit the list to exactly those token ids, favorites included), and `min_`/`max_` on `liq`, `vol`, `age` (hours), `mcap`, `txns`, `buys`, `sells`. Amounts in those filters are NOID, not μNOID. `/?demo=1` shows the same sample on the homepage. If the node is unreachable the homepage still shows the Explore card. Collection filters use `sort=volume|floor|items|owners|age` and `min_`/`max_` on `vol`, `floor`, `items`, `owners`, `age`. `preset=watch` with `ids` limits the list to starred collections (the same account list as tokens, 200 ids). USD fields use the CoinPaprika NOID price.

A collection page uses the token layout. `/api/collections/:id/candles?tf=1m|5m|15m|1h|4h|1d|1w&kind=sale|floor` returns sale-price or floor-price candles. Volume on both is sales μNOID. `/book` is `getNftOrders` when the node has it (`source: orders`, label “NFT orders”); otherwise it groups listings by price (`source: listings`, label “Listings and floor depth”) and bids are empty. `/activity` merges sales and transfers. `?demo=1` fills sales, transfers, listings, traits, both candle series, and an enhanced profile on `stamps`. Live rows stay empty until the snapshot includes `nfts[].traits`, `sales`, `transfers`, and `listings`. Floor history is only the current floor written into the latest minute. The same 100 USDC enhanced profile accepts a collection id in `token_id`.

**Favorites** (`/favorites`, the header link beside Explore, with a live count). One list for tokens, collections and addresses: `/api/stars` stores it on the account, and the browser keeps a copy in `localStorage` until a key exists, then merges the two. Addresses are saved as `addr:o1…`, so a single table holds both. Stars are on every screener row, every token and collection page, every address page and every wallet portfolio row; a labelled ☆ Save / ★ Saved button sits in the token and address headers, and the mobile action bar uses the same wording. The page shows a token table with price, 24h change, volume and mcap, an address row with balance and blocks mined, and one-tap remove. `?preset=watch` on `/explore` still filters to the same list; with no `ids` it now means "nothing saved yet" rather than the whole catalog.

The indexer calls `paranoid_getAssetSnapshot` and, once that exists, `paranoid_quoteSwap` / `paranoid_buildSwap`. Until then it logs nothing and leaves the tables empty. Snapshot shape and the wallet provider the page expects (`window.parano1d.request`) are documented at the top of `assets.js`.

**Enhanced token info** costs `ENHANCED_PROFILE_USDC` (default 100 USDC). The buyer picks a chain at checkout. `USDC_EVM_ADDRESS` is one checksummed wallet that turns on Ethereum, Base, Arbitrum, Optimism, Polygon, and Avalanche together. `USDC_SOLANA_ADDRESS` is optional. `USDC_<CHAIN>_ADDRESS` overrides that one chain. An address that fails the EIP-55 checksum or the Solana base58 check is logged when the process starts and that chain stays off. The server never creates a key. The watched token is native Circle USDC, hardcoded per chain, not a bridged token and not an env var. EVM chains match a confirmed `Transfer` log of the exact base-unit amount (the price plus a unique 6-digit reference). Solana matches a finalized balance increase, or a transfer into that token account, for that same amount. A different amount does not match. One transaction settles only one order, and the same transaction cannot be applied again. The payment does not add API credits. The pages do not name an operating company. NOID (the dust payment) and USDC are the two ways to pay at `ENHANCED_PROFILE_USD`/`ENHANCED_PROFILE_USDC`; there is no card checkout. After payment the row is `pending`. `GET/POST /api/admin` (header `x-admin-token`) approves or rejects it; the route is 404 when `ADMIN_TOKEN` is unset. Only an approved profile is returned as `token.enhanced` or `collection.enhanced`. The token page shows a live transaction feed (age, buy or sell, USD, token amount, NOID, price, maker, tx) with amount, type, and maker filters, and a My trades toggle once you are logged in. A maker opens a wallet page with holdings, trades, and PnL from the indexed fills. The header lists price, 5m/1h/6h/24h change, txns, buys/sells, volume, makers, liquidity, FDV, market cap, and pair age, plus share and copy-address. Beside the chart, the page also shows a book: `getOpenOrders` when the node has it, otherwise a ladder derived from pool or curve reserves. The label says which. `?demo=1` derives the sample book and does not take payment.

**Promoted slots** are a separate list on Explore and the homepage (`GET /api/boosts?kind=token|collection&asset=`). A project buys one with `POST /api/boost` then `POST /api/boost-pay` (USDC only, same chains and exact-amount check as an enhanced profile). The amount is the pack’s whole USDC plus a unique suffix. The body includes `chain`. After the transfer the row is `pending`. An admin approves it with `POST /api/admin` and `{"kind":"boost"}`. It then shows in the Promoted section until `ends`, and the next read marks it expired. It is not part of the `/api/tokens` or `/api/collections` sort. The label is Promoted. Enhanced profiles stay labeled Enhanced. Both use the line “Paid promotion. Not a recommendation or endorsement by NOID Scan.” `?demo=1` shows sample slots for `gcat` and `stamps` and does not take payment.

**Swaps are non-custodial and off by default.** The server never holds a key and never signs. `/api/swap/quote` returns `{enabled:false}` unless `SWAP_ENABLED=true`, `SWAP_FEE_ADDRESS` is a valid `o1…` address, and the node exposes both swap methods. The fee (`SWAP_FEE_BPS`, default 50 = 0.50%, maximum 1000) is sent as its own output when `buildSwap` sets `fee_in_tx`; otherwise the quote only itemizes it. `/api/swap/build` returns an unsigned payload for the wallet, and refuses anything that already has a signature. `?demo=1` returns a preview quote from sample reserves and `/api/swap/build` rejects it. A token page shows a locked trade card until that is true. When trading is on, the quote lists the fee and the total before the wallet signs, and the sign button stays off until `window.parano1d` is present. `?demo=1` shows a preview quote and cannot submit.

Errors are JSON `{"error": "…"}`: 400 bad input, 401 missing/unknown key, 402 out of credits, 404 not found, 429 rate limited (`retry-after`), 502 node or upstream unavailable. `/api/stats` has `coverage` (which heights have captured bodies) and `indexer.error`. Holder counts and the rich list are approximate: a sweep reads the Live State over ~20 minutes while blocks keep arriving.

**Reorgs.** The indexer re-reads the last 42 heights each pass. A replaced block is copied into `orphans` in the same transaction before the canonical row is overwritten, and block lists only show a body's tx count/fees when its hash matches the header. If the node's tip goes down by up to 18 blocks, those rows are copied to `orphans` and then removed. A bigger drop is not a normal reorg (node reset or resync): indexing pauses with an error in `/api/stats` and `/api/health`, and nothing is deleted. Heights the node pruned before a body was stored are `gaps`; each pass retries a few against this node and then `ARCHIVE_PEERS`.

**Archive layout.** Block hashes are 32-byte blobs. The body is zstd-compressed JSON. Reward, fees, tx count and time are columns, so a block list does not decompress. An existing text-hash database is migrated on startup. Address totals, the hourly net and miner payout destinations are computed only from stored bodies and are marked partial. `POST /api/receipts` verifies a pasted payment or contract receipt on the node. A txid is not a public receipt: `walletExportReceipt` only exports this node’s own wallet and is not exposed. `/api/contracts` lists call and close transactions from stored bodies, plus the six templates. A stored body does not name the template.

**Full history.** Block headers are never pruned, so the indexer stores every header since genesis (height, hash, time, miner, expected work) and keeps the newest in step, 25 × 200 headers per pass via JSON-RPC batches (`HEADER_BATCH`). On a fresh database the first ~221k headers take a few minutes. Hashrate = expected work per block (`2^256 / target`, target read little-endian) ÷ observed block time; every block hash becomes searchable.

All amounts are integers in μNOID (1 NOID = 1,000,000 μNOID); large values come as decimal strings.

## Wallet

The wallet in a browser is the account. Its public `o1…` address is remembered in `localStorage` (`no1d_wallet_identity_v1`), so the account page, the portfolio and the trade panel all know who you are without a key and without ever seeing a seed. `POST /api/link {address}` attaches that address to an API key (`POST /api/unlink` clears it, one account per address, `409` if taken), and `GET /api/me` answers with `wallet`. Holdings come from the node itself: `paranoid_getNativeHoldings {owner}` lists the address's state pages, a kind-2 page is one token balance (magic `NOIDAS21`, 32-byte asset id, little-endian u64 of micro-units at byte 76), and several pages of the same token are summed. The indexed `token_holders` table is only a fallback for a node that does not answer.


`/wallet` is a self-custody Parano1d wallet that runs in the visitor's browser.
It makes a 24-word seed from the browser's own randomness, derives `o1…`
addresses on the device, and keeps the seed only as an AES-GCM blob under a
passphrase the user picks. Nothing about the seed is ever sent to this server.

* `public/wallet.js` — the wallet: seed words, keystore, page, and the
  `window.parano1d` provider the DEX card already looks for.
* `public/noid-wallet.wasm` — the address engine, built from the chain's own
  source (Apache-2.0) with `cargo build --release --target wasm32-unknown-unknown`.
  `noid_wallet_address_text(seed, index, out)` derives exactly the address a
  daemon derives for the same master secret; verified against a live node wallet.
* `public/bip39.txt` — the standard BIP39 English list, so a phrase written here
  restores 256 bits of entropy that a desktop wallet accepts.

Spending is deliberately absent: Parano1d authorizes a payment with a
zero-knowledge proof, not a signature, and this build ships the address engine
only. The send and trade buttons are disabled and say so. Wiring them means
bundling the chain's authorization prover as wasm, which compiles for
`wasm32-unknown-unknown` (verified) and is the next step.

The seed writes the same 48-byte `wallet.key` a node reads (`noid_plain_key_1`
plus 32 secret bytes), so it can be exported from the wallet and used to run the
chain's own wallet, or imported from one.

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

## Payments

**Accounts** are API keys (`nk_…`): no email or password. Only the key's SHA-256 is stored. Anyone can create one free on the **API & Credits** page; the key is shown once.

**Prepaid credits, bought with NOID only.** Three plans, priced directly in NOID so a quote never depends on the USD price feed: Starter 5 NOID = 1,000 credits, Pro 10 NOID = 3,000, Scale 20 NOID = 8,000. Credits never expire and there is no subscription. With credits a key gets `PAID_RATE_LIMIT` requests/min and pays 1 credit per 1,000 requests. Without credits everyone keeps the free tier. The explorer has no AI assistant: the pages, the route and the module are gone. There is no card rail: `POST /api/topup` takes `{"plan":"starter|pro|scale"}` and answers a NOID quote.

**What a request costs.** A keyed request counts only when it returns data (HTTP 200, cached or not). Errors, 404s, the `/live` stream and account/payment routes are free. Every request, billed or not, counts toward the per-minute rate limit. `/live` allows 10 streams per IP; a viewer that stops reading is dropped once 256 KB is queued for it (the browser reconnects).

- **NOID** (the only way to buy credits): the buyer gets a quote whose last 4 μNOID digits ("dust", e.g. `5.004217 NOID`) identify the order; NOID has no payment memo, so the digits are the link. An output on `PAY_ADDRESS` pays the unpaid order with the same digits only if the order was quoted before the output first appeared (outputs already on the address can never pay a new order) and only after `NOID_CONFIRMATIONS` blocks (default 18: Parano1d consensus can replace up to 18 blocks, `CONSENSUS_FINALITY_DEPTH` in Core; about 9 minutes). A payment that disappears in a reorg before then is never credited. Credits scale with the amount received at the quoted rate. Each output pays once. Claiming the order, the ledger entry and the balance change are one database transaction. Quotes are valid 24 h; an expired order is kept, and its digits stay reserved for 7 more days so a late payment can't match someone else's order: a late payment is credited to the account that ordered it, at the quoted rate. Anything that fails to settle is marked `review` in `noid_seen` and logged.

Put secrets in `/etc/noid-scan.env` (`chmod 600`, owned by root), one per line, then `systemctl restart noid-scan`:

```
PAY_ADDRESS=o1...
SITE_URL=https://parano1d-scan.com
```

| Env | Default | |
|---|---|---|
| `PAY_ADDRESS` | – | Enables NOID top-ups and NOID promo quotes. Watch-only: the server never holds a wallet secret |
| `USD_PER_NOID` | live price | Pin the NOID price used for USD-based promo quotes (API plans are fixed in NOID and ignore it) |
| `NOID_CONFIRMATIONS` / `PRICE_MAX_AGE_MS` | `18` / `900000` | Blocks before a NOID payment is credited; how old the live price may be for USD-based promo quotes |
| `PRICE_ID` | `noid-parano1d` | CoinPaprika coin id for the price panel (free API, no key; ticker every 3 min, history hourly) |
| `SITE_URL` | `https://parano1d-scan.com` | Canonical site URL used in links and redirects |
| `PAID_RATE_LIMIT` | `3000` | Requests/min for accounts with credits |
| `LIVE_MS` | `2000` | How often the live feed polls the node (shared by all viewers) |
| `DONATE_ADDRESS` | – | `o1…` address shown in the footer |
| `P2P_PORT` | `9600` | Node P2P port, used to find peer connections for the globe |
| `HOLDERS_EVERY_MS` | `7200000` | How often the Live State is swept (every slot via batched `getSlot`, `SWEEP_BATCH` per request) for the holders count, concentration and rich list. Takes ~20 min on a 2-vCPU droplet with the real state; `/api/holders` reports progress |
| `TOKENS_DEMO` | – | `1` serves the sample token and NFT catalog on every Explore request, still labeled demo, still not written to the database |
| `SWAP_ENABLED` | – | must be the string `true` or the swap panel stays hidden |
| `SWAP_FEE_BPS` | `50` | Front-end fee in basis points (50 = 0.50%). Allowed range 0–1000. A non-integer disables swaps |
| `SWAP_FEE_ADDRESS` | – | `o1…` address that receives the fee output. Swaps stay hidden until this is a valid address |
| `ENHANCED_PROFILE_USDC` | `100` | One-time enhanced-profile price in USDC. Integer from 1 to 1000000; anything else stays 100 |
| `USDC_EVM_ADDRESS` | – | Checksummed `0x` wallet. Enables Ethereum, Base, Arbitrum, Optimism, Polygon, and Avalanche. A bad checksum leaves those chains off unless a chain override is valid |
| `USDC_SOLANA_ADDRESS` | – | Optional base58 wallet for Solana. A bad address leaves Solana off |
| `USDC_<CHAIN>_ADDRESS` | – | Optional override for one chain (`ETHEREUM`, `BASE`, `ARBITRUM`, `OPTIMISM`, `POLYGON`, `AVALANCHE`, `SOLANA`). Invalid: that chain stays off |
| `USDC_<CHAIN>_RPC_URL` | – | JSON-RPC for that chain. A chain with an address and no RPC is listed, and checkout on it returns 503 |
| `USDC_<CHAIN>_CONFIRMATIONS` | Ethereum 12, Base 12, Arbitrum 12, Optimism 12, Polygon 128, Avalanche 1, Solana 0 | EVM logs are read only once they are this many blocks behind the head. Solana always reads `finalized` |
| `USDC_LOOKBACK` | `2000` | How many confirmed blocks an EVM poll scans |
| `ENHANCED_PROFILE_USD` | same as USDC | Card and NOID price for the same profile. Integer dollars |
| `ADMIN_TOKEN` | – | Secret for `/admin`. Unset hides the review routes |
| `BOOST_PACKS` | `12:6h,40:1d,100:7d` | Promoted-slot prices as `usdc:6h` or `usdc:7d`, comma-separated, up to 8. Empty or invalid disables new purchases. A live slot still shows until it ends |

Native Circle USDC contracts the poll watches, and will not swap for a bridged token: Ethereum `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, Base `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, Arbitrum `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`, Optimism `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85`, Polygon PoS `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`, Avalanche C-Chain `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E`, Solana `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.

**Network globe** (home page): countries of peers connected to this explorer's node, read from established TCP connections on `P2P_PORT` in `/proc/net` and resolved to a country with [country.is](https://country.is) (free, no key, cached per IP, and free for commercial use, which is why it replaces ip-api.com's non-commercial free tier). Only country codes and counts leave the server. It is one node's view of the network at country level: not miner or user locations, which the chain does not reveal. Each new block draws arcs from the peer countries into the node. The globe is [globe.gl](https://globe.gl) 2.46.2, loaded from jsDelivr only on the home page.

**Checking the books** (read-only; run it any time, nothing is changed):

```sh
sqlite3 /var/lib/noid-scan/noid.db "
  select 'balance differs from ledger', a.id, a.credits, coalesce(sum(l.delta),0) from accounts a left join ledger l on l.account = a.id group by a.id having a.credits != coalesce(sum(l.delta),0);
  select 'paid order without ledger entry', t.id, t.paid_ref from noid_topups t left join ledger l on l.ref = t.paid_ref where t.paid_ref is not null and l.id is null;
  select 'payment needs review', ref, value, topup from noid_seen where status = 'review';"
```

No output means everything matches. The ledger is append-only: fix a mistake with a new entry, never by editing or deleting rows.

Crypto received for a service is ordinary income at its dollar value when received; keep the History tab or `select * from ledger` as your record.

## Seeding our own token

`/verified` sells an enhanced profile. Our own listings are seeded instead of bought:

```bash
DB_PATH=/var/lib/noid-scan/noid.db node scripts/seed-profile.js --token <asset_id> \
  --website https://noidcat.com --x https://x.com/no1dcat \
  --icon-url https://noidcat.com/assets/logo-512.png --banner-url https://noidcat.com/assets/banner.jpg \
  --description "…" --boost 7d
```

Safe to re-run: it updates the existing row. Icon max 512×512/256 KB, banner max 1500×500/1 MB.
