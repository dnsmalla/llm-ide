// Command bus (S3): routes, tier gate, approvals, idempotency, tenancy, replay, cancel, quotas, kill switch, crash recovery,
// execution-time re-check, engines (fake engine, stub CLIs, fake SDK/adapter). No model call, no network beyond loopback.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
delete process.env.LLMIDE_BUS;
delete process.env.LLMIDE_CORE_NONCE;
process.env.LLMIDE_BUS_TRUST_CLIENT_HEADER = '1'; // tests declare the class by header; the capping tests unset it
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_command-bus-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bus-test-')));
const STUBS = path.join(SANDBOX, 'stubs');
fs.mkdirSync(STUBS);

const main = await import('../kb/db.mjs');
const store = await import('../kb/bus-store.mjs');
const q = await import('../kb/job-queue.mjs');
const users = await import('../server/users.mjs');
const { handleBusRoute, closeBusStreams } = await import('../routes/bus/bus-routes.mjs');
const { createBus, approvalNonce, confirmMatches } = await import('../routes/bus/executor.mjs');
const { resolveClient } = await import('../routes/bus/client.mjs');
const { REGISTRY } = await import('../routes/bus/registry.mjs');
const { checkSequence } = await import('../routes/bus/sequence.mjs');
const engines = await import('../routes/bus/engines.mjs');
const { runReview } = await import('../routes/bus/review.mjs');

const mk = (e) => users.registerUser(main.getDb(), { email: e, password: 'CorrectHorseBattery', displayName: e }).id;
const A = mk('bus-a@example.test');
const B = mk('bus-b@example.test');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) throw new Error('timeout waiting'); await sleep(15); } };

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' } });
}
const REPO = path.join(SANDBOX, 'repo');
fs.mkdirSync(REPO);
fs.writeFileSync(path.join(REPO, 'a.txt'), 'one\n');
git(['init', '-q'], REPO); git(['add', '.'], REPO); git(['commit', '-q', '-m', 'init'], REPO);

// ---- harness ----
let busRef = null;
const server = http.createServer(async (req, res) => {
  req.user = { id: req.headers['x-test-user'] };
  await handleBusRoute(req, res, { bus: busRef });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

function call(method, p, body, { user = A, client = 'desktop-ui', headers = {} } = {}) {
  const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: p, agent: false,
      headers: { 'x-test-user': user, ...(client ? { 'x-llmide-client': client } : {}), ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers },
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
/** Read an SSE stream; stops (client drop) after `stopAfter` events when given. Returns the parsed events. */
function sse(p, { user = A, client = 'desktop-ui', stopAfter = Infinity } = {}) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.get({ host: '127.0.0.1', port, path: p, agent: false, headers: { 'x-test-user': user, 'x-llmide-client': client } }, (res) => {
      if (res.statusCode !== 200) { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, text: t, events })); return; }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const m = /^id: (\d+)\ndata: (.*)$/m.exec(frame);
          if (m) { const ev = JSON.parse(m[2]); assert.equal(ev.seq, Number(m[1])); events.push(ev); }
          if (events.length >= stopAfter) { req.destroy(); resolve({ status: 200, events, dropped: true }); return; }
        }
      });
      res.on('end', () => resolve({ status: 200, events }));
    });
    req.on('error', (e) => { if (e.code === 'ECONNRESET') return; reject(e); });
  });
}

// ---- fakes ----
const control = { gate: null, calls: [], failWith: null, text: 'Finding: none\nNo findings.' };
const fakeReview = async ({ userId, args, cwd, signal, emit }) => {
  control.calls.push({ userId, args, cwd });
  emit('progress', { step: 'fake step 1' });
  if (control.gate) await Promise.race([control.gate, new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))))]);
  if (control.failWith) throw Object.assign(new Error('x'), { code: control.failWith });
  return { focus: args.focus, engine: 'fake', text: control.text, truncated: false };
};
const PROJECTS = { 'proj-1': REPO, 'proj-2': REPO };
const newBus = (extra = {}) => createBus({
  graceMs: 50, sweepMs: 60_000,
  deps: { resolveProjectRoot: (u, id) => { if (!PROJECTS[id]) throw new Error('unknown'); return PROJECTS[id]; }, projectAllowed: () => true, runReview: fakeReview, ...extra },
});
let bus = newBus();
busRef = bus;
bus.start();

const reset = async () => {
  control.gate = null; control.calls.length = 0; control.failWith = null;
  for (const t of ['job_events', 'bus_commands', 'bus_kind_flags', 'jobs']) main.getDb().prepare(`DELETE FROM ${t}`).run();
};
let idemN = 0;
const cmd = (over = {}) => ({ v: 1, kind: 'review', idem: `k-${++idemN}-${Date.now()}`, args: { focus: 'code', projectId: 'proj-1' }, ...over });
const enableReview = (user = A) => call('PUT', '/bus/kinds/review', { enabled: true }, { user, client: 'desktop-ui' });

