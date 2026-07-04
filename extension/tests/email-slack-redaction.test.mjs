// Tests that the email/slack connector routes redact secrets before the
// provider error reaches the HTTP client — the twin of the Box route's
// "surfaces a redacted 502 BOX_CONNECT_FAILED on token exchange failure"
// test in tests/box-routes.test.mjs.
//
// A provider error can echo a credential back (e.g. "Bad credentials for
// xoxb-…"). The route wraps `e.message` in redactSecrets(), so the token
// must not survive into the response body (browser DevTools, etc.).
//
// Slack is used here because slack-source.mjs reaches the network via the
// global `fetch`, so a stub can force a credential-bearing error through the
// exact code path the route redacts. (Email goes through an IMAP client that
// isn't fetch-based, so it can't be stubbed the same way; the redaction site
// is identical.) As in the siblings, LLMIDE_DB_PATH must be set before any
// (dynamic) import that transitively pulls in kb/db.mjs, since core/config.mjs
// bakes DB_PATH as a module-const at import time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_email-slack-redaction-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const { handleKB } = await import('../kb/router.mjs');
const users = await import('../server/users.mjs');
const vault = await import('../server/vault.mjs');

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
    email: `email-slack-${tag}-${Date.now()}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: tag,
  });
}

test('POST /kb/slack/test surfaces a redacted 502 SLACK_CONNECT_FAILED when the provider echoes the token', async () => {
  resetDb();
  const u = makeUser('slackleak');
  const token = 'xoxb-should-not-leak-1234567890';
  vault.setSecret(db.getDb(), u.id, 'slack.botToken', token);

  const orig = global.fetch;
  // Provider error whose message echoes the credential — exactly the shape
  // redactSecrets must scrub before it hits the client.
  global.fetch = async () => { throw new Error(`Bad credentials for ${token}`); };
  try {
    const req = makeReq({ method: 'POST', url: '/kb/slack/test', body: {}, userId: u.id });
    const res = makeRes();
    const handled = await handleKB(req, res);

    assert.equal(handled, true);
    assert.equal(res.statusCode, 502);
    const parsed = JSON.parse(res._body);
    assert.equal(parsed.error.code, 'SLACK_CONNECT_FAILED');
    assert.ok(!parsed.error.message.includes(token), 'bot token must be redacted from the error message');
  } finally {
    global.fetch = orig;
  }
});
