// B5 (Software Factory Phase B, Task 9): the four desktop-claim routes. A real loopback server + a real bus, fake
// project and engine only. The host proof is the per-launch `x-llmide-host-nonce` the Tauri host sends to its core.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.LLMIDE_HOST_APPROVAL_KEY = 'c'.repeat(64);
process.env.NODE_ENV = 'test';
delete process.env.LLMIDE_BUS;
delete process.env.LLMIDE_CORE_NONCE;
process.env.LLMIDE_BUS_TRUST_CLIENT_HEADER = '1';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(HERE, '_bus-desktop-claim-test.db');
process.env.LLMIDE_DB_PATH = DB;
for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true });
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bus-claim-')));

const db = await import('../kb/db.mjs');
const store = await import('../kb/bus-store.mjs');
const q = await import('../kb/job-queue.mjs');
const users = await import('../server/users.mjs');
const { handleBusRoute, closeBusStreams } = await import('../routes/bus/bus-routes.mjs');
const { createBus } = await import('../routes/bus/executor.mjs');
const { busHostProof } = await import('../core/host-approval.mjs');

const A = users.registerUser(db.getDb(), { email: 'b5-claim@example.test', password: 'CorrectHorseBattery', displayName: 'a' }).id;
const B = users.registerUser(db.getDb(), { email: 'b5-claim-b@example.test', password: 'CorrectHorseBattery', displayName: 'b' }).id;
const PROOF = busHostProof();
const ARGS = { projectId: 'p1', issueIds: ['i1', 'i2'], ship: true };

const bus = createBus({ graceMs: 20, sweepMs: 60_000, deps: { resolveProjectRoot: () => ROOT, projectAllowed: () => true } });
bus.start();
const server = http.createServer(async (req, res) => {
  req.user = { id: req.headers['x-test-user'] };
  await handleBusRoute(req, res, { bus });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

function call(method, p, body, { user = A, client = 'desktop-ui', proof = PROOF, headers = {} } = {}) {
  const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, method, path: p, agent: false,
      headers: {
        'x-test-user': user, 'x-llmide-client': client, ...(proof ? { 'x-llmide-host-nonce': proof } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers,
      },
    }, (res) => {
      let text = ''; res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode, body: json, text }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let seq = 0;
async function approved(args = ARGS, { user = A, ship = args.ship } = {}) {
  const r = await call('POST', '/bus/commands', { v: 1, kind: 'issues.implement', idem: `b5-${++seq}`, args: { ...args, ship } }, { user, client: 'ios-native' });
  assert.equal(r.status, 202, r.text);
  const id = r.body.command.id;
  const nonce = (await call('GET', '/bus/approvals', undefined, { user })).body.items.find((i) => i.id === id).nonce;
  const confirm = { projectId: args.projectId, issueIds: [...args.issueIds].sort(), ship: !!ship };
  const ok = await call('POST', `/bus/commands/${id}/approve`, { nonce, confirm }, { user });
  assert.equal(ok.status, 200, ok.text);
  return id;
}
const reset = () => {
  for (const t of ['job_events', 'bus_commands', 'bus_kinds_flags', 'jobs']) { try { db.getDb().prepare(`DELETE FROM ${t}`).run(); } catch { /* table name */ } }
  db.getDb().prepare('DELETE FROM bus_kind_flags').run();
};

after(async () => {
  closeBusStreams();
  await bus.stop();
  await new Promise((r) => server.close(r));
  db.closeDb();
  for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true });
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('claimable, claim, progress and finish all require the host proof and the desktop class', async () => {
  reset();
  const id = await approved();
  assert.equal((await call('GET', '/bus/claimable', undefined, { proof: null })).status, 403);
  assert.equal((await call('GET', '/bus/claimable', undefined, { client: 'ios-native' })).status, 403);
  assert.equal((await call('POST', `/bus/commands/${id}/claim`, {}, { proof: null })).status, 403);
  assert.equal((await call('POST', `/bus/commands/${id}/claim`, {}, { client: 'ios-native' })).status, 403);
  assert.equal((await call('POST', `/bus/commands/${id}/events`, { type: 'progress', payload: { step: 'x' } }, { proof: null })).status, 403);
  assert.equal((await call('POST', `/bus/commands/${id}/finish`, { state: 'succeeded' }, { proof: null })).status, 403);
  const refused = await call('GET', '/bus/claimable', undefined, { proof: null });
  assert.equal(refused.body.error.code, 'HOST_PROOF_REQUIRED');
});

test('an approved issues.implement waits for the desktop: the core never runs it', async () => {
  reset();
  const id = await approved();
  const before = await call('GET', `/bus/commands/${id}`);
  assert.equal(before.body.command.state, 'queued', 'approved, but not claimed');
  assert.equal(q.getJob(A, id).runner, 'desktop');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(q.getJob(A, id).state, 'queued', 'the core runner never claimed it');
  assert.equal(store.listEvents(A, id).some((e) => e.type === 'progress' && e.payload.step === 'checks passed'), false);
});

test('only this user sees a claimable command; claiming it returns the one token and a lease', async () => {
  reset();
  const id = await approved();
  assert.deepEqual((await call('GET', '/bus/claimable', undefined, { user: B })).body.items, []);
  const list = (await call('GET', '/bus/claimable')).body;
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].id, id);
  assert.equal(list.items[0].kind, 'issues.implement');
  assert.deepEqual(list.items[0].args, ARGS);
  assert.equal('nonce' in list.items[0], false);
  assert.equal('claimToken' in list.items[0], false);
  const claim = await call('POST', `/bus/commands/${id}/claim`, {});
  assert.equal(claim.status, 200, claim.text);
  assert.equal(claim.body.command.state, 'running');
  assert.equal(typeof claim.body.claimToken, 'string');
  assert.ok(claim.body.leaseExpiresAt);
  assert.equal((await call('GET', '/bus/claimable')).body.items.length, 0);
  const again = await call('POST', `/bus/commands/${id}/claim`, {});
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'LEASE_HELD');
  assert.equal((await call('POST', `/bus/commands/${id}/claim`, {}, { user: B })).status, 404, "another user's command is not found");
});