after(async () => {
  closeBusStreams();
  await bus.stop();
  await new Promise((r) => server.close(r));
  main.closeDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------------------

test('desktop starts a review: 202, runs, ended with a result, gap-free events with one terminal', async () => {
  await reset();
  const r = await call('POST', '/bus/commands', cmd());
  assert.equal(r.status, 202, r.text);
  assert.equal(r.body.deduped, false);
  const id = r.body.command.id;
  await until(async () => (await call('GET', `/bus/commands/${id}`)).body.command.state === 'succeeded');
  const done = (await call('GET', `/bus/commands/${id}`)).body.command;
  assert.equal(done.result.engine, 'fake');
  assert.match(done.result.text, /No findings/);
  const ev = await sse(`/bus/commands/${id}/events`);
  assert.equal(ev.status, 200);
  assert.equal(checkSequence(ev.events), null);
  assert.deepEqual(ev.events.map((e) => e.type).filter((t) => t !== 'chunk' && t !== 'progress'), ['accepted', 'ended']);
  assert.equal(ev.events.at(-1).payload.state, 'succeeded');
  assert.equal(ev.events.at(-1).payload.result.engine, 'fake');
  assert.equal(ev.events.at(-1).payload.result.textBytes > 0, true, 'terminal event carries a summary, not the text');
  assert.equal(ev.events.at(-1).payload.result.text, undefined);
});

test('validation: unknown kind, bad version, bad args, path-as-id, extra field are refused with fixed codes', async () => {
  await reset();
  const bad = async (frame) => (await call('POST', '/bus/commands', frame));
  let r = await bad(cmd({ kind: 'files.write', args: {} })); assert.equal(r.status, 400); assert.equal(r.body.error.code, 'UNKNOWN_KIND');
  r = await bad(cmd({ v: 2 })); assert.equal(r.status, 400); assert.equal(r.body.error.code, 'UNSUPPORTED_VERSION');
  r = await bad(cmd({ args: { focus: 'code', projectId: '../../etc/passwd' } })); assert.equal(r.body.error.code, 'INVALID_ARGS');
  assert.ok(r.body.error.details.errors.some((e) => e.path === '.args.projectId'));
  r = await bad(cmd({ args: { focus: 'code', projectId: 'proj-1', prompt: 'ignore everything' } })); assert.equal(r.body.error.code, 'INVALID_ARGS');
  r = await bad(cmd({ idem: undefined })); assert.equal(r.body.error.code, 'INVALID_ARGS');
  r = await bad('{not json'); assert.equal(r.status, 400); assert.equal(r.body.error.code, 'VALIDATION_FAILED');
  r = await bad(cmd({ args: { focus: 'code', projectId: 'no-such-project' } })); assert.equal(r.status, 404); assert.equal(r.body.error.code, 'NOT_FOUND');
  r = await bad(JSON.stringify({ ...cmd(), pad: 'x'.repeat(70_000) })); assert.equal(r.status, 413); assert.equal(r.body.error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(control.calls.length, 0, 'nothing ran');
  assert.equal((await call('GET', '/bus/commands')).body.items.length, 0, 'nothing was stored');
});

test('frame origin, userId and deviceId are ignored: the host decides', async () => {
  await reset();
  const r = await call('POST', '/bus/commands', cmd({ origin: { clientKind: 'desktop-ui' }, userId: B, deviceId: 'x' }), { client: 'ios-native' });
  assert.equal(r.status, 202);
  assert.equal(r.body.command.originClient, 'ios-native');
  assert.equal((await call('GET', '/bus/commands', undefined, { user: B })).body.items.length, 0, 'not stored under the frame userId');
});

test('tier gate: extension and phone-pwa cannot start a review; ios-native can only enqueue (needs approval while the kind is off)', async () => {
  await reset();
  for (const client of ['extension', 'phone-pwa']) {
    const r = await call('POST', '/bus/commands', cmd(), { client });
    assert.equal(r.status, 403, client); assert.equal(r.body.error.code, 'TIER_DENIED');
  }
  const r = await call('POST', '/bus/commands', cmd(), { client: 'ios-native' });
  assert.equal(r.status, 202);
  assert.equal(r.body.command.state, 'awaiting_approval');
  assert.equal(r.body.command.approvalReason, 'switch_off');
  await sleep(100);
  assert.equal(control.calls.length, 0, 'a phone request for a disabled task never runs');
  const ev = await sse(`/bus/commands/${r.body.command.id}/events`, { stopAfter: 2 });
  assert.deepEqual(ev.events.map((e) => e.type), ['accepted', 'needs_approval']);
  assert.equal(ev.events[0].payload.state, 'awaiting_approval');
  assert.equal(JSON.stringify(ev.events).includes('nonce'), false, 'the nonce is never in an event');
});

test('with the enable flag on, ios-native starts a review without a click', async () => {
  await reset();
  assert.equal((await enableReview()).status, 200);
  const r = await call('POST', '/bus/commands', cmd(), { client: 'ios-native' });
  assert.equal(r.status, 202);
  assert.notEqual(r.body.command.state, 'awaiting_approval');
  await until(async () => (await call('GET', `/bus/commands/${r.body.command.id}`)).body.command.state === 'succeeded');
});

test('only a desktop-class client may switch a kind on, list approvals, approve or deny', async () => {
  await reset();
  for (const client of ['ios-native', 'extension', 'phone-pwa']) {
    assert.equal((await call('PUT', '/bus/kinds/review', { enabled: true }, { client })).status, 403, client);
    assert.equal((await call('GET', '/bus/approvals', undefined, { client })).status, 403, client);
  }
  const phone = await call('POST', '/bus/commands', cmd(), { client: 'ios-native' });
  const id = phone.body.command.id;
  for (const client of ['ios-native', 'extension', 'phone-pwa']) {
    const a = await call('POST', `/bus/commands/${id}/approve`, { nonce: 'x'.repeat(64) }, { client });
    assert.equal(a.status, 403, `${client} cannot approve`); assert.equal(a.body.error.code, 'TIER_DENIED');
    assert.equal((await call('POST', `/bus/commands/${id}/deny`, {}, { client })).status, 403);
  }
  // Even with the real nonce a phone cannot approve: the class decides first.
  const list = (await call('GET', '/bus/approvals')).body.items;
  const nonce = list.find((i) => i.id === id).nonce;
  assert.equal((await call('POST', `/bus/commands/${id}/approve`, { nonce }, { client: 'ios-native' })).status, 403);
  // Desktop: no nonce, wrong nonce -> 403; right nonce -> runs.
  assert.equal((await call('POST', `/bus/commands/${id}/approve`, {})).body.error.code, 'APPROVAL_NONCE_INVALID');
  assert.equal((await call('POST', `/bus/commands/${id}/approve`, { nonce: 'a'.repeat(64) })).body.error.code, 'APPROVAL_NONCE_INVALID');
  assert.equal(control.calls.length, 0);
  const ok = await call('POST', `/bus/commands/${id}/approve`, { nonce });
  assert.equal(ok.status, 200, ok.text);
  await until(async () => (await call('GET', `/bus/commands/${id}`)).body.command.state === 'succeeded');
  assert.equal(control.calls.length, 1);
  assert.equal((await call('POST', `/bus/commands/${id}/approve`, { nonce })).status, 409, 'cannot approve twice');
});

test('deny: the command ends with one terminal error and never runs', async () => {
  await reset();
  const id = (await call('POST', '/bus/commands', cmd(), { client: 'ios-native' })).body.command.id;
  const d = await call('POST', `/bus/commands/${id}/deny`, {});
  assert.equal(d.status, 200); assert.equal(d.body.command.state, 'denied'); assert.equal(d.body.command.errorCode, 'tier_denied');
  const ev = await sse(`/bus/commands/${id}/events`);
  assert.equal(checkSequence(ev.events), null);
  assert.equal(ev.events.at(-1).type, 'error');
  await sleep(80); assert.equal(control.calls.length, 0);
});

test('an approval older than its ttl is expired, never run', async () => {
  await reset();
  const id = (await call('POST', '/bus/commands', cmd({ ttlMs: 1000 }), { client: 'ios-native' })).body.command.id;
  const nonce = (await call('GET', '/bus/approvals')).body.items[0].nonce;
  main.getDb().prepare("UPDATE bus_commands SET ttl_at = ? WHERE id = ?").run(new Date(Date.now() - 5000).toISOString(), id);
  const a = await call('POST', `/bus/commands/${id}/approve`, { nonce });
  assert.equal(a.status, 409); assert.equal(a.body.error.code, 'EXPIRED');
  const c = (await call('GET', `/bus/commands/${id}`)).body.command;
  assert.equal(c.state, 'expired'); assert.equal(c.errorCode, 'expired');
  assert.equal(control.calls.length, 0);
});

test('a client that claims desktop-ui without host proof is capped at extension; with the derived host proof it is honoured', async () => {
  const keep = process.env.LLMIDE_BUS_TRUST_CLIENT_HEADER;
  delete process.env.LLMIDE_BUS_TRUST_CLIENT_HEADER;
  try {
    const hdr = (h) => ({ headers: h });
    assert.equal(resolveClient({ headers: { 'x-llmide-client': 'desktop-ui' } }).client, 'extension');
    assert.equal(resolveClient({ headers: { 'x-llmide-client': 'ios-native' } }).client, 'extension');
    assert.equal(resolveClient({ headers: { 'x-llmide-client': 'phone-pwa' } }).client, 'phone-pwa', 'it may lower itself');
    assert.equal(resolveClient({ headers: {} }).client, 'extension');
    assert.equal(resolveClient({ headers: { 'x-llmide-client': 'bogus' } }).client, 'extension');
    assert.equal(resolveClient({ headers: { 'x-llmide-client': 'relay-bridge' } }).client, 'phone-pwa');
    // Over HTTP: the claim does not open the desktop-only routes.
    assert.equal((await call('PUT', '/bus/kinds/review', { enabled: true }, hdr({}))).status, 403);
    // Host proof: HMAC(approval key, "bus-host-proof/v1"), never the /health nonce (tests/bus-host-proof.test.mjs).
    const keyHex = 'a1'.repeat(32);
    process.env.LLMIDE_HOST_APPROVAL_KEY = keyHex;
    const proof = (await import('../core/host-approval.mjs')).busHostProof(process.env);
    assert.equal(resolveClient({ headers: { 'x-llmide-client': 'desktop-ui', 'x-llmide-host-nonce': proof } }).client, 'desktop-ui');
    assert.equal(resolveClient({ headers: { 'x-llmide-client': 'ios-native', 'x-llmide-host-nonce': proof } }).client, 'ios-native');
    assert.equal(resolveClient({ headers: { 'x-llmide-client': 'desktop-ui', 'x-llmide-host-nonce': 'cd'.repeat(32) } }).client, 'extension', 'wrong proof');
    assert.equal(resolveClient({ headers: { 'x-llmide-client': 'desktop-ui', 'x-llmide-host-nonce': proof.slice(1) } }).client, 'extension', 'short proof');
    assert.equal((await call('PUT', '/bus/kinds/review', { enabled: true }, { headers: { 'x-llmide-host-nonce': proof } })).status, 200);
    // No approval key configured: nobody can prove host.
    delete process.env.LLMIDE_HOST_APPROVAL_KEY;
    assert.equal(resolveClient({ headers: { 'x-llmide-client': 'desktop-ui', 'x-llmide-host-nonce': proof } }).client, 'extension');
  } finally {
    delete process.env.LLMIDE_HOST_APPROVAL_KEY;
    if (keep !== undefined) process.env.LLMIDE_BUS_TRUST_CLIENT_HEADER = keep;
  }
});

test('custom.run is desktop-only: every other client class gets 403 KIND_NOT_ALLOWED_FOR_CLIENT and it is reported not allowed', async () => {
  await reset();
  for (const client of ['phone-pwa', 'extension', 'ios-native']) {
    const r = await call('POST', '/bus/commands', cmd({ kind: 'custom.run', args: { customTaskId: 'c-1' } }), { client });
    assert.equal(r.status, 403, `${client}: ${r.text}`); assert.equal(r.body.error.code, 'KIND_NOT_ALLOWED_FOR_CLIENT', client);
    const kinds = (await call('GET', '/bus/kinds', undefined, { client })).body;
    assert.equal(kinds.kinds.find((k) => k.kind === 'custom.run').allowed, false, client);
  }
  assert.equal((await call('GET', '/bus/commands')).body.items.length, 0);
});

test('unavailable kinds answer KIND_NOT_AVAILABLE with the reason; nothing is stubbed as success', async () => {
  await reset();
  for (const [kind, args, client] of [
    ['sources.update', {}, 'desktop-ui'], ['issues.from_notes', { projectId: 'proj-1' }, 'ios-native'],
    ['issues.implement', { projectId: 'proj-1', issueIds: ['1'] }, 'desktop-ui'],
    ['loop.run', { projectId: 'proj-1', loopId: 'l' }, 'ios-native'], ['custom.run', { customTaskId: 'c-1' }, 'desktop-ui'],
  ]) {
    const r = await call('POST', '/bus/commands', cmd({ kind, args }), { client });
    assert.equal(r.status, 501, `${kind}: ${r.text}`); assert.equal(r.body.error.code, 'KIND_NOT_AVAILABLE');
    assert.ok(r.body.error.details.reason.length > 20);
  }
  assert.equal((await call('GET', '/bus/commands')).body.items.length, 0);
  const kinds = (await call('GET', '/bus/kinds')).body;
  assert.equal(kinds.client, 'desktop-ui');
  const by = Object.fromEntries(kinds.kinds.map((k) => [k.kind, k]));
  assert.equal(by.review.available, true);
  for (const k of ['sources.update', 'issues.from_notes', 'issues.implement', 'loop.run', 'custom.run']) { assert.equal(by[k].available, false); assert.ok(by[k].unavailableReason); }
  assert.equal(by['issues.implement'].tier, 'T2');
  const asExt = (await call('GET', '/bus/kinds', undefined, { client: 'extension' })).body;
  assert.equal(asExt.kinds.find((k) => k.kind === 'review').allowed, false);
  assert.equal(asExt.kinds.find((k) => k.kind === 'review').needsApproval, false);
});

test('idempotency: same key and command returns the original (200, deduped); different command is IDEM_CONFLICT; per user', async () => {
  await reset();
  const frame = cmd();
  const first = await call('POST', '/bus/commands', frame);
  const again = await call('POST', '/bus/commands', frame);
  assert.equal(first.status, 202); assert.equal(again.status, 200); assert.equal(again.body.deduped, true);
  assert.equal(again.body.command.id, first.body.command.id);
  await until(async () => control.calls.length === 1);
  await sleep(100);
  assert.equal(control.calls.length, 1, 'executed once');
  const other = await call('POST', '/bus/commands', { ...frame, args: { focus: 'doc', projectId: 'proj-1' } });
  assert.equal(other.status, 409); assert.equal(other.body.error.code, 'IDEM_CONFLICT');
  const b = await call('POST', '/bus/commands', frame, { user: B });
  assert.equal(b.status, 202); assert.notEqual(b.body.command.id, first.body.command.id, 'another user is independent');
});

test('tenancy: another user gets 404 for every route on a command, and sees nothing in lists or approvals', async () => {
  await reset();
  const id = (await call('POST', '/bus/commands', cmd(), { client: 'ios-native' })).body.command.id;
  const nonce = (await call('GET', '/bus/approvals')).body.items[0].nonce;
  const asB = { user: B };
  assert.equal((await call('GET', `/bus/commands/${id}`, undefined, asB)).status, 404);
  assert.equal((await sse(`/bus/commands/${id}/events`, { user: B })).status, 404);
  assert.equal((await call('POST', `/bus/commands/${id}/cancel`, {}, asB)).status, 404);
  assert.equal((await call('POST', `/bus/commands/${id}/approve`, { nonce }, asB)).status, 404, 'even with A\'s nonce');
  assert.equal((await call('POST', `/bus/commands/${id}/deny`, {}, asB)).status, 404);
  assert.deepEqual((await call('GET', '/bus/commands', undefined, asB)).body.items, []);
  assert.deepEqual((await call('GET', '/bus/approvals', undefined, asB)).body.items, []);
  assert.equal((await call('GET', '/bus/commands/not-a-real-id-at-all')).status, 404);
  assert.equal((await call('GET', '/bus/commands/..%2F..%2Fetc')).status, 404);
  assert.equal(approvalNonce(A, id, 'h') === approvalNonce(B, id, 'h'), false);
  // A's own flag does not leak: B's review is still off.
  await enableReview(A);
  const bk = (await call('GET', '/bus/kinds', undefined, { user: B })).body.kinds.find((k) => k.kind === 'review');
  assert.equal(bk.enabled, false);
});

test('replay after a dropped stream is gap-free and ends with exactly one terminal event', async () => {
  await reset();
  let release; control.gate = new Promise((r) => { release = r; });
  const id = (await call('POST', '/bus/commands', cmd())).body.command.id;
  const part1 = await sse(`/bus/commands/${id}/events`, { stopAfter: 2 });
  assert.equal(part1.dropped, true);
  assert.deepEqual(part1.events.map((e) => e.seq), [1, 2]);
  release();
  const part2 = await sse(`/bus/commands/${id}/events?after=2`);
  assert.equal(part2.events[0].seq, 3);
  const all = [...part1.events, ...part2.events];
  assert.equal(checkSequence(all), null);
  assert.equal(all.filter((e) => e.terminal).length, 1);
  // after beyond the end of a finished command: an empty, clean close.
  const past = await sse(`/bus/commands/${id}/events?after=${all.length}`);
  assert.deepEqual(past.events, []);
  assert.equal((await sse(`/bus/commands/${id}/events?after=-1`)).status, 400);
  assert.equal((await sse(`/bus/commands/${id}/events?after=abc`)).status, 400);
});

test('cancel: a running command aborts and ends cancelled; a queued one is cancelled at once; repeats are safe', async () => {
  await reset();
  control.gate = new Promise(() => {}); // never resolves: only abort ends it
  const running = (await call('POST', '/bus/commands', cmd())).body.command.id;
  await until(async () => control.calls.length === 1);
  const queued = (await call('POST', '/bus/commands', cmd())).body.command.id; // same lane (same project): waits behind the first
  assert.equal((await call('GET', `/bus/commands/${queued}`)).body.command.state, 'queued');
  const cq = await call('POST', `/bus/commands/${queued}/cancel`, {});
  assert.equal(cq.status, 200); assert.equal(cq.body.command.state, 'cancelled');
  const cr = await call('POST', `/bus/commands/${running}/cancel`, {});
  assert.equal(cr.status, 200);
  await until(async () => (await call('GET', `/bus/commands/${running}`)).body.command.state === 'cancelled');
  for (const id of [running, queued]) {
    const ev = await sse(`/bus/commands/${id}/events`);
    assert.equal(checkSequence(ev.events), null, id);
    assert.deepEqual([ev.events.at(-1).type, ev.events.at(-1).payload.state], ['ended', 'cancelled']);
  }
  assert.equal((await call('POST', `/bus/commands/${queued}/cancel`, {})).status, 200, 'idempotent');
  assert.equal(control.calls.length, 1, 'the queued one never ran');
});

test('cancel of a command waiting for approval ends it; cancelling a finished one is 409', async () => {
  await reset();
  const id = (await call('POST', '/bus/commands', cmd(), { client: 'ios-native' })).body.command.id;
  const c = await call('POST', `/bus/commands/${id}/cancel`, {}, { client: 'ios-native' });
  assert.equal(c.status, 200); assert.equal(c.body.command.state, 'cancelled');
  assert.equal(checkSequence((await sse(`/bus/commands/${id}/events`)).events), null);
  const done = (await call('POST', '/bus/commands', cmd())).body.command.id;
  await until(async () => (await call('GET', `/bus/commands/${done}`)).body.command.state === 'succeeded');
  const late = await call('POST', `/bus/commands/${done}/cancel`, {});
  assert.equal(late.status, 409); assert.equal(late.body.error.code, 'ALREADY_FINISHED');
});

test('quotas: waiting approvals and active commands are capped per user; another user is unaffected', async () => {
  await reset();
  const cap = store.BUS_LIMITS.maxPendingApprovals;
  for (let i = 0; i < cap; i += 1) assert.equal((await call('POST', '/bus/commands', cmd(), { client: 'ios-native' })).status, 202);
  const over = await call('POST', '/bus/commands', cmd(), { client: 'ios-native' });
  assert.equal(over.status, 429); assert.equal(over.body.error.code, 'QUOTA_EXCEEDED');
  assert.equal((await call('POST', '/bus/commands', cmd(), { client: 'ios-native', user: B })).status, 202);
  // Active commands (queued/running): the same cap, counting the waiting ones too.
  await reset();
  await enableReview(A);
  control.gate = new Promise(() => {});
  for (let i = 0; i < store.BUS_LIMITS.maxActiveCommands; i += 1) assert.equal((await call('POST', '/bus/commands', cmd(), { client: 'ios-native' })).status, 202);
  assert.equal((await call('POST', '/bus/commands', cmd(), { client: 'ios-native' })).body.error.code, 'QUOTA_EXCEEDED');
  for (const c of (await call('GET', '/bus/commands?limit=200')).body.items) await call('POST', `/bus/commands/${c.id}/cancel`, {});
  control.gate = null;
  await until(async () => bus.runner.activeCount() === 0);
});

test('limit and state filters on the list are validated', async () => {
  await reset();
  assert.equal((await call('GET', '/bus/commands?limit=0')).status, 400);
  assert.equal((await call('GET', '/bus/commands?limit=500')).status, 400);
  assert.equal((await call('GET', '/bus/commands?state=bogus')).status, 400);
  assert.equal((await call('GET', '/bus/commands?state=running&limit=5')).status, 200);
});

test('kill switch: LLMIDE_BUS=off answers 503 on every route', async () => {
  process.env.LLMIDE_BUS = 'off';
  try {
    for (const [m, p, b] of [['POST', '/bus/commands', cmd()], ['GET', '/bus/commands'], ['GET', '/bus/kinds'], ['GET', '/bus/approvals'], ['GET', '/bus/commands/abcdefgh12345/events']]) {
      const r = await call(m, p, b);
      assert.equal(r.status, 503, p); assert.equal(r.body.error.code, 'BUS_DISABLED');
    }
  } finally { delete process.env.LLMIDE_BUS; }
  assert.equal((await call('GET', '/bus/kinds')).status, 200);
});

test('crash recovery: a command running when the process died is interrupted at boot, with one terminal event, gap-free', async () => {
  await reset();
  const dead = newBus();
  // Accept a command, then claim its job as a process that never finished it (no runner is started here).
  const out = dead.receive(A, cmd(), { client: 'desktop-ui' });
  const claimed = q.claimNextJobSystem();
  assert.equal(claimed.id, out.command.id);
  assert.equal(q.getJob(A, claimed.id).state, 'running');
  const fresh = newBus();
  const swept = fresh.start();
  assert.deepEqual(swept.interrupted, [claimed.id]);
  try {
    const c = store.getCommand(A, claimed.id);
    assert.equal(c.state, 'interrupted');
    const events = store.listEvents(A, claimed.id, 0);
    assert.equal(checkSequence(events), null);
    assert.deepEqual([events.at(-1).type, events.at(-1).payload.code], ['error', 'interrupted']);
    assert.equal(store.backfillTerminalsSystem(), 0, 'idempotent: nothing more to write');
  } finally { await fresh.stop(); }
  // The process-wide bus keeps working after another bus swept and stopped.
  busRef = bus; bus.start();
});

test('execution-time re-check: a phone run is refused when the kind was switched off after it was queued', async () => {
  await reset();
  await enableReview(A);
  control.gate = new Promise(() => {});
  const first = (await call('POST', '/bus/commands', cmd(), { client: 'ios-native' })).body.command.id; // holds the lane
  await until(async () => control.calls.length === 1);
  const second = (await call('POST', '/bus/commands', cmd(), { client: 'ios-native' })).body.command.id; // queued behind it
  assert.equal(second && (await call('GET', `/bus/commands/${second}`)).body.command.state, 'queued');
  await call('PUT', '/bus/kinds/review', { enabled: false });
  await call('POST', `/bus/commands/${first}/cancel`, {});
  await until(async () => ['failed', 'succeeded'].includes((await call('GET', `/bus/commands/${second}`)).body.command.state));
  const c = (await call('GET', `/bus/commands/${second}`)).body.command;
  assert.equal(c.state, 'failed'); assert.equal(c.errorCode, 'switch_off');
  assert.equal(control.calls.length, 1, 'the second never reached the engine');
});

test('execution-time re-check: an approved phone run still runs after the kind is off; a removed project fails project_not_registered', async () => {
  await reset();
  control.gate = new Promise(() => {});
  const hold = (await call('POST', '/bus/commands', cmd({ args: { focus: 'code', projectId: 'proj-2' } }))).body.command.id; // desktop run holds proj-2 lane
  await until(async () => control.calls.length === 1);
  const approved = (await call('POST', '/bus/commands', cmd({ args: { focus: 'code', projectId: 'proj-2' } }), { client: 'ios-native' })).body.command.id;
  const nonce = (await call('GET', '/bus/approvals')).body.items.find((i) => i.id === approved).nonce;
  await call('POST', `/bus/commands/${approved}/approve`, { nonce }); // approved while the kind is OFF
  const gone = (await call('POST', '/bus/commands', cmd({ args: { focus: 'doc', projectId: 'proj-2' } }))).body.command.id;
  const saved = PROJECTS['proj-2']; delete PROJECTS['proj-2'];
  try {
    control.gate = null;
    await call('POST', `/bus/commands/${hold}/cancel`, {});
    await until(async () => ['succeeded', 'failed'].includes((await call('GET', `/bus/commands/${gone}`)).body.command.state));
    const g = (await call('GET', `/bus/commands/${gone}`)).body.command;
    assert.equal(g.errorCode, 'project_not_registered');
  } finally { PROJECTS['proj-2'] = saved; }
  const a = (await call('GET', `/bus/commands/${approved}`)).body.command;
  assert.ok(['failed', 'succeeded'].includes(a.state));
});

test('an engine failure surfaces only its fixed code; no message, path or output leaks into the event', async () => {
  await reset();
  control.failWith = 'engine_not_logged_in';
  const id = (await call('POST', '/bus/commands', cmd())).body.command.id;
  await until(async () => (await call('GET', `/bus/commands/${id}`)).body.command.state === 'failed');
  const ev = await sse(`/bus/commands/${id}/events`);
  const last = ev.events.at(-1);
  assert.deepEqual([last.type, last.payload.code], ['error', 'engine_not_logged_in']);
  assert.equal(checkSequence(ev.events), null);
  control.failWith = 'something_unexpected';
  const id2 = (await call('POST', '/bus/commands', cmd())).body.command.id;
  await until(async () => (await call('GET', `/bus/commands/${id2}`)).body.command.state === 'failed');
  assert.equal((await call('GET', `/bus/commands/${id2}`)).body.command.errorCode, 'engine_failed');
});

test('results and events are redacted and bounded', async () => {
  await reset();
  control.text = `token sk-ant-api03-${'A'.repeat(40)} and ${'x'.repeat(400_000)}`;
  const id = (await call('POST', '/bus/commands', cmd())).body.command.id;
  await until(async () => (await call('GET', `/bus/commands/${id}`)).body.command.state === 'succeeded');
  control.text = 'Finding: none\nNo findings.';
  const c = (await call('GET', `/bus/commands/${id}`)).body.command;
  assert.equal(c.result.text.includes('sk-ant-api03'), false, 'secret redacted');
  assert.equal(c.result.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(c.result)) <= REGISTRY.limits.maxResultBytes);
  const ev = await sse(`/bus/commands/${id}/events`);
  assert.equal(JSON.stringify(ev.events).includes('sk-ant-api03'), false);
  for (const e of ev.events) assert.ok(Buffer.byteLength(JSON.stringify(e.payload)) <= REGISTRY.limits.maxEventPayloadBytes + 64);
  assert.equal(checkSequence(ev.events), null);
});

test('event log bounds: at the row cap one events_truncated marker is written, seq stays gap-free, the terminal event is always accepted', async () => {
  await reset();
  const r = bus.receive(A, cmd({ idem: `cap-${Date.now()}` }), { client: 'ios-native' }); // waits for approval: no job runs
  const id = r.command.id;
  for (let i = 0; i < store.BUS_LIMITS.maxEventsPerCommand + 50; i += 1) store.appendEvent(A, id, { type: 'progress', payload: { step: `s${i}` } });
  const n = main.getDb().prepare('SELECT COUNT(*) AS n FROM job_events WHERE job_id = ?').get(id).n;
  assert.ok(n <= store.BUS_LIMITS.maxEventsPerCommand - 1, `rows ${n}`);
  assert.ok(store.appendEvent(A, id, { type: 'error', terminal: true, payload: { code: 'internal', message: 'x' } }), 'terminal always accepted');
  assert.equal(store.appendEvent(A, id, { type: 'progress', payload: { step: 'late' } }), null, 'nothing after the terminal event');
  assert.equal(store.appendEvent(A, id, { type: 'error', terminal: true, payload: { code: 'internal', message: 'again' } }), null, 'one terminal only');
  const events = store.listEvents(A, id, 0, 1000);
  const all = []; let after = 0;
  for (;;) { const b = store.listEvents(A, id, after, 1000); if (!b.length) break; all.push(...b); after = b.at(-1).seq; }
  assert.equal(checkSequence(all), null);
  assert.equal(all.filter((e) => e.payload.step === 'events_truncated').length, 1);
  assert.ok(events.length > 0);
  assert.equal(store.appendEvent(B, id, { type: 'progress', payload: { step: 'x' } }), null, 'another user cannot append');
});

test('an oversize event payload is shortened to fit, keeping its shape', () => {
  const big = store.fitPayload('chunk', { text: 'y'.repeat(100_000) });
  assert.ok(Buffer.byteLength(JSON.stringify(big)) <= store.BUS_LIMITS.maxEventPayloadBytes);
  assert.equal(typeof big.text, 'string');
  assert.deepEqual(store.fitPayload('ended', { state: 'succeeded', result: { text: 'z'.repeat(100_000) } }), { state: 'succeeded', result: { truncated: true } });
  assert.equal(store.redactValue({ apiKey: 'abc', nested: { token: 'x', ok: 'fine' } }).apiKey, '[redacted]');
});

test('T2 approval requires the exact ids to be confirmed (pure check)', () => {
  assert.equal(confirmMatches({ projectId: 'p', issueIds: ['2', '1'], ship: true }, { projectId: 'p', issueIds: ['1', '2'], ship: true }), true);
  assert.equal(confirmMatches({ projectId: 'p', issueIds: ['1'] }, { projectId: 'p', issueIds: ['1', '9'] }), false);
  assert.equal(confirmMatches({ projectId: 'p', issueIds: ['1'], ship: true }, { projectId: 'p', issueIds: ['1'] }), false);
  assert.equal(confirmMatches({ projectId: 'p', issueIds: ['1'] }, undefined), false);
});

test('account delete removes the user\'s commands, events and flags', async () => {
  await reset();
  const victim = mk('bus-victim@example.test');
  await call('PUT', '/bus/kinds/review', { enabled: true }, { user: victim });
  const id = (await call('POST', '/bus/commands', cmd(), { user: victim, client: 'ios-native' })).body.command.id;
  assert.ok(store.getCommand(victim, id));
  main.getDb().prepare('DELETE FROM users WHERE id = ?').run(victim);
  for (const t of ['bus_commands', 'job_events', 'bus_kind_flags', 'jobs']) {
    assert.equal(main.getDb().prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).get(victim).n, 0, t);
  }
});

// ---- engines ----

const writeStub = (name, body) => { const f = path.join(STUBS, name); fs.writeFileSync(f, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 }); return f; };
const MODE = path.join(STUBS, 'mode');
const SEEN = path.join(STUBS, 'seen.json');
const stubBody = `
const fs = require('fs');
const mode = fs.existsSync(${JSON.stringify(MODE)}) ? fs.readFileSync(${JSON.stringify(MODE)}, 'utf8').trim() : 'ok';
fs.writeFileSync(${JSON.stringify(SEEN)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), env: Object.keys(process.env), key: process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY || null }));
if (mode === 'login') { console.error('Error: not logged in. Run login first.'); process.exit(1); }
if (mode === 'write') fs.writeFileSync(require('path').join(process.cwd(), 'a.txt'), 'tampered\\n');
if (mode === 'fail') { console.error('boom'); process.exit(2); }
console.log('Review output from stub. token sk-ant-api03-' + 'B'.repeat(40));
`;
process.env.LLMIDE_OPENAI_CLI = writeStub('codex-stub', stubBody);
process.env.LLMIDE_GOOGLE_CLI = writeStub('gemini-stub', stubBody);
const setMode = (m) => fs.writeFileSync(MODE, m);
const seen = () => JSON.parse(fs.readFileSync(SEEN, 'utf8'));
const seen_reset = () => fs.rmSync(SEEN, { force: true });
const { runGrouped } = await import('../core/process-group.mjs');
const spawnGrouped = (cmd, args, opts) => runGrouped(cmd, args, { ...opts, graceMs: 50 });

