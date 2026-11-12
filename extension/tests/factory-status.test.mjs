// Factory PR/MR status (agents/factory-status.mjs) and POST /kb/loop/ship-status (routes/loop-agent.mjs).
// The provider is always faked through _setPinnedFetchForTests; no network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(HERE, '_factory-status-test.db');
process.env.LLMIDE_DB_PATH = DB;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB + s); } catch { /* ok */ } }

const { parseGitlabMrUrl, pollRequest, MAX_SHIP_STATUS_REQUESTS } = await import('../agents/factory-status.mjs');
const { handleLoopAgentRoutes } = await import('../routes/loop-agent.mjs');
const { _setPinnedFetchForTests } = await import('../server/pinned-fetch.mjs');
const { getDb, closeDb } = await import('../kb/db.mjs');
const { registerUser } = await import('../server/users.mjs');
const { setSecret } = await import('../server/vault.mjs');

after(() => {
  _setPinnedFetchForTests(null);
  closeDb();
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB + s); } catch { /* ok */ } }
});

const SHA = 'a'.repeat(40);
const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
/** Answers by origin + pathname (the query string is ignored); an unknown URL is a 404. */
function fakeProvider(routes) {
  const seen = [];
  _setPinnedFetchForTests(async (url, init = {}) => {
    seen.push({ url: String(url), headers: init.headers || {} });
    const u = new URL(String(url));
    const answer = routes[u.origin + u.pathname];
    return answer ? answer(u) : json(404, { message: 'Not Found' });
  });
  return seen;
}

const userId = registerUser(getDb(), { email: 'factory-status@example.com', password: 'CorrectHorseBattery', displayName: 't' }).id;
setSecret(getDb(), userId, 'github.token', 'ghp_vault_token_1234567890');

function post(body) {
  const chunks = [Buffer.from(JSON.stringify(body))];
  const r = {
    method: 'POST', url: '/kb/loop/ship-status', user: { id: userId },
    headers: { 'user-agent': 'factory-status-test' }, socket: { remoteAddress: '127.0.0.1' },
    on(ev, cb) { if (ev === 'data') chunks.forEach(cb); else if (ev === 'end') cb(); return r; },
  };
  return r;
}
function res() {
  return {
    statusCode: 200, headers: {}, body: '',
    writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h || {}); },
    setHeader(k, v) { this.headers[k] = v; },
    write(c) { this.body += c; },
    end(c) { if (c) this.body += c; },
  };
}
async function callRoute(body) {
  const out = res();
  const handled = await handleLoopAgentRoutes(post(body), out, { userId });
  return { handled, status: out.statusCode, body: JSON.parse(out.body), raw: out.body };
}

test('github: merged PR with failing check returns merged and failed', async () => {
  const base = 'https://api.github.com/repos/o/r';
  const seen = fakeProvider({
    [`${base}/pulls/8`]: () => json(200, { state: 'closed', merged: true, head: { sha: SHA } }),
    [`${base}/commits/${SHA}/check-runs`]: () => json(200, { total_count: 2, check_runs: [
      { name: 'build', status: 'completed', conclusion: 'success' },
      { name: 'test', status: 'completed', conclusion: 'failure' },
    ] }),
    [`${base}/commits/${SHA}/status`]: () => json(200, { state: 'pending', total_count: 0, statuses: [] }),
    [`${base}/issues/8/comments`]: () => json(200, [
      { user: { login: 'alice' }, body: 'please rename', created_at: '2026-11-03T09:00:00Z' },
      { user: { login: 'bob' }, body: 'old', created_at: '2026-10-01T00:00:00Z' },
      { user: { login: 'sonarcloud[bot]', type: 'Bot' }, body: 'Quality gate passed', created_at: '2026-11-03T10:00:00Z' },
    ]),
    [`${base}/pulls/8/comments`]: () => json(200, [
      { user: { login: 'carol' }, body: 'nit: typo', created_at: '2026-11-02T08:00:00Z', path: 'a.js' },
    ]),
  });
  try {
    const url = 'https://github.com/o/r/pull/8';
    const out = await pollRequest(url, { since: '2026-11-01T00:00:00Z', creds: { github: { token: 'ghp_test_token_1234567890' } } });
    assert.deepEqual(out, {
      url, state: 'merged', ci: 'failed', ciSummary: 'Failed checks: test',
      comments: [
        { author: 'carol', body: 'nit: typo', at: '2026-11-02T08:00:00Z', bot: false },
        { author: 'alice', body: 'please rename', at: '2026-11-03T09:00:00Z', bot: false },
        { author: 'sonarcloud[bot]', body: 'Quality gate passed', at: '2026-11-03T10:00:00Z', bot: true },
      ],
    });
    assert.equal(seen.length, 5);
    assert.ok(seen.every((s) => s.url.startsWith('https://api.github.com/repos/o/r/')), 'fixed host only');
    assert.ok(seen.every((s) => s.headers.Authorization === 'Bearer ghp_test_token_1234567890'));
  } finally { _setPinnedFetchForTests(null); }
});

