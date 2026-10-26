// GET /kb/meeting/:id — the transcript is opt-in via ?include=transcript.
// The default response must not carry it (the summary-only shape is what
// most callers depend on); the opt-in form adds it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_kb-meeting-transcript-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const kb = db;
const { handleKB } = await import('../routes/router.mjs');
const users = await import('../server/users.mjs');

function resetDb() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
}

function makeReq({ method, url, userId }) {
  const req = {
    method,
    url,
    user: { id: userId },
    on(event, cb) {
      if (event === 'end') cb();
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
    end(chunk) { if (chunk) this._body += chunk; },
    write(chunk) { this._body += chunk; },
  };
}

function seedUser(label) {
  return users.registerUser(db.getDb(), {
    email: `${label}-${Date.now()}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: label,
  });
}

test('GET /kb/meeting/:id omits transcript by default', async () => {
  resetDb();
  const u = seedUser('mtg-default');
  kb.ingestMeeting(u.id, {
    id: 'mtg-default-1', title: 'Default form', date: '2026-10-26',
    transcript: 'Alice: we ship on Friday.', participants: ['Alice'],
  });
  const res = makeRes();
  assert.equal(await handleKB(makeReq({ method: 'GET', url: '/kb/meeting/mtg-default-1', userId: u.id }), res), true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res._body);
  assert.equal(body.id, 'mtg-default-1');
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'transcript'), false);
});

test('GET /kb/meeting/:id?include=transcript adds the transcript', async () => {
  resetDb();
  const u = seedUser('mtg-include');
  kb.ingestMeeting(u.id, {
    id: 'mtg-include-1', title: 'Opt-in form', date: '2026-10-26',
    transcript: 'Alice: we ship on Friday.', participants: ['Alice'],
  });
  const res = makeRes();
  assert.equal(await handleKB(makeReq({ method: 'GET', url: '/kb/meeting/mtg-include-1?include=transcript', userId: u.id }), res), true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res._body);
  assert.equal(body.id, 'mtg-include-1');
  assert.equal(body.transcript, 'Alice: we ship on Friday.');
});

test('GET /kb/meeting/:id?include=transcript on a missing meeting is still 404', async () => {
  resetDb();
  const u = seedUser('mtg-missing');
  const res = makeRes();
  await handleKB(makeReq({ method: 'GET', url: '/kb/meeting/nope?include=transcript', userId: u.id }), res);
  assert.equal(res.statusCode, 404);
});
