// HTTP-layer tests for POST /kb/ingest-scip. Covers validation, allowlist gate,
// and the error envelope. The success-path counts are proven by scip-connector.test.mjs
// (the router just wraps indexScip in { ok: true, ...result }).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_kb-router-scip-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const { handleKB } = await import('../routes/router.mjs');
const users = await import('../server/users.mjs');

function resetDb() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
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

test('POST /kb/ingest-scip 400 on missing fields (VALIDATION_FAILED)', async () => {
  resetDb();
  const u = users.registerUser(db.getDb(), { email: `v-${Date.now()}@e.com`, password: 'CorrectHorseBattery', displayName: 'v' });
  const res = makeRes();
  await handleKB(makeReq({ method: 'POST', url: '/kb/ingest-scip', body: { repoPath: '/tmp/x' }, userId: u.id }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res._body).error.code, 'VALIDATION_FAILED');
});

test('POST /kb/ingest-scip 403 when repoPath not allowlisted (PATH_NOT_APPROVED)', async () => {
  resetDb();
  const u = users.registerUser(db.getDb(), { email: `d-${Date.now()}@e.com`, password: 'CorrectHorseBattery', displayName: 'd' });
  const res = makeRes();
  await handleKB(makeReq({ method: 'POST', url: '/kb/ingest-scip', body: { repoPath: '/tmp/not-approved', scipPath: '/tmp/x.scip' }, userId: u.id }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res._body).error.code, 'PATH_NOT_APPROVED');
});

test('POST /kb/ingest-scip 400 SCIP_INDEX_FAILED when scip cannot read the index', async () => {
  resetDb();
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'scip-ok-'));
  try {
    const u = users.registerUser(db.getDb(), { email: `e-${Date.now()}@e.com`, password: 'CorrectHorseBattery', displayName: 'e' });
    db.addUserRepo(u.id, tmpRepo, 'scip-repo');
    const res = makeRes();
    // repo is allowlisted + is a real dir; scipPath is bogus so load() rejects
    // (scip CLI missing OR `scip print` non-zero) -> router returns the error envelope.
    await handleKB(makeReq({
      method: 'POST', url: '/kb/ingest-scip',
      body: { repoPath: tmpRepo, scipPath: '/nonexistent/file.scip' }, userId: u.id,
    }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res._body).error.code, 'SCIP_INDEX_FAILED');
  } finally {
    try { fs.rmSync(tmpRepo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('cleanup', () => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
});
