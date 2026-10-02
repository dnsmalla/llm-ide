// indexLocalRepo wiped and re-inserted EVERY chunk of the repo on every
// project open — thousands of FTS writes in one transaction holding the
// only writer, and a fresh AUTOINCREMENT id per chunk each time. Now each
// file carries its content hash: unchanged files are left alone, a changed
// file is replaced, and a deleted file's rows go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_git-incremental-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { indexLocalRepo } = await import('../connectors/git.mjs');
const U = users.registerUser(db.getDb(), {
  email: `gi-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'g',
}).id;
const REPO = fs.mkdtempSync(path.join(__dirname, '_gi-repo-'));
const write = (name, text) => fs.writeFileSync(path.join(REPO, name), text);
const rows = () => db.getDb()
  .prepare("SELECT id, ref, body FROM sources WHERE user_id=? AND kind='code' AND ref LIKE ? ORDER BY ref, chunk_idx")
  .all(U, `${REPO}%`);
const idsOf = (name) => rows().filter((r) => r.ref.endsWith(`${path.sep}${name}`)).map((r) => r.id);

test.after(() => {
  db.closeDb();
  fs.rmSync(REPO, { recursive: true, force: true });
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

test('a re-index leaves unchanged files alone, replaces a changed one, and drops a deleted one', async () => {
  write('keep.ts', 'export const keep = 1;\n');
  write('edit.ts', 'export const before = 1;\n');
  write('gone.ts', 'export const gone = 1;\n');
  const first = await indexLocalRepo(U, REPO);
  assert.equal(first.filesIndexed, 3);
  const keepIds = idsOf('keep.ts');

  write('edit.ts', 'export const after = 2;\n');
  fs.rmSync(path.join(REPO, 'gone.ts'));
  const second = await indexLocalRepo(U, REPO);

  assert.deepEqual(idsOf('keep.ts'), keepIds, 'an unchanged file keeps its rows (and ids) — nothing rewritten');
  assert.match(rows().find((r) => r.ref.endsWith('edit.ts')).body, /after = 2/);
  assert.equal(idsOf('gone.ts').length, 0, 'a deleted file\'s rows are removed');
  assert.equal(second.unchanged, 1);
  assert.equal(second.removed, 1);
  assert.equal(second.filesIndexed, 2, 'filesIndexed still counts every file in the index');
  assert.equal(second.filesWritten, 1, 'only the changed file was (re)written');
});

test('a file that shrinks to fewer chunks loses its extra chunk rows', async () => {
  write('long.ts', Array.from({ length: 200 }, (_, i) => `// line ${i}`).join('\n'));
  await indexLocalRepo(U, REPO);
  assert.equal(idsOf('long.ts').length, 3);
  write('long.ts', '// short now\n');
  await indexLocalRepo(U, REPO);
  assert.equal(idsOf('long.ts').length, 1);
});
