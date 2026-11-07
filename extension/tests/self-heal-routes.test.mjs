// The Self-Heal routes (routes/self-heal.mjs): JWT user + bus host proof, then the store (real DB).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_self-heal-routes-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
const wipe = () => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } } };
wipe();

const KEY_HEX = 'd4'.repeat(32);
const env = { LLMIDE_HOST_APPROVAL_KEY: KEY_HEX };
const PROOF = crypto.createHmac('sha256', Buffer.from(KEY_HEX, 'hex')).update('bus-host-proof/v1').digest('hex');

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { handleSelfHealRoute } = await import('../routes/self-heal.mjs');

const mk = (tag) => users.registerUser(kb.getDb(), { email: `shr-${tag}-${Date.now()}@example.com`, password: 'CorrectHorseBattery', displayName: tag }).id;
const owner = mk('a');
const other = mk('b');
const state = { userId: owner };
const server = http.createServer((req, res) => {
  req.user = { id: state.userId };
  void handleSelfHealRoute(req, res, { env });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); kb.closeDb(); wipe(); });
async function call(method, p, body, { proof = PROOF } = {}) {
  const r = await fetch(base + p, { method, headers: { ...(proof ? { 'x-llmide-host-nonce': proof } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const R = '/kb/self-heal/incidents';
const report = (o = {}) => ({ source: 'server', category: 'POST /kb/notes/:id', message: 'db is locked for me@example.com', stack: 'Error: db is locked\n    at x (/r/extension/kb/db.mjs:9:1)', ...o });

test('without the host proof every route answers 403 HOST_PROOF_REQUIRED and records nothing', async () => {
  for (const [m, p, b] of [['GET', R], ['POST', R, { incidents: [report()] }], ['POST', `${R}/0123456789abcdef/ignore`], ['DELETE', R]]) {
    const r = await call(m, p, b, { proof: null });
    assert.deepEqual([r.status, r.body.error.code], [403, 'HOST_PROOF_REQUIRED'], `${m} ${p}`);
  }
  assert.deepEqual((await call('GET', R)).body, { incidents: [] });
});

test('POST records redacted, deduped incidents; unusable reports are skipped; the batch is bounded', async () => {
  for (const b of [{}, { incidents: [] }, { incidents: 'x' }, { incidents: Array.from({ length: 51 }, () => report()) }]) {
    const r = await call('POST', R, b);
    assert.deepEqual([r.status, r.body.error.code], [400, 'VALIDATION_FAILED'], JSON.stringify(b).slice(0, 60));
  }
  const r = await call('POST', R, { incidents: [report(), report({ message: 'db is locked for you@example.com' }), report({ source: 'evil' }), report({ message: '  ' }), 7] });
  assert.deepEqual(r, { status: 200, body: { recorded: 2, skipped: 3 } });
  const { incidents } = (await call('GET', R)).body;
  assert.equal(incidents.length, 1, 'both emails redact to [EMAIL], so one signature');
  assert.equal(incidents[0].count, 2);
  assert.equal(incidents[0].message, 'db is locked for [EMAIL]');
  assert.match(incidents[0].id, /^[0-9a-f]{16}$/);
  assert.deepEqual(Object.keys(incidents[0]).sort(), ['attempts', 'category', 'count', 'environmental', 'firstSeen', 'id', 'lastSeen', 'message', 'note', 'proposal', 'source', 'stack', 'status']);
});

test('ignore is per user, an unknown path is 404, and DELETE clears', async () => {
  const [inc] = (await call('GET', R)).body.incidents;
  state.userId = other;
  assert.deepEqual((await call('GET', R)).body, { incidents: [] });
  assert.deepEqual((await call('POST', `${R}/${inc.id}/ignore`)).body, { ignored: false });
  state.userId = owner;
  assert.deepEqual((await call('POST', `${R}/${inc.id}/ignore`)).body, { ignored: true });
  assert.equal((await call('GET', R)).body.incidents[0].status, 'ignored');
  const bad = await call('POST', `${R}/NOT-HEX/ignore`);
  assert.deepEqual([bad.status, bad.body.error.code], [404, 'NOT_FOUND']);
  assert.deepEqual((await call('DELETE', R)).body, { deleted: 1 });
  assert.deepEqual((await call('GET', R)).body, { incidents: [] });
});