test('codex CLI engine: read-only sandbox flags, never --yolo, scrubbed env, redacted output', async () => {
  setMode('ok');
  git(['checkout', '-q', '--', '.'], REPO);
  const r = await engines.runTask({ userId: A, engine: { provider: 'openai', model: 'gpt-5-codex' }, prompt: 'review it', cwd: REPO, mode: 'read', spawn: spawnGrouped, deps: { allowUnsandboxedCli: true } });
  const s = seen();
  assert.deepEqual(s.args.slice(0, 1), ['exec']);
  assert.ok(s.args.includes('-s') && s.args[s.args.indexOf('-s') + 1] === 'read-only');
  assert.ok(!s.args.some((a) => /yolo|dangerously/.test(a)), 'no --yolo');
  assert.ok(s.args.includes('-C') && s.args.includes('-m'));
  assert.equal(fs.realpathSync(s.cwd), REPO);
  for (const k of ['LLMIDE_JWT_SECRET', 'LLMIDE_VAULT_KEY', 'LLMIDE_BUS_TRUST_CLIENT_HEADER', 'LLMIDE_DB_PATH', 'ANTHROPIC_API_KEY']) assert.ok(!s.env.includes(k), `${k} must not reach the CLI`);
  assert.equal(s.key, null, 'login path passes no key');
  assert.equal(r.engine, 'codex');
  assert.equal(r.text.includes('sk-ant-api03'), false);
});

