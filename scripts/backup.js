// Consistent snapshot of the explorer database. VACUUM INTO copies a quiet file the node no longer has.
// Daily from deploy/noid-scan-backup.timer. Set BACKUP_DEST to rsync it off the machine (user@host:/path/).
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const src = process.env.DB_PATH || path.join(__dirname, '..', 'noid.db');
if (src === ':memory:' || src.endsWith(':memory:')) {
  console.error('backup: DB_PATH is in memory; nothing to copy');
  process.exit(1);
}
const dir = process.env.BACKUP_DIR || path.join(path.dirname(src), 'backups');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const dest = path.join(dir, `noid-${stamp}.db`);
const db = new DatabaseSync(src);
db.exec(`vacuum into '${dest.replace(/'/g, "''")}'`);
db.close();

const keep = Number(process.env.BACKUP_KEEP || 14);
const files = fs.readdirSync(dir).filter((f) => f.startsWith('noid-') && f.endsWith('.db')).sort();
for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.unlinkSync(path.join(dir, f));

if (process.env.BACKUP_DEST) {
  const r = spawnSync('rsync', ['-a', dest, process.env.BACKUP_DEST], { stdio: 'inherit' });
  if (r.error) throw r.error;
  if (r.status) process.exit(r.status);
}
console.log(dest);
