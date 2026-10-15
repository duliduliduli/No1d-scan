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

1. **Node:** download the Core release and verify its SHA256. `./parano1d --check-hardware` must report `NODE READY`. Install to `/usr/local/bin`, then `cp deploy/parano1d.service /etc/systemd/system/` and `systemctl enable --now parano1d` (it runs as its own `parano1d` user, data in `/var/lib/parano1d`, RPC on `127.0.0.1:9601`). Never expose the RPC port publicly. Check it with `parano1d-cli status`.
2. **Explorer:** install Node 22+ (Ubuntu's own package is too old: use NodeSource or `nvm`), put this repo in `/opt/noid-scan`, then `useradd -r noidscan`, `cp deploy/noid-scan.service /etc/systemd/system/` and `systemctl enable --now noid-scan`.
3. **TLS:** install Caddy and copy `deploy/Caddyfile` to `/etc/caddy/Caddyfile`. In Cloudflare add A records for `@` and `www` pointing at the droplet, first with the proxy **off** (grey cloud) so Caddy can obtain its certificate; once `https://parano1d-scan.com` loads, set Cloudflare SSL mode to **Full (strict)** and turn the proxy **on** (orange cloud).
4. **Backups:** back up `/var/lib/noid-scan/noid.db` (plus its `-wal` file, or use `sqlite3 noid.db '.backup out.db'`). It is the only data the node no longer has.
5. **Monitoring:** point an uptime check at `/api/stats`; its `indexer.at` is the time of the last successful indexer pass. Alert if it is more than a few minutes old.
6. **Cloudflare:** add a cache rule for `/api/*` that respects origin `Cache-Control`, so most visitors never reach the node. In the DigitalOcean cloud firewall allow ports 80/443 only from [Cloudflare's IP ranges](https://www.cloudflare.com/ips/), plus 9600 from anywhere (node peers) and 22 from your IP. That keeps the rate limiter's client IPs honest.

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

## Monetization

Set `DONATE_ADDRESS` to show a donation address in the footer.

**Paid API keys, bought in NOID.** Set `PAY_ADDRESS` to an `o1…` address you control and the `/api-access` page goes live. Each buyer gets a quote with a unique fractional amount (e.g. `25.004217 NOID`); when a slot with exactly that value lands on `PAY_ADDRESS`, the indexer issues a 32-hex key automatically. Keys go in an `x-api-key` header or `?key=` and raise the rate limit to `PAID_RATE_LIMIT`.

| Env | Default | |
|---|---|---|
| `PAY_ADDRESS` | – | Your receiving address (watch-only: the server never holds a secret) |
| `KEY_PRICE_NOID` | `25` | Price per key |
| `KEY_DAYS` | `30` | Key lifetime |
| `PAID_RATE_LIMIT` | `3000` | Requests/min for paid keys |

Unpaid quotes expire after 24 h. A payment that arrives late or with the wrong amount is not matched; handle those by hand (`sqlite3 noid.db "select * from orders where created > ..."`) and spend the funds normally from your wallet. Payments are visible on-chain like any NOID transfer.