test('gemini CLI engine: no --yolo, prompt as one --prompt= token, model validated', async () => {
  setMode('ok');
  const r = await engines.runTask({ userId: A, engine: { provider: 'google', model: '--yolo' }, prompt: 'review it', cwd: REPO, mode: 'read', spawn: spawnGrouped, deps: { allowUnsandboxedCli: true } });
  const s = seen();
  assert.ok(s.args.some((a) => a.startsWith('--prompt=')));
  assert.ok(!s.args.some((a) => /yolo|dangerously/.test(a)), 'a flag-shaped model id is dropped, never forwarded');
  assert.equal(r.engine, 'gemini');
});

test('API-key path: a CLI child NEVER gets a key in its env; the api-key credential is refused for CLI engines', async () => {
  setMode('ok');
  const deps = { allowUnsandboxedCli: true, providerApiKey: (u, p) => (p === 'openai' ? 'sk-test-key-for-openai-1234567890' : null) };
  seen_reset();
  await assert.rejects(engines.runTask({ userId: A, engine: { provider: 'openai', credential: 'api-key' }, prompt: 'p', cwd: REPO, spawn: spawnGrouped, deps }), { code: 'kind_not_available' });
  assert.equal(fs.existsSync(SEEN), false, 'the CLI was never started');
  await engines.runTask({ userId: A, engine: { provider: 'openai', credential: 'cli-login' }, prompt: 'p', cwd: REPO, spawn: spawnGrouped, deps });
  assert.equal(seen().key, null);
  assert.ok(!seen().env.includes('OPENAI_API_KEY') && !seen().env.includes('GEMINI_API_KEY'));
  await assert.rejects(engines.runTask({ userId: A, engine: { provider: 'google', credential: 'api-key' }, prompt: 'p', cwd: REPO, spawn: spawnGrouped, deps }), { code: 'kind_not_available' });
});

