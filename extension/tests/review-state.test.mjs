// Review status transitions are compare-and-swap: a reject / auto-reject /
// final executed-or-failed write only lands while the row is in the state the
// handler read. A lost swap keeps the stored status (never overwrites it).

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
const tmpDb = path.join(__dirname, '_review-state-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { setSecret } = await import('../server/vault.mjs');
const { handleKB } = await import('../routes/router.mjs');

const TOKEN_SEG = 'SUPERSECRETTOKENVALUE0123456789abcde'; // 36 chars: a full ghp_ token body
const TOKEN = `ghp_${TOKEN_SEG}`;
let U;

function reset() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
  U = users.registerUser(db.getDb(), {
    email: `review-state-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: 'review-state',
  }).id;
  db.savePlan(U, { id: 'plan1', title: 'Q3 plan', tasks: [{ id: 't1', title: 'Fine' }] });
}

async function call(method, url, body) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method, url, user: { id: U },
    on(event, cb) {
      if (event === 'data') chunks.forEach((c) => cb(c));
      else if (event === 'end') cb();
      return req;
    },
  };
  const res = {
    statusCode: 200, headers: {}, _body: '',
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); },
    setHeader(k, v) { this.headers[k] = v; },
    write(chunk) { this._body += chunk; },
    end(chunk) { if (chunk) this._body += chunk; },
  };
  await handleKB(req, res);
  return { status: res.statusCode, body: res._body ? JSON.parse(res._body) : null };
}

const submit = (config) => call('POST', '/kb/review/submit', {
  kind: 'dispatch', planId: 'plan1',
  payload: { planId: 'plan1', target: 'github', config },
});

function pendingItem() {
  return db.submitReview(U, {
    kind: 'dispatch', planId: 'plan1', title: 'p',
    payload: { planId: 'plan1', target: 'github', config: { repo: 'a/b' } },
    guardrails: {},
  });
}

test('reject: a pending item is rejected (200)', async () => {
  reset();
  const item = pendingItem();
  const r = await call('POST', '/kb/review/reject', { id: item.id, note: 'no' });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'rejected');
});

for (const status of ['approved', 'executed', 'rejected', 'failed']) {
  test(`reject: a ${status} item answers 409 and keeps its status`, async () => {
    reset();
    const item = pendingItem();
    db.setReviewStatus(U, item.id, { status });
    const r = await call('POST', '/kb/review/reject', { id: item.id });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'REVIEW_NOT_PENDING');
    assert.equal(r.body.error.message, `Item already ${status}`);
    assert.equal(db.getReview(U, item.id).status, status);
  });
}

test('reject: a missing item answers 404', async () => {
  reset();
  const r = await call('POST', '/kb/review/reject', { id: 'rev-missing' });
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'NOT_FOUND');
});

test('kb.setReviewStatus: expectedStatus loses once the row moved on', () => {
  reset();
  const item = pendingItem();
  assert.ok(db.setReviewStatus(U, item.id, { status: 'approved', expectedStatus: 'pending' }));
  assert.equal(db.setReviewStatus(U, item.id, { status: 'rejected', expectedStatus: 'pending' }), null);
  assert.equal(db.getReview(U, item.id).status, 'approved');
});

async function withPausedFetch(fn) {
  const orig = globalThis.fetch;
  let release;
  const gate = new Promise((r) => { release = r; });
  let entered;
  const reached = new Promise((r) => { entered = r; });
  globalThis.fetch = async () => {
    entered();
    await gate;
    return { ok: true, status: 201, json: async () => ({ html_url: 'x', number: 1 }) };
  };
  try { await fn({ reached, release }); } finally { globalThis.fetch = orig; }
}

test('approve vs reject: a reject during execution loses, and the item ends executed', async () => {
  reset();
  setSecret(db.getDb(), U, 'github.token', TOKEN);
  const r = await submit({ repo: 'a/b' });
  await withPausedFetch(async ({ reached, release }) => {
    const approving = call('POST', '/kb/review/approve', { id: r.body.id });
    await reached;
    const rej = await call('POST', '/kb/review/reject', { id: r.body.id });
    assert.equal(rej.status, 409);
    assert.equal(rej.body.error.message, 'Item already approved');
    const second = await call('POST', '/kb/review/approve', { id: r.body.id });
    assert.equal(second.status, 409);
    release();
    const a = await approving;
    assert.equal(a.status, 200, JSON.stringify(a.body));
  });
  assert.equal(db.getReview(U, r.body.id).status, 'executed');
});

test('approve: a failed execution writes failed only over approved, and redacts err.message', async () => {
  reset();
  // The repo path carries a GitHub-token-shaped segment, so the error thrown by
  // applyCodegen (it names the path) would echo it unless redacted.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
  const repo = path.join(base, `ghp_${TOKEN_SEG}`);
  fs.mkdirSync(repo, { recursive: true });
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(repo, '.llmide-auto'));
  db.addUserRepo(U, repo, 'scratch');
  const s = await call('POST', '/kb/review/submit', {
    kind: 'codegen-apply',
    payload: { repoPath: repo, taskId: 't1', files: [{ path: 'a.txt', content: 'x' }], tests: [] },
  });
  assert.equal(s.body.guardrails.passed, true, JSON.stringify(s.body.guardrails));
  const a = await call('POST', '/kb/review/approve', { id: s.body.id });
  assert.equal(a.status, 500, JSON.stringify(a.body));
  assert.equal(a.body.error.code, 'REVIEW_EXECUTION_FAILED');
  // The item echoes its own repoPath (a stored field, not a credential), so
  // the redaction is asserted on the error message itself.
  assert.ok(!a.body.error.message.includes(TOKEN_SEG), 'token echoed in the 500 error message');
  assert.ok(a.body.error.message.includes('[REDACTED]'));
  const stored = db.getReview(U, s.body.id);
  assert.equal(stored.status, 'failed');
  assert.ok(!JSON.stringify(stored.result).includes(TOKEN_SEG), 'token persisted in result');
  fs.rmSync(base, { recursive: true, force: true });
});

test('approve: guardrails failing at approval auto-reject the pending item (422)', async () => {
  reset();
  // A codegen-apply outside the allow-list fails guardrails (not a credential
  // finding), so approve takes the auto-reject branch.
  const s = await call('POST', '/kb/review/submit', {
    kind: 'codegen-apply',
    payload: { repoPath: '/nonexistent-outside-allowlist', taskId: 't1', files: [{ path: 'a.txt', content: 'x' }], tests: [] },
  });
  assert.equal(s.body.guardrails.passed, false);
  const a = await call('POST', '/kb/review/approve', { id: s.body.id });
  assert.equal(a.status, 422);
  assert.equal(a.body.error.code, 'GUARDRAILS_FAILED');
  assert.equal(db.getReview(U, s.body.id).status, 'rejected');
});
