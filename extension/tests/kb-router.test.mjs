// Tests for /kb router handler — security-focused.
//
// Pins the path-traversal guard on /kb/connect-git: only paths that the
// user has explicitly added to their per-user repo allow-list (via
// /auth/me/repos, mirroring codegen-apply's check) may be indexed.
// Without this guard a tenant could index arbitrary host filesystem
// paths (e.g. /etc, /root) into their searchable KB.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.MEETNOTES_JWT_SECRET = 'a'.repeat(48);
process.env.MEETNOTES_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_kb-router-test.db');
process.env.MEETNOTES_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const { handleKB } = await import('../kb/router.mjs');
const { appendCaptions, _resetForTests: resetLive } = await import('../agents/live-sessions.mjs');

function resetDb() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
  resetLive();
}

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
  };
}

test('POST /kb/connect-git rejects an un-allowlisted path with 403 PATH_NOT_APPROVED', async () => {
  resetDb();
  const userId = 'u-test-' + Date.now();

  const req = makeReq({
    method: 'POST',
    url: '/kb/connect-git',
    body: { path: '/etc' },
    userId,
  });
  const res = makeRes();
  const handled = await handleKB(req, res);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 403);
  const parsed = JSON.parse(res._body);
  assert.equal(parsed.error.code, 'PATH_NOT_APPROVED');
});

test('POST /kb/connect-git rejects relative-traversal path that resolves outside the allow-list', async () => {
  resetDb();
  // Provision a real user so the FK constraint on user_repos holds.
  const users = await import('../server/users.mjs');
  const u = users.registerUser(db.getDb(), {
    email: `pathtrav-${Date.now()}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: 'pt',
  });
  db.addUserRepo(u.id, '/tmp/safe', 'safe');

  const req = makeReq({
    method: 'POST',
    url: '/kb/connect-git',
    body: { path: '/tmp/safe/../../etc' },
    userId: u.id,
  });
  const res = makeRes();
  await handleKB(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res._body).error.code, 'PATH_NOT_APPROVED');
});

test('GET /kb/system/status returns linked capture + review flow state for the authenticated user', async () => {
  resetDb();
  const users = await import('../server/users.mjs');
  const u = users.registerUser(db.getDb(), {
    email: `status-${Date.now()}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: 'status',
  });

  appendCaptions(u.id, 'live-session-1', [{
    speaker: 'Alice',
    text: 'We should ship the hardening patch today.',
    ts: Date.now(),
    source: 'extension-cc',
  }], 'Production Review');
  db.submitReview(u.id, {
    kind: 'dispatch',
    title: 'Approve automation dispatch',
    payload: { target: 'github' },
    guardrails: {},
  });

  const req = makeReq({
    method: 'GET',
    url: '/kb/system/status',
    userId: u.id,
  });
  const res = makeRes();
  const handled = await handleKB(req, res);

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res._body);
  assert.equal(body.flow.capture.activeCount, 1);
  assert.equal(body.flow.capture.sessions[0].sessionId, 'live-session-1');
  assert.equal(body.flow.review.pendingCount, 1);
  assert.equal(body.flow.review.pendingItems.length, 1);
  assert.equal(body.flow.agent.activeCount, 0);
});
