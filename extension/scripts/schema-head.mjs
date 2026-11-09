// Print the highest applied migration version in a SQLite database, or 0 when the table is absent.
// Used by the hub deploy helper (R-034 #8): `predeploy-backup` records the head, and `rollback`
// restores the pre-deploy snapshot only when a forward migration raised it.
//
// Read-only and closed immediately. The path is the first argument; a missing/unreadable file is an
// error (the caller treats no output as "unknown" and skips the restore).
import Database from 'better-sqlite3';

const file = process.argv[2];
if (!file) {
  process.stderr.write('usage: schema-head.mjs <data.db>\n');
  process.exit(2);
}

let db;
try {
  db = new Database(file, { readonly: true, fileMustExist: true });
  const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get();
  process.stdout.write(`${Number(row?.v) || 0}\n`);
} catch (err) {
  // A database before the first migration (or a missing schema table) is head 0, not a crash.
  if (/no such table/i.test(String(err?.message))) process.stdout.write('0\n');
  else {
    process.stderr.write(`schema-head: ${err?.message || err}\n`);
    process.exitCode = 1;
  }
} finally {
  try { db?.close(); } catch { /* closed */ }
}
