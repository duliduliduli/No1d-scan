// First-party seed: an approved profile and a live promoted slot for the project's own token.
// No account, no payment, no admin token. Uses the same image checks as the public form.
// Usage:
//   DB_PATH=/var/lib/noid-scan/noid.db node scripts/seed-profile.js \
//     --token <asset_id> --name NOIDCAT --website https://noidcat.com --x https://x.com/no1dcat \
//     --icon-url https://noidcat.com/assets/logo-512.png --banner-url https://noidcat.com/assets/banner.jpg \
//     --description "Grey cat, tinfoil hat, side eye." --boost 7d
const { DatabaseSync } = require('node:sqlite');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const images = require('../images.js');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i].replace(/^--/, '');
  if (!k || !process.argv[i + 1]) break;
  args[k] = process.argv[i + 1];
}
const die = (m) => { console.error(`seed-profile: ${m}`); process.exit(1); };
const DB = process.env.DB_PATH || args.db;
if (!DB) die('set DB_PATH');
if (!/^[A-Za-z0-9:_-]{1,80}$/.test(args.token || '')) die('--token <asset_id> is required');

const grab = async (url, kind) => {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) die(`${kind} fetch ${r.status} from ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return images.prepare(buf, kind);
};

(async () => {
  const icon = await grab(args['icon-url'], 'icon');
  const banner = await grab(args['banner-url'], 'banner');
  const db = new DatabaseSync(DB);
  require('../profiles.js')(db);              // creates the table if the app never ran here
  require('../boosts.js')(db, () => true);    // same for boosts, and its extra columns
  const now = Date.now();
  const rows = db.prepare("select id from token_profiles where token_id = ?").all(args.token);
  const id = rows[0]?.id ?? randomBytes(8).toString('hex');
  db.prepare(`insert into token_profiles (id, token_id, account, description, website, twitter, icon, icon_type, banner, banner_type, status, created, reviewed)
      values (?, ?, 'seed', ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?)
      on conflict(id) do update set description = excluded.description, website = excluded.website,
        twitter = excluded.twitter, icon = excluded.icon, icon_type = excluded.icon_type,
        banner = excluded.banner, banner_type = excluded.banner_type, status = 'approved', reviewed = excluded.reviewed`)
    .run(id, args.token, args.description ?? '', args.website ?? null, args.x ?? null,
      icon.bytes, icon.type, banner.bytes, banner.type, now, now);
  console.log(`profile ${id} approved for ${args.token}`);

  if (args.boost) {
    const secs = /^\d+d$/.test(args.boost) ? Number(args.boost.slice(0, -1)) * 86400
      : /^\d+h$/.test(args.boost) ? Number(args.boost.slice(0, -1)) * 3600 : null;
    if (!secs) die('--boost looks like 6h, 1d or 7d');
    db.prepare("update boosts set status = 'expired' where asset_id = ? and status = 'live'").run(args.token);
    db.prepare(`insert into boosts (id, asset_id, kind, account, pack, usdc, secs, status, created, reviewed, starts, ends)
        values (?, ?, 'token', 'seed', ?, 100, ?, 'live', ?, ?, ?, ?)`)
      .run(randomBytes(8).toString('hex'), args.token, args.boost, secs, now, now, now, now + secs * 1000);
    console.log(`boost live for ${args.boost}`);
  }
  console.log(`verify: ${path.basename(DB)} updated. Profile is approved, so the banner and links show on the token page.`);
})();
