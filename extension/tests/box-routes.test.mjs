// Tests for /kb/box/test + /kb/connect-box router handlers.
//
// Mirrors the authed-request harness in tests/kb-router.test.mjs (makeReq/
// makeRes driving handleKB directly) and reuses the global.fetch-stub
// pattern from tests/box-connector.test.mjs for the Box CCG token +
// folder-info calls. As in both siblings, LLMIDE_DB_PATH must be set
// before any (dynamic) import that transitively pulls in kb/db.mjs, since
// core/config.mjs bakes DB_PATH as a module-const at import time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_box-routes-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const { handleKB } = await import('../kb/router.mjs');
const users = await import('../server/users.mjs');
const vault = await import('../server/vault.mjs');
const { logger } = await import('../core/logger.mjs');

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

function makeUser(tag) {
  return users.registerUser(db.getDb(), {
    email: `box-route-${tag}-${Date.now()}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: tag,
  });
}

test('POST /kb/box/test 400s when no clientSecret is saved', async () => {
  resetDb();
  const u = makeUser('nosecret');

  const req = makeReq({
    method: 'POST',
    url: '/kb/box/test',
    body: { clientId: 'cid', subjectId: 'sid', folderId: 'F' },
    userId: u.id,
  });
  const res = makeRes();
  const handled = await handleKB(req, res);

  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  const parsed = JSON.parse(res._body);
  assert.equal(parsed.error.code, 'BOX_NO_SECRET');
});

test('POST /kb/connect-box 400s VALIDATION_FAILED when folderId is missing', async () => {
  resetDb();
  const u = makeUser('novalidation');
  vault.setSecret(db.getDb(), u.id, 'box.clientSecret', 'super-secret');

  const req = makeReq({
    method: 'POST',
    url: '/kb/connect-box',
    body: { clientId: 'cid', subjectId: 'sid' }, // folderId omitted
    userId: u.id,
  });
  const res = makeRes();
  const handled = await handleKB(req, res);

  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  const parsed = JSON.parse(res._body);
  assert.equal(parsed.error.code, 'VALIDATION_FAILED');
});

test('POST /kb/box/test 200s with folderName on a stubbed-fetch success', async () => {
  resetDb();
  const u = makeUser('success');
  vault.setSecret(db.getDb(), u.id, 'box.clientSecret', 'super-secret');

  const orig = global.fetch;
  global.fetch = async (urlStr) => {
    const url = String(urlStr);
    const json = (o, ok = true) => ({ ok, json: async () => o, text: async () => '' });
    if (url === 'https://api.box.com/oauth2/token') return json({ access_token: 'tok' });
    if (url.includes('/folders/F1')) {
      return json({ name: 'Contracts', item_collection: { total_count: 7 } });
    }
    return json({}, false);
  };
  try {
    const req = makeReq({
      method: 'POST',
      url: '/kb/box/test',
      body: { clientId: 'cid', subjectId: 'sid', folderId: 'F1' },
      userId: u.id,
    });
    const res = makeRes();
    const handled = await handleKB(req, res);

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res._body);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.folderName, 'Contracts');
    assert.equal(parsed.itemCount, 7);
  } finally {
    global.fetch = orig;
  }
});

test('POST /kb/box/test surfaces a redacted 502 BOX_CONNECT_FAILED on token exchange failure', async () => {
  resetDb();
  const u = makeUser('tokenfail');
  vault.setSecret(db.getDb(), u.id, 'box.clientSecret', 'sk-ant-should-not-leak-1234567890');

  const orig = global.fetch;
  global.fetch = async (urlStr) => {
    const url = String(urlStr);
    if (url === 'https://api.box.com/oauth2/token') {
      return { ok: false, status: 400, json: async () => ({ error: 'invalid_client', error_description: 'bad creds for sk-ant-should-not-leak-1234567890' }), text: async () => '' };
    }
    return { ok: false, status: 500, json: async () => ({}), text: async () => '' };
  };
  try {
    const req = makeReq({
      method: 'POST',
      url: '/kb/box/test',
      body: { clientId: 'cid', subjectId: 'sid', folderId: 'F1' },
      userId: u.id,
    });
    const res = makeRes();
    const handled = await handleKB(req, res);

    assert.equal(handled, true);
    assert.equal(res.statusCode, 502);
    const parsed = JSON.parse(res._body);
    assert.equal(parsed.error.code, 'BOX_CONNECT_FAILED');
    assert.ok(!parsed.error.message.includes('sk-ant-should-not-leak-1234567890'), 'secret must be redacted from error message');
  } finally {
    global.fetch = orig;
  }
});

// B1: a Box client_secret is an opaque string with no recognizable shape, so
// pattern-based redactSecrets can't catch it — the route must use
// redactWithKey (masks the exact in-flight secret). This bare secret would
// leak with the old redactSecrets(e.message) code.
test('POST /kb/box/test redacts a BARE (shapeless) client_secret echoed in a Box error', async () => {
  resetDb();
  const u = makeUser('baresecret');
  const bare = 'Xy9QpZ2mB7Kv0Lr4Ns8Wt'; // no ghp_/sk-/xox/AKIA prefix — redactSecrets can't match this
  vault.setSecret(db.getDb(), u.id, 'box.clientSecret', bare);

  const orig = global.fetch;
  global.fetch = async (urlStr) => {
    const url = String(urlStr);
    if (url === 'https://api.box.com/oauth2/token') {
      return { ok: false, status: 400, json: async () => ({ error: 'invalid_client', error_description: `secret ${bare} rejected` }), text: async () => '' };
    }
    return { ok: false, status: 500, json: async () => ({}), text: async () => '' };
  };
  try {
    const req = makeReq({ method: 'POST', url: '/kb/box/test', body: { clientId: 'cid', subjectId: 'sid', folderId: 'F1' }, userId: u.id });
    const res = makeRes();
    await handleKB(req, res);
    assert.equal(res.statusCode, 502);
    const parsed = JSON.parse(res._body);
    assert.ok(!parsed.error.message.includes(bare), 'bare client_secret must not leak in the response (redactWithKey)');
  } finally {
    global.fetch = orig;
  }
});

test('POST /kb/box/test redacts the secret from the logged failure reason', async () => {
  resetDb();
  const u = makeUser('logleak');
  const secret = 'sk-ant-should-not-leak-in-logs-1234567890';
  vault.setSecret(db.getDb(), u.id, 'box.clientSecret', secret);

  // The provider echoes the credential back into the token-exchange error body,
  // exactly as the reviewer reproduced. It must not survive into the log line.
  const origFetch = global.fetch;
  global.fetch = async (urlStr) => {
    const url = String(urlStr);
    if (url === 'https://api.box.com/oauth2/token') {
      return { ok: false, status: 400, json: async () => ({ error: 'invalid_client', error_description: `bad creds for ${secret}` }), text: async () => '' };
    }
    return { ok: false, status: 500, json: async () => ({}), text: async () => '' };
  };

  // Spy on the shared logger singleton (kb/router.mjs imports the same instance).
  const captured = [];
  const origError = logger.error;
  logger.error = (event, fields) => { captured.push({ event, fields }); };

  try {
    const req = makeReq({
      method: 'POST',
      url: '/kb/box/test',
      body: { clientId: 'cid', subjectId: 'sid', folderId: 'F1' },
      userId: u.id,
    });
    const res = makeRes();
    await handleKB(req, res);

    const leaked = JSON.stringify(captured);
    assert.ok(captured.some((c) => c.event === 'box_test_failed'), 'expected a box_test_failed log line');
    assert.ok(!leaked.includes(secret), `secret must be redacted from logged fields, got: ${leaked}`);
    assert.ok(leaked.includes('[REDACTED]'), 'redaction marker should appear in the logged reason');
  } finally {
    logger.error = origError;
    global.fetch = origFetch;
  }
});
