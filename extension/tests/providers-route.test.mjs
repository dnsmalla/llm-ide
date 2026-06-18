// POST /kb/providers/verify route glue. Pins provider validation, the
// supplied-key probe path (mocked fetch), and the cli-mode branch. The
// verification logic itself is unit-tested in providers.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_providers-route-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const { handleKB } = await import('../kb/router.mjs');

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
    writeHead(code, h) { this.statusCode = code; Object.assign(this.headers, h || {}); },
    setHeader(k, v) { this.headers[k] = v; },
    write(c) { this._body += c; },
    end(c) { if (c) this._body += c; this.ended = true; },
  };
}
function withMockFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = original; });
}

test('POST /kb/providers/verify rejects an unknown provider with 400', async () => {
  resetDb();
  const req = makeReq({ method: 'POST', url: '/kb/providers/verify', body: { provider: 'skynet' }, userId: 'u1' });
  const res = makeRes();
  assert.equal(await handleKB(req, res), true);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res._body).error.code, 'VALIDATION_FAILED');
});

test('POST /kb/providers/verify (key mode) returns ok:true on a 200 probe', async () => {
  resetDb();
  await withMockFetch(
    async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'pong' } }] }), text: async () => '{}' }),
    async () => {
      const req = makeReq({
        method: 'POST', url: '/kb/providers/verify',
        body: { provider: 'openai', mode: 'key', apiKey: 'sk-test', model: 'gpt-4o-mini' }, userId: 'u1',
      });
      const res = makeRes();
      assert.equal(await handleKB(req, res), true);
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res._body).ok, true);
    },
  );
});

test('POST /kb/providers/verify (cli mode) returns a boolean ok without network', async () => {
  resetDb();
  const req = makeReq({ method: 'POST', url: '/kb/providers/verify', body: { provider: 'google', mode: 'cli' }, userId: 'u1' });
  const res = makeRes();
  assert.equal(await handleKB(req, res), true);
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res._body);
  assert.equal(typeof parsed.ok, 'boolean');
  assert.equal(typeof parsed.detail, 'string');
});
