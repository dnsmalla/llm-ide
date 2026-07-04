import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_email-classify-route-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const { handleKB } = await import('../kb/router.mjs');
const users = await import('../server/users.mjs');

for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) { try { fs.rmSync(f, { force: true }); } catch { /* ok */ } }
db.getDb();

function makeReq({ method, url, body, userId }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = { method, url, user: { id: userId },
    on(event, cb) { if (event === 'data') chunks.forEach((c) => cb(c)); else if (event === 'end') cb(); return req; } };
  return req;
}
function makeRes() {
  return { statusCode: 200, headers: {}, _body: '',
    writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h || {}); },
    setHeader(k, v) { this.headers[k] = v; },
    write(ch) { this._body += ch; }, end(ch) { if (ch) this._body += ch; this.ended = true; } };
}
function makeUser(tag) {
  return users.registerUser(db.getDb(), { email: `eml-${tag}-${Date.now()}@example.com`, password: 'CorrectHorseBattery', displayName: tag });
}

test('POST /kb/email/classify 400s when body is missing', async () => {
  const u = makeUser('a');
  const req = makeReq({ method: 'POST', url: '/kb/email/classify', userId: u.id, body: { subject: 'Hi' } }); // no `body`
  const res = makeRes();
  await handleKB(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res._body).error.code, 'VALIDATION_FAILED');
});
