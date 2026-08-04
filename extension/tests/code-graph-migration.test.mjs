import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_code-graph-migration-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }

const db = await import('../kb/db.mjs');

test('migration 0025 creates code_graph_nodes and code_graph_edges with required columns', () => {
  const conn = db.getDb();
  const nodeCols = conn.prepare('PRAGMA table_info(code_graph_nodes)').all().map((c) => c.name);
  const edgeCols = conn.prepare('PRAGMA table_info(code_graph_edges)').all().map((c) => c.name);
  for (const c of ['user_id', 'repo_id', 'symbol_id', 'title', 'kind', 'source_file', 'line', 'language', 'doc']) {
    assert.ok(nodeCols.includes(c), `code_graph_nodes has ${c}`);
  }
  for (const c of ['user_id', 'repo_id', 'from_id', 'to_id', 'kind', 'confidence']) {
    assert.ok(edgeCols.includes(c), `code_graph_edges has ${c}`);
  }
  const applied = conn.prepare('SELECT version FROM schema_migrations WHERE version=25').get();
  assert.ok(applied, 'migration 0025 recorded as applied');
});

test('cleanup', () => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }
});
