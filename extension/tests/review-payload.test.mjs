// Review payloads: keys are whitelisted per kind, credential-looking keys are
// removed at every depth on submit and on read, and migration 0045 scrubs rows
// stored before this rule existed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_review-payload-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { handleKB } = await import('../routes/router.mjs');
const { applyMigrations } = await import('../kb/migrations.mjs');
const { pickReviewPayload, scrubSecretKeysDeep, REVIEW_SECRET_KEY_RE } = await import('../kb/review-payload.mjs');
const m = await import('../server/review-secrets.mjs');

let U;

function reset() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
  U = users.registerUser(db.getDb(), {
    email: `review-payload-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: 'review-payload',
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

const rawPayload = (id) => db.getDb().prepare('SELECT payload, result FROM review_items WHERE id = ?').get(id);

// ---------------------------------------------------------------- key rules

test('key regex covers the credential names and keeps the original ones', () => {
  for (const k of ['token', 'ghToken', 'apiKey', 'api_key', 'clientSecret', 'password', 'credential', 'credentials',
    'authorization', 'Authorization', 'bearer', 'authToken', 'oauth', 'auth']) {
    assert.ok(REVIEW_SECRET_KEY_RE.test(k), k);
  }
  for (const k of ['repo', 'labels', 'summary', 'baseBranch', 'files', 'content', 'taskId']) {
    assert.ok(!REVIEW_SECRET_KEY_RE.test(k), k);
  }
});

test('scrubSecretKeysDeep removes matching keys at every depth, including inside arrays', () => {
  const out = scrubSecretKeysDeep({
    a: { token: 'x', keep: 1, deeper: { authorization: 'y', list: [{ api_key: 'z', ok: true }] } },
    arr: [{ bearer: 'b', name: 'n' }],
  });
  assert.deepEqual(out, { a: { keep: 1, deeper: { list: [{ ok: true }] } }, arr: [{ name: 'n' }] });
});

test('pickReviewPayload keeps only the keys each kind reads', () => {
  assert.deepEqual(
    Object.keys(pickReviewPayload('dispatch', { target: 'github', planId: 'p', taskIds: [], config: {}, items: [], junk: 1, allowedRepos: ['/'] })).sort(),
    ['config', 'items', 'planId', 'target', 'taskIds'],
  );
  assert.deepEqual(
    Object.keys(pickReviewPayload('codegen-apply', { repoPath: '/r', taskId: 't', files: [], tests: [], summary: 's', pr: {}, allowedRepos: [], target: 'x', items: [] })).sort(),
    ['allowedRepos', 'files', 'pr', 'repoPath', 'summary', 'taskId', 'tests'],
  );
  assert.deepEqual(pickReviewPayload('unknown-kind', { target: 'github' }), {});
});

// ---------------------------------------------------------------- submit

test('submit: a dispatch keeps its whitelisted keys and drops the rest', async () => {
  reset();
  const r = await call('POST', '/kb/review/submit', {
    kind: 'dispatch', planId: 'plan1',
    payload: { planId: 'plan1', target: 'github', taskIds: ['t1'], config: { repo: 'a/b' }, debugDump: { x: 1 }, allowedRepos: ['/'], note: 'free text' },
  });
  assert.equal(r.status, 200);
  const keys = Object.keys(r.body.payload).sort();
  assert.deepEqual(keys, ['config', 'items', 'planId', 'target', 'taskIds']);
  assert.ok(!JSON.stringify(rawPayload(r.body.id)).includes('debugDump'));
});

test('submit: a codegen-apply keeps its whitelisted keys and drops the rest', async () => {
  reset();
  const r = await call('POST', '/kb/review/submit', {
    kind: 'codegen-apply',
    payload: { repoPath: '/nowhere', taskId: 't1', files: [{ path: 'a.txt', content: 'x' }], tests: [], summary: 'S', pr: { ghRepo: 'a/b', baseBranch: 'main' }, target: 'github', extra: 'x' },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body.payload).sort(), ['allowedRepos', 'files', 'pr', 'repoPath', 'summary', 'taskId', 'tests']);
  assert.equal(r.body.payload.summary, 'S');
  assert.equal(r.body.payload.pr.ghRepo, 'a/b');
});

test('submit: credential-looking keys are stripped at every depth, with the new key names', async () => {
  reset();
  const r = await call('POST', '/kb/review/submit', {
    kind: 'dispatch', planId: 'plan1',
    payload: {
      planId: 'plan1', target: 'github',
      config: {
        repo: 'a/b',
        labels: [{ name: 'bug', apiToken: 'VAL_ARRAY_TOKEN' }],
        nested: { deep: { client_secret: 'VAL_DEEP_SECRET', authorization: 'VAL_AUTHZ', bearer: 'VAL_BEARER', credential: 'VAL_CRED', auth: 'VAL_AUTH' } },
      },
      items: [{ taskId: 't1', title: 'T', body: 'B', password: 'VAL_ITEM_PW' }],
    },
  });
  assert.equal(r.status, 200);
  const raw = rawPayload(r.body.id).payload;
  for (const v of ['VAL_ARRAY_TOKEN', 'VAL_DEEP_SECRET', 'VAL_AUTHZ', 'VAL_BEARER', 'VAL_CRED', 'VAL_AUTH', 'VAL_ITEM_PW']) {
    assert.ok(!raw.includes(v), `${v} persisted`);
    assert.ok(!JSON.stringify(r.body).includes(v), `${v} echoed`);
  }
  // Non-credential structure survives.
  assert.equal(r.body.payload.config.repo, 'a/b');
  assert.equal(r.body.payload.config.labels[0].name, 'bug');
});

test('submit: only top-level config credentials are held for approval; nested ones are dropped', async () => {
  reset();
  const r = await call('POST', '/kb/review/submit', {
    kind: 'dispatch', planId: 'plan1',
    payload: { planId: 'plan1', target: 'github', config: { repo: 'a/b', token: 'VAL_TOP', nested: { token: 'VAL_NESTED' } } },
  });
  assert.equal(r.status, 200);
  const held = m.takeHeldSecrets(U, r.body.id);
  assert.equal(held.config.token, 'VAL_TOP');
  assert.ok(!('nested' in held.config), 'nested credential was held');
  assert.ok(!JSON.stringify(held).includes('VAL_NESTED'));
});

// ---------------------------------------------------------------- read

test('read: a row stored with nested credentials is redacted on GET and never echoed', async () => {
  reset();
  const item = db.submitReview(U, {
    kind: 'dispatch', planId: 'plan1', title: 'legacy',
    payload: { planId: 'plan1', target: 'github', config: { repo: 'a/b', nested: { apiKey: 'VAL_READ_KEY' } }, items: [{ title: 'x', headers: { Authorization: 'VAL_READ_AUTHZ' } }] },
    guardrails: {},
  });
  const got = await call('GET', `/kb/review/get/${item.id}`);
  assert.equal(got.status, 200);
  assert.ok(!JSON.stringify(got.body).includes('VAL_READ_KEY'));
  assert.ok(!JSON.stringify(got.body).includes('VAL_READ_AUTHZ'));
  assert.equal(got.body.payload.config.repo, 'a/b');
  // Still in the raw row (the read path redacts, the migration scrubs storage).
  assert.ok(rawPayload(item.id).payload.includes('VAL_READ_KEY'));
});

// ---------------------------------------------------------------- migration 0045

test('migration 0045 scrubs credentials at every depth from stored rows, idempotently', () => {
  reset();
  const legacy = db.submitReview(U, {
    kind: 'dispatch', planId: 'plan1', title: 'seeded',
    payload: {
      planId: 'plan1', target: 'github', extra: { password: 'VAL_M_PW', keep: 'yes' },
      config: { repo: 'a/b', token: 'VAL_M_TOP', labels: [{ name: 'x', apiToken: 'VAL_M_ARR' }], nested: { x: { client_secret: 'VAL_M_DEEP' } } },
      items: [{ title: 'T', credential: 'VAL_M_CRED' }],
    },
    guardrails: {},
  });
  const codegen = db.submitReview(U, {
    kind: 'codegen-apply', title: 'seeded-result',
    payload: { repoPath: '/x', taskId: 't1', files: [], tests: [], pr: { ghRepo: 'a/b', ghToken: 'VAL_M_PRTOK' } },
    guardrails: {},
  });
  db.getDb().prepare('UPDATE review_items SET result = ? WHERE id = ?')
    .run(JSON.stringify({ baseDir: '/x', files: [], pr: { html_url: 'u', authorization: 'VAL_M_RES' } }), codegen.id);

  // Re-run migration 45 against the seeded rows.
  db.getDb().prepare('DELETE FROM schema_migrations WHERE version = 45').run();
  applyMigrations(db.getDb());
  const after = rawPayload(legacy.id).payload;
  for (const v of ['VAL_M_PW', 'VAL_M_TOP', 'VAL_M_ARR', 'VAL_M_DEEP', 'VAL_M_CRED']) assert.ok(!after.includes(v), v);
  const p = JSON.parse(after);
  assert.equal(p.config.repo, 'a/b');
  assert.deepEqual(p.config.labels, [{ name: 'x' }]);
  assert.deepEqual(p.extra, { keep: 'yes' });
  assert.deepEqual(p.items, [{ title: 'T' }]);

  const cg = rawPayload(codegen.id);
  assert.ok(!cg.payload.includes('VAL_M_PRTOK'));
  assert.ok(!cg.result.includes('VAL_M_RES'));
  assert.equal(JSON.parse(cg.result).pr.html_url, 'u');

  // Second run: nothing left to change, and the version is recorded again.
  const before = rawPayload(legacy.id).payload;
  db.getDb().prepare('DELETE FROM schema_migrations WHERE version = 45').run();
  applyMigrations(db.getDb());
  assert.equal(rawPayload(legacy.id).payload, before);
  const recorded = db.getDb().prepare('SELECT version FROM schema_migrations WHERE version = 45').get();
  assert.ok(recorded);
});

test('scrubReviewPayloadRows returns only the rows it changed', async () => {
  const { scrubReviewPayloadRows } = await import('../kb/review-payload.mjs');
  reset();
  db.submitReview(U, { kind: 'dispatch', planId: 'plan1', title: 'clean', payload: { planId: 'plan1', target: 'github', config: { repo: 'a/b' } }, guardrails: {} });
  assert.equal(scrubReviewPayloadRows(db.getDb()), 0);
});
