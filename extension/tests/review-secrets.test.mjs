// Review payloads must never persist or return tracker / GitHub credentials;
// approval resolves them from the per-user vault (or the approve request).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_review-secrets-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { setSecret } = await import('../server/vault.mjs');
const { handleKB } = await import('../routes/router.mjs');

const TOKEN = 'ghp_SUPERSECRETTOKENVALUE0123456789abcd';
let U;

function reset() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
  U = users.registerUser(db.getDb(), {
    email: `review-secrets-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: 'review-secrets',
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

test('submit: the token never lands in the DB or any review response', async () => {
  reset();
  const r = await submit({ repo: 'a/b', token: TOKEN });
  assert.equal(r.status, 200);
  assert.equal(r.body.guardrails.passed, true, 'a supplied credential still satisfies the guardrail');
  const id = r.body.id;
  const raw = db.getDb().prepare('SELECT payload FROM review_items WHERE id = ?').get(id).payload;
  assert.ok(!raw.includes(TOKEN), 'token persisted in review_items.payload');
  assert.ok(!JSON.stringify(r.body).includes(TOKEN));
  const got = await call('GET', `/kb/review/get/${id}`);
  assert.ok(!JSON.stringify(got.body).includes(TOKEN));
  assert.equal(got.body.payload.config.repo, 'a/b');
});

test('submit: vault credential satisfies the dispatch guardrail with no token sent', async () => {
  reset();
  setSecret(db.getDb(), U, 'github.token', TOKEN);
  const r = await submit({ repo: 'a/b' });
  assert.equal(r.body.guardrails.passed, true);
});

test('approve: without any credential it reports CREDENTIAL_REQUIRED', async () => {
  reset();
  const r = await submit({ repo: 'a/b' });
  assert.equal(r.body.guardrails.passed, false);
  const a = await call('POST', '/kb/review/approve', { id: r.body.id });
  assert.equal(a.status, 422);
  assert.equal(a.body.error.code, 'CREDENTIAL_REQUIRED');
  // Credential-only failure leaves the item pending so a retry can succeed.
  assert.equal(db.getReview(U, r.body.id).status, 'pending');
});

test('approve: retry with a credential after CREDENTIAL_REQUIRED proceeds', async () => {
  reset();
  const r = await submit({ repo: 'a/b' });
  const first = await call('POST', '/kb/review/approve', { id: r.body.id });
  assert.equal(first.status, 422);
  assert.equal(db.getReview(U, r.body.id).status, 'pending');
  let a;
  const calls = await withFetchStub(async () => { a = await call('POST', '/kb/review/approve', { id: r.body.id, config: { token: TOKEN } }); });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.status, 'executed');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
});

/** Stub globalThis.fetch for the duration of fn; returns the recorded calls. */
async function withFetchStub(fn) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 201, json: async () => ({ html_url: 'x', number: 1 }) };
  };
  try { await fn(); } finally { globalThis.fetch = orig; }
  return calls;
}

test('approve: resolves the credential from the vault and proceeds to dispatch', async () => {
  reset();
  setSecret(db.getDb(), U, 'github.token', TOKEN);
  const r = await submit({ repo: 'a/b' });
  let a;
  const calls = await withFetchStub(async () => { a = await call('POST', '/kb/review/approve', { id: r.body.id }); });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.status, 'executed');
  assert.ok(calls.length >= 1);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.ok(!JSON.stringify(a.body).includes(TOKEN));
  assert.equal(db.getReview(U, r.body.id).status, 'executed');
});

test('approve: a credential on the approve request is accepted and not persisted', async () => {
  reset();
  const r = await submit({ repo: 'a/b' });
  let a;
  const calls = await withFetchStub(async () => { a = await call('POST', '/kb/review/approve', { id: r.body.id, config: { token: TOKEN } }); });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.status, 'executed');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  const raw = db.getDb().prepare('SELECT payload, result FROM review_items WHERE id = ?').get(r.body.id);
  assert.ok(!`${raw.payload}${raw.result}`.includes(TOKEN));
});

test('migration 0042 scrubs secrets from existing review payloads', () => {
  reset();
  const item = db.submitReview(U, {
    kind: 'dispatch', planId: 'plan1', title: 'legacy',
    payload: { planId: 'plan1', target: 'github', config: { repo: 'a/b', token: TOKEN }, pr: { ghRepo: 'a/b', ghToken: TOKEN } },
    guardrails: {},
  });
  db.getDb().exec(fs.readFileSync(path.join(__dirname, '../kb/migrations/0042_scrub_review_secrets.sql'), 'utf8'));
  const raw = db.getDb().prepare('SELECT payload FROM review_items WHERE id = ?').get(item.id).payload;
  assert.ok(!raw.includes(TOKEN));
  assert.equal(JSON.parse(raw).config.repo, 'a/b');
});

test('held secrets expire after the TTL and are capped per user', async () => {
  const m = await import('../server/review-secrets.mjs');
  const t0 = 1_000_000;
  m.holdSecrets('u-ttl', 'r1', { config: { token: 'x' } }, t0);
  assert.deepEqual(m.takeHeldSecrets('u-ttl', 'r1', t0 + m.HELD_TTL_MS - 1), { config: { token: 'x' } });
  assert.deepEqual(m.takeHeldSecrets('u-ttl', 'r1', t0 + m.HELD_TTL_MS + 1), {});
  for (let i = 0; i < m.HELD_MAX_PER_USER + 5; i++) m.holdSecrets('u-cap', `r${i}`, { config: { token: 't' } }, t0);
  m.holdSecrets('u-other', 'keep', { config: { token: 'k' } }, t0);
  assert.deepEqual(m.takeHeldSecrets('u-cap', 'r0', t0), {});
  assert.deepEqual(m.takeHeldSecrets('u-cap', 'r4', t0), {});
  assert.ok(m.takeHeldSecrets('u-cap', 'r5', t0).config);
  assert.ok(m.takeHeldSecrets('u-cap', `r${m.HELD_MAX_PER_USER + 4}`, t0).config);
  assert.ok(m.takeHeldSecrets('u-other', 'keep', t0).config);
});
