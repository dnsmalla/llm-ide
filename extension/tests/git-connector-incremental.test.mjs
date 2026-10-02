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

// The walker read every non-hidden directory, so a repo's generated output
// (anything its .gitignore excludes) went into the index and crowded real
// code out of search. In a git work tree the file list now comes from git:
// tracked + untracked, minus ignored.
test('in a git repo, files its .gitignore excludes are not indexed', async () => {
  const { execFileSync } = await import('node:child_process');
  const GR = fs.mkdtempSync(path.join(__dirname, '_gi-git-'));
  try {
    execFileSync('git', ['init', '-q', '--template='], { cwd: GR, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    fs.writeFileSync(path.join(GR, '.gitignore'), 'generated/\n*.log\n');
    fs.mkdirSync(path.join(GR, 'generated'));
    fs.writeFileSync(path.join(GR, 'generated', 'out.js'), 'export const generatedMarker = 1;\n');
    fs.writeFileSync(path.join(GR, 'debug.log'), 'noise\n');
    fs.mkdirSync(path.join(GR, 'src'));
    fs.writeFileSync(path.join(GR, 'src', 'real.ts'), 'export const realMarker = 1;\n');
    const out = await indexLocalRepo(U, GR);
    const refs = db.getDb().prepare("SELECT ref FROM sources WHERE user_id=? AND kind='code' AND ref LIKE ?")
      .all(U, `${GR}%`).map((r) => path.relative(GR, r.ref));
    assert.deepEqual(refs, [path.join('src', 'real.ts')], `only the un-ignored file (got ${refs.join(', ')})`);
    assert.equal(out.filesIndexed, 1);
  } finally {
    fs.rmSync(GR, { recursive: true, force: true });
  }
});

// `git ls-files` succeeding with NO output is not "the repo is empty": a
// project inside a parent repo that ignores it (a dotfiles repo at ~ with
// `*` in its .gitignore, or an ignored folder of another checkout) lists
// nothing — and with incremental indexing every previously indexed file was
// then DELETED. An empty listing now falls back to the plain walk.
test('a project its enclosing repo ignores is still indexed (empty git listing falls back to the walk)', async () => {
  const { execFileSync } = await import('node:child_process');
  const PARENT = fs.mkdtempSync(path.join(__dirname, '_gi-parent-'));
  try {
    execFileSync('git', ['init', '-q', '--template='], { cwd: PARENT, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    fs.writeFileSync(path.join(PARENT, '.gitignore'), '*\n');
    const PROJ = path.join(PARENT, 'proj');
    fs.mkdirSync(PROJ);
    fs.writeFileSync(path.join(PROJ, 'main.ts'), 'export const mainMarker = 1;\n');
    const out = await indexLocalRepo(U, PROJ);
    assert.equal(out.filesIndexed, 1, 'the walk found the file git would not list');
    const again = await indexLocalRepo(U, PROJ);
    assert.equal(again.removed, 0, 'and a re-index does not delete it');
  } finally {
    fs.rmSync(PARENT, { recursive: true, force: true });
  }
});

// A server started from a git hook inherits GIT_DIR / GIT_WORK_TREE, and with
// GIT_DIR set `git -C <repo> ls-files` lists the OTHER repository.
test('an inherited GIT_DIR does not point the listing at another repository', async () => {
  const { execFileSync } = await import('node:child_process');
  const A = fs.mkdtempSync(path.join(__dirname, '_gi-a-'));
  const B = fs.mkdtempSync(path.join(__dirname, '_gi-b-'));
  const saved = process.env.GIT_DIR;
  try {
    for (const d of [A, B]) execFileSync('git', ['init', '-q', '--template='], { cwd: d, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    fs.writeFileSync(path.join(A, 'a-only.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(B, 'b-only.ts'), 'export const b = 1;\n');
    process.env.GIT_DIR = path.join(B, '.git');
    await indexLocalRepo(U, A);
    const refs = db.getDb().prepare("SELECT ref FROM sources WHERE user_id=? AND kind='code' AND ref LIKE ?")
      .all(U, `${A}%`).map((r) => path.basename(r.ref));
    assert.deepEqual(refs, ['a-only.ts']);
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved;
    fs.rmSync(A, { recursive: true, force: true });
    fs.rmSync(B, { recursive: true, force: true });
  }
});