test('gitlab: open MR with failed pipeline and one new note since returns one comment', async () => {
  const base = 'https://gitlab.com/api/v4/projects/g%2Fsub%2Fp';
  const seen = fakeProvider({
    [`${base}/merge_requests/5`]: () => json(200, { state: 'opened', head_pipeline: { id: 77, status: 'failed' } }),
    [`${base}/pipelines/77/jobs`]: () => json(200, [{ name: 'unit', stage: 'test' }]),
    [`${base}/merge_requests/5/notes`]: () => json(200, [
      { body: 'added 1 commit', author: { username: 'bot' }, created_at: '2026-11-02T11:00:00Z', system: true },
      { body: 'new review note', author: { username: 'rev' }, created_at: '2026-11-02T10:00:00Z', system: false },
      { body: 'coverage 81%', author: { username: 'project_123_bot', bot: true }, created_at: '2026-11-02T10:30:00Z', system: false },
      { body: 'old note', author: { username: 'rev' }, created_at: '2026-10-30T10:00:00Z', system: false },
    ]),
  });
  try {
    const url = 'https://gitlab.com/g/sub/p/-/merge_requests/5';
    const out = await pollRequest(url, { since: '2026-11-01T00:00:00Z', creds: { gitlab: { token: 'glpat_test_token_12345' } } });
    assert.deepEqual(out, {
      url, state: 'open', ci: 'failed', ciSummary: 'Failed jobs: unit',
      comments: [{ author: 'rev', body: 'new review note', at: '2026-11-02T10:00:00Z', bot: false }, { author: 'project_123_bot', body: 'coverage 81%', at: '2026-11-02T10:30:00Z', bot: true }],
    });
    assert.ok(seen.every((s) => s.url.startsWith(`${base}/`)), 'gitlab.com with the encoded project path only');
    assert.ok(seen.every((s) => s.headers['PRIVATE-TOKEN'] === 'glpat_test_token_12345'));
  } finally { _setPinnedFetchForTests(null); }
});

test('comments are the newest 20 and each body is cut at 4000 characters', async () => {
  const base = 'https://gitlab.com/api/v4/projects/g%2Fp';
  const notes = Array.from({ length: 25 }, (_, i) => ({
    body: String(i).padEnd(5000, 'x'), author: { username: 'u' },
    created_at: new Date(Date.UTC(2026, 10, 1, i)).toISOString(), system: false,
  }));
  fakeProvider({
    [`${base}/merge_requests/1`]: () => json(200, { state: 'merged', head_pipeline: null }),
    [`${base}/merge_requests/1/notes`]: () => json(200, notes),
  });
  try {
    const out = await pollRequest('https://gitlab.com/g/p/-/merge_requests/1', { since: null });
    assert.equal(out.state, 'merged');
    assert.equal(out.ci, 'none');
    assert.equal(out.ciSummary, null);
    assert.equal(out.comments.length, 20);
    assert.ok(out.comments[0].body.startsWith('5x'), 'the 5 oldest are dropped');
    assert.ok(out.comments.every((c) => c.body.length === 4000));
  } finally { _setPinnedFetchForTests(null); }
});

