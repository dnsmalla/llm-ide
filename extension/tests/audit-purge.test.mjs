// Audit-log retention: purgeOldAuditRows deletes rows older than the cutoff
// and keeps recent ones. The audit log otherwise grows unbounded (a privacy +
// DB-bloat limitation), so a retention sweep runs on the auth GC interval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const { purgeOldAuditRows } = await import('../server/audit.mjs');

function auditDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT,
      request_id  TEXT,
      ip          TEXT,
      user_agent  TEXT,
      action      TEXT NOT NULL,
      resource    TEXT,
      outcome     TEXT NOT NULL DEFAULT 'success',
      detail      TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  return db;
}

test('purgeOldAuditRows deletes rows older than ageDays and keeps recent ones', () => {
  const db = auditDb();
  const ins = db.prepare(
    `INSERT INTO audit_log (action, created_at) VALUES (?, datetime('now', ?))`,
  );
  ins.run('old.event', '-200 days');     // well past a 90-day cutoff
  ins.run('old.event2', '-91 days');     // just past the cutoff
  ins.run('recent.event', '-1 days');    // inside the window
  ins.run('now.event', '0 days');        // brand new

  const purged = purgeOldAuditRows(db, 90);
  assert.equal(purged, 2, 'two rows older than 90 days should be deleted');

  const remaining = db.prepare('SELECT action FROM audit_log ORDER BY id').all().map((r) => r.action);
  assert.deepEqual(remaining, ['recent.event', 'now.event']);
});

test('purgeOldAuditRows defaults to a 90-day retention window', () => {
  const db = auditDb();
  db.prepare(`INSERT INTO audit_log (action, created_at) VALUES (?, datetime('now', ?))`).run('stale', '-120 days');
  const purged = purgeOldAuditRows(db);
  assert.equal(purged, 1);
});

test('purgeOldAuditRows falls back to 90 days on ageDays=0 (does not wipe recent rows)', () => {
  const db = auditDb();
  const ins = db.prepare(`INSERT INTO audit_log (action, created_at) VALUES (?, datetime('now', ?))`);
  ins.run('recent', '-1 days');
  ins.run('old', '-200 days');
  // 0 is falsy — must NOT mean "delete everything"; falls back to 90-day retention.
  const purged = purgeOldAuditRows(db, 0);
  assert.equal(purged, 1, 'only the >90d row should go');
  assert.deepEqual(db.prepare('SELECT action FROM audit_log').all().map(r => r.action), ['recent']);
})

test('purgeOldAuditRows treats a negative ageDays as the 90-day default, not an invalid modifier', () => {
  const db = auditDb();
  db.prepare(`INSERT INTO audit_log (action, created_at) VALUES (?, datetime('now', ?))`).run('old', '-200 days');
  // -5 would build "--5 days" (invalid → silent no-op); the guard normalizes to 90.
  const purged = purgeOldAuditRows(db, -5);
  assert.equal(purged, 1);
})
