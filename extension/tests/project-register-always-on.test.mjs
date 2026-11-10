// POST /kb/projects/register is always on: with doc_gen disabled it still answers (the bus and the task route need a
// registered project), while the /kb/docs/* routes answer feature_disabled. Drives the real router (handleKB).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
// team.yaml is written through on a new registration: keep the whole data dir in a temp folder, never the checkout.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'register-always-on-'));
process.env.LLMIDE_DATA_DIR = DATA;
process.env.LLMIDE_DB_PATH = path.join(DATA, 'data.db');

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { handleKB, initFeatureRoutes } = await import('../routes/router.mjs');

after(async () => {
  await initFeatureRoutes(null);
  kb.closeDb();
  fs.rmSync(DATA, { recursive: true, force: true });
});

function makeReq({ method, url, body, user }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method, url, user, headers: {},
    on(event, cb) {
      if (event === 'data') chunks.forEach((c) => cb(c));
      else if (event === 'end') cb();
      return req;
    },
    once() { return req; },
    off() { return req; },
    removeListener() { return req; },
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
    on() { return this; }, once() { return this; }, off() { return this; }, removeListener() { return this; },
  };
}
async function kbCall(userId, method, url, body) {
  const res = makeRes();
  const handled = await handleKB(makeReq({ method, url, body, user: { id: userId } }), res);
  return { handled, status: res.statusCode, body: res._body ? JSON.parse(res._body) : null };
}

/** A marked project folder under the OS temp dir, realpath (the same marker the docs routes use). */
function makeProject() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'register-root-')));
  fs.mkdirSync(path.join(root, 'system'), { recursive: true });
  fs.writeFileSync(path.join(root, 'system', 'project.json'), '{}');
  return root;
}

const userId = users.registerUser(kb.getDb(), {
  email: `register-${Date.now()}@example.com`, password: 'CorrectHorseBattery', displayName: 'reg',
}).id;

test('doc_gen off: POST /kb/projects/register answers normally, not feature_disabled', async () => {
  await initFeatureRoutes(new Set(['agent_chat']));
  const root = makeProject();
  const r = await kbCall(userId, 'POST', '/kb/projects/register', { id: 'always-on', root });
  assert.equal(r.handled, true);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.root, root);
  assert.equal(r.body.error, undefined);
});

test('doc_gen off: a /kb/docs/* route still answers feature_disabled for doc_gen', async () => {
  await initFeatureRoutes(new Set(['agent_chat']));
  const r = await kbCall(userId, 'POST', '/kb/docs/seed?project=always-on', {});
  assert.equal(r.handled, true);
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'feature_disabled');
  assert.equal(r.body.feature, 'doc_gen');
});