test('CLI engine: a logged-out CLI is engine_not_logged_in; a failing one is engine_failed; a missing binary is typed', async () => {
  setMode('login');
  await assert.rejects(engines.runTask({ userId: A, engine: { provider: 'openai' }, prompt: 'p', cwd: REPO, spawn: spawnGrouped, deps: { allowUnsandboxedCli: true } }), { code: 'engine_not_logged_in' });
  await assert.rejects(engines.runTask({ userId: A, engine: { provider: 'openai', credential: 'api-key' }, prompt: 'p', cwd: REPO, spawn: spawnGrouped, deps: { allowUnsandboxedCli: true,  providerApiKey: () => 'k' } }), { code: 'kind_not_available' });
  setMode('fail');
  await assert.rejects(engines.runTask({ userId: A, engine: { provider: 'openai' }, prompt: 'p', cwd: REPO, spawn: spawnGrouped, deps: { allowUnsandboxedCli: true } }), { code: 'engine_failed' });
  const keep = process.env.LLMIDE_OPENAI_CLI;
  process.env.LLMIDE_OPENAI_CLI = path.join(STUBS, 'does-not-exist');
  try { await assert.rejects(engines.runTask({ userId: A, engine: { provider: 'openai' }, prompt: 'p', cwd: REPO, spawn: spawnGrouped, deps: { allowUnsandboxedCli: true } }), { code: 'engine_not_logged_in' }); }
  finally { process.env.LLMIDE_OPENAI_CLI = keep; }
});

test('a CLI that changes the working tree fails the read-only task (read_only_violated)', async () => {
  setMode('write');
  try {
    await assert.rejects(engines.runTask({ userId: A, engine: { provider: 'google' }, prompt: 'p', cwd: REPO, spawn: spawnGrouped, deps: { allowUnsandboxedCli: true } }), { code: 'read_only_violated' });
  } finally { git(['checkout', '-q', '--', '.'], REPO); setMode('ok'); }
});

test('write mode is refused by every engine, and an unsafe flag from a builder is refused before spawn', async () => {
  for (const provider of ['anthropic', 'openai', 'google', 'custom:cat-x']) {
    await assert.rejects(engines.runTask({ userId: A, engine: { provider }, prompt: 'p', cwd: REPO, mode: 'write', spawn: spawnGrouped, deps: { allowUnsandboxedCli: true } }), { code: 'kind_not_available' }, provider);
  }
  await assert.rejects(engines.runTask({ userId: A, engine: { provider: 'openai' }, prompt: 'p', cwd: REPO, spawn: spawnGrouped, deps: { allowUnsandboxedCli: true,  cliInvocation: () => ({ bin: 'x', args: ['exec', '--yolo', 'p'] }) } }), { code: 'engine_failed' });
  await assert.rejects(engines.runTask({ userId: A, engine: { provider: 'nonsense' }, prompt: 'p', cwd: REPO, deps: { allowUnsandboxedCli: true } }), { code: 'invalid_args' });
  assert.equal(engines.engineIdFor('anthropic'), 'claude');
  assert.equal(engines.engineIdFor('custom:cat-1'), 'adapter');
});

test('claude engine: runs the confined agent READ-ONLY on a validated root; a changed path or missing key is typed', async () => {
  let seenArgs = null;
  const claudeEngine = {
    validateLoopRepoRoot: (u, root) => (root === REPO ? { ok: true, root } : { ok: false }),
    runLoopAgent: async (a) => { seenArgs = a; return { reply: 'ok reply', changedPaths: [], createdPaths: [], usage: { inputTokens: 5 }, resultSubtype: 'success' }; },
  };
  const r = await engines.runTask({ userId: A, engine: { provider: 'anthropic', model: 'sonnet' }, prompt: 'p', cwd: REPO, deps: { claudeEngine } });
  assert.equal(seenArgs.readOnly, true); assert.equal(seenArgs.root, REPO); assert.deepEqual(seenArgs.skills, []);
  assert.equal(r.text, 'ok reply'); assert.equal(r.engine, 'claude');
  await assert.rejects(engines.runTask({ userId: A, engine: { provider: 'anthropic' }, prompt: 'p', cwd: '/elsewhere', deps: { claudeEngine } }), { code: 'project_not_allowed' });
  const wrote = { ...claudeEngine, runLoopAgent: async () => ({ reply: 'x', changedPaths: ['a.txt'], createdPaths: [] }) };
  await assert.rejects(engines.runTask({ userId: A, engine: { provider: 'anthropic' }, prompt: 'p', cwd: REPO, deps: { claudeEngine: wrote } }), { code: 'read_only_violated' });
  const nokey = { ...claudeEngine, runLoopAgent: async () => { throw Object.assign(new Error('x'), { code: 'NO_KEY' }); } };
  await assert.rejects(engines.runTask({ userId: A, engine: { provider: 'anthropic' }, prompt: 'p', cwd: REPO, deps: { claudeEngine: nokey } }), { code: 'engine_no_key' });
  await assert.rejects(engines.runTask({ userId: A, engine: { provider: 'anthropic', credential: 'api-key' }, prompt: 'p', cwd: REPO, deps: { claudeEngine, providerApiKey: () => null } }), { code: 'engine_no_key' });
});

