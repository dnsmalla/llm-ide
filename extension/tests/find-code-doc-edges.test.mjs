// Doc→code citation edges (graph-kit: backticked paths/symbols in markdown
// become `references` edges from the doc page) must read as documentation in
// find-code, reach file seeds too, and never hide a symbol's file-level blast
// radius.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_find-code-doc-edges-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { searchCodeIndex } = await import('../graphkit/index.mjs');

const U = users.registerUser(db.getDb(), { email: `de-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'd' }).id;
const REPO = '/r/docs-app';

test.before(() => {
  db.writeCodeGraph(U, REPO, {
    nodes: [
      { id: 'file:src/store.mjs', title: 'store.mjs', kind: 'file', metadata: { source_file: 'src/store.mjs', line: 'L0' } },
      { id: 'function:src/store.mjs:saveLedgerRow', title: 'saveLedgerRow', kind: 'function', metadata: { source_file: 'src/store.mjs', line: 'L4' } },
      { id: 'file:src/api.mjs', title: 'api.mjs', kind: 'file', metadata: { source_file: 'src/api.mjs', line: 'L0' } },
      { id: 'file:llm-doc/docs/ledger.md', title: 'ledger.md', kind: 'docPage', metadata: { source_file: 'llm-doc/docs/ledger.md', line: 'L0' } },
    ],
    edges: [
      { fromId: 'file:src/store.mjs', toId: 'function:src/store.mjs:saveLedgerRow', kind: 'contains' },
      { fromId: 'file:src/api.mjs', toId: 'file:src/store.mjs', kind: 'imports' },
      { fromId: 'file:llm-doc/docs/ledger.md', toId: 'function:src/store.mjs:saveLedgerRow', kind: 'references', confidence: 'INFERRED' },
      { fromId: 'file:llm-doc/docs/ledger.md', toId: 'file:src/store.mjs', kind: 'references', confidence: 'EXTRACTED' },
    ],
  }, { source: 'structure' });
});
test.after(() => { db.closeDb(); for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true }); });

const rel = (res) => Object.fromEntries(res.related.map((r) => [r.title, r.relation]));

test('a doc citing a symbol reads "documented by (inferred)"', () => {
  const res = searchCodeIndex(U, 'saveLedgerRow', { repoIds: [REPO] });
  assert.equal(rel(res)['ledger.md'], 'documented by (inferred)', JSON.stringify(res.related));
});

test('a doc citation does not hide the symbol\'s file-level blast radius', () => {
  const r = rel(searchCodeIndex(U, 'saveLedgerRow', { repoIds: [REPO] }));
  assert.equal(r['store.mjs'], 'declared in');
  assert.equal(r['api.mjs'], 'file imported by');
});

test('a file seed lists the docs citing it', () => {
  assert.equal(rel(searchCodeIndex(U, 'store.mjs', { repoIds: [REPO] }))['ledger.md'], 'documented by');
});

test('a doc seed lists what it documents', () => {
  const r = rel(searchCodeIndex(U, 'ledger.md', { repoIds: [REPO] }));
  assert.equal(r['store.mjs'], 'documents');
  assert.equal(r.saveLedgerRow, 'documents (inferred)');
});

test('at most three docs reach related; the rest of the budget goes to code', () => {
  const REPO2 = '/r/cited-app';
  const docs = [1, 2, 3, 4, 5, 6].map((i) => ({
    id: `file:docs/page${i}.md`, title: `page${i}.md`, kind: 'docPage',
    metadata: { source_file: `docs/page${i}.md`, line: 'L0' },
  }));
  const callers = [1, 2, 3].map((i) => ({
    id: `function:src/caller${i}.mjs:callSite${i}`, title: `callSite${i}`, kind: 'function',
    metadata: { source_file: `src/caller${i}.mjs`, line: 'L2' },
  }));
  db.writeCodeGraph(U, REPO2, {
    nodes: [
      { id: 'function:src/vault.mjs:reconcileVaultEntry', title: 'reconcileVaultEntry', kind: 'function', metadata: { source_file: 'src/vault.mjs', line: 'L9' } },
      ...docs, ...callers,
    ],
    edges: [
      ...docs.map((d) => ({ fromId: d.id, toId: 'function:src/vault.mjs:reconcileVaultEntry', kind: 'references', confidence: 'INFERRED' })),
      ...callers.map((c) => ({ fromId: c.id, toId: 'function:src/vault.mjs:reconcileVaultEntry', kind: 'calls', confidence: 'EXTRACTED' })),
    ],
  }, { source: 'structure' });
  const res = searchCodeIndex(U, 'reconcileVaultEntry', { repoIds: [REPO2] });
  const docRows = res.related.filter((r) => /\.md$/.test(r.source_file));
  assert.equal(docRows.length, 3, JSON.stringify(res.related.map((r) => r.title)));
  for (const c of callers) {
    assert.ok(res.related.some((r) => r.title === c.title), `${c.title} missing: ${JSON.stringify(res.related.map((r) => r.title))}`);
  }
});
