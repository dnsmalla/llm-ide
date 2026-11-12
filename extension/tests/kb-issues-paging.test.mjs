// GET /kb/issues paging and fields (API 105). Drives the real router handler
// against a temp DB: SQL filter, order, offset/limit boundaries, the
// total/hasMore/nextOffset envelope, tenant isolation, malformed meta, and the
// milestone/assignees fields.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-issues-paging-'));
const tmpDb = path.join(WS, 'kb.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const { handleKB } = await import('../routes/router.mjs');
const users = await import('../server/users.mjs');

after(() => {
  db.closeDb();
  fs.rmSync(WS, { recursive: true, force: true });
});

function makeReq({ url, userId }) {
  return { method: 'GET', url, user: { id: userId }, on(ev, cb) { if (ev === 'end') cb(); return this; } };
}
function makeRes() {
  return {
    statusCode: 200, headers: {}, _body: '',
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); },
    setHeader(k, v) { this.headers[k] = v; },
    write(c) { this._body += c; },
    end(c) { if (c) this._body += c; this.ended = true; },
  };
}
async function getIssues(userId, query) {
  const res = makeRes();
  const handled = await handleKB(makeReq({ url: `/kb/issues?${query}`, userId }), res);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200, res._body);
  return JSON.parse(res._body);
}

