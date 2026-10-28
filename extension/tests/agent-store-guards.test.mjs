// Guards for the agent store migration (plan T0.2): the SQL that touches the
// ledger, turn tables and activity feed stays inside the inventory below.
// A new writer or reader must be added here on purpose, after review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');

// Files with direct SQL on the four tables in the main DB, as of Stage 1a
// (plan section 1.1 and 1.3). Stage 1b moves these; update the list then.
const INVENTORY = [
  'kb/activity.mjs',
  'kb/agent-history-copy.mjs',
  'kb/db.mjs',
  'kb/os-state.mjs',
  'kb/tool-events-summary.mjs',
  'kb/tool-events.mjs',
  'kb/turn-composition.mjs',
  'kb/usage.mjs',
  'scripts/retrieval-report.mjs',
  'scripts/usage-report.mjs',
];

const SQL_RE = /\b(?:FROM|INTO|UPDATE|JOIN|TABLE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(usage_ledger|turn_tool_events|turn_composition|activity|activity_seen)\b|pragma_table_info\(\s*'(usage_ledger|turn_tool_events|turn_composition|activity)'/i;
// The agent store's own modules use these table names in agent.db, not the
// main DB. They are the new home, so they are not part of the inventory.
const AGENT_STORE_OWN = new Set(['kb/agent-db.mjs', 'kb/agent-store.mjs']);
const SKIP_DIRS = new Set(['node_modules', 'tests', 'migrations', 'agent-migrations', 'src', 'coverage', 'ui']);

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(mjs|js|cjs|ts)$/.test(e.name)) {
      const rel = path.relative(EXT, p).split(path.sep).join('/');
      if (!AGENT_STORE_OWN.has(rel) && SQL_RE.test(fs.readFileSync(p, 'utf8'))) out.push(rel);
    }
  }
  return out;
}

test('SQL on the ledger, turn tables and activity feed stays inside the inventory', () => {
  const found = walk(EXT, []).sort();
  const extra = found.filter((f) => !INVENTORY.includes(f));
  assert.deepEqual(extra, [], `new direct SQL on a ledger/turn/activity table in: ${extra.join(', ')}. Add it to INVENTORY after review.`);
});

test('the inventory lists no file that no longer touches those tables', () => {
  const found = new Set(walk(EXT, []));
  const stale = INVENTORY.filter((f) => !found.has(f));
  assert.deepEqual(stale, [], `inventory rows with no matching SQL: ${stale.join(', ')}`);
});

test('the user-purge list covers every agent.db table that carries user_id', async () => {
  process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
  process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
  const { default: Database } = await import('better-sqlite3');
  const { applyMigrations, AGENT_MIGRATIONS_DIR } = await import('../kb/migrations.mjs');
  const { AGENT_USER_TABLES } = await import('../kb/agent-store.mjs');
  const { AGENT_MIGRATIONS_TABLE } = await import('../kb/agent-db.mjs');
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'agent-guard-'));
  const db = new Database(path.join(dir, 'g.db'));
  applyMigrations(db, { dir: AGENT_MIGRATIONS_DIR, table: AGENT_MIGRATIONS_TABLE });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  const withUser = tables.filter((t) => db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'user_id'));
  const missing = withUser.filter((t) => !AGENT_USER_TABLES.includes(t));
  assert.deepEqual(missing, [], `agent.db tables with user_id missing from the purge list: ${missing.join(', ')}`);
  db.close();
});
