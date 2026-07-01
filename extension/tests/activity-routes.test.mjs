// Tests for the /kb/activity HTTP routes.
// Uses the same req/res double pattern as kb-router.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_activity-routes-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

// Clean up any stale DB files before the test run.
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

// Mirrored from kb-router.test.mjs — minimal Node http-compatible doubles.
function makeReq({ method, url, body, userId }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    url,
    user: { id: userId },
    _chunks: chunks,
    on(event, cb) {
      if (event === 'data') chunks.forEach((c) => cb(c));
      else if (event === 'end') cb();
      else if (event === 'close') { /* no-op */ }
      return req;
    },
  };
  return req;
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    _body: '',
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); },
    setHeader(k, v) { this.headers[k] = v; },
    write(chunk) { this._body += chunk; },
    end(chunk) { if (chunk) this._body += chunk; this.ended = true; },
    json() { return JSON.parse(this._body); },
  };
}

const db = await import('../kb/db.mjs');
const { handleKB } = await import('../kb/router.mjs');

function resetDb() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
}

test('POST /kb/activity records a valid event; GET returns it; seen clears unread', async () => {
  resetDb();
  const users = await import('../server/users.mjs');
  const u = users.registerUser(db.getDb(), {
    email: `activity-route-${Date.now()}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: 'ar',
  });
  const userId = u.id;

  // POST: record a valid activity event.
  let res = makeRes();
  await handleKB(makeReq({
    method: 'POST',
    url: '/kb/activity',
    userId,
    body: { kind: 'issue_created', title: 'Issue created — X', detail: { url: 'https://x/1' } },
  }), res);
  assert.equal(res.statusCode, 200);
  const postBody = res.json();
  assert.equal(postBody.ok, true);
  assert.ok(typeof postBody.id === 'number', 'id should be a number');
  const id = postBody.id;

  // GET: list the feed — should have 1 item, unread=1.
  res = makeRes();
  await handleKB(makeReq({ method: 'GET', url: '/kb/activity', userId }), res);
  assert.equal(res.statusCode, 200);
  const getBody = res.json();
  assert.equal(getBody.items.length, 1);
  assert.equal(getBody.unread, 1);
  assert.equal(getBody.lastId, id);

  // POST /seen: advance cursor — unread should drop to 0.
  res = makeRes();
  await handleKB(makeReq({
    method: 'POST',
    url: '/kb/activity/seen',
    userId,
    body: { uptoId: id },
  }), res);
  assert.equal(res.statusCode, 200);
  const seenBody = res.json();
  assert.equal(seenBody.ok, true);
  assert.equal(seenBody.unread, 0);
});

test('POST /kb/activity rejects an unknown kind with 400', async () => {
  resetDb();
  const users = await import('../server/users.mjs');
  const u = users.registerUser(db.getDb(), {
    email: `activity-route-bad-${Date.now()}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: 'arb',
  });

  const res = makeRes();
  await handleKB(makeReq({
    method: 'POST',
    url: '/kb/activity',
    userId: u.id,
    body: { kind: 'nope', title: 'x' },
  }), res);
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.error.code, 'VALIDATION_FAILED');
});

test('POST /kb/activity rejects a missing title with 400', async () => {
  resetDb();
  const users = await import('../server/users.mjs');
  const u = users.registerUser(db.getDb(), {
    email: `activity-route-notitle-${Date.now()}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: 'arnt',
  });

  const res = makeRes();
  await handleKB(makeReq({
    method: 'POST',
    url: '/kb/activity',
    userId: u.id,
    body: { kind: 'issue_created' },
  }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'VALIDATION_FAILED');
});

test('recordActivity is called for email_fetched with count>0 shape', async () => {
  // Guard test: the email_fetched kind is in the allow-list and round-trips.
  const { getDb } = await import('../kb/db.mjs');
  const { registerUser } = await import('../server/users.mjs');
  const { recordActivity, listActivity } = await import('../kb/activity.mjs');
  resetDb();
  getDb();
  const { id: userId } = registerUser(getDb(), { email: 'u-email-evt@example.com', password: 'pw-12345678', displayName: 'evttest' });
  const dbInst = getDb();
  recordActivity(dbInst, { userId, kind: 'email_fetched', title: 'Fetched 7 new emails', detail: { count: 7 } });
  const items = listActivity(dbInst, userId, {});
  assert.equal(items[0].kind, 'email_fetched');
});

test('GET /kb/activity?since=<id> returns only newer items', async () => {
  resetDb();
  const users = await import('../server/users.mjs');
  const u = users.registerUser(db.getDb(), {
    email: `activity-route-since-${Date.now()}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: 'ars',
  });
  const userId = u.id;

  // Record two events.
  let res = makeRes();
  await handleKB(makeReq({
    method: 'POST', url: '/kb/activity', userId,
    body: { kind: 'meeting_added', title: 'First event' },
  }), res);
  const firstId = res.json().id;

  res = makeRes();
  await handleKB(makeReq({
    method: 'POST', url: '/kb/activity', userId,
    body: { kind: 'meeting_added', title: 'Second event' },
  }), res);
  const secondId = res.json().id;

  // GET with since=firstId → should return only the second event.
  res = makeRes();
  await handleKB(makeReq({
    method: 'GET',
    url: `/kb/activity?since=${firstId}`,
    userId,
  }), res);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].id, secondId);
  assert.equal(body.lastId, secondId);
});
