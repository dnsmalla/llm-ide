// Sources -> Issue (`issues.from_notes`, Task 9): one issue per meeting action, filed once across runs and restarts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-issues-from-notes-'));
process.env.LLMIDE_DB_PATH = path.join(root, 'kb.db');
process.env.LLMIDE_DATA_DIR = root;

const { getDb, closeDb } = await import('../kb/db.mjs');
const { runCoreTask } = await import('../agents/task-runner.mjs');

after(() => {
  try { closeDb(); } catch { /* closed */ }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

for (const id of ['u1', 'u2', 'u3', 'u4', 'u5']) {
  getDb().prepare("INSERT OR IGNORE INTO users (id, email, display_name, password_hash, role, status) VALUES (?, ?, ?, 'x', 'user', 'active')")
    .run(id, `${id}@example.com`, id);
}

const ACTIONS = [
  { meetingId: 'm1', entityId: 11, meetingTitle: 'Kickoff', date: '2026-11-02', title: 'Send the invoice' },
  { meetingId: 'm1', entityId: 11, meetingTitle: 'Kickoff', date: '2026-11-02', title: 'Send the invoice' },
];
const searchActions = async () => ACTIONS.map((a) => ({ ...a }));

function fakeCreate(created, { fail = null } = {}) {
  return async (a) => {
    if (fail) return { status: 400, body: { error: { code: fail, message: 'refused' } } };
    created.push(a);
    const number = 100 + created.length;
    return { status: 200, number, body: { ok: true, id: number, url: `https://github.com/o/r/issues/${number}`, state: 'open', deduped: false } };
  };
}
const onBoard = () => true;
const token = async () => 'tok';
const ARGS = { provider: 'github', repo: 'o/r', since: '2026-11-01' };
const run = (userId, deps, extra = {}) => runCoreTask({
  taskId: 'sourcesToIssue', userId, projectRoot: '/p', projectId: 'proj-1', args: ARGS,
  deps: { searchActions, isOnBoard: onBoard, getToken: token, ...deps }, ...extra,
});

test('issues.from_notes creates one issue per new action and skips repeats', async () => {
  const created = [];
  const out = await run('u1', { createIssue: fakeCreate(created) });
  assert.equal(out.ok, true);
  assert.equal(out.runner, 'core-route');
  assert.equal(created.length, 1);
  assert.equal(out.summary, 'Created 1 issue; skipped 1 duplicate.');
});

test('a second run with the same actions creates nothing (durable record, not memory)', async () => {
  const created = [];
  const out = await run('u1', { createIssue: fakeCreate(created) });
  assert.equal(created.length, 0);
  assert.equal(out.summary, 'Created 0 issues; skipped 2 duplicates.');
});

test('a run after a restart (DB closed and reopened) still creates nothing', async () => {
  closeDb();
  const created = [];
  const out = await run('u1', { createIssue: fakeCreate(created) });
  assert.equal(created.length, 0);
  assert.equal(out.ok, true);
});

test("another user's record never suppresses this user's create", async () => {
  const created = [];
  const out = await run('u2', { createIssue: fakeCreate(created) });
  assert.equal(created.length, 1);
  assert.equal(out.ok, true);
});

test('a repository that is not on the Issues board is refused before any create', async () => {
  const created = [];
  const out = await run('u1', { createIssue: fakeCreate(created), isOnBoard: () => false });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'REPO_NOT_ALLOWED');
  assert.equal(created.length, 0);
});

test('a cancelled run creates nothing', async () => {
  const created = [];
  const ac = new AbortController();
  ac.abort();
  const out = await run('u3', { createIssue: fakeCreate(created) }, { signal: ac.signal });
  assert.equal(created.length, 0);
  assert.equal(out.ok, false);
});

test('a provider failure stops with its typed code and keeps the creates already made', async () => {
  const many = Array.from({ length: 3 }, (_, i) => ({ meetingId: 'm9', entityId: 900 + i, meetingTitle: 'M', date: '2026-11-03', title: `Task ${i}` }));
  const created = [];
  const create = async (a) => {
    if (created.length === 1) return { status: 502, body: { error: { code: 'PROVIDER_ERROR', message: 'GitHub answered 500.' } } };
    created.push(a);
    return { status: 200, number: 300 + created.length, body: { ok: true, id: 1, url: null, state: 'open', deduped: false } };
  };
  const out = await run('u4', { searchActions: async () => many, createIssue: create });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'PROVIDER_ERROR');
  assert.equal(created.length, 1);
  const again = [];
  const second = await run('u4', { searchActions: async () => many, createIssue: fakeCreate(again) });
  assert.equal(second.ok, true);
  assert.equal(again.length, 2, 'the first action stays filed; the other two are created on the re-run');
});

test('actions before the since date are not filed; at most 20 are created per run', async () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ meetingId: 'm2', entityId: 500 + i, meetingTitle: 'M', date: '2026-11-05', title: `Item ${i}` }));
  const created = [];
  const out = await run('u5', { searchActions: async () => [...many, { meetingId: 'm0', entityId: 1, meetingTitle: 'Old', date: '2026-10-01', title: 'Old item' }], createIssue: fakeCreate(created) });
  assert.equal(created.length, 20);
  assert.equal(out.ok, true);
  assert.equal(out.result.skipped, 5, 'the five over the cap are skipped; the item before since is not an action of this run');
  assert.ok(!created.some((c) => c.title === 'Old item'));
});

test('a bad provider is refused as a typed task error before any create', async () => {
  const created = [];
  const out = await runCoreTask({
    taskId: 'issues.from_notes', userId: 'u1', projectRoot: '/p', projectId: 'proj-1',
    args: { provider: 'bitbucket', repo: 'o/r' }, deps: { searchActions, isOnBoard: onBoard, getToken: token, createIssue: fakeCreate(created) },
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'TASK_BAD_ARG');
  assert.equal(created.length, 0);
});
