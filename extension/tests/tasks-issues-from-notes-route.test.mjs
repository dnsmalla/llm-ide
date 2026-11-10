// POST /kb/tasks/issues.from_notes/run (Task 9): the desktop route files issues through the shared writer. Covers the
// project and tracker-write authority (a viewer is refused before any provider call), the feature gate, and that a
// second run through the route files nothing again (the durable record, not the in-memory key).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.LLMIDE_HOST_APPROVAL_KEY = 'c'.repeat(64);
process.env.NODE_ENV = 'test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-task-issues-route-'));
process.env.LLMIDE_DB_PATH = path.join(root, 'kb.db');
process.env.LLMIDE_DATA_DIR = root;

const { getDb, closeDb } = await import('../kb/db.mjs');
const { handleTaskRoutes } = await import('../routes/tasks.mjs');

const { busHostProof } = await import('../core/host-approval.mjs');
const { setSecret } = await import('../server/vault.mjs');
const { _setPinnedFetchForTests } = await import('../server/pinned-fetch.mjs');
const { indexTicketsJson } = await import('../connectors/issues.mjs');
const { registerProject } = await import('../kb/projects.mjs');
const { grant } = await import('./helpers/grant.mjs');
const { closeAgentDb } = await import('../kb/agent-db.mjs');

after(() => {
  _setPinnedFetchForTests(null);
  try { closeAgentDb(); } catch { /* closed */ }
  try { closeDb(); } catch { /* closed */ }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

const db = () => getDb();
const PROOF = busHostProof();
let seq = 0;
function user(teamRole) {
  const id = `t-${++seq}`;
  db().prepare("INSERT INTO users (id, email, display_name, password_hash, role, status) VALUES (?, ?, ?, 'x', 'user', 'active')")
    .run(id, `${id}@example.com`, id);
  grant(db(), id, { teamRole, maxMode: 'execute', usdCapMonth: 0 });
  return id;
}
const owner = user('member');
const viewer = user('viewer');
registerProject(db(), owner, { id: 'p-issues', name: 'Issues', root: path.join(root, 'issues') });
indexTicketsJson(owner, { provider: 'github', tickets: [
  { url: 'https://github.com/o/r/issues/1', title: 'One', meta: { repo: 'o/r', number: 1, state: 'open', isPR: false } },
] });
setSecret(db(), owner, 'github.token', 'ghp_test_token_value_123');
setSecret(db(), viewer, 'github.token', 'ghp_test_token_value_456');
indexTicketsJson(viewer, { provider: 'github', tickets: [
  { url: 'https://github.com/o/r/issues/1', title: 'One', meta: { repo: 'o/r', number: 1, state: 'open', isPR: false } },
] });

function fakeRes() {
  const out = { status: null, body: null };
  return { out, writeHead(status) { out.status = status; }, end(text) { out.body = JSON.parse(String(text)); } };
}
// readBody listens for 'data' and 'end'; the same synchronous shape the issue-writes route test uses.
function fakeReq(url, body) {
  const chunk = Buffer.from(JSON.stringify(body));
  const req = {
    method: 'POST', url, headers: { 'x-llmide-host-nonce': PROOF }, socket: { remoteAddress: '127.0.0.1' },
    pause() {},
    on(ev, cb) { if (ev === 'data') cb(chunk); else if (ev === 'end') cb(); return req; },
  };
  return req;
}
let providerCalls = 0;
function providerOk() {
  providerCalls = 0;
  _setPinnedFetchForTests(async () => { providerCalls += 1; return new Response(JSON.stringify({ number: 77, html_url: 'https://github.com/o/r/issues/77' }), { status: 201 }); });
}
const run = (userId, args = { provider: 'github', repo: 'o/r', since: '2026-11-01' }) => {
  const res = fakeRes();
  return handleTaskRoutes(fakeReq('/kb/tasks/issues.from_notes/run', { projectId: 'p-issues', args }), res, { userId, url: '/kb/tasks/issues.from_notes/run' })
    .then(() => res.out);
};

// The action rows come from the Library; seed one meeting action with the real entity table.
function seedAction(userId) {
  const meetingId = `meet-${userId}`;
  db().prepare("INSERT INTO meetings (id, title, date, duration_sec, user_id, meta) VALUES (?, 'Kickoff', '2026-11-04', 60, ?, '{\"projectId\":\"p-issues\"}')").run(meetingId, userId);
  db().prepare("INSERT INTO entities (id, meeting_id, user_id, kind, text, meta) VALUES (?, ?, ?, 'action', 'Book the room', '{}')").run(`ent-${userId}`, meetingId, userId);
}

test('a member files the action once through the route, and a second run files nothing', async () => {
  seedAction(owner);
  providerOk();
  const first = await run(owner);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.ok, true);
  assert.equal(providerCalls, 1);
  assert.match(first.body.summary, /^Created 1 issue; skipped 0 duplicates\.$/);
  assert.deepEqual(first.body.result.issues, [77]);
  assert.ok(!JSON.stringify(first.body).includes('https://'), 'the answer carries counts and numbers, never a URL');
  providerOk();
  const second = await run(owner);
  assert.equal(second.status, 200);
  assert.equal(providerCalls, 0, 'the durable record stops the second run before any provider call');
  assert.match(second.body.summary, /^Created 0 issues; skipped 1 duplicate\.$/);
});

test('a viewer is refused by the tracker-write class before any provider call', async () => {
  seedAction(viewer);
  providerOk();
  const out = await run(viewer);
  assert.equal(out.status, 403);
  assert.equal(out.body.error.code, 'ROLE_DENIED');
  assert.equal(providerCalls, 0);
});

test('a run without a project is refused before any work', async () => {
  const res = fakeRes();
  await handleTaskRoutes(fakeReq('/kb/tasks/issues.from_notes/run', { args: { provider: 'github', repo: 'o/r' } }), res, { userId: owner, url: '/kb/tasks/issues.from_notes/run' });
  assert.equal(res.out.status, 400);
  assert.equal(res.out.body.error.code, 'PROJECT_REQUIRED');
});

test('the retired id updateIssues runs Sources -> Issue through the same route', async () => {
  const res = fakeRes();
  await handleTaskRoutes(fakeReq('/kb/tasks/updateIssues/run', { projectId: 'p-issues', args: { provider: 'github', repo: 'o/r' } }), res, { userId: owner, url: '/kb/tasks/updateIssues/run' });
  assert.equal(res.out.status, 200, JSON.stringify(res.out.body));
  assert.equal(res.out.body.taskId, 'issues.from_notes');
});
