// HTTP route tests for the issue-schedule overlay (gantt parity). Drives
// the real kb router (handleKB) with mock req/res, exercising GET/PUT/DELETE
// and the validation envelope.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_issue-schedule-routes-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const { handleKB } = await import('../kb/router.mjs');
const users = await import('../server/users.mjs');

function resetDb() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
}

function makeReq({ method, url, body, userId }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method, url, user: { id: userId },
    on(event, cb) {
      if (event === 'data') chunks.forEach((c) => cb(c));
      else if (event === 'end') cb();
      return req;
    },
  };
  return req;
}

function makeRes() {
  return {
    statusCode: 200, headers: {}, _body: '',
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); },
    setHeader(k, v) { this.headers[k] = v; },
    write(chunk) { this._body += chunk; },
    end(chunk) { if (chunk) this._body += chunk; this.ended = true; },
  };
}

function mkUser(tag) {
  return users.registerUser(db.getDb(), {
    email: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'CorrectHorseBattery', displayName: tag,
  }).id;
}

async function call(method, url, body, userId) {
  const res = makeRes();
  const handled = await handleKB(makeReq({ method, url, body, userId }), res);
  return { handled, status: res.statusCode, json: res._body ? JSON.parse(res._body) : null };
}

test('PUT then GET round-trips a schedule for the user', async () => {
  resetDb();
  const u = mkUser('sched');
  const put = await call('PUT', '/kb/issue-schedule',
    { provider: 'github', repo: 'octo/repo', issueNumber: 12, startDate: '2026-07-01', dueDate: '2026-07-09', estimateDays: 2, dependsOn: [3] }, u);
  assert.equal(put.handled, true);
  assert.equal(put.status, 200);
  assert.equal(put.json.issueNumber, 12);

  const get = await call('GET', '/kb/issue-schedule?provider=github&repo=octo/repo', null, u);
  assert.equal(get.status, 200);
  assert.equal(get.json.count, 1);
  assert.equal(get.json.schedules[0].dueDate, '2026-07-09');
});

test('PUT rejects a malformed date with 400 VALIDATION_FAILED', async () => {
  resetDb();
  const u = mkUser('bad');
  const put = await call('PUT', '/kb/issue-schedule',
    { provider: 'github', repo: 'octo/repo', issueNumber: 1, dueDate: 'not-a-date' }, u);
  assert.equal(put.status, 400);
  assert.equal(put.json.error.code, 'VALIDATION_FAILED');
});

test('DELETE removes the schedule', async () => {
  resetDb();
  const u = mkUser('del');
  await call('PUT', '/kb/issue-schedule', { provider: 'github', repo: 'octo/repo', issueNumber: 5, dueDate: '2026-07-09' }, u);
  const del = await call('DELETE', '/kb/issue-schedule', { provider: 'github', repo: 'octo/repo', issueNumber: 5 }, u);
  assert.equal(del.status, 200);
  assert.equal(del.json.deleted, true);
  const get = await call('GET', '/kb/issue-schedule?provider=github&repo=octo/repo', null, u);
  assert.equal(get.json.count, 0);
});

test('tenancy: a second user does not see the first user\'s schedule', async () => {
  resetDb();
  const u1 = mkUser('one');
  const u2 = mkUser('two');
  await call('PUT', '/kb/issue-schedule', { provider: 'github', repo: 'octo/repo', issueNumber: 9, dueDate: '2026-07-09' }, u1);
  const get = await call('GET', '/kb/issue-schedule?provider=github&repo=octo/repo', null, u2);
  assert.equal(get.json.count, 0, 'no cross-tenant read');
});