test('adapter engine: text only through the provider adapter; a refused connection is typed', async () => {
  let got = null;
  const completeViaAdapter = async (provider, o) => { got = { provider, ...o }; return 'adapter reply'; };
  const r = await engines.runTask({ userId: A, engine: { provider: 'custom:cat-acme', model: 'm1' }, prompt: 'p', cwd: REPO, deps: { completeViaAdapter } });
  assert.equal(r.text, 'adapter reply'); assert.equal(got.provider, 'custom:cat-acme'); assert.equal(got.userId, A);
  await assert.rejects(engines.runTask({ userId: A, engine: { provider: 'custom:cat-acme' }, prompt: 'p', cwd: REPO, deps: { completeViaAdapter: async () => { throw Object.assign(new Error('nope'), { code: 'PROVIDER_UNAVAILABLE' }); } } }), { code: 'engine_no_key' });
});

test('review end to end with a stub codex: whole path through the bus, process group, redaction, terminal event', async () => {
  await reset();
  setMode('ok');
  const real = createBus({ graceMs: 50, deps: { resolveProjectRoot: () => REPO, projectAllowed: () => true, engineDeps: { allowUnsandboxedCli: true } } });
  busRef = real; real.start();
  try {
    const r = await call('POST', '/bus/commands', cmd({ args: { focus: 'code', projectId: 'proj-1', engine: { provider: 'openai', model: 'gpt-5-codex', credential: 'cli-login' } } }));
    assert.equal(r.status, 202, r.text);
    await until(async () => ['succeeded', 'failed'].includes((await call('GET', `/bus/commands/${r.body.command.id}`)).body.command.state), 8000);
    const c = (await call('GET', `/bus/commands/${r.body.command.id}`)).body.command;
    assert.equal(c.state, 'succeeded', JSON.stringify(c));
    assert.equal(c.result.engine, 'codex');
    assert.match(c.result.text, /Review output from stub/);
    assert.equal(c.result.text.includes('sk-ant-api03'), false);
    assert.ok(seen().args.join(' ').includes('read-only'));
    const ev = await sse(`/bus/commands/${r.body.command.id}/events`);
    assert.equal(checkSequence(ev.events), null);
    assert.ok(ev.events.some((e) => e.type === 'chunk'));
    // A CLI that tampers with the tree: the command fails read_only_violated.
    setMode('write');
    const r2 = await call('POST', '/bus/commands', cmd({ args: { focus: 'doc', projectId: 'proj-1', engine: { provider: 'google' } } }));
    await until(async () => ['succeeded', 'failed'].includes((await call('GET', `/bus/commands/${r2.body.command.id}`)).body.command.state), 8000);
    assert.equal((await call('GET', `/bus/commands/${r2.body.command.id}`)).body.command.errorCode, 'read_only_violated');
  } finally { git(['checkout', '-q', '--', '.'], REPO); setMode('ok'); await real.stop(); busRef = bus; bus.start(); }
});

test('review conflicts focus: git answers first; a clean tree makes no model call', async () => {
  let called = 0;
  const emitted = [];
  const r = await runReview({
    userId: A, args: { focus: 'conflicts', projectId: 'p' }, cwd: REPO, signal: new AbortController().signal, spawn: spawnGrouped,
    emit: (t, p) => emitted.push([t, p]), deps: { claudeEngine: { validateLoopRepoRoot: () => ({ ok: true, root: REPO }), runLoopAgent: async () => { called += 1; return { reply: 'x', changedPaths: [] }; } } },
  });
  assert.equal(called, 0);
  assert.equal(r.engine, 'none'); assert.match(r.text, /No findings/);
});

test('review with the adapter engine gets bounded, redacted git evidence in its prompt', async () => {
  let prompt = '';
  fs.writeFileSync(path.join(REPO, 'a.txt'), 'two\n'); git(['commit', '-qam', 'second'], REPO);
  fs.writeFileSync(path.join(REPO, 'a.txt'), 'three sk-ant-api03-' + 'C'.repeat(40) + '\n'); git(['commit', '-qam', 'third'], REPO);
  await runReview({
    userId: A, args: { focus: 'code', projectId: 'p', engine: { provider: 'custom:cat-x' } }, cwd: REPO, signal: new AbortController().signal, spawn: spawnGrouped,
    emit: () => {}, deps: { completeViaAdapter: async (p, o) => { prompt = o.prompt; return 'r'; } },
  });
  assert.match(prompt, /READ-ONLY/);
  assert.match(prompt, /<evidence>/);
  assert.match(prompt, /third/);
  assert.equal(prompt.includes('sk-ant-api03'), false, 'evidence is redacted');
});

// ---- M1: codex and gemini are not sandboxed, so they are unavailable for the bus ----

test('M1: codex and gemini are refused by runTask (kind_not_available) without spawning anything', async () => {
  setMode('ok');
  seen_reset();
  for (const provider of ['openai', 'google']) {
    await assert.rejects(engines.runTask({ userId: A, engine: { provider }, prompt: 'p', cwd: REPO, spawn: spawnGrouped }), { code: 'kind_not_available' }, provider);
  }
  assert.equal(fs.existsSync(SEEN), false, 'no CLI was started');
  assert.deepEqual(engines.engineStatus('codex'), { id: 'codex', available: false, reason: 'ENGINE_NOT_SANDBOXED' });
  assert.deepEqual(engines.engineStatus('gemini'), { id: 'gemini', available: false, reason: 'ENGINE_NOT_SANDBOXED' });
  assert.deepEqual(engines.engineStatus('claude'), { id: 'claude', available: true });
  assert.deepEqual(engines.engineStatus('adapter'), { id: 'adapter', available: true });
});

test('M1: POST /bus/commands with a codex or gemini review is refused 501 ENGINE_NOT_SANDBOXED and queues nothing', async () => {
  await reset();
  seen_reset();
  for (const provider of ['openai', 'google']) {
    const r = await call('POST', '/bus/commands', cmd({ args: { focus: 'code', projectId: 'proj-1', engine: { provider } } }));
    assert.equal(r.status, 501, r.text);
    assert.equal(r.body.error.code, 'ENGINE_NOT_SANDBOXED');
    assert.equal(r.body.error.details.reason, 'ENGINE_NOT_SANDBOXED');
  }
  assert.equal((await call('GET', '/bus/commands')).body.items.length, 0);
  assert.equal(fs.existsSync(SEEN), false);
  // claude and the adapter are accepted
  for (const provider of ['anthropic', 'custom:cat-x']) {
    const r = await call('POST', '/bus/commands', cmd({ args: { focus: 'code', projectId: 'proj-1', engine: { provider } } }));
    assert.equal(r.status, 202, `${provider}: ${r.text}`);
  }
});

test('M1: GET /bus/kinds lists only usable engines and reports the others as available:false with a reason', async () => {
  const r = await call('GET', '/bus/kinds');
  const review = r.body.kinds.find((k) => k.kind === 'review');
  assert.deepEqual(review.engines, ['claude', 'adapter']);
  assert.deepEqual(review.engineStatus, [
    { id: 'claude', available: true }, { id: 'adapter', available: true },
    { id: 'codex', available: false, reason: 'ENGINE_NOT_SANDBOXED' }, { id: 'gemini', available: false, reason: 'ENGINE_NOT_SANDBOXED' },
  ]);
  for (const k of r.body.kinds.filter((x) => !x.available)) assert.deepEqual(k.engineStatus, []);
});

// ---- M5: a lane stuck after finishJobSystem throws, and one user filling every slot ----

