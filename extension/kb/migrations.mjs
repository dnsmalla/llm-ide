// Versioned schema migrations.  `schema.sql` worked while we were just
// adding tables (every CREATE was IF NOT EXISTS), but production code
// inevitably needs ALTER COLUMN, DROP INDEX, data backfill, etc.  This
// module gives us the discipline to do those safely.
//
// Migrations live in `kb/migrations/NNN_description.sql`.  Each runs
// in a transaction; on success, an entry is inserted into the
// `schema_migrations` table.  Already-applied migrations are skipped.
//
// We deliberately don't ship "down" migrations — they're rare in
// practice and almost always wrong (lossy rollbacks of recent data).
// If you need to revert, restore from a backup.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

const FILE_RE = /^(\d{3,4})_([\w.-]+)\.sql$/;

// True when `sql` consists of exactly one effective statement and that
// statement is an `ALTER TABLE … ADD COLUMN`. Used to bound the
// duplicate-column error swallow to migrations where nothing else could
// have been skipped by the rollback. Line (`--`) and block (`/* */`)
// comments are stripped first; a trailing semicolon is ignored.
function isSingleAddColumn(sql) {
  if (typeof sql !== 'string') return false;
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments
    .replace(/--[^\n]*/g, ' ');          // line comments
  const statements = stripped
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  if (statements.length !== 1) return false;
  return /^alter\s+table\s+\S+\s+add\s+(column\s+)?/i.test(statements[0]);
}

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      checksum   TEXT
    );
  `);
}

function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR)
    .map((f) => {
      const m = f.match(FILE_RE);
      if (!m) return null;
      return { file: f, version: Number(m[1]), name: m[2] };
    })
    .filter(Boolean)
    .sort((a, b) => a.version - b.version);
}

function checksum(text) {
  // FNV-1a over the file contents.  Sole purpose: detect that an
  // already-applied migration was edited after the fact, which would
  // silently desync schema between environments.  We surface a warning
  // — refusing to start would be too aggressive for a single-user app.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function applyMigrations(db, { logger } = {}) {
  ensureMigrationsTable(db);
  const applied = new Map(
    db.prepare('SELECT version, checksum FROM schema_migrations').all()
      .map((r) => [r.version, r.checksum]),
  );
  const files = listMigrationFiles();
  let ranCount = 0;
  for (const { file, version, name } of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const sum = checksum(sql);
    if (applied.has(version)) {
      const prev = applied.get(version);
      if (prev && prev !== sum) {
        // In production, schema drift between deployed instances is a
        // real risk — refuse to start.  In dev / test, a warning lets
        // contributors edit migrations during iteration without losing
        // their data.
        if (process.env.NODE_ENV === 'production') {
          throw new Error(
            `Migration ${file} (v${version}) has been edited after it was applied. ` +
            `Stored checksum=${prev} current=${sum}. ` +
            `Refusing to start in production — create a new migration or restore from backup.`
          );
        }
        if (logger) logger.warn('migration_checksum_mismatch', {
          version, name, previous: prev, current: sum,
        });
      }
      continue;
    }
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare(
        'INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)',
      ).run(version, name, sum);
    });
    try {
      tx();
      ranCount += 1;
      if (logger) logger.info('migration_applied', { version, name, file });
    } catch (err) {
      // "duplicate column name" means the column already exists — the desired
      // state is already achieved, so treat this as a successful no-op and
      // record the migration as applied so it isn't retried on every boot.
      //
      // BUT only when the migration is a SINGLE `ALTER TABLE … ADD COLUMN`
      // statement. db.exec(sql) ran inside `tx`, so a throw rolled the WHOLE
      // migration back; if a multi-statement migration tripped on a duplicate
      // column, swallowing here would mark it applied while its OTHER
      // statements never ran — silent schema drift. In that case we must
      // re-throw so the operator fixes the migration to be idempotent.
      if (err.message && err.message.includes('duplicate column name') &&
          isSingleAddColumn(sql)) {
        db.prepare(
          'INSERT OR IGNORE INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)',
        ).run(version, name, sum);
        ranCount += 1;
        if (logger) logger.info('migration_column_already_exists', { version, name, file });
        continue;
      }
      const wrapped = new Error(`Migration ${file} failed: ${err.message}`);
      wrapped.cause = err;
      throw wrapped;
    }
  }
  return { applied: ranCount, total: files.length };
}

export function migrationStatus(db) {
  ensureMigrationsTable(db);
  const rows = db.prepare(`
    SELECT version, name, applied_at FROM schema_migrations ORDER BY version
  `).all();
  return {
    current: rows.length > 0 ? rows[rows.length - 1].version : 0,
    applied: rows,
  };
}
