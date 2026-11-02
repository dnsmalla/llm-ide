// GitHub issue importer (connectors/issues.mjs): paging to exhaustion, the 20
// page / 2 000 row / time caps, duplicate numbers across pages, re-run
// replacement, field mapping (milestone, assignees, cleaned text), and the
// token going only to api.github.com. Fake transport via _setPinnedFetchForTests,
// so no test reaches a real tracker host.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-gh-import-'));
process.env.LLMIDE_DB_PATH = path.join(WS, 'kb.db');

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { _setPinnedFetchForTests } = await import('../server/pinned-fetch.mjs');
const { indexGithubIssues, MAX_PAGES, MAX_ROWS } = await import('../connectors/issues.mjs');

const REPO = 'example/repo';
let userId;
let calls;
// The html_url of a fixture issue must name the repo being imported, as on GitHub.
let curRepo = REPO;

before(() => {
  userId = users.registerUser(db.getDb(), {
    email: `gh-import-${Date.now()}@example.com`, password: 'CorrectHorseBattery', displayName: 'gh',
  }).id;
});
after(() => {
  _setPinnedFetchForTests(null);
  db.closeDb();
  fs.rmSync(WS, { recursive: true, force: true });
});

function issue(n, overrides = {}) {
  return {
    number: n,
    title: `Issue ${n}`,
    body: `body ${n}`,
    state: 'open',
    html_url: `https://github.com/${curRepo}/issues/${n}`,
    labels: [{ name: 'bug' }],
    user: { login: 'ann' },
    created_at: '2026-10-01T00:00:00Z',
    updated_at: `2026-10-${String(Math.min(28, (n % 28) + 1)).padStart(2, '0')}T00:00:00Z`,
    closed_at: null,
    ...overrides,
  };
}

