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

test('a truncated run (2500 issues, 20-page cap) upserts what it fetched and deletes nothing', async () => {
  const repo = 'example/trunc';
  serve((page) => (page === 1 ? range(9001, 9003) : []));
  await run(repo, { token: 't' });
  assert.equal(db.listTicketSources(userId, { provider: 'github', repo, state: null, limit: 10 }).total, 3, 'the older rows are stored first');
  serve((page) => range((page - 1) * 100 + 1, page * 100));
  const result = await run(repo, { token: 't' });
  assert.equal(result.truncated, true);
  assert.equal(result.count, 2000, 'the run stops at the 20-page cap');
  const { total, rows } = db.listTicketSources(userId, { provider: 'github', repo, state: null, limit: 10000 });
  assert.equal(total, 2003, 'the 3 older rows the run never saw are kept');
  assert.ok(rows.some((r) => r.meta.number === 9001), 'an older row survived');
});

test('a run that finished without truncation replaces the repo: a vanished issue is removed', async () => {
  const repo = 'example/vanish';
  serve((page) => (page === 1 ? range(1, 100) : page === 2 ? range(101, 155) : []));
  await run(repo, { token: 't' });
  serve((page) => (page === 1 ? range(1, 100) : page === 2 ? range(101, 150) : []));
  const result = await run(repo, { token: 't' });
  assert.equal(result.truncated, false);
  const { total, rows } = db.listTicketSources(userId, { provider: 'github', repo, state: null, limit: 10000 });
  assert.equal(total, 150);
  assert.ok(!rows.some((r) => r.meta.number === 153), 'issue 153 vanished upstream and is gone');
});

test('an error on page 2 deletes nothing: the stored rows stay', async () => {
  const repo = 'example/pageerr';
  serve((page) => (page === 1 ? range(1, 3) : []));
  await run(repo, { token: 't' });
  _setPinnedFetchForTests(async (url) => {
    const page = Number(new URL(String(url)).searchParams.get('page'));
    if (page === 1) return new Response(JSON.stringify(range(1, 100)), { status: 200 });
    return new Response('{}', { status: 500 });
  });
  await assert.rejects(() => run(repo, { token: 't' }), /status 500/);
  const { total } = db.listTicketSources(userId, { provider: 'github', repo, state: null, limit: 10 });
  assert.equal(total, 3, 'a run that errors midway keeps every stored row');
});

test('a secondary limit with Retry-After stops cleanly: the result reports retryAfter, rows are kept, nothing deleted', async () => {
  const repo = 'example/secondary';
  serve((page) => (page === 1 ? range(1, 3) : []));
  await run(repo, { token: 't' });
  _setPinnedFetchForTests(async (url) => {
    const page = Number(new URL(String(url)).searchParams.get('page'));
    if (page === 1) return new Response(JSON.stringify(range(10, 109)), { status: 200 });
    return new Response('{}', { status: 429, headers: { 'retry-after': '30' } });
  });
  const result = await run(repo, { token: 't' });
  assert.equal(result.retryAfter, 30);
  assert.equal(result.truncated, true);
  assert.equal(result.count, 100);
  const { total, rows } = db.listTicketSources(userId, { provider: 'github', repo, state: null, limit: 1000 });
  assert.equal(total, 103, 'the 3 old rows are kept and the 100 fetched rows are upserted');
  assert.ok(rows.some((r) => r.meta.number === 1));
});

test('a 403 with Retry-After is a secondary limit too; without it the run still fails as before', async () => {
  const repo = 'example/secondary403';
  _setPinnedFetchForTests(async () => new Response('{}', { status: 403, headers: { 'retry-after': '60' } }));
  const stopped = await run(repo, { token: 't' });
  assert.equal(stopped.retryAfter, 60);
  assert.equal(stopped.count, 0);
  _setPinnedFetchForTests(async () => new Response('{}', { status: 403 }));
  await assert.rejects(() => run(repo, { token: 't' }), /auth failed \(403\)/);
});

test('without a limit the result carries retryAfter null', async () => {
  serve((page) => (page === 1 ? range(1, 2) : []));
  const result = await run('example/nolimit', { token: 't' });
  assert.equal(result.retryAfter, null);
});

test('Retry-After: an HTTP-date is read, and absurd, negative, empty or junk values are held to 1 s .. 1 h (default 60)', async () => {
  const at = (h) => {
    _setPinnedFetchForTests(async () => new Response('{}', { status: 429, headers: h == null ? {} : { 'retry-after': h } }));
    return run('example/retry', { token: 't' });
  };
  const date = new Date(Date.now() + 120_000).toUTCString();
  const r = (await at(date)).retryAfter;
  assert.ok(r >= 118 && r <= 121, `HTTP-date read as ~120 s, got ${r}`);
  assert.equal((await at('99999999')).retryAfter, 3600);
  assert.equal((await at(new Date(Date.now() + 864e5 * 30).toUTCString())).retryAfter, 3600);
  assert.equal((await at(new Date(Date.now() - 60_000).toUTCString())).retryAfter, 1, 'a past date is not an instant retry');
  for (const junk of ['-5', '', 'soon', '1.5e3', null]) {
    assert.equal((await at(junk)).retryAfter, 60, String(junk));
  }
});

