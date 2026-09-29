// indexLocalRepo deleted a repo's rows BEFORE an async walk, outside any
// transaction — a crash or error mid-walk left the repo with no code index.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_git-atomic-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { indexLocalRepo } = await import('../connectors/git.mjs');
const U = users.registerUser(db.getDb(), {
  email: `ga-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'g',
}).id;
const REPO = fs.mkdtempSync(path.join(__dirname, '_ga-repo-'));
fs.writeFileSync(path.join(REPO, 'a.ts'), 'export const alphaMarker = 1;\n');

const codeRows = () => db.getDb()
  .prepare("SELECT COUNT(*) AS n FROM sources WHERE user_id=? AND kind='code' AND ref LIKE ?")
  .get(U, `${REPO}%`).n;

test.after(() => {
  db.closeDb();
  fs.rmSync(REPO, { recursive: true, force: true });
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

test('a failed reindex keeps the previous rows', async () => {
  await indexLocalRepo(U, REPO);
  const before = codeRows();
  assert.ok(before > 0);
  async function* failingWalk() { yield path.join(REPO, 'a.ts'); throw new Error('disk vanished'); }
  await assert.rejects(indexLocalRepo(U, REPO, { walk: failingWalk }), /disk vanished/);
  assert.equal(codeRows(), before, 'the old index must survive a failed walk');
});

test('a successful reindex still replaces stale rows', async () => {
  fs.rmSync(path.join(REPO, 'a.ts'));
  fs.writeFileSync(path.join(REPO, 'b.ts'), 'export const bravo = 2;\n');
  await indexLocalRepo(U, REPO);
  const refs = db.getDb().prepare("SELECT ref FROM sources WHERE user_id=? AND kind='code'").all(U).map((r) => r.ref);
  assert.ok(refs.every((r) => !r.endsWith('a.ts')));
  assert.ok(refs.some((r) => r.endsWith('b.ts')));
});