test('M5: a running job the runner no longer tracks is marked interrupted by the sweep, its terminal event written and its lane freed', async () => {
  await reset();
  const lone = newBus({}); // not started: the runner never pumps, so the test plays the lost-settle by hand
  const r1 = lone.receive(A, cmd(), { client: 'desktop-ui' });
  const claimed = q.claimNextJobSystem();
  assert.equal(claimed.id, r1.command.id);
  assert.equal(q.getJob(A, claimed.id).state, 'running');
  assert.equal(lone.runner.activeIds().includes(claimed.id), false, 'the runner holds no such job');
  // a second command on the same lane cannot start while the orphan holds it
  const r2 = lone.receive(A, cmd(), { client: 'desktop-ui' });
  assert.equal(q.claimNextJobSystem(), null, 'the lane is stuck');
  // the sweep only reaps rows older than its stale window: a fresh row is left alone
  lone.sweep();
  assert.equal(q.getJob(A, claimed.id).state, 'running', 'inside the stale window');
  const reaper = newBus({}); // same DB; sweepStaleMs 0 reaps at once
  const swept = reaper.sweepOrphans({ staleMs: 0 });
  assert.deepEqual(swept.map((x) => x.id), [claimed.id]);
  assert.equal(q.getJob(A, claimed.id).state, 'interrupted');
  const term = store.terminalEvent(A, claimed.id);
  assert.equal(term.payload.code, 'interrupted');
  assert.equal(store.getCommand(A, claimed.id).state, 'interrupted');
  assert.equal(q.claimNextJobSystem().id, r2.command.id, 'the lane is free again');
  await lone.stop();
});

test('M5: the minute sweep itself reaps orphans (sweepStaleMs option) and releases the lane', async () => {
  await reset();
  const b = createBus({ graceMs: 50, sweepStaleMs: 0, deps: { resolveProjectRoot: () => REPO, projectAllowed: () => true, runReview: fakeReview } });
  const c1 = b.receive(A, cmd(), { client: 'desktop-ui' });
  assert.equal(q.claimNextJobSystem().id, c1.command.id);
  b.sweep();
  assert.equal(q.getJob(A, c1.command.id).state, 'interrupted');
  assert.equal(store.hasTerminal(A, c1.command.id), true);
});

test('M5: one user cannot occupy every slot: the per-user concurrent limit leaves room for another user', async () => {
  await reset();
  Object.assign(PROJECTS, { 'proj-3': REPO, 'proj-4': REPO, 'proj-5': REPO });
  let release;
  control.gate = new Promise((r) => { release = r; });
  const b = newBus({});
  busRef = b; b.start();
  try {
    for (const p of ['proj-1', 'proj-2', 'proj-3', 'proj-4']) assert.equal((await call('POST', '/bus/commands', cmd({ args: { focus: 'code', projectId: p } }))).status, 202);
    await until(() => b.runner.activeCount() >= 2);
    await sleep(150);
    const runningOf = (u) => main.getDb().prepare("SELECT COUNT(*) AS n FROM jobs WHERE user_id = ? AND state = 'running'").get(u).n;
    assert.equal(runningOf(A), 2, 'A is capped below the total slots');
    assert.ok(b.runner.activeCount() < 3, 'one slot is held back for others');
    assert.equal((await call('POST', '/bus/commands', cmd({ args: { focus: 'code', projectId: 'proj-5' } }), { user: B })).status, 202);
    await until(() => runningOf(B) === 1);
    assert.equal(runningOf(A), 2);
    assert.equal(b.runner.activeCount(), 3);
  } finally {
    release();
    await sleep(100);
    control.gate = null;
    await b.stop();
    busRef = bus; bus.start();
  }
});

// ---- L1: size caps are in BYTES, not UTF-16 units ----

test('L1: capResult keeps the serialized result under maxResultBytes for multibyte and escape-heavy text', async () => {
  const { capResult } = await import('../routes/bus/executor.mjs');
  const max = REGISTRY.limits.maxResultBytes;
  for (const ch of ['日', '😀', '"', '\n', 'a']) {
    const r = capResult({ focus: 'code', engine: 'x', text: ch.repeat(max), truncated: false });
    const bytes = Buffer.byteLength(JSON.stringify(r), 'utf8');
    assert.ok(bytes <= max, `${JSON.stringify(ch)}: ${bytes} > ${max}`);
    assert.equal(r.truncated, true);
    assert.ok(!r.text.includes('�'), 'no split character');
  }
  const small = capResult({ text: '日本語', truncated: false });
  assert.equal(small.text, '日本語');
  assert.notEqual(small.truncated, true);
});

test('L1: engine text is capped at MAX_ENGINE_TEXT BYTES (100k three-byte characters are 300 KB)', async () => {
  const text = '日'.repeat(100_000); // 100000 chars < 262144 chars, but 300000 bytes
  const r = await engines.runTask({ userId: A, engine: { provider: 'custom:cat-x' }, prompt: 'p', cwd: REPO, deps: { completeViaAdapter: async () => text } });
  assert.ok(Buffer.byteLength(r.text, 'utf8') <= engines.MAX_ENGINE_TEXT);
  assert.equal(r.truncated, true);
  assert.ok(!r.text.includes('�'));
});

test('L1: chunk events carry the whole text in valid UTF-8 pieces', async () => {
  await reset();
  control.text = '日本語です。'.repeat(9000); // ~162 KB of multibyte text
  try {
    const r = await call('POST', '/bus/commands', cmd());
    const id = r.body.command.id;
    await until(async () => (await call('GET', `/bus/commands/${id}`)).body.command.state === 'succeeded');
    const ev = await sse(`/bus/commands/${id}/events`);
    const got = ev.events.filter((e) => e.type === 'chunk').map((e) => e.payload.text).join('');
    const result = (await call('GET', `/bus/commands/${id}`)).body.command.result.text;
    assert.equal(got, result, 'the chunks add up to the result text');
    for (const e of ev.events.filter((x) => x.type === 'chunk')) assert.ok(Buffer.byteLength(JSON.stringify(e.payload), 'utf8') <= 16 * 1024);
  } finally { control.text = 'Finding: none\nNo findings.'; }
});

// ---- L2, L3: store queries ----

