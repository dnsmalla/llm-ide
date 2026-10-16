// Code rows are written when a project is opened (connectors/git.mjs) but
// nothing removed them when the repo folder was later deleted or moved.
// Measured 2026-10-16 on a real KB: 97% of code chunks pointed into deleted
// folders, and planner grounding (findContext) returned 49 of 50 code refs
// from them. pruneMissingCodeRepos drops those rows; they are regenerable
// (re-indexed whenever the project is opened again).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_kb-prune-missing-repos-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');

function reset() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
}

function provision(name) {
  return users.registerUser(db.getDb(), {
    email: `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: name,
  }).id;
}

function indexFile(userId, repo, rel, body = 'prunetoken body') {
  db.ingestSources(userId, [{
    kind: 'code', ref: path.join(repo, rel), chunkIdx: 0, title: rel, body,
    meta: { repo, relPath: rel },
  }]);
}

function codeRefs(userId) {
  return db.getDb().prepare("SELECT ref FROM sources WHERE user_id = ? AND kind = 'code' ORDER BY ref")
    .all(userId).map((r) => r.ref);
}

test('pruneMissingCodeRepos drops code rows of a deleted repo and keeps a live one', () => {
  reset();
  const alice = provision('alice');
  const live = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-live-'));
  const gone = path.join(os.tmpdir(), `prune-gone-${Date.now()}`);
  indexFile(alice, live, 'a.ts');
  indexFile(alice, gone, 'b.ts');
  indexFile(alice, gone, 'c.ts');

  const out = db.pruneMissingCodeRepos();

  assert.deepEqual(codeRefs(alice), [path.join(live, 'a.ts')]);
  assert.equal(out.rows, 2);
  assert.deepEqual(out.repos, [gone]);
  // The FTS index follows the delete: the deleted repo's text is unsearchable.
  const hits = db.search(alice, { q: 'prunetoken', limit: 10 });
  assert.deepEqual(hits.map((h) => h.ref), [path.join(live, 'a.ts')]);
  fs.rmSync(live, { recursive: true, force: true });
});

test('pruneMissingCodeRepos keeps a repo whose existence cannot be confirmed as absent', () => {
  reset();
  const alice = provision('alice');
  indexFile(alice, '/unreadable/repo', 'a.ts');
  // Only a definite "does not exist" prunes; any other answer keeps the rows.
  const out = db.pruneMissingCodeRepos({ repoExists: () => null });
  assert.equal(out.rows, 0);
  assert.equal(codeRefs(alice).length, 1);
});

test('pruneMissingCodeRepos leaves rows without meta.repo (SCIP symbols) and other kinds alone', () => {
  reset();
  const alice = provision('alice');
  db.ingestSources(alice, [
    { kind: 'code', ref: '/gone/scip/a.ts:L1', title: 'sym', body: 'b', meta: { source: 'scip' } },
    { kind: 'doc', ref: '/gone/doc.md', title: 'doc', body: 'b', meta: { repo: '/gone' } },
  ]);
  const out = db.pruneMissingCodeRepos({ repoExists: () => false });
  assert.equal(out.rows, 0);
  assert.equal(db.getDb().prepare('SELECT count(*) AS n FROM sources WHERE user_id = ?').get(alice).n, 2);
});

test('pruneMissingCodeRepos never touches a sibling repo whose path only shares a prefix', () => {
  reset();
  const alice = provision('alice');
  indexFile(alice, '/w/proj', 'a.ts');
  indexFile(alice, '/w/proj-live', 'b.ts');
  db.pruneMissingCodeRepos({ repoExists: (p) => p !== '/w/proj' });
  assert.deepEqual(codeRefs(alice), ['/w/proj-live/b.ts']);
});

// Rows indexed before migration 0037 have no search_source_rowid mapping, so
// the legacy BEFORE DELETE trigger scans the whole FTS table once PER ROW —
// 9,108 such rows took 40 s on a real KB, past the Mac app's 20 s /health
// deadline (restart loop, the transaction rolling back each time). The prune
// must backfill the mapping in one scan first, so every delete is by rowid.
test('pruneMissingCodeRepos deletes legacy (unmapped) rows by rowid, not one FTS scan per row', () => {
  reset();
  const alice = provision('alice');
  for (let i = 0; i < 50; i++) indexFile(alice, '/gone/legacy', `f${i}.ts`, `legacytoken ${i}`);
  indexFile(alice, '/live/repo', 'keep.ts', 'legacytoken keep');
  const raw = db.getDb();
  // Simulate pre-0037 rows: drop their mapping.
  raw.prepare(`DELETE FROM search_source_rowid WHERE source_id IN (
    SELECT id FROM sources WHERE json_extract(meta, '$.repo') = '/gone/legacy')`).run();
  let legacyFires = 0;
  raw.function('count_legacy_fire', () => { legacyFires += 1; return 1; });
  raw.exec(`CREATE TEMP TRIGGER count_legacy BEFORE DELETE ON main.sources
    WHEN NOT EXISTS (SELECT 1 FROM main.search_source_rowid WHERE source_id = OLD.id)
    BEGIN SELECT count_legacy_fire(); END;`);
  try {
    const out = db.pruneMissingCodeRepos({ repoExists: (p) => p !== '/gone/legacy' });
    assert.equal(out.rows, 50);
    assert.equal(legacyFires, 0, 'no row took the per-row FTS-scan delete path');
    // And the FTS rows really went: only the live repo's chunk still matches.
    assert.deepEqual(db.search(alice, { q: 'legacytoken', limit: 100 }).map((h) => h.ref), ['/live/repo/keep.ts']);
  } finally {
    raw.exec('DROP TRIGGER IF EXISTS temp.count_legacy');
  }
});

// The default existence check (no repoExists injected): only ENOENT/ENOTDIR
// count as "gone". A permission refusal (macOS TCC on ~/Desktop, ~/Documents)
// must keep the rows, as must a repo on an external volume that is unmounted.
function withStatSyncThrowing(code, fn) {
  const real = fs.statSync;
  fs.statSync = (p, ...rest) => {
    if (String(p).startsWith('/stub/')) {
      const err = new Error(`${code}: stubbed`);
      err.code = code;
      throw err;
    }
    return real(p, ...rest);
  };
  try { return fn(); } finally { fs.statSync = real; }
}

test('default existence check: a permission error keeps the rows', () => {
  reset();
  const alice = provision('alice');
  indexFile(alice, '/stub/denied', 'a.ts');
  const out = withStatSyncThrowing('EPERM', () => db.pruneMissingCodeRepos());
  assert.equal(out.rows, 0);
  assert.equal(codeRefs(alice).length, 1);
});

test('default existence check: ENOENT prunes, but not on an unmounted /Volumes drive', () => {
  reset();
  const alice = provision('alice');
  indexFile(alice, '/stub/gone', 'a.ts');
  indexFile(alice, '/Volumes/__llmide_not_mounted__/repo', 'b.ts');
  const out = withStatSyncThrowing('ENOENT', () => db.pruneMissingCodeRepos());
  assert.deepEqual(out.repos, ['/stub/gone']);
  assert.deepEqual(codeRefs(alice), ['/Volumes/__llmide_not_mounted__/repo/b.ts']);
});
