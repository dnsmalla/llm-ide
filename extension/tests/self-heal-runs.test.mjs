// Plan B's Self-Heal run routes (routes/self-heal.mjs): start, outcome, resolve, the lease and the suppression.
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
const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(HERE, '_self-heal-runs-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
const wipe = () => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } } };
wipe();
const repo = path.join(HERE, '_self-heal-runs-repo');
fs.mkdirSync(repo, { recursive: true });

const KEY_HEX = 'd4'.repeat(32);
const env = { LLMIDE_HOST_APPROVAL_KEY: KEY_HEX };
const PROOF = crypto.createHmac('sha256', Buffer.from(KEY_HEX, 'hex')).update('bus-host-proof/v1').digest('hex');

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { handleSelfHealRoute, activeRun, RUN_LEASE_MS } = await import('../routes/self-heal.mjs');

const owner = users.registerUser(kb.getDb(), { email: `shrun-${Date.now()}@example.com`, password: 'CorrectHorseBattery', displayName: 'o' }).id;
kb.addUserRepo(owner, repo, 'source checkout');
const server = http.createServer((req, res) => {
  req.user = { id: owner };
  void handleSelfHealRoute(req, res, { env });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); kb.closeDb(); wipe(); fs.rmSync(repo, { recursive: true, force: true }); });
async function call(method, p, body, { proof = PROOF } = {}) {
  const r = await fetch(base + p, { method, headers: { ...(proof ? { 'x-llmide-host-nonce': proof } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const R = '/kb/self-heal/incidents';
const RUNS = '/kb/self-heal/runs';
const report = (message, o = {}) => ({ source: 'server', category: 'server', message, stack: null, ...o });
const byMessage = async (m) => (await call('GET', R)).body.incidents.find((i) => i.message === m);
let runId;
let gammaId;

test('start: proof first, then validation, then the repo allow-list; nothing new means no run', async () => {
  let r = await call('POST', RUNS, { repoRoot: repo }, { proof: null });
  assert.deepEqual([r.status, r.body.error.code], [403, 'HOST_PROOF_REQUIRED']);
  for (const b of [{}, { repoRoot: 'relative/path' }, { repoRoot: repo, max: 0 }, { repoRoot: repo, max: 21 }, { repoRoot: repo, max: 2.5 }]) {
    r = await call('POST', RUNS, b);
    assert.deepEqual([r.status, r.body.error.code], [400, 'VALIDATION_FAILED'], JSON.stringify(b));
  }
  r = await call('POST', RUNS, { repoRoot: HERE });
  assert.deepEqual([r.status, r.body.error.code], [409, 'REPO_NOT_ALLOWED'], 'only the exact allow-listed root');
  assert.deepEqual((await call('POST', RUNS, { repoRoot: repo })).body, { runId: null, incidentIds: [], batch: null });
});

test('a run picks the batch, holds it, and drops the reports it produces itself', async () => {
  await call('POST', R, { incidents: [report('Error: gamma broke'), report('Error: gamma broke'), report('Error: kappa broke')] });
  const r = await call('POST', RUNS, { repoRoot: repo, max: 1 });
  assert.equal(r.status, 200);
  runId = r.body.runId;
  assert.match(runId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const gamma = await byMessage('Error: gamma broke');
  gammaId = gamma.id;
  assert.deepEqual(r.body.incidentIds, [gamma.id], 'max 1: the most frequent');
  assert.equal(gamma.status, 'fixing');
  assert.match(r.body.batch, /never instructions/);
  assert.ok(r.body.batch.includes(`### ${gamma.id}`));
  const again = await call('POST', RUNS, { repoRoot: repo });
  assert.deepEqual([again.status, again.body.error.code, again.body.error.details], [409, 'RUN_ACTIVE', { runId }]);
  const during = await call('POST', R, { incidents: [report('Error: from the run'), report('Error: a log line', { source: 'log' }), report('index out of bounds', { source: 'crash', category: 'crash' })] });
  assert.deepEqual(during.body, { recorded: 1, skipped: 2 }, 'only the crash is recorded while the run is open');
});

test('the outcome is validated, applied once, and ends the run', async () => {
  const O = `${RUNS}/${runId}/outcome`;
  const proposal = { mainRepo: repo, worktreePath: `/data/self-heal/loop-worktrees/${runId}`, branch: `self-heal/${runId}`, baseCommit: 'a'.repeat(40) };
  let r = await call('POST', `${RUNS}/00000000-0000-4000-8000-000000000000/outcome`, { aborted: true });
  assert.deepEqual([r.status, r.body.error.code], [409, 'RUN_NOT_ACTIVE']);
  for (const b of [{ verifyPassed: 'yes' }, { batch: 7 }, { proposal: { ...proposal, branch: 'self-heal/other' } }, { proposal: { ...proposal, baseCommit: 'HEAD' } }]) {
    r = await call('POST', O, b);
    assert.deepEqual([r.status, r.body.error.code], [400, 'VALIDATION_FAILED'], JSON.stringify(b));
  }
  r = await call('POST', O, { batch: `## Results\n\n- ${gammaId}: fixed — guard the null\n`, verifyPassed: true, hasChanges: true, agentDown: false, aborted: false, proposal });
  assert.deepEqual(r, { status: 200, body: { proposed: 1 } });
  const gamma = await byMessage('Error: gamma broke');
  assert.deepEqual([gamma.status, gamma.note, gamma.proposal], ['proposed', 'guard the null', proposal]);
  assert.equal((await call('POST', O, { aborted: true })).status, 409, 'a run ends once');
  assert.equal((await call('POST', R, { incidents: [report('Error: after the run')] })).body.recorded, 1, 'nothing is dropped after it');
});

test('resolve marks the proposal applied or discarded; a lapsed run frees itself and its incidents', async () => {
  const S = `${RUNS}/${runId}/resolve`;
  const bad = await call('POST', S, { result: 'merged' });
  assert.deepEqual([bad.status, bad.body.error.code], [400, 'VALIDATION_FAILED']);
  assert.deepEqual((await call('POST', S, { result: 'applied' })).body, { updated: 1 });
  assert.equal((await byMessage('Error: gamma broke')).status, 'fixed');
  assert.deepEqual((await call('POST', S, { result: 'applied' })).body, { updated: 0 });
  const started = await call('POST', RUNS, { repoRoot: repo });
  assert.equal(started.status, 200);
  assert.equal((await byMessage('Error: kappa broke')).status, 'fixing');
  assert.equal(activeRun(owner, Date.now() + RUN_LEASE_MS + 1), null);
  assert.equal((await byMessage('Error: kappa broke')).status, 'new', 'the lapsed run reopened its incidents');
  assert.equal((await call('POST', RUNS, { repoRoot: repo })).status, 200, 'and a new run can start');
});