/** Serve `pages(pageNo)` as the GitHub list endpoint; record every call. */
function serve(pages) {
  calls = [];
  _setPinnedFetchForTests(async (url, init = {}) => {
    const u = new URL(String(url));
    const page = Number(u.searchParams.get('page'));
    calls.push({ url: u, headers: init.headers || {} });
    const batch = pages(page);
    return new Response(JSON.stringify(batch), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

/** Import one repo with the fixture transport; the URLs the fake serves name that repo. */
function run(repo, opts = {}) {
  curRepo = repo;
  return indexGithubIssues(userId, { repo, token: opts.token ?? 'tok-123', budgetMs: opts.budgetMs });
}

function range(from, to) {
  const out = [];
  for (let n = from; n <= to; n += 1) out.push(issue(n));
  return out;
}

function storedNumbers() {
  const { total, rows } = db.listTicketSources(userId, { provider: 'github', repo: REPO, state: null, limit: 100000 });
  return { total, numbers: rows.map((r) => r.meta.number).sort((a, b) => a - b) };
}

test('pages until a short page: 3 pages (100, 100, 5) stop after the third', async () => {
  serve((page) => (page === 1 ? range(1, 100) : page === 2 ? range(101, 200) : page === 3 ? range(201, 205) : []));
  const result = await run(REPO, { token: 'tok-123' });
  assert.equal(calls.length, 3, 'exactly three requests');
  assert.equal(result.pages, 3);
  assert.equal(result.truncated, false);
  assert.equal(result.count, 205);
  assert.equal(result.chunks, 205);
  assert.equal(storedNumbers().total, 205);
  for (const c of calls) {
    assert.equal(c.url.host, 'api.github.com', 'token goes only to the GitHub API host');
    assert.equal(c.headers.Authorization, 'Bearer tok-123');
  }
});

test('an empty first page stops at once and writes nothing', async () => {
  serve(() => []);
  const result = await run('example/empty', { token: 't' });
  assert.equal(calls.length, 1);
  assert.equal(result.count, 0);
  assert.equal(result.truncated, false);
});

test('a run that never runs out of full pages stops at 20 pages and reports truncated', async () => {
  assert.equal(MAX_PAGES, 20);
  assert.equal(MAX_ROWS, 2000);
  serve((page) => range((page - 1) * 100 + 1, page * 100));
  const result = await run('example/huge', { token: 't' });
  assert.equal(calls.length, 20, 'page 21 is never requested');
  assert.equal(result.pages, 20);
  assert.equal(result.count, 2000);
  assert.equal(result.truncated, true);
});

test('the time budget stops paging after the first page and reports truncated', async () => {
  serve((page) => (page === 1 ? range(1, 100) : range(101, 200)));
  const result = await run('example/slow', { token: 't', budgetMs: -1 });
  assert.equal(calls.length, 1);
  assert.equal(result.pages, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.count, 100);
});

test('the same issue number on two pages is stored once, and the later copy wins', async () => {
  // Page 2 repeats number 100 with a new title (issues shift between pages while a run is paging).
  serve((page) => (page === 1
    ? range(1, 100)
    : [issue(100, { title: 'second copy' }), ...range(101, 149)]));
  const repo = 'example/dup';
  const result = await run(repo, { token: 't' });
  assert.equal(result.count, 150, 'rows fetched, duplicates included');
  assert.equal(result.chunks, 149, 'rows written, unique by html_url');
  const { rows, total } = db.listTicketSources(userId, { provider: 'github', repo, state: null, limit: 1000 });
  assert.equal(total, 149);
  assert.equal(rows.find((r) => r.meta.number === 100).title, 'second copy');
});

test('re-running the import replaces the repo rows: no duplicates, no leftovers', async () => {
  const repo = 'example/rerun';
  serve((page) => (page === 1 ? range(1, 5) : []));
  await run(repo, { token: 't' });
  await run(repo, { token: 't' });
  // A closed issue that vanished upstream on the second run is removed too.
  serve((page) => (page === 1 ? range(1, 3) : []));
  await run(repo, { token: 't' });
  const { total, rows } = db.listTicketSources(userId, { provider: 'github', repo, state: null, limit: 1000 });
  assert.equal(total, 3);
  assert.deepEqual(rows.map((r) => r.meta.number).sort(), [1, 2, 3]);
});

test('milestone, assignees and labels are mapped; control characters are stripped and lengths capped', async () => {
  const repo = 'example/fields';
  serve((page) => (page === 1
    ? [
      issue(1, {
        milestone: { title: 'v1.0', due_on: '2026-11-30T07:00:00Z', number: 4, state: 'open' },
        assignees: [{ login: 'bob' }, { login: 'bo\u0007b' }],
      }),
      issue(2, { milestone: null, assignees: [] }),
      issue(3, { milestone: { title: 'x'.repeat(400), due_on: null }, assignees: [{ login: 'y'.repeat(300) }] }),
      issue(4, { milestone: { title: '\u0001 bad', due_on: null } }),
    ]
    : []));
  await run(repo, { token: 't' });
  const { rows } = db.listTicketSources(userId, { provider: 'github', repo, state: null, limit: 100 });
  const byNumber = Object.fromEntries(rows.map((r) => [r.meta.number, r.meta]));
  assert.deepEqual(byNumber[1].milestone, { title: 'v1.0', dueOn: '2026-11-30T07:00:00Z' });
  assert.deepEqual(byNumber[1].assignees, ['bob', 'bob'], 'bell character stripped from the login');
  assert.equal(byNumber[1].labels[0], 'bug');
  assert.equal(byNumber[2].milestone, null);
  assert.deepEqual(byNumber[2].assignees, []);
  assert.equal(byNumber[3].milestone.title.length, 200);
  assert.equal(byNumber[3].milestone.dueOn, null);
  assert.equal(byNumber[3].assignees[0].length, 100);
  assert.equal(byNumber[4].milestone.title, ' bad');
  assert.equal('dueDate' in byNumber[1], false, 'GitHub issues carry no due date of their own');
});

test('a 401 from GitHub is rejected by the existing error path, no rows written', async () => {
  _setPinnedFetchForTests(async () => new Response('{"message":"Bad credentials"}', { status: 401 }));
  await assert.rejects(
    () => run('example/auth', { token: 'wrong' }),
    /GitHub auth failed \(401\)/,
  );
  const { total } = db.listTicketSources(userId, { provider: 'github', repo: 'example/auth', state: null, limit: 10 });
  assert.equal(total, 0);
});

test('pull requests in the /issues answer are kept and flagged isPR', async () => {
  const repo = 'example/prs';
  serve((page) => (page === 1
    ? [issue(1), issue(2, { pull_request: { url: 'x' }, html_url: `https://github.com/${repo}/pull/2` })]
    : []));
  await run(repo, { token: 't' });
  const { rows } = db.listTicketSources(userId, { provider: 'github', repo, state: null, limit: 10 });
  const byNumber = Object.fromEntries(rows.map((r) => [r.meta.number, r.meta]));
  assert.equal(byNumber[1].isPR, false);
  assert.equal(byNumber[2].isPR, true);
});

test('an invalid milestone due date is stored as null; labels are cleaned and capped', async () => {
  const repo = 'example/badfields';
  serve((page) => (page === 1
    ? [issue(1, {
      milestone: { title: 'v2', due_on: 'not a date' },
      labels: [{ name: 'a\u0007b' }, 'z'.repeat(300), ...Array.from({ length: 150 }, (_, i) => `l${i}`)],
    })]
    : []));
  await run(repo, { token: 't' });
  const { rows } = db.listTicketSources(userId, { provider: 'github', repo, state: null, limit: 10 });
  assert.deepEqual(rows[0].meta.milestone, { title: 'v2', dueOn: null });
  assert.equal(rows[0].meta.labels[0], 'ab');
  assert.equal(rows[0].meta.labels[1].length, 100);
  assert.equal(rows[0].meta.labels.length, 100);
});

test('a redirect to another host is refused: the token never leaves api.github.com', async () => {
  calls = [];
  _setPinnedFetchForTests(async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u, headers: init.headers || {} });
    if (u.host !== 'api.github.com') return new Response('[]', { status: 200 });
    return new Response(null, { status: 301, headers: { location: 'https://evil.example/repos/example/repo/issues?page=1' } });
  });
  await assert.rejects(() => run('example/redirect', { token: 'secret-tok' }));
  assert.ok(calls.every((c) => c.url.host === 'api.github.com'), 'no request to the foreign host');
  const { total } = db.listTicketSources(userId, { provider: 'github', repo: 'example/redirect', state: null, limit: 10 });
  assert.equal(total, 0);
});

test('a rate limit on page 2 stops the run without looping and keeps the stored rows', async () => {
  const repo = 'example/ratelimit';
  serve((page) => (page === 1 ? range(1, 3) : []));
  await run(repo, { token: 't' });
  calls = [];
  _setPinnedFetchForTests(async (url) => {
    const page = Number(new URL(String(url)).searchParams.get('page'));
    calls.push(page);
    if (page === 1) return new Response(JSON.stringify(range(1, 100)), { status: 200 });
    return new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' } });
  });
  await assert.rejects(() => run(repo, { token: 't' }), /rate-limit exceeded/);
  assert.deepEqual(calls, [1, 2], 'one request per page, no retry loop');
  const { total } = db.listTicketSources(userId, { provider: 'github', repo, state: null, limit: 10 });
  assert.equal(total, 3, 'a failed run deletes nothing');
});
