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
| `CACHE_MS` | `5000` | How long an API response is reused (in memory, and via `Cache-Control` for Cloudflare/browsers) |
| `TRUST_PROXY` | – | Set it behind Caddy/nginx so rate limiting uses `X-Forwarded-For` |
| `DONATE_ADDRESS` | – | `o1…` address shown in the footer |

## API

`/api/stats` · `/api/blocks?before=H&limit=N` · `/api/block/:height|:hash` · `/api/tx/:txid` · `/api/address/:o1…?page=N` · `/api/txs?page=N` · `/api/charts` · `/api/search?q=…`

All amounts are integers in μNOID (1 NOID = 1,000,000 μNOID); large values come as decimal strings. A block hash is searchable only once the explorer has indexed that block, because the node looks blocks up by height only.

## Deploy (one VPS)

1. **Node:** download the Core release and verify its SHA256. `./parano1d --check-hardware` must report `NODE READY`. Install to `/usr/local/bin` and run it under systemd with RPC on `127.0.0.1:9601`. Never expose the RPC port publicly. Check it with `parano1d-cli status`.
2. **Explorer:** install Node 22+ (Ubuntu's own package is too old: use NodeSource or `nvm`), put this repo in `/opt/noid-scan`, then `useradd -r noidscan`, `cp deploy/noid-scan.service /etc/systemd/system/` and `systemctl enable --now noid-scan`.
3. **TLS:** install Caddy and copy `deploy/Caddyfile` to `/etc/caddy/Caddyfile`. In Cloudflare add A records for `@` and `www` pointing at the droplet, first with the proxy **off** (grey cloud) so Caddy can obtain its certificate; once `https://parano1d-scan.com` loads, set Cloudflare SSL mode to **Full (strict)** and turn the proxy **on** (orange cloud).
4. **Backups:** back up `/var/lib/noid-scan/noid.db` (plus its `-wal` file, or use `sqlite3 noid.db '.backup out.db'`). It is the only data the node no longer has.
5. **Monitoring:** point an uptime check at `/api/stats`; its `indexer.at` is the time of the last successful indexer pass. Alert if it is more than a few minutes old.
6. **Cloudflare:** add a cache rule for `/api/*` that respects origin `Cache-Control`, so most visitors never reach the node. In the DigitalOcean cloud firewall allow ports 80/443 only from [Cloudflare's IP ranges](https://www.cloudflare.com/ips/), plus 9600 from anywhere (node peers) and 22 from your IP. That keeps the rate limiter's client IPs honest.

Run the indexer continuously. Any block body it misses is gone once the node prunes it.

## Monetization

Set `DONATE_ADDRESS` to show a donation address. Ads, sponsorships and a paid API tier can come later, once there is traffic. Don't take custody of user funds.
