// Preview the UI in this checkout against live chain data, without deploying.
// Pages and static files come from ./public; every /api/* request (including the
// /api/live event stream) is forwarded to the live explorer. Read-only use only:
// anything you submit (receipts, payments) goes to the real server.
//
//   node scripts/preview-live.js              # http://127.0.0.1:8090
//   PREVIEW_API=https://parano1d-scan.com PORT=8090 node scripts/preview-live.js
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const API = new URL(process.env.PREVIEW_API || 'https://parano1d-scan.com');
const PORT = Number(process.env.PORT || 8090);
const PUB = path.join(__dirname, '..', 'public');
const TYPES = { '.ico': 'image/x-icon', '.png': 'image/png', '.js': 'text/javascript; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    const lib = API.protocol === 'https:' ? https : http;
    const up = lib.request(new URL(url.pathname + url.search, API), {
      method: req.method,
      // Only what the API reads; browser cookies and connection headers stay here.
      headers: Object.fromEntries(['accept', 'content-type', 'content-length', 'x-api-key', 'x-admin-token', 'last-event-id', 'sec-fetch-site']
        .filter((h) => req.headers[h]).map((h) => [h, req.headers[h]])),
    }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', (e) => { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); });
    res.on('close', () => up.destroy()); // the browser left (e.g. closed the live stream)
    return req.pipe(up);
  }
  // A known static file, else the single-page app (its router reads the path).
  const file = path.join(PUB, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
  if (file.startsWith(PUB + path.sep) && TYPES[path.extname(file)] && fs.existsSync(file)) {
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] });
    return fs.createReadStream(file).pipe(res);
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  fs.createReadStream(path.join(PUB, 'index.html')).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`preview on http://127.0.0.1:${PORT} (data from ${API.origin})`));
