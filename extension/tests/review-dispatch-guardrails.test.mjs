// Dispatch guardrails must judge what actually leaves the machine.
//
// Regression (2026-09 review): /kb/review/submit + /approve scanned the
// client-supplied `payload.items`, while dispatchPlan sends the plan's
// stored tasks — so a secret in a stored task passed review behind clean
// client items. /kb/dispatch also took target/taskIds from the request
// instead of the approved review.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_review-dispatch-guardrails-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { handleKB } = await import('../routes/router.mjs');

const SECRET = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CONFIG = { repo: 'a/b', token: 'x' };
let U;

function reset() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
  U = users.registerUser(db.getDb(), {
    email: `review-dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: 'review-dispatch',
  }).id;
}

function seedPlan(tasks) {
  db.savePlan(U, { id: 'plan1', title: 'Q3 plan', tasks });
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

const blockingRules = (g) => g.findings.filter((f) => f.severity === 'blocking').map((f) => f.ruleId);

test('submit: a secret in a stored task blocks even when client items are clean', async () => {
  reset();
  seedPlan([{ id: 't1', title: `Rotate ${SECRET}` }]);
  const r = await call('POST', '/kb/review/submit', {
    kind: 'dispatch', planId: 'plan1',
    payload: { planId: 'plan1', target: 'github', config: CONFIG, items: [{ title: 'clean', body: 'clean' }] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.guardrails.passed, false);
  assert.ok(blockingRules(r.body.guardrails).includes('dispatch.secret'));
});

test('submit: a missing plan blocks as empty, whatever items the client sends', async () => {
  reset();
  const r = await call('POST', '/kb/review/submit', {
    kind: 'dispatch',
    payload: { planId: 'nope', target: 'github', config: CONFIG, items: [{ title: 'clean', body: 'clean' }] },
  });
  assert.ok(blockingRules(r.body.guardrails).includes('dispatch.empty'));
});

test('submit: taskIds subset is what gets scanned', async () => {
  reset();
  seedPlan([{ id: 't1', title: 'Fine' }, { id: 't2', title: `Leak ${SECRET}` }]);
  const clean = await call('POST', '/kb/review/submit', {
    kind: 'dispatch', planId: 'plan1',
    payload: { planId: 'plan1', target: 'github', config: CONFIG, taskIds: ['t1'] },
  });
  assert.equal(clean.body.guardrails.passed, true);
  const dirty = await call('POST', '/kb/review/submit', {
    kind: 'dispatch', planId: 'plan1',
    payload: { planId: 'plan1', target: 'github', config: CONFIG, taskIds: ['t2'] },
  });
  assert.equal(dirty.body.guardrails.passed, false);
});

test('approve: a task edited to contain a secret after submit is auto-rejected', async () => {
  reset();
  seedPlan([{ id: 't1', title: 'Fine' }]);
  const sub = await call('POST', '/kb/review/submit', {
    kind: 'dispatch', planId: 'plan1',
    payload: { planId: 'plan1', target: 'github', config: CONFIG },
  });
  assert.equal(sub.body.guardrails.passed, true);
  seedPlan([{ id: 't1', title: `Now ${SECRET}` }]);
  const r = await call('POST', '/kb/review/approve', { id: sub.body.id });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'GUARDRAILS_FAILED');
  assert.equal(db.getReview(U, sub.body.id).status, 'rejected');
});

function approvedReview(payload) {
  const item = db.submitReview(U, { kind: 'dispatch', planId: 'plan1', title: 'r', payload, guardrails: {} });
  db.setReviewStatus(U, item.id, { status: 'approved' });
  return item.id;
}

test('/kb/dispatch: an approval for one target cannot dispatch to another', async () => {
  reset();
  seedPlan([{ id: 't1', title: 'Fine' }]);
  const reviewId = approvedReview({ planId: 'plan1', target: 'linear', config: {} });
  const r = await call('POST', '/kb/dispatch', { planId: 'plan1', target: 'github', reviewId, config: CONFIG });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'REVIEW_TARGET_MISMATCH');
  assert.equal(db.getReview(U, reviewId).status, 'approved'); // not consumed
});

test('/kb/dispatch: a review without a plan binding is refused', async () => {
  reset();
  seedPlan([{ id: 't1', title: 'Fine' }]);
  const item = db.submitReview(U, { kind: 'dispatch', title: 'r', payload: { target: 'github' }, guardrails: {} });
  db.setReviewStatus(U, item.id, { status: 'approved' });
  const r = await call('POST', '/kb/dispatch', { planId: 'plan1', target: 'github', reviewId: item.id, config: CONFIG });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'REVIEW_PLAN_MISMATCH');
});

test('/kb/dispatch: a non-dispatch review cannot authorize a dispatch', async () => {
  reset();
  seedPlan([{ id: 't1', title: 'Fine' }]);
  const item = db.submitReview(U, { kind: 'codegen-apply', planId: 'plan1', title: 'r', payload: { planId: 'plan1', target: 'github' }, guardrails: {} });
  db.setReviewStatus(U, item.id, { status: 'approved' });
  const r = await call('POST', '/kb/dispatch', { planId: 'plan1', target: 'github', reviewId: item.id, config: CONFIG });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'REVIEW_KIND_MISMATCH');
});