test('a finished run deletes only this user\'s rows for this repo: a sibling repo and another user keep theirs', async () => {
  const other = users.registerUser(db.getDb(), {
    email: `gh-import-other-${Date.now()}@example.com`, password: 'CorrectHorseBattery', displayName: 'o',
  }).id;
  serve(() => []);
  curRepo = 'example/iso';
  db.ingestSources(other, [{ kind: 'ticket', ref: 'https://github.com/example/iso/issues/1', title: 'theirs', body: 'b', meta: { provider: 'github', repo: 'example/iso' } }]);
  serve((page) => (page === 1 ? range(1, 2) : []));
  await run('example/iso-sibling', { token: 't' });
  serve((page) => (page === 1 ? range(1, 2) : []));
  await run('example/iso', { token: 't' });
  serve(() => []);
  const result = await run('example/iso', { token: 't' });
  assert.equal(result.truncated, false);
  assert.equal(db.listTicketSources(userId, { provider: 'github', repo: 'example/iso', state: null, limit: 10 }).total, 0, 'the empty finished run cleared this repo');
  assert.equal(db.listTicketSources(userId, { provider: 'github', repo: 'example/iso-sibling', state: null, limit: 10 }).total, 2, 'a sibling repo sharing the prefix is kept');
  assert.equal(db.getDb().prepare("SELECT COUNT(*) AS n FROM sources WHERE user_id = ? AND kind = 'ticket'").get(other).n, 1, 'another user\'s row is kept');
});

// --- GitLab importer: same paging and replacement rules, nested groups, GitLab's own due date ---

const { indexGitlabIssues, gitlabSlug } = await import('../connectors/issues.mjs');

function glIssue(n, slug, overrides = {}) {
  return {
    iid: n, title: `Issue ${n}`, description: `body ${n}`, state: 'opened', web_url: `https://gitlab.com/${slug}/-/issues/${n}`,
    labels: ['bug'], author: { username: 'ann' }, assignees: [{ username: 'bob' }], due_date: '2026-12-24',
    milestone: { title: 'v1', due_date: '2026-12-31' }, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z', closed_at: null,
    ...overrides,
  };
}

test('gitlabSlug accepts nested groups and URLs and rejects other shapes', () => {
  assert.equal(gitlabSlug('group/sub/project'), 'group/sub/project');
  assert.equal(gitlabSlug('https://gitlab.com/group/sub/project.git/'), 'group/sub/project');
  for (const bad of ['', 'solo', 'a//b', 'a/../b', 'a b/c', `g/${Array(20).fill('s').join('/')}`]) assert.throws(() => gitlabSlug(bad), /Repo must be/, bad);
});

test('GitLab import: maps the issue, keeps its own due date, sends the token only to gitlab.com, and re-runs replace', async () => {
  const slug = 'group/sub/project';
  calls = [];
  _setPinnedFetchForTests(async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u, headers: init.headers || {} });
    return new Response(JSON.stringify(Number(u.searchParams.get('page')) === 1 ? [glIssue(1, slug), glIssue(2, slug, { state: 'closed', due_date: null })] : []), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const r = await indexGitlabIssues(userId, { repo: slug, token: 'glpat-test', state: 'open' });
  assert.equal(r.count, 2); assert.equal(r.truncated, false);
  assert.equal(calls[0].url.hostname, 'gitlab.com');
  assert.equal(calls[0].url.pathname, `/api/v4/projects/${encodeURIComponent(slug)}/issues`.replace(/%2F/g, '%2F'));
  assert.equal(calls[0].url.searchParams.get('state'), 'opened', 'open is spelled "opened" for GitLab');
  assert.equal(calls[0].headers['PRIVATE-TOKEN'], 'glpat-test');
  const page = db.listTicketSources(userId, { provider: 'gitlab', repo: slug, state: null, limit: 10, offset: 0 });
  const one = page.rows.find((x) => x.meta.number === 1);
  assert.equal(one.meta.state, 'open'); assert.equal(one.meta.dueDate, '2026-12-24'); assert.deepEqual(one.meta.milestone, { title: 'v1', dueOn: '2026-12-31' });
  assert.deepEqual(one.meta.assignees, ['bob']);
  assert.equal(page.rows.find((x) => x.meta.number === 2).meta.dueDate, null);
  // An exhausted re-run replaces the project's rows: an issue gone upstream goes.
  _setPinnedFetchForTests(async (url) => new Response(JSON.stringify(Number(new URL(String(url)).searchParams.get('page')) === 1 ? [glIssue(1, slug)] : []), { status: 200 }));
  await indexGitlabIssues(userId, { repo: slug, token: 'glpat-test' });
  assert.equal(db.listTicketSources(userId, { provider: 'gitlab', repo: slug, state: null, limit: 10, offset: 0 }).total, 1);
});

test('GitLab import: auth, missing project and rate limit are reported plainly', async () => {
  for (const [status, re] of [[401, /GitLab auth failed \(401\)/], [404, /Project not found/]]) {
    _setPinnedFetchForTests(async () => new Response('{}', { status }));
    await assert.rejects(indexGitlabIssues(userId, { repo: 'g/p', token: 'x' }), re);
  }
  _setPinnedFetchForTests(async () => new Response('{}', { status: 429, headers: { 'retry-after': '30' } }));
  const r = await indexGitlabIssues(userId, { repo: 'g/limited', token: 'x' });
  assert.equal(r.truncated, true); assert.equal(r.retryAfter, 30);
});