const insertCmd = (userId, i, { state, createdAt, kind = 'review' }) => main.getDb().prepare(
  `INSERT INTO bus_commands (id, user_id, kind, tier, idem, args_hash, args_json, origin_client, state, ttl_at, created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
).run(`seed-${i}-${state}-${createdAt.slice(0, 4)}`.padEnd(12, 'x'), userId, kind, 'T0', `seed-idem-${i}-${state}`, 'h', '{}', 'desktop-ui', state, '2099-01-01T00:00:00.000Z', createdAt);

test('L3: listCommands filters by state BEFORE the limit (an old match is found behind newer rows of other states)', async () => {
  await reset();
  insertCmd(A, 0, { state: 'expired', createdAt: '2020-01-01T00:00:00.000Z' });
  for (let i = 1; i <= 650; i++) insertCmd(A, i, { state: 'denied', createdAt: new Date(Date.UTC(2024, 0, 1) + i * 1000).toISOString() });
  const exp = store.listCommands(A, { state: 'expired', limit: 5 });
  assert.equal(exp.length, 1, 'the old expired row is found');
  assert.equal(exp[0].state, 'expired');
  const denied = store.listCommands(A, { state: 'denied', limit: 200 });
  assert.equal(denied.length, 200);
  assert.ok(denied[0].createdAt > denied[199].createdAt, 'newest first');
  assert.equal(store.listCommands(A, { limit: 7 }).length, 7);
  assert.equal(store.listCommands(B, { state: 'expired' }).length, 0, 'per user');
});

test('L3: job-derived states filter in SQL too (queued, running, succeeded, cancelled)', async () => {
  await reset();
  const b = newBus({});
  const c1 = b.receive(A, cmd(), { client: 'desktop-ui' }); // queued
  const c2 = b.receive(A, cmd({ args: { focus: 'doc', projectId: 'proj-2' } }), { client: 'desktop-ui' });
  q.claimNextJobSystem(); // c1 -> running
  q.finishJobSystem(c1.command.id, 'succeeded', { result: {} });
  q.claimNextJobSystem(); // c2 -> running
  q.requestCancel(A, c2.command.id);
  q.finishJobSystem(c2.command.id, 'cancelled', { error: 'cancelled' });
  b.receive(A, cmd({ args: { focus: 'conflicts', projectId: 'proj-1' } }), { client: 'desktop-ui' }); // queued
  assert.deepEqual(store.listCommands(A, { state: 'succeeded' }).map((c) => c.id), [c1.command.id]);
  assert.deepEqual(store.listCommands(A, { state: 'cancelled' }).map((c) => c.id), [c2.command.id]);
  assert.equal(store.listCommands(A, { state: 'queued' }).length, 1);
  assert.equal(store.listCommands(A, { state: 'running' }).length, 0);
  assert.equal(store.listCommands(A, {}).length, 3);
});

test('L2: cancelled-while-waiting commands are purged after the retention window like every other finished command', async () => {
  await reset();
  const old = new Date(Date.now() - 9 * 86400_000).toISOString();
  insertCmd(A, 1, { state: 'cancelled', createdAt: old });
  insertCmd(A, 2, { state: 'cancelled', createdAt: new Date().toISOString() });
  insertCmd(A, 3, { state: 'awaiting_approval', createdAt: old });
  const db = main.getDb();
  const oldId = db.prepare("SELECT id FROM bus_commands WHERE idem = 'seed-idem-1-cancelled'").get().id;
  db.prepare("INSERT INTO job_events (job_id, seq, user_id, type, payload_json, terminal, bytes, at) VALUES (?,?,?,?,?,?,?,?)").run(oldId, 1, A, 'ended', '{}', 1, 2, 1);
  assert.equal(store.purgeOldCommandsSystem(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM bus_commands WHERE idem = 'seed-idem-1-cancelled'").get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM job_events WHERE job_id = ?').get(oldId).n, 0, 'its events go too');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM bus_commands WHERE idem IN ('seed-idem-2-cancelled','seed-idem-3-awaiting_approval')").get().n, 2, 'recent and still-pending rows stay');
});

// ---- L4: audit rows for approve / deny / cancel / PUT kinds ----

const busAudit = (action) => main.getDb().prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action);

test('L4: approve, deny, cancel and PUT /bus/kinds write audit rows (who, what, outcome) and never a nonce', async () => {
  await reset();
  main.getDb().prepare('DELETE FROM audit_log').run();
  await call('PUT', '/bus/kinds/review', { enabled: true });
  const put = busAudit('bus.kind_set');
  assert.equal(put.length, 1);
  assert.equal(put[0].resource, 'review'); assert.equal(put[0].outcome, 'success');
  assert.deepEqual(JSON.parse(put[0].detail), { kind: 'review', enabled: true, client: 'desktop-ui' });
  await call('PUT', '/bus/kinds/review', { enabled: false });
  const phone = async () => (await call('POST', '/bus/commands', cmd(), { client: 'ios-native' })).body.command.id;
  const id1 = await phone();
  const nonce = (await call('GET', '/bus/approvals')).body.items.find((i) => i.id === id1).nonce;
  // a wrong nonce is audited as denied and the supplied value is not recorded
  await call('POST', `/bus/commands/${id1}/approve`, { nonce: 'a'.repeat(64) });
  assert.equal((await call('POST', `/bus/commands/${id1}/approve`, { nonce })).status, 200);
  const ap = busAudit('bus.approve');
  assert.deepEqual(ap.map((r) => r.outcome), ['denied', 'success']);
  assert.equal(ap[1].resource, id1);
  assert.equal(JSON.parse(ap[1].detail).kind, 'review');
  assert.equal(JSON.parse(ap[1].detail).client, 'desktop-ui');
  assert.equal(JSON.parse(ap[0].detail).reason, 'APPROVAL_NONCE_INVALID');
  // an approve attempted by a phone is audited too
  await call('POST', `/bus/commands/${id1}/approve`, { nonce }, { client: 'ios-native' });
  assert.equal(busAudit('bus.approve').at(-1).outcome, 'denied');
  const id2 = await phone();
  assert.equal((await call('POST', `/bus/commands/${id2}/deny`, {})).status, 200);
  assert.equal(busAudit('bus.deny').at(-1).resource, id2);
  const id3 = await phone();
  assert.equal((await call('POST', `/bus/commands/${id3}/cancel`, {})).status, 200);
  const ca = busAudit('bus.cancel');
  assert.equal(ca.at(-1).resource, id3); assert.equal(ca.at(-1).outcome, 'success');
  const all = JSON.stringify(main.getDb().prepare("SELECT * FROM audit_log WHERE action LIKE 'bus.%'").all());
  assert.ok(!all.includes(nonce), 'the approval nonce is never in an audit row');
  assert.ok(!all.includes('a'.repeat(64)), 'neither is a submitted wrong nonce');
});

// ---- L5: who may read which command ----

test('L5: phone-pwa and extension read only commands of their own class; ios-native and desktop-ui read all of the user\'s', async () => {
  await reset();
  const dId = (await call('POST', '/bus/commands', cmd(), { client: 'desktop-ui' })).body.command.id;
  const iId = (await call('POST', '/bus/commands', cmd(), { client: 'ios-native' })).body.command.id;
  insertCmd(A, 91, { state: 'denied', createdAt: new Date().toISOString() });
  const row = (cls) => main.getDb().prepare("UPDATE bus_commands SET origin_client = ? WHERE idem = ?").run(cls, `seed-idem-91-denied`);
  row('extension');
  const eId = main.getDb().prepare("SELECT id FROM bus_commands WHERE idem = 'seed-idem-91-denied'").get().id;
  await sleep(100);
  const ids = (r) => r.body.items.map((c) => c.id).sort();
  const all = [dId, iId, eId].sort();
  assert.deepEqual(ids(await call('GET', '/bus/commands', undefined, { client: 'desktop-ui' })), all);
  assert.deepEqual(ids(await call('GET', '/bus/commands', undefined, { client: 'ios-native' })), all);
  assert.deepEqual(ids(await call('GET', '/bus/commands', undefined, { client: 'extension' })), [eId]);
  assert.deepEqual(ids(await call('GET', '/bus/commands', undefined, { client: 'phone-pwa' })), []);
  for (const client of ['extension', 'phone-pwa']) {
    for (const id of [dId, iId]) {
      assert.equal((await call('GET', `/bus/commands/${id}`, undefined, { client })).status, 404, `${client} cannot read ${id}`);
      assert.equal((await sse(`/bus/commands/${id}/events`, { client })).status, 404, `${client} events`);
      assert.equal((await call('POST', `/bus/commands/${id}/cancel`, {}, { client })).status, 404, `${client} cancel`);
    }
  }
  assert.equal((await call('GET', `/bus/commands/${eId}`, undefined, { client: 'extension' })).status, 200, 'its own class');
  assert.equal((await call('GET', `/bus/commands/${eId}`, undefined, { client: 'phone-pwa' })).status, 404, 'a different low class');
  assert.equal((await call('GET', `/bus/commands/${dId}`, undefined, { client: 'ios-native' })).status, 200);
  assert.equal((await call('GET', `/bus/commands/${dId}`, undefined, { client: 'desktop-ui' })).status, 200);
  assert.equal((await call('GET', '/bus/commands?state=denied', undefined, { client: 'extension' })).body.items.length, 1);
});

// ---- L6: git runs in a registered repo whose own config may be hostile ----

test('L6: git run for a review ignores the repo\'s fsmonitor, textconv and external diff (no code from the repo config runs)', async () => {
  const marker = (n) => path.join(SANDBOX, `PWNED-${n}`);
  const script = (n) => { const f = path.join(SANDBOX, `evil-${n}.sh`); fs.writeFileSync(f, `#!/bin/sh\ntouch ${marker(n)}\nprintf '\\0'\n`, { mode: 0o755 }); return f; };
  const cfg = (...a) => git(['config', ...a], REPO);
  const attrs = path.join(REPO, '.gitattributes');
  try {
    cfg('core.fsmonitor', script('fsmonitor'));
    cfg('diff.evil.textconv', script('textconv'));
    cfg('diff.external', script('extdiff'));
    fs.writeFileSync(attrs, '*.txt diff=evil\n');
    fs.writeFileSync(path.join(REPO, 'a.txt'), 'changed\n'); // an uncommitted change so diff has something to convert
    // focus conflicts: `git ls-files -u` and `git diff --check`; clean tree answers from git alone (no model call)
    await runReview({ userId: A, args: { focus: 'conflicts', projectId: 'p' }, cwd: REPO, signal: new AbortController().signal, spawn: spawnGrouped, emit: () => {}, deps: { completeViaAdapter: async () => 'No findings.' } });
    // the adapter path collects git evidence ('code' focus on a custom provider) and the CLI path takes a git signature
    await runReview({ userId: A, args: { focus: 'code', projectId: 'p', engine: { provider: 'custom:cat-x' } }, cwd: REPO, signal: new AbortController().signal, spawn: spawnGrouped, emit: () => {}, deps: { completeViaAdapter: async () => 'No findings.' } });
    await engines.runTask({ userId: A, engine: { provider: 'openai' }, prompt: 'p', cwd: REPO, spawn: spawnGrouped, deps: { allowUnsandboxedCli: true } }).catch(() => null);
    for (const n of ['fsmonitor', 'textconv', 'extdiff']) assert.equal(fs.existsSync(marker(n)), false, `${n} from the repo config must not run`);
  } finally {
    for (const k of ['core.fsmonitor', 'diff.evil.textconv', 'diff.external']) { try { cfg('--unset', k); } catch { /* absent */ } }
    fs.rmSync(attrs, { force: true });
    git(['checkout', '-q', '--', '.'], REPO);
  }
});

test('L6: the review checks AND runs in the realpath (a symlink swapped in after the check is not followed)', async () => {
  await reset();
  const link = path.join(SANDBOX, 'link-to-repo');
  fs.rmSync(link, { force: true });
  fs.symlinkSync(REPO, link);
  const checked = [];
  const seenCwd = [];
  const b = createBus({ graceMs: 50, deps: {
    resolveProjectRoot: () => link,
    projectAllowed: (u, root) => { checked.push(root); return true; },
    runReview: async ({ cwd }) => { seenCwd.push(cwd); return { focus: 'code', engine: 'fake', text: 'ok', truncated: false }; },
  } });
  busRef = b; b.start();
  try {
    const r = b.receive(A, cmd(), { client: 'desktop-ui' });
    await until(() => ['succeeded', 'failed'].includes(store.getCommand(A, r.command.id).state), 5000);
    assert.equal(store.getCommand(A, r.command.id).state, 'succeeded');
    assert.deepEqual(checked, [REPO], 'the allow-check saw the resolved path');
    assert.deepEqual(seenCwd, [REPO], 'the run used that same resolved path, not the symlink');
  } finally { await b.stop(); busRef = bus; bus.start(); fs.rmSync(link, { force: true }); }
});
