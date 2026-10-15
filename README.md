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
| `DB_PATH` | `./noid.db` | SQLite file |
| `PORT` / `HOST` | `8080` / `127.0.0.1` | |
| `RATE_LIMIT` | `120` | API requests per IP per minute |
| `CACHE_MS` | `5000` | How long an API response is reused in server memory (and by the visitor's browser) |
| `TRUST_PROXY` | – | Set it behind Caddy/nginx so rate limiting uses `X-Forwarded-For` |
| `DONATE_ADDRESS` | – | `o1…` address shown in the footer |

## API

`/api/stats` · `/api/blocks?before=H&limit=N` · `/api/block/:height|:hash` · `/api/tx/:txid` · `/api/address/:o1…?page=N` · `/api/txs?page=N` · `/api/charts` · `/api/search?q=…` · `/api/history?window=24h|7d|30d|all` · `/api/miners?window=…` · `/api/mempool` · `/api/network` · `/api/price?window=…` (3-minute ticks, market cap, volume, markets) · `/api/holders?window=…` · `/api/richlist?limit=N` · `/api/supply?window=…` · `/api/live` (server-sent events)

Errors are JSON `{"error": "…"}`: 400 bad input, 401 missing/unknown key, 402 out of credits (AI), 404 not found, 429 rate limited (`retry-after`), 502 node or upstream unavailable. `/api/stats` has `coverage` (which heights have captured bodies) and `indexer.error`. Holder counts and the rich list are approximate: a sweep reads the Live State over ~20 minutes while blocks keep arriving.

**Reorgs.** The indexer re-reads the last 42 heights each pass, so a replaced block is overwritten, and block lists only show a body's tx count/fees when its hash matches the header. If the node's tip goes down by up to 17 blocks, rows above it are removed. A bigger drop is not a normal reorg (node reset or resync): indexing pauses with an error in `/api/stats` and nothing is deleted.

**Full history.** Block headers are never pruned, so the indexer stores every header since genesis (height, hash, time, miner, expected work) and keeps the newest in step, 25 × 200 headers per pass via JSON-RPC batches (`HEADER_BATCH`). On a fresh database the first ~221k headers take a few minutes. Hashrate = expected work per block (`2^256 / target`, target read little-endian) ÷ observed block time; every block hash becomes searchable.

All amounts are integers in μNOID (1 NOID = 1,000,000 μNOID); large values come as decimal strings.

## Deploy (one VPS)

1. **Node:** download the Core release and verify its SHA256. `./parano1d --check-hardware` must report `NODE READY`. Install to `/usr/local/bin`, then `cp deploy/parano1d.service /etc/systemd/system/` and `systemctl enable --now parano1d` (it runs as its own `parano1d` user, data in `/var/lib/parano1d`, RPC on `127.0.0.1:9601`). Never expose the RPC port publicly. Check it with `parano1d-cli status`.
2. **Explorer:** install Node 22+ (Ubuntu's own package is too old: use NodeSource or `nvm`), put this repo in `/opt/noid-scan`, then `useradd -r noidscan`, `cp deploy/noid-scan.service /etc/systemd/system/` and `systemctl enable --now noid-scan`.
3. **TLS:** install Caddy and copy `deploy/Caddyfile` to `/etc/caddy/Caddyfile`. In Cloudflare add A records for `@` and `www` pointing at the droplet, first with the proxy **off** (grey cloud) so Caddy can obtain its certificate; once `https://parano1d-scan.com` loads, set Cloudflare SSL mode to **Full (strict)** and turn the proxy **on** (orange cloud).
4. **Backups:** back up `/var/lib/noid-scan/noid.db` (plus its `-wal` file, or use `sqlite3 noid.db '.backup out.db'`). It is the only data the node no longer has.
5. **Monitoring:** point an uptime check at `/api/stats`; its `indexer.at` is the time of the last successful indexer pass. Alert if it is more than a few minutes old.
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
- **NOID**: the buyer gets a quote whose last 4 μNOID digits ("dust", e.g. `25.004217 NOID`) identify the order; NOID has no payment memo, so the digits are the link. An output on `PAY_ADDRESS` pays the unpaid order with the same digits only if the order was quoted before the output first appeared (outputs already on the address can never pay a new order) and only after `NOID_CONFIRMATIONS` blocks (default 17, Parano1d's maximum reorg depth; about 9 minutes). A payment that disappears in a reorg before then is never credited. Credits scale with the amount received at the quoted rate. Each output pays once. Claiming the order, the ledger entry and the balance change are one database transaction. Quotes are valid 24 h; an expired order is kept, and its digits stay reserved for 7 more days so a late payment can't match someone else's order: a late payment is credited to the account that ordered it, at the quoted rate. Anything that fails to settle is marked `review` in `noid_seen` and logged. New quotes pause when the live price is older than `PRICE_MAX_AGE_MS` (15 min); orders already quoted keep their price and still settle.
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
| `NOID_CONFIRMATIONS` / `PRICE_MAX_AGE_MS` | `17` / `900000` | Blocks before a NOID payment is credited; how old the live price may be for new quotes |
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
