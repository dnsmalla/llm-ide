// Host API v1 audit log + per-session rate limits (Plan 6 Task 8) — the Node twin of
// the retired Swift app's HostApiV1AuditRateTests.swift (same scenarios, same constants).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_host-api-audit-rate-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { getDb } = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { TokenBucket, createRateLimiter, RATE_LIMITS } = await import('../routes/host-api/rate.mjs');
const { createAuditSink, listenerRefusalAuditor, identityEventAuditor, AUDIT_EVENT_CAP_PER_MINUTE } = await import('../routes/host-api/audit.mjs');
const { upgradeRefusal } = await import('../server/host-api-listener.mjs');
const { loadOrCreateHostIdentity, resetHostIdentity } = await import('../server/host-identity.mjs');
const { createGateway, MAX_UNAUTHENTICATED_PER_PEER } = await import('../routes/host-api/gateway.mjs');

const HELLO = { clientName: 'Phone', clientVersion: '1', platform: 'web', apiVersions: [1] };
const req = (id, command, payload = {}) => JSON.stringify({ apiVersion: 1, id, type: 'request', command, payload, ts: 1 });
const PIN = '123456';
const TEXT = 'secret frame text 9f3a';

function harness({ caps = ['host', 'chat', 'approvals'] } = {}) {
  const t = { sent: [], closed: [], turns: [], audit: [], clock: 1_000_000, caps };
  const tokens = new Map();
  let n = 0;
  t.g = createGateway({
    send: (s, text) => t.sent.push([s, JSON.parse(text)]),
    close: (s) => t.closed.push(s),
    hostName: () => 'Test Computer',
    capabilities: () => t.caps,
    // ADR 0021: the paired account is this install's owner (the pre-team fixture world had no roles).
    member: () => ({ teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 }),
    log: () => {},
    now: () => t.clock,
    audit: (event, fields) => t.audit.push({ event, ...fields }),
    chatClearEnabled: () => false,
    pins: { consumePin: (pin) => (pin === PIN ? 'u1' : null) },
    devices: {
      issueDeviceToken(userId, _name, _now, scopes) { n += 1; const deviceId = `h1-dev${n}`; const token = `tok-${deviceId}-0123456789abcdef`; tokens.set(token, { userId, deviceId, scopes }); return { deviceId, token }; },
      authenticateDeviceToken: (token) => tokens.get(token) ?? null,
      revokeDevice(userId, deviceId) { for (const [k, v] of tokens) if (v.deviceId === deviceId) tokens.delete(k); return true; },
    },
    quickChat: { get: () => 'chat-1', set: () => {}, create: () => 'chat-1' },
    history: async () => [],
    append: () => {},
    turn: (args) => { t.turns.push(args); args.onEvent({ type: 'init', sessionId: 'sdk' }); args.onEvent({ type: 'result', subtype: 'success' }); return Promise.resolve(); },
    cancel: () => true,
    clear: () => ({ cleared: true }),
    decide: () => ({ ok: true }),
  });
  t.reply = (id) => t.sent.filter(([, f]) => f.replyTo === id).at(-1)?.[1];
  t.open = async (s, peer = '127.0.0.1') => { t.g.opened(s, peer); await t.g.receive(s, req('c-h', 'host.hello', HELLO)); };
  t.pair = async (s, peer) => { await t.open(s, peer); await t.g.receive(s, req('c-p', 'host.auth.pair', { pin: PIN })); return t.reply('c-p').result.token; };
  return t;
}

test('the read bucket is per device: 20 reads, then a wait', () => {
  const r = createRateLimiter();
  for (let i = 0; i < 20; i += 1) assert.equal(r.read('d1', 0), null);
  assert.ok(r.read('d1', 0) > 0);
  assert.equal(r.read('d2', 0), null);
});

test('bucket: 40 frames pass, the 41st waits 0.1 s and passes at t=0.1; 6 turns pass, the 7th waits 10 s', () => {
  assert.deepEqual({ ...RATE_LIMITS }, { frameCapacity: 40, framePerSecond: 10, turnCapacity: 6, turnPerSecond: 0.1, readCapacity: 20, readPerSecond: 2, closeAfterRefusals: 100 });
  const b = new TokenBucket(40, 10, 0);
  for (let i = 0; i < 40; i++) assert.equal(b.take(0), null);
  assert.equal(b.take(0), 100);
  assert.equal(b.take(100), null);
  const r = createRateLimiter();
  for (let i = 0; i < 6; i++) assert.equal(r.turn('d', 0), null);
  assert.equal(r.turn('d', 0), 10_000);
});