test('progress needs the token, accepts progress only, and caps the payload', async () => {
  reset();
  const id = await approved();
  const { claimToken } = (await call('POST', `/bus/commands/${id}/claim`, {})).body;
  assert.equal((await call('POST', `/bus/commands/${id}/events`, { type: 'progress', payload: { step: 'stage 1' } })).status, 409, 'no token');
  const bad = await call('POST', `/bus/commands/${id}/events`, { claimToken, type: 'ended', payload: { state: 'succeeded' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'VALIDATION_FAILED');
  const huge = await call('POST', `/bus/commands/${id}/events`, { claimToken, type: 'progress', payload: { step: 'x'.repeat(5000) } });
  assert.equal(huge.status, 413);
  assert.equal(huge.body.error.code, 'PAYLOAD_TOO_LARGE');
  const ok = await call('POST', `/bus/commands/${id}/events`, { claimToken, type: 'progress', payload: { step: 'stage 1' } });
  assert.equal(ok.status, 200, ok.text);
  const steps = store.listEvents(A, id).filter((e) => e.type === 'progress').map((e) => e.payload.step);
  assert.ok(steps.includes('stage 1'));
  assert.equal(store.listEvents(A, id).some((e) => e.terminal), false, 'progress never ends the command');
});

test('finish needs the token, writes one terminal event, and a replay is idempotent', async () => {
  reset();
  const id = await approved();
  const { claimToken } = (await call('POST', `/bus/commands/${id}/claim`, {})).body;
  assert.equal((await call('POST', `/bus/commands/${id}/finish`, { state: 'succeeded' })).status, 409, 'no token');
  assert.equal((await call('POST', `/bus/commands/${id}/finish`, { claimToken, state: 'weird' })).status, 400);
  const wrong = await call('POST', `/bus/commands/${id}/finish`, { claimToken: `${claimToken}x`, state: 'succeeded' });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.error.code, 'LEASE_LOST');
  const done = await call('POST', `/bus/commands/${id}/finish`, { claimToken, state: 'succeeded', result: { readyToShip: true, shipped: false } });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.body.command.state, 'succeeded');
  assert.deepEqual(done.body.command.result, { readyToShip: true, shipped: false });
  const terms = store.listEvents(A, id).filter((e) => e.terminal);
  assert.equal(terms.length, 1);
  assert.equal(terms[0].type, 'ended');
  const replay = await call('POST', `/bus/commands/${id}/finish`, { claimToken, state: 'succeeded', result: { readyToShip: true, shipped: false } });
  assert.equal(replay.status, 200, 'a replay after a lost response is not an error');
  assert.equal(store.listEvents(A, id).filter((e) => e.terminal).length, 1);
  const diff = await call('POST', `/bus/commands/${id}/finish`, { claimToken, state: 'failed', errorCode: 'engine_failed' });
  assert.equal(diff.status, 409);
});

test('finish interrupted records the interrupted error code', async () => {
  reset();
  const id = await approved();
  const { claimToken } = (await call('POST', `/bus/commands/${id}/claim`, {})).body;
  const done = await call('POST', `/bus/commands/${id}/finish`, { claimToken, state: 'interrupted' });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.body.command.state, 'interrupted');
  const term = store.terminalEvent(A, id);
  assert.equal(term.type, 'error');
  assert.equal(term.payload.code, 'interrupted');
});

test('a member demoted after approval cannot claim the command', async () => {
  reset();
  const id = await approved();
  db.getDb().prepare("UPDATE members SET team_role='viewer' WHERE user_id=?").run(A);
  try {
    const r = await call('POST', `/bus/commands/${id}/claim`, {});
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'TIER_DENIED');
    assert.equal((await call('GET', '/bus/claimable')).body.items.length, 0);
  } finally {
    db.getDb().prepare("UPDATE members SET team_role='owner' WHERE user_id=?").run(A);
  }
});

test('an expired lease is released by the sweep and the phone sees it interrupted', async () => {
  reset();
  const id = await approved();
  const { claimToken } = (await call('POST', `/bus/commands/${id}/claim`, {})).body;
  db.getDb().prepare('UPDATE bus_commands SET lease_expires_at=? WHERE id=?').run(new Date(Date.now() - 1_000).toISOString(), id);
  assert.deepEqual((await call('GET', '/bus/claimable')).body.items, []);
  const cmd = await call('GET', `/bus/commands/${id}`);
  assert.equal(cmd.body.command.state, 'interrupted');
  assert.equal(store.terminalEvent(A, id).payload.code, 'interrupted');
  const late = await call('POST', `/bus/commands/${id}/finish`, { claimToken, state: 'succeeded' });
  assert.equal(late.status, 409, 'a late finish cannot resurrect an interrupted command');
});
