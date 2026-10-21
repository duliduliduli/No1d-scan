#!/usr/bin/env node
// Read-only check of noid.db. Never deletes or rewrites the live file.
//
//   node scripts/db-check.js [/var/lib/noid-scan/noid.db]
//   node scripts/db-check.js --full /var/lib/noid-scan/noid.db
//   node scripts/db-check.js --repair /var/lib/noid-scan/noid.db
//
// --full is PRAGMA integrity_check (every page; slower than quick_check).
// --repair runs only when the check fails. It writes a sibling copy with VACUUM INTO,
// REINDEXes that copy, and checks the copy. Swap it in by hand; the original stays.
'use strict';
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const args = process.argv.slice(2);
const full = args.includes('--full');
const repair = args.includes('--repair');
const file = args.find((a) => !a.startsWith('--')) || process.env.DB_PATH || '/var/lib/noid-scan/noid.db';
const values = (rows) => rows.map((r) => String(Object.values(r)[0]));

function check(db, pragma) {
  const rows = values(db.prepare(`pragma ${pragma}`).all());
  return { ok: rows.length === 1 && rows[0] === 'ok', rows };
}

if (!fs.existsSync(file)) {
  console.error(`no database at ${file}`);
  process.exit(1);
}
const db = new DatabaseSync(file, { readOnly: true });
const pragma = full ? 'integrity_check' : 'quick_check';
let result;
try { result = check(db, pragma); }
catch (e) { console.error(`${pragma}: ${e.message}`); process.exit(1); }
finally { db.close(); }
console.log(`${pragma}: ${result.ok ? 'ok' : result.rows.slice(0, 20).join('\n')}`);
if (result.ok) {
  console.log('Pages are readable. "disk I/O error" on a long /api/supply or /api/miners window is a sort');
  console.log('tempfile failing under ProtectSystem=strict (/tmp, /var/tmp and /opt/noid-scan are read-only),');
  console.log('not corruption. Restart noid-scan on the fixed build and it stops.');
  if (repair) {
    console.error('Refusing --repair: the check passed, so there is nothing to rebuild.');
    process.exit(2);
  }
  process.exit(0);
}
console.error('Check failed. The original database is left as it is.');
if (!repair) {
  console.error('Stop noid-scan, then re-run with --repair to write a rebuilt copy beside this file.');
  process.exit(1);
}
const copy = `${file}.repair-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const rw = new DatabaseSync(file);
try {
  rw.exec('pragma busy_timeout = 8000');
  rw.exec(`vacuum into '${copy.replace(/'/g, "''")}'`);
} catch (e) {
  console.error(`Could not copy: ${e.message}`);
  console.error('If the file is locked: sudo systemctl stop noid-scan');
  process.exit(1);
} finally { rw.close(); }
const copyDb = new DatabaseSync(copy);
let again;
try {
  copyDb.exec('reindex');
  again = check(copyDb, 'quick_check');
} finally { copyDb.close(); }
console.log(`copy ${copy}`);
console.log(`quick_check after reindex: ${again.ok ? 'ok' : again.rows.slice(0, 20).join('\n')}`);
if (!again.ok) {
  console.error('The copy is still damaged. REINDEX only rebuilds indexes. Table-page damage needs a');
  console.error('manual recover into a new file, which can drop unreadable pages. Keep the original:');
  console.error(`  sqlite3 ${file} .recover | sqlite3 ${file}.recovered`);
  process.exit(1);
}
console.log('Original left in place. To swap, after you have looked at the copy:');
console.log('  sudo systemctl stop noid-scan');
console.log(`  sudo cp -a ${file} ${file}.bak-$(date +%Y%m%d%H%M%S)`);
console.log(`  sudo cp -a ${copy} ${file}`);
console.log(`  sudo chown noidscan:noidscan ${file}`);
console.log('  sudo systemctl start noid-scan');