test('gateway: the 41st host.ping in one tick is rate_limited, retryable, retryAfterMs >= 100', async () => {
  const t = harness();
  const s = {};
  await t.pair(s);
  const all = [];
  for (let i = 0; i < 41; i++) all.push(t.g.receive(s, req(`p-${i}`, 'host.ping')));
  await Promise.all(all);
  // hello + pair spent 2 of the 40.
  const firstRefused = t.reply('p-38');
  assert.equal(firstRefused.error.code, 'rate_limited');
  assert.equal(t.reply('p-37').type, 'response');
  const e = t.reply('p-40').error;
  assert.equal(e.code, 'rate_limited');
  assert.equal(e.retryable, true);
  assert.ok(e.details.retryAfterMs >= 100);
});

test('a refused frame whose id cannot be read cheaply replies to null', async () => {
  const t = harness();
  const s = {};
  t.g.opened(s, '127.0.0.1');
  for (let i = 0; i < 41; i++) t.g.receive(s, 'not json');
  assert.equal(t.sent.at(-1)[1].error.code, 'rate_limited');
  assert.equal('replyTo' in t.sent.at(-1)[1], false); // replyTo: null is omitted on the wire
});

test('140 frames in one tick close the session after the 100th refusal and write rate_closed', async () => {
  const t = harness();
  const s = {};
  t.g.opened(s, '10.0.0.5');
  for (let i = 0; i < 140; i++) t.g.receive(s, req(`p-${i}`, 'host.ping'));
  assert.deepEqual(t.closed, [s]);
  const refusals = t.sent.filter(([, f]) => f.error?.code === 'rate_limited').length;
  assert.equal(refusals, 100);
  assert.deepEqual(t.audit.filter((a) => a.event === 'rate_closed').map((a) => a.peer), ['10.0.0.5']);
});

test('a 7th chat.send within 10 s on one device, even from a new session, is rate_limited; the turn ran 6 times', async () => {
  const t = harness();
  const s1 = {};
  const token = await t.pair(s1);
  for (let i = 0; i < 6; i++) { await t.g.receive(s1, req(`c-${i}`, 'chat.send', { text: TEXT })); t.clock += 1000; }
  assert.equal(t.turns.length, 6);
  const s2 = {};
  await t.open(s2);
  await t.g.receive(s2, req('c-t', 'host.auth.token', { token }));
  await t.g.receive(s2, req('c-7', 'chat.send', { text: TEXT }));
  assert.equal(t.reply('c-7').error.code, 'rate_limited');
  assert.ok(t.reply('c-7').error.details.retryAfterMs > 0);
  assert.equal(t.turns.length, 6);
});

test('audit rows: pair_failed, pair_ok, token_failed, revoke_self, scope_denied — never the PIN, token or frame text', async () => {
  const t = harness({ caps: ['host', 'chat', 'approvals'] });
  const bad = {};
  await t.open(bad, '10.0.0.9');
  await t.g.receive(bad, req('c-p', 'host.auth.pair', { pin: '000000' }));
  assert.deepEqual(t.audit.at(-1), { event: 'pair_failed', peer: '10.0.0.9' });

  const s = {};
  const token = await t.pair(s, '10.0.0.10');
  const ok = t.audit.at(-1);
  assert.equal(ok.event, 'pair_ok');
  assert.equal(ok.deviceId, 'h1-dev1');
  assert.equal(ok.userId, 'u1');
  assert.equal(ok.clientName, 'Phone');

  const s3 = {};
  await t.open(s3, '10.0.0.11');
  await t.g.receive(s3, req('c-t', 'host.auth.token', { token: 'tok-wrong-0123456789abcdef' }));
  assert.equal(t.audit.at(-1).event, 'token_failed');

  // A capability served after pairing is refused as not granted.
  t.caps = ['host', 'chat', 'approvals', 'tool_approvals'];
  await t.g.receive(s, req('c-a', 'toolApprovals.answer', { requestId: 'r', commandId: 'c', decision: 'allow_once' }));
  assert.equal(t.reply('c-a').error.code, 'denied');
  const sd = t.audit.at(-1);
  assert.deepEqual(sd, { event: 'scope_denied', peer: '10.0.0.10', userId: 'u1', deviceId: 'h1-dev1', detail: 'tool_approvals', dedupeKey: 'h1-dev1:tool_approvals' });

  await t.g.receive(s, req('c-m', 'chat.send', { text: TEXT }));
  await t.g.receive(s, req('c-r', 'host.auth.revoke', { token }));
  assert.deepEqual(t.audit.at(-1), { event: 'revoke_self', peer: '10.0.0.10', userId: 'u1', deviceId: 'h1-dev1' });

  const json = JSON.stringify(t.audit);
  for (const secret of [PIN, token, TEXT, '000000']) assert.equal(json.includes(secret), false, secret);
});

