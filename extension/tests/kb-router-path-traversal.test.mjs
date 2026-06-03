// Tests for /kb/connect-git path-traversal guard.
//
// Complements the broader kb-router.test.mjs by pinning the two halves of
// the allow-list contract explicitly:
//   (a) an allowlisted path → 200 (proves the guard does not over-block)
//   (b) a path outside the allowlist → 403 PATH_NOT_APPROVED
//
// The connect-git endpoint resolves body.path via path.resolve() before
// comparing to the user's allow-list (userRepoAllowlist), so symlinks and
// "../" segments cannot smuggle access to /etc or /root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.MEETNOTES_JWT_SECRET = 'a'.repeat(48);
process.env.MEETNOTES_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_kb-router-path-traversal-test.db');
process.env.MEETNOTES_DB_PATH = tmpDb;

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
    method,
    url,
    user: { id: userId },
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
    statusCode: 200,
    headers: {},
    _body: '',
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); },
    setHeader(k, v) { this.headers[k] = v; },
    write(chunk) { this._body += chunk; },
    end(chunk) { if (chunk) this._body += chunk; this.ended = true; },
  };
}

test('POST /kb/connect-git accepts an allowlisted path (200)', async () => {
  resetDb();
  // Create a real empty directory + register it in the user's allowlist.
  // indexLocalRepo handles empty dirs gracefully (0 files indexed).
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-kbtrav-ok-'));
  try {
    const u = users.registerUser(db.getDb(), {
      email: `allow-${Date.now()}@example.com`,
      password: 'CorrectHorseBattery',
      displayName: 'allow',
    });
    db.addUserRepo(u.id, tmpRepo, 'safe-repo');

    const req = makeReq({
      method: 'POST',
      url: '/kb/connect-git',
      body: { path: tmpRepo },
      userId: u.id,
    });
    const res = makeRes();
    await handleKB(req, res);
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res._body);
    assert.equal(parsed.ok, true);
  } finally {
    try { fs.rmSync(tmpRepo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('GET /kb/meeting/<bad-id> rejects path-traversal IDs (400 INVALID_ID)', async () => {
  resetDb();
  const u = users.registerUser(db.getDb(), {
    email: `mtg-${Date.now()}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: 'mtg',
  });
  // `%2F..%2Fetc` decodes to `/../etc` — must never reach getMeeting().
  const req = makeReq({ method: 'GET', url: '/kb/meeting/%2F..%2Fetc', userId: u.id });
  const res = makeRes();
  const handled = await handleKB(req, res);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res._body).error.code, 'INVALID_ID');
});

test('GET /kb/entity/<bad-id> rejects path-traversal IDs (400 INVALID_ID)', async () => {
  resetDb();
  const u = users.registerUser(db.getDb(), {
    email: `ent-${Date.now()}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: 'ent',
  });
  const req = makeReq({ method: 'GET', url: '/kb/entity/..%2F..%2Fsecrets', userId: u.id });
  const res = makeRes();
  const handled = await handleKB(req, res);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res._body).error.code, 'INVALID_ID');
});

test('POST /kb/connect-git rejects /tmp/notarized-attack (403 PATH_NOT_APPROVED)', async () => {
  resetDb();
  const u = users.registerUser(db.getDb(), {
    email: `deny-${Date.now()}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: 'deny',
  });
  // Note: we deliberately do NOT add /tmp/notarized-attack to the allowlist.

  const req = makeReq({
    method: 'POST',
    url: '/kb/connect-git',
    body: { path: '/tmp/notarized-attack' },
    userId: u.id,
  });
  const res = makeRes();
  const handled = await handleKB(req, res);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res._body).error.code, 'PATH_NOT_APPROVED');
});