test('401 from provider returns unauthorized without echoing the token', async () => {
  const seen = fakeProvider({
    'https://api.github.com/repos/o/r/pulls/8': () => json(401, { message: 'Bad credentials ghp_vault_token_1234567890' }),
  });
  try {
    const url = 'https://github.com/o/r/pull/8';
    const r = await callRoute({ requests: [{ url, since: null }] });
    assert.equal(r.handled, true);
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body, { results: [{ url, error: 'unauthorized' }] });
    assert.equal(seen[0].headers.Authorization, 'Bearer ghp_vault_token_1234567890', 'the vault token is used');
    assert.equal(r.raw.includes('ghp_vault'), false, 'the token never reaches the answer');
    assert.equal(r.raw.includes('Bad credentials'), false, 'provider text never reaches the answer');
  } finally { _setPinnedFetchForTests(null); }
});

test('non gitlab.com MR URL returns unsupported_url', async () => {
  assert.deepEqual(parseGitlabMrUrl('https://gitlab.com/g/sub/p/-/merge_requests/5'), { project: 'g/sub/p', iid: 5 });
  assert.equal(parseGitlabMrUrl('https://gitlab.example.com/g/p/-/merge_requests/1'), null);
  assert.equal(parseGitlabMrUrl('https://gitlab.com.evil.example/g/p/-/merge_requests/1'), null);
  assert.equal(parseGitlabMrUrl('https://gitlab.com/g/../p/-/merge_requests/1'), null);
  assert.equal(parseGitlabMrUrl('https://gitlab.com/p/-/merge_requests/1'), null, 'a project path has at least 2 segments');
  const seen = fakeProvider({});
  try {
    await assert.rejects(pollRequest('https://github.com/o/r/issues/7'), { code: 'unsupported_url' });
    await assert.rejects(pollRequest('https://github.com/../r/pull/1'), { code: 'unsupported_url' });
    const self = 'https://gitlab.example.com/g/p/-/merge_requests/1';
    const r = await callRoute({ requests: [{ url: self, since: '2026-11-01T00:00:00Z' }, { url: 'https://github.com/o/r/issues/7', since: null }] });
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body, { results: [{ url: self, error: 'unsupported_url' }, { url: 'https://github.com/o/r/issues/7', error: 'unsupported_url' }] });
    assert.equal(seen.length, 0, 'no provider call for an unsupported URL');
  } finally { _setPinnedFetchForTests(null); }
});

test('more than 20 requests is rejected with 400', async () => {
  assert.equal(MAX_SHIP_STATUS_REQUESTS, 20);
  const seen = fakeProvider({});
  try {
    const many = (n) => Array.from({ length: n }, (_, i) => ({ url: `https://github.com/o/r/pull/${i + 1}`, since: null }));
    const r = await callRoute({ requests: many(21) });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'VALIDATION_FAILED');
    assert.equal(seen.length, 0);
    const ok = await callRoute({ requests: many(20) });
    assert.equal(ok.status, 200, ok.raw);
    assert.equal(ok.body.results.length, 20);
    assert.ok(ok.body.results.every((x) => x.error === 'provider_error'), 'the fake answers 404 → provider_error');
    const bad = await callRoute({ requests: [{ url: 'https://github.com/o/r/pull/1', since: 'yesterday' }] });
    assert.equal(bad.status, 400, 'since must be an ISO date or null');
  } finally { _setPinnedFetchForTests(null); }
});