test('throttled attempts write pair_throttled / token_throttled keyed by peer', async () => {
  const t = harness();
  const s = {};
  await t.open(s, '10.0.0.20');
  await t.g.receive(s, req('c-1', 'host.auth.pair', { pin: '000000' }));
  await t.g.receive(s, req('c-2', 'host.auth.pair', { pin: '000000' }));
  assert.deepEqual(t.audit.at(-1), { event: 'pair_throttled', peer: '10.0.0.20', detail: 'wait', dedupeKey: '10.0.0.20' });
  const s2 = {};
  await t.open(s2, '10.0.0.21');
  await t.g.receive(s2, req('c-1', 'host.auth.token', { token: 'nope-0123456789abcdef' }));
  await t.g.receive(s2, req('c-2', 'host.auth.token', { token: 'nope-0123456789abcdef' }));
  assert.equal(t.audit.at(-1).event, 'token_throttled');
});

test('a wrong token does not delay pairing from the same peer (separate throttle buckets)', async () => {
  const t = harness();
  const s = {};
  await t.open(s);
  await t.g.receive(s, req('c-t', 'host.auth.token', { token: 'nope-0123456789abcdef' }));
  assert.equal(t.reply('c-t').error.code, 'auth_failed');
  await t.g.receive(s, req('c-p', 'host.auth.pair', { pin: PIN }));
  assert.equal(t.reply('c-p').type, 'response');
});

test('pre-auth: a peer may hold at most MAX_UNAUTHENTICATED_PER_PEER unauthenticated sessions; others still connect', async () => {
  assert.equal(MAX_UNAUTHENTICATED_PER_PEER, 2);
  const t = harness();
  const a = {}; const b = {}; const c = {}; const d = {};
  t.g.opened(a, '10.0.0.30');
  t.g.opened(b, '10.0.0.30');
  t.g.opened(c, '10.0.0.30');
  assert.deepEqual(t.closed, [c]);
  assert.equal(t.sent.at(-1)[1].error.code, 'busy');
  t.g.opened(d, '10.0.0.31');
  assert.deepEqual(t.closed, [c]);
  // Once one authenticates, the peer has a free unauthenticated slot again.
  await t.g.receive(a, req('c-h', 'host.hello', HELLO));
  await t.g.receive(a, req('c-p', 'host.auth.pair', { pin: PIN }));
  const e = {};
  t.g.opened(e, '10.0.0.30');
  assert.deepEqual(t.closed, [c]);
});

test('de-dup: 10 pair_throttled for one peer within 60 s are 1 row; one more at t=61 s is a second', () => {
  let clock = 0;
  const db = getDb();
  const sink = createAuditSink({ db, now: () => clock });
  for (let i = 0; i < 10; i++) { sink.record('pair_throttled', { peer: '10.1.1.1', dedupeKey: '10.1.1.1' }); clock += 1000; }
  const count = () => db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'host_api.pair_throttled'").get().n;
  assert.equal(count(), 1);
  clock = 61_000;
  sink.record('pair_throttled', { peer: '10.1.1.1', dedupeKey: '10.1.1.1' });
  assert.equal(count(), 2);
});

test('node: rows land in audit_log as host_api.<event>; pair_failed has a NULL user, pair_ok the pairing user', () => {
  const db = getDb();
  const sink = createAuditSink({ db });
  const u7 = users.registerUser(db, { email: `audit-${Date.now()}@example.com`, password: 'CorrectHorseBattery', displayName: 'a' }).id;
  sink.record('pair_failed', { peer: '10.2.2.2' });
  sink.record('pair_ok', { peer: '10.2.2.2', userId: u7, deviceId: 'h1-x', clientName: 'Phone' });
  sink.record('origin_refused', { peer: '10.2.2.2', detail: 'https://evil.example'.padEnd(400, 'x'), dedupeKey: 'https://evil.example' });
  const rows = db.prepare("SELECT user_id, ip, user_agent, action, resource, outcome, detail FROM audit_log WHERE ip = '10.2.2.2' ORDER BY id").all();
  assert.deepEqual(rows.slice(0, 2), [
    { user_id: null, ip: '10.2.2.2', user_agent: null, action: 'host_api.pair_failed', resource: null, outcome: 'failure', detail: null },
    { user_id: u7, ip: '10.2.2.2', user_agent: 'Phone', action: 'host_api.pair_ok', resource: 'h1-x', outcome: 'success', detail: null },
  ]);
  assert.equal(rows[2].outcome, 'denied');
  assert.equal(JSON.parse(rows[2].detail).reason.length, 200);
});

