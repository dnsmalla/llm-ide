// HTTP-layer tests for POST /kb/ingest-code-graph — the endpoint the Mac app
// posts its structural code graph to. Covers validation, the allow-list gate,
// the error envelope, and the success shape. The storage semantics themselves
// are proven by structure-graph-ingest.test.mjs.

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
const tmpDb = path.join(__dirname, '_kb-router-code-graph-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const { handleKB } = await import('../kb/router.mjs');
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
function newUser(tag) {
  return users.registerUser(db.getDb(), {
    email: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@e.com`,
    password: 'CorrectHorseBattery', displayName: tag,
  });
}

const GRAPH = {
  nodes: [{ id: 'file:a.swift', title: 'a.swift', kind: 'file', metadata: { source_file: 'a.swift' } }],
  edges: [],
};

test('400 VALIDATION_FAILED when graph is missing', async () => {
  resetDb();
  const u = newUser('v');
  const res = makeRes();
  await handleKB(makeReq({ method: 'POST', url: '/kb/ingest-code-graph', body: { repoPath: '/tmp/x' }, userId: u.id }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res._body).error.code, 'VALIDATION_FAILED');
});

test('403 PATH_NOT_APPROVED when the repo is not allow-listed', async () => {
  resetDb();
  const u = newUser('d');
  const res = makeRes();
  await handleKB(makeReq({
    method: 'POST', url: '/kb/ingest-code-graph',
    body: { repoPath: '/tmp/not-approved', graph: GRAPH }, userId: u.id,
  }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res._body).error.code, 'PATH_NOT_APPROVED');
});

test('200 with stored counts for an allow-listed repo', async () => {
  resetDb();
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ok-'));
  try {
    const u = newUser('ok');
    db.addUserRepo(u.id, tmpRepo, 'cg-repo');
    const res = makeRes();
    await handleKB(makeReq({
      method: 'POST', url: '/kb/ingest-code-graph',
      body: { repoPath: tmpRepo, graph: GRAPH, replace: true }, userId: u.id,
    }), res);
    assert.equal(res.statusCode, 200);
    const out = JSON.parse(res._body);
    assert.equal(out.ok, true);
    assert.equal(out.nodes, 1);
    assert.equal(out.replaced, true);
  } finally {
    try { fs.rmSync(tmpRepo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('400 CODE_GRAPH_INGEST_FAILED when a batch exceeds the request cap', async () => {
  resetDb();
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-big-'));
  try {
    const u = newUser('big');
    db.addUserRepo(u.id, tmpRepo, 'cg-repo');
    const res = makeRes();
    await handleKB(makeReq({
      method: 'POST', url: '/kb/ingest-code-graph',
      body: {
        repoPath: tmpRepo,
        graph: { nodes: Array.from({ length: 5001 }, (_, i) => ({ id: `n${i}` })), edges: [] },
      },
      userId: u.id,
    }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res._body).error.code, 'CODE_GRAPH_INGEST_FAILED');
  } finally {
    try { fs.rmSync(tmpRepo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('replace defaults to false so a follow-up batch appends', async () => {
  resetDb();
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-app-'));
  try {
    const u = newUser('app');
    db.addUserRepo(u.id, tmpRepo, 'cg-repo');
    const res = makeRes();
    await handleKB(makeReq({
      method: 'POST', url: '/kb/ingest-code-graph',
      body: { repoPath: tmpRepo, graph: GRAPH }, userId: u.id,
    }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res._body).replaced, false);
  } finally {
    try { fs.rmSync(tmpRepo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('cleanup', () => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
});
