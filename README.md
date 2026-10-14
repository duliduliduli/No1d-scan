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
| `TRUST_PROXY` | – | Set it behind Caddy/nginx so rate limiting uses `X-Forwarded-For` |
| `DONATE_ADDRESS` | – | `o1…` address shown in the footer |

## API

`/api/stats` · `/api/blocks?before=H&limit=N` · `/api/block/:height|:hash` · `/api/tx/:txid` · `/api/address/:o1…?page=N` · `/api/txs?page=N` · `/api/charts` · `/api/search?q=…`

All amounts are integers in μNOID (1 NOID = 1,000,000 μNOID); large values come as decimal strings. A block hash is searchable only once the explorer has indexed that block, because the node looks blocks up by height only.

## Deploy (one VPS)

1. **Node:** download the Core release and verify its SHA256. `./parano1d --check-hardware` must report `NODE READY`. Install to `/usr/local/bin` and run it under systemd with RPC on `127.0.0.1:9601`. Never expose the RPC port publicly. Check it with `parano1d-cli status`.
2. **Explorer:** put this repo in `/opt/noid-scan`, then `useradd -r noidscan`, `cp deploy/noid-scan.service /etc/systemd/system/` and `systemctl enable --now noid-scan`.
3. **TLS:** install Caddy, edit the domain in `deploy/Caddyfile` and copy it to `/etc/caddy/Caddyfile`.
4. **Backups:** back up `/var/lib/noid-scan/noid.db`. It is the only data the node no longer has.

Run the indexer continuously. Any block body it misses is gone once the node prunes it.

## Monetization

Set `DONATE_ADDRESS` to show a donation address. Ads, sponsorships and a paid API tier can come later, once there is traffic. Don't take custody of user funds.