let seq = 0;
function register(tag) {
  seq += 1;
  return users.registerUser(db.getDb(), {
    email: `issues-${tag}-${seq}-${Date.now()}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: tag,
  }).id;
}

// updatedAt grows with n, so n = count is the newest row.
const stamp = (n) => new Date(Date.UTC(2026, 9, 1) + n * 60_000).toISOString();
function ticket({ n, repo = 'example/repo', provider = 'github', state = 'open', updatedAt, meta = {} }) {
  return {
    kind: 'ticket',
    ref: `https://github.com/${repo}/issues/${n}`,
    title: `Issue ${n}`,
    body: `body ${n}`,
    meta: { provider, repo, number: n, state, labels: [], updatedAt: updatedAt ?? stamp(n), ...meta },
  };
}
const numbers = (body) => body.issues.map((i) => i.number);

test('first page: default filters, newest update first, envelope fields', async () => {
  const u = register('first');
  const items = [];
  for (let n = 1; n <= 25; n += 1) items.push(ticket({ n }));
  items.push(ticket({ n: 100, state: 'closed' }));
  items.push(ticket({ n: 200, provider: 'gitlab' }));
  db.ingestSources(u, items);

  const body = await getIssues(u, 'repo=example%2Frepo');
  assert.equal(body.total, 25, 'open github rows only');
  assert.equal(body.issues.length, 20, 'default limit is 20');
  assert.deepEqual(numbers(body).slice(0, 3), [25, 24, 23]);
  assert.equal(body.hasMore, true);
  assert.equal(body.nextOffset, 20);
  assert.equal(body.issues[0].url, 'https://github.com/example/repo/issues/25', 'url carries the stored ref');
  assert.equal(typeof body.issues[0].id, 'string');
});

test('limit: zero, negative, NaN, fraction below 1 give 20; above 100 caps at 100', async () => {
  const u = register('limit');
  const items = [];
  for (let n = 1; n <= 105; n += 1) items.push(ticket({ n, repo: 'example/big' }));
  db.ingestSources(u, items);
  const q = 'repo=example%2Fbig';
  for (const raw of ['0', '-3', 'NaN', 'abc', '0.5', '']) {
    const body = await getIssues(u, `${q}&limit=${encodeURIComponent(raw)}`);
    assert.equal(body.issues.length, 20, `limit=${raw}`);
  }
  assert.equal((await getIssues(u, `${q}&limit=101`)).issues.length, 100);
  assert.equal((await getIssues(u, `${q}&limit=100`)).issues.length, 100);
  assert.equal((await getIssues(u, `${q}&limit=2.9`)).issues.length, 2);
  const big = await getIssues(u, `${q}&limit=101`);
  assert.equal(big.total, 105);
  assert.equal(big.hasMore, true);
  assert.equal(big.nextOffset, 100);
});

test('offset: beyond the total is an empty page; negative, NaN and empty are the first page', async () => {
  const u = register('offset');
  const items = [];
  for (let n = 1; n <= 25; n += 1) items.push(ticket({ n }));
  db.ingestSources(u, items);
  const past = await getIssues(u, 'repo=example%2Frepo&offset=500');
  assert.deepEqual(past.issues, []);
  assert.equal(past.total, 25);
  assert.equal(past.hasMore, false);
  assert.equal(past.nextOffset, null);
  for (const raw of ['-4', 'NaN', '']) {
    const body = await getIssues(u, `repo=example%2Frepo&offset=${encodeURIComponent(raw)}`);
    assert.equal(body.issues[0].number, 25, `offset=${raw} is the first page`);
  }
});

test('walking pages with nextOffset yields every row once, in a stable order', async () => {
  const u = register('walk');
  const items = [];
  for (let n = 1; n <= 25; n += 1) items.push(ticket({ n }));
  // Three rows with the same updatedAt: the tie breaks on id descending (insertion order reversed).
  for (let n = 300; n < 303; n += 1) items.push(ticket({ n, repo: 'example/ties', updatedAt: stamp(1) }));
  db.ingestSources(u, items);

  const walk = async () => {
    const seen = [];
    let offset = 0;
    let pages = 0;
    for (;;) {
      const body = await getIssues(u, `repo=example%2Frepo&limit=7&offset=${offset}`);
      seen.push(...numbers(body));
      pages += 1;
      if (body.nextOffset === null) break;
      assert.equal(body.hasMore, true);
      offset = body.nextOffset;
    }
    return { seen, pages };
  };
  const first = await walk();
  assert.equal(first.pages, 4);
  assert.equal(new Set(first.seen).size, 25, 'no duplicates across pages');
  assert.deepEqual(first.seen, Array.from({ length: 25 }, (_, i) => 25 - i));
  assert.deepEqual(await walk(), first, 'same order on a second walk');

  const ties = await getIssues(u, 'repo=example%2Fties');
  assert.deepEqual(numbers(ties), [302, 301, 300], 'equal updatedAt: id descending');
});

test('filter combinations: state, provider and repo are applied in SQL and counted in total', async () => {
  const u = register('filters');
  const items = [];
  for (let n = 1; n <= 25; n += 1) items.push(ticket({ n }));
  items.push(ticket({ n: 100, state: 'closed' }));
  items.push(ticket({ n: 200, provider: 'gitlab' }));
  items.push(ticket({ n: 201, repo: 'example/other' }));
  db.ingestSources(u, items);

  assert.equal((await getIssues(u, 'repo=example%2Frepo&state=closed')).total, 1);
  assert.equal((await getIssues(u, 'repo=example%2Frepo&state=all')).total, 26);
  assert.equal((await getIssues(u, 'repo=example%2Frepo&state=all&limit=5')).issues.length, 5);
  const gl = await getIssues(u, 'repo=example%2Frepo&provider=gitlab&state=all');
  assert.equal(gl.total, 1);
  assert.equal(gl.issues[0].provider, 'gitlab');
  assert.equal((await getIssues(u, 'repo=example%2Fmissing')).total, 0);
  const noRepo = await getIssues(u, 'state=all&limit=100');
  assert.equal(noRepo.total, 27, 'no repo filter: every github ticket of the user');
});

test('tenant isolation: another user sees none of these rows, and the same repo name stays separate', async () => {
  const a = register('tenant-a');
  const b = register('tenant-b');
  const items = [];
  for (let n = 1; n <= 5; n += 1) items.push(ticket({ n }));
  db.ingestSources(a, items);
  const mine = await getIssues(a, 'repo=example%2Frepo&state=all');
  assert.equal(mine.total, 5);
  const theirs = await getIssues(b, 'repo=example%2Frepo&state=all');
  assert.equal(theirs.total, 0);
  assert.deepEqual(theirs.issues, []);
  assert.equal(theirs.hasMore, false);
  db.ingestSources(b, [ticket({ n: 9 })]);
  assert.deepEqual(numbers(await getIssues(b, 'repo=example%2Frepo')), [9]);
  assert.equal((await getIssues(a, 'repo=example%2Frepo')).total, 5);
});

test('malformed meta is skipped, never a 500', async () => {
  const u = register('malformed');
  db.ingestSources(u, [ticket({ n: 1 })]);
  db.getDb().prepare(
    "INSERT INTO sources (user_id, kind, ref, chunk_idx, title, body, meta) VALUES (?, 'ticket', 'https://github.com/example/repo/issues/77', 0, 'broken', '', 'not json')",
  ).run(u);
  const body = await getIssues(u, 'repo=example%2Frepo&state=all');
  assert.equal(body.total, 1);
  assert.deepEqual(numbers(body), [1]);
});

test('milestone and assignees are returned; rows without them get null and []', async () => {
  const u = register('fields');
  db.ingestSources(u, [
    ticket({
      n: 1,
      meta: {
        milestone: { title: 'v1.0', dueOn: '2026-11-30T07:00:00Z' },
        assignees: ['alice', 'bob'],
      },
    }),
    ticket({ n: 2 }),
  ]);
  const body = await getIssues(u, 'repo=example%2Frepo');
  const byNumber = Object.fromEntries(body.issues.map((i) => [i.number, i]));
  assert.deepEqual(byNumber[1].milestone, { title: 'v1.0', dueOn: '2026-11-30T07:00:00Z' });
  assert.deepEqual(byNumber[1].assignees, ['alice', 'bob']);
  assert.equal(byNumber[2].milestone, null);
  assert.deepEqual(byNumber[2].assignees, []);
});

test('an old client that sends no offset still gets the same fields it read before', async () => {
  const u = register('legacy');
  db.ingestSources(u, [ticket({ n: 1 })]);
  const body = await getIssues(u, 'repo=example%2Frepo&state=open&limit=5&provider=github');
  const issue = body.issues[0];
  // Every key a pre-105 client could read is still present, and nothing new is required of it.
  const pre105 = ['id', 'title', 'body', 'url', 'provider', 'repo', 'number', 'state', 'labels', 'author', 'createdAt', 'updatedAt', 'isPR'];
  const added = ['milestone', 'assignees', 'dueDate'];
  for (const key of Object.keys(issue)) assert.ok([...pre105, ...added].includes(key), `unexpected key ${key}`);
  for (const key of ['id', 'title', 'body', 'url', 'provider', 'repo', 'number', 'state', 'labels']) {
    assert.ok(key in issue, `missing ${key}`);
  }
  assert.equal(issue.title, 'Issue 1');
  assert.equal(issue.state, 'open');
});

test('hasMore and nextOffset on an exact-multiple last page', async () => {
  const u = register('exact');
  const items = [];
  for (let n = 1; n <= 20; n += 1) items.push(ticket({ n }));
  db.ingestSources(u, items);
  const first = await getIssues(u, 'repo=example%2Frepo&limit=10');
  assert.equal(first.hasMore, true);
  assert.equal(first.nextOffset, 10);
  const last = await getIssues(u, 'repo=example%2Frepo&limit=10&offset=10');
  assert.equal(last.issues.length, 10);
  assert.equal(last.hasMore, false, 'a full last page has nothing after it');
  assert.equal(last.nextOffset, null);
});

test('repeated params use the first value; a huge offset is an empty page, never a 500', async () => {
  const u = register('repeat');
  const items = [];
  for (let n = 1; n <= 5; n += 1) items.push(ticket({ n }));
  db.ingestSources(u, items);
  const body = await getIssues(u, 'repo=example%2Frepo&limit=2&limit=50&offset=1&offset=0');
  assert.deepEqual(numbers(body), [4, 3]);
  for (const raw of ['1e20', '99999999999999999999', '1e400']) {
    const b = await getIssues(u, `repo=example%2Frepo&offset=${raw}`);
    assert.equal(b.total, 5, `offset=${raw}`);
  }
});

test('caller-supplied meta from the JSON importer is reduced to the documented shapes', async () => {
  const u = register('shapes');
  db.ingestSources(u, [
    ticket({ n: 1, meta: { milestone: 'v1', assignees: ['ann', { login: 'x' }, 7] } }),
    ticket({ n: 2, meta: { milestone: { title: 'v2', dueOn: 5, extra: 'drop' } } }),
  ]);
  const byNumber = Object.fromEntries((await getIssues(u, 'repo=example%2Frepo')).issues.map((i) => [i.number, i]));
  assert.equal(byNumber[1].milestone, null);
  assert.deepEqual(byNumber[1].assignees, ['ann']);
  assert.deepEqual(byNumber[2].milestone, { title: 'v2', dueOn: null });
});

test('GitLab\'s own due date is returned as dueDate; an issue without one (or GitHub) answers null', async () => {
  const u = register('gl-due');
  const gl = (n, extra = {}) => ({ ...ticket({ n }), meta: { ...ticket({ n }).meta, provider: 'gitlab', repo: 'group/sub/project', ...extra } });
  db.ingestSources(u, [gl(1, { dueDate: '2026-12-24' }), gl(2), gl(3, { dueDate: 'not a date' })]);
  const body = await getIssues(u, 'repo=group%2Fsub%2Fproject&state=open&limit=10&provider=gitlab');
  const by = Object.fromEntries(body.issues.map((i) => [i.number, i.dueDate]));
  assert.deepEqual(by, { 1: '2026-12-24', 2: null, 3: null });
});