const countAction = (db, action) => db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?').get(action).n;

test('listener refusals: de-dup per peer (IPv6 per /64), never per origin; the mapping and detail', () => {
  let clock = 5_000_000;
  const db = getDb();
  const rows = [];
  const onRefused = listenerRefusalAuditor({ record: (event, f) => rows.push({ event, ...f }) });
  onRefused('origin_refused', '10.3.3.3', 'https://a.example');
  onRefused('plaintext_refused', '192.168.1.20', '');
  assert.deepEqual(rows, [
    { event: 'origin_refused', peer: '10.3.3.3', detail: 'https://a.example', dedupeKey: '10.3.3.3' },
    { event: 'plaintext_refused', peer: '192.168.1.20', detail: undefined, dedupeKey: '192.168.1.20' },
  ]);
  const before = countAction(db, 'host_api.origin_refused');
  const real = listenerRefusalAuditor(createAuditSink({ db, now: () => clock }));
  for (let i = 0; i < 500; i++) real('origin_refused', '10.3.3.4', `https://o${i}.example`);
  for (let i = 0; i < 50; i++) real('origin_refused', `2001:db8:1:2::${i.toString(16)}`, `https://v6-${i}.example`);
  assert.equal(countAction(db, 'host_api.origin_refused') - before, 2, 'one row for the IPv4 peer, one for the IPv6 /64');
});

test('a flood with a different Origin on each upgrade from many peers writes at most the per-event cap', () => {
  assert.equal(AUDIT_EVENT_CAP_PER_MINUTE, 60);
  let clock = 9_000_000;
  const db = getDb();
  const before = countAction(db, 'host_api.plaintext_refused');
  const onRefused = listenerRefusalAuditor(createAuditSink({ db, now: () => clock }));
  for (let i = 0; i < 5000; i++) { onRefused('plaintext_refused', `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, `https://x${i}.example`); clock += 1; }
  assert.equal(countAction(db, 'host_api.plaintext_refused') - before, AUDIT_EVENT_CAP_PER_MINUTE);
  // The next window writes one summary row of what was dropped.
  clock += 60_000;
  onRefused('plaintext_refused', '10.250.0.1', '');
  const summary = db.prepare("SELECT detail FROM audit_log WHERE action = 'host_api.plaintext_refused_suppressed'").all();
  assert.equal(summary.length, 1);
  assert.match(JSON.parse(summary[0].detail).reason, /^4940 more plaintext_refused rows dropped/);
});

test('the plaintext listener honours only loopback http origins; https entries are TLS-only', () => {
  const allowlist = ['http://127.0.0.1:5180', 'https://app.example'];
  const req = (origin) => ({ url: '/host-api/v1', socket: { remoteAddress: '127.0.0.1' }, headers: { origin } });
  assert.equal(upgradeRefusal(req('http://127.0.0.1:5180'), { tls: false, allowlist }), null);
  assert.deepEqual(upgradeRefusal(req('https://app.example'), { tls: false, allowlist }), { status: 403, event: 'origin_refused', detail: 'https://app.example' });
  assert.equal(upgradeRefusal(req('https://app.example'), { tls: true, allowlist }), null);
});

test('the identity onEvent writes identity_created through the sink', () => {
  const db = getDb();
  resetHostIdentity(db);
  loadOrCreateHostIdentity(db, { hostName: 't', onEvent: identityEventAuditor(createAuditSink({ db })) });
  const row = db.prepare("SELECT user_id, ip, outcome FROM audit_log WHERE action = 'host_api.identity_created'").get();
  assert.deepEqual(row, { user_id: null, ip: null, outcome: 'success' });
});

test('a rate refusal replies to the top-level id only, never a payload id', async () => {
  const t = harness();
  const s = {};
  t.g.opened(s, '127.0.0.1');
  for (let i = 0; i < 40; i++) t.g.receive(s, 'x');
  t.g.receive(s, JSON.stringify({ apiVersion: 1, type: 'request', command: 'host.ping', payload: { id: 'nested' }, id: 'outer' }));
  assert.equal('replyTo' in t.sent.at(-1)[1], false);
  t.g.receive(s, JSON.stringify({ apiVersion: 1, id: 'top', type: 'request', command: 'host.ping', payload: { id: 'nested' } }));
  assert.equal(t.sent.at(-1)[1].replyTo, 'top');
});
