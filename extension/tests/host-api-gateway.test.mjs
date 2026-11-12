// Host API v1 desktop gateway — scenarios ported from the retired Swift app's HostApiV1GatewayTests.swift,
// driven with injected fakes (no engine, no DB, no network).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../routes/host-api/gateway.mjs';

const flush = () => new Promise((r) => setImmediate(r));
const HELLO = { clientName: 't', clientVersion: '1', platform: 'web', apiVersions: [1] };
const req = (id, command, payload = {}) => JSON.stringify({ apiVersion: 1, id, type: 'request', command, payload, ts: 1 });

function harness({ toolApprovals = false, chatClear = false, hold = false, skipInit = () => false, history = null, fingerprint = null, read = false, reads = null, compose = false, models = null, pinUser = () => 'u1', member = () => ({ teamRole: 'owner', maxMode: 'execute' }), projectRequired = false } = {}) {
  const t = { sent: [], closed: [], turns: [], cancelled: [], decided: [], cleared: [], saved: [], toolApprovals, read, compose, readCalls: [], pending: [], audits: [], modelCalls: 0, member, skew: 0 };
  const tokens = new Map(); // token -> { userId, deviceId, scopes }
  let n = 0;
  const quick = new Map(); // projectId || '' -> current phone chat
  let made = 0;
  t.tokens = tokens;
  t.devices = {
    issueDeviceToken(userId, _name, now = Date.now(), scopes) { n += 1; const deviceId = `h1-dev${n}`; const token = `tok-${deviceId}-0123456789`; tokens.set(token, { userId, deviceId, scopes, pairedAt: now }); return { deviceId, token }; },
    authenticateDeviceToken: (token) => tokens.get(token) ?? null,
    revokeDevice(userId, deviceId) { for (const [k, v] of tokens) if (v.userId === userId && v.deviceId === deviceId) tokens.delete(k); return true; },
  };
  t.g = createGateway({
    send: (s, text) => t.sent.push([s, JSON.parse(text)]),
    close: (s) => t.closed.push(s),
    hostName: () => 'Test Computer',
    certificateFingerprint: () => fingerprint,
    capabilities: () => ['host', 'chat', 'approvals', ...(t.toolApprovals ? ['tool_approvals'] : []), ...(t.read ? ['read'] : []), ...(t.compose ? ['compose'] : [])],
    // ADR 0021 authority; the default is the install owner, so the full served list is paired.
    member: (userId) => t.member(userId),
    projectRequired: () => projectRequired,
    now: () => Date.now() + t.skew,
    log: () => {},
    chatClearEnabled: () => chatClear,
    pins: { consumePin: (pin) => (pin === '123456' ? pinUser() : null) },
    devices: t.devices,
    quickChat: {
      get: (_u, pid, surface = 'ask') => quick.get(`${surface}:${pid || ''}`) ?? null,
      set: (_u, id, pid, surface = 'ask') => { quick.set(`${surface}:${pid || ''}`, id); },
      create: () => `chat-${++made}`,
    },
    models: async () => { t.modelCalls += 1; if (models instanceof Error) throw models; return models ?? [{ id: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5' }]; },
    audit: (event, fields) => t.audits.push([event, fields]),
    history: history ?? (async () => [{ role: 'user', content: 'hi' }, { role: 'tool', content: 'x' }, { role: 'assistant', content: 'yo' }]),
    turn: (args) => {
      t.turns.push(args);
      if (!skipInit(t.turns.length - 1)) args.onEvent({ type: 'init', sessionId: 'sdk-1' });
      if (hold) return new Promise((resolve) => t.pending.push(resolve));
      args.onEvent({ type: 'delta', text: 'hi' });
      args.onEvent({ type: 'result', subtype: 'success' });
      return Promise.resolve();
    },
    cancel: (userId, chatSessionId) => { t.cancelled.push([userId, chatSessionId]); return true; },
    clear: (userId, chatSessionId) => { t.cleared.push([userId, chatSessionId]); return { cleared: true }; },
    decide: (args) => { t.decided.push(args); return { ok: true }; },
    read: reads ?? {
      sessions: (userId, opts) => { t.readCalls.push(['sessions', userId, opts]); return [{ id: 'chat-1', title: 'Phone chat', updatedAt: 1 }, { id: 'chat-2', title: 'Other', updatedAt: 2 }]; },
      history: (userId, id, opts) => { t.readCalls.push(['history', userId, id, opts]); return id === 'chat-2' ? { hasMore: false, messages: [{ seq: 1, role: 'user', content: 'q' }, { seq: 2, role: 'assistant', content: 'a' }] } : null; },
      usage: (userId) => { t.readCalls.push(['usage', userId]); return { providers: {} }; },
    },
    append: (userId, chatSessionId, line) => { t.saved.push([userId, chatSessionId, line]); },
  });
  t.last = () => t.sent.at(-1)[1];
  t.lastError = () => t.last().error?.code;
  t.paired = async (s) => {
    t.g.opened(s, '127.0.0.1');
    await t.g.receive(s, req('c-h', 'host.hello', HELLO));
    await t.g.receive(s, req('c-p', 'host.auth.pair', { pin: '123456' }));
  };
  return t;
}

test('pairing: hello, pair, then the token authenticates a second session', async () => {
  const t = harness();
  const s1 = { n: 1 };
  await t.paired(s1);
  const result = t.last().result;
  assert.equal(t.last().replyTo, 'c-p');
  assert.ok(result.token.startsWith('tok-h1-'));
  assert.deepEqual(result.capabilities, ['host', 'chat', 'approvals']);
  const s2 = { n: 2 };
  t.g.opened(s2, '127.0.0.1');
  await t.g.receive(s2, req('c-h', 'host.hello', HELLO));
  await t.g.receive(s2, req('c-t', 'host.auth.token', { token: result.token }));
  assert.equal(t.last().type, 'response');
  assert.deepEqual(t.last().result, { capabilities: ['host', 'chat', 'approvals'] });
});

test('the session cap is per member: four each for two users, a fifth for one is busy', async () => {
  let who = 'u1';
  const t = harness({ pinUser: () => who });
  const open = async (n) => { const s = { n }; t.g.opened(s, '127.0.0.1'); await t.paired(s); return s; };
  for (let i = 1; i <= 4; i += 1) {
    const s = await open(i);
    assert.equal(t.last().type, 'response', `user 1 session ${i} pairs`);
    assert.ok(!t.closed.includes(s));
  }
  const fifth = await open(5);
  assert.equal(t.lastError(), 'busy');
  assert.equal(t.last().error.retryable, true);
  assert.ok(t.closed.includes(fifth), 'the over-cap connection is closed');
  // A different member is not affected by the first member's four connections.
  who = 'u2';
  const other = await open(6);
  assert.equal(t.last().type, 'response', 'another user still pairs their first session');
  assert.deepEqual(t.last().result.capabilities, ['host', 'chat', 'approvals']);
  assert.ok(!t.closed.includes(other));
  assert.equal([...t.tokens.values()].filter((v) => v.userId === 'u1').length, 4, 'no token was issued for the refused session');
});

test('wrong PIN: auth_failed, not retryable; commands before auth are refused', async () => {
  const t = harness();
  const s = {};
  t.g.opened(s, '127.0.0.1');
  await t.g.receive(s, req('c-1', 'chat.snapshot'));
  assert.equal(t.lastError(), 'auth_failed');
  await t.g.receive(s, req('c-h', 'host.hello', HELLO));
  await t.g.receive(s, req('c-p', 'host.auth.pair', { pin: '000000' }));
  assert.equal(t.lastError(), 'auth_failed');
  assert.equal(t.last().error.retryable, false);
  // The throttle now asks this peer to wait before the next attempt.
  await t.g.receive(s, req('c-p2', 'host.auth.pair', { pin: '123456' }));
  assert.equal(t.lastError(), 'auth_failed');
  assert.equal(t.last().error.retryable, true);
  assert.ok(t.last().error.details.retryAfterMs > 0);
});

test('chat.send runs a turn on the quick chat and routes delta + done', async () => {
  const t = harness();
  const s = {};
  await t.paired(s);
  await t.g.receive(s, req('c-9', 'chat.send', { text: 'hello', attachments: [{ name: 'a.md', text: 'x' }] }));
  await flush();
  const reply = t.sent.find(([, f]) => f.replyTo === 'c-9' && f.type === 'response')[1];
  assert.deepEqual(reply.result, { accepted: true, requestId: 'c-9' });
  assert.equal(t.turns.length, 1);
  assert.equal(t.turns[0].userId, 'u1');
  assert.equal(t.turns[0].chatSessionId, 'chat-1');
  assert.equal(t.turns[0].message, 'hello');
  assert.deepEqual(t.turns[0].files, [{ path: 'a.md', content: 'x' }]);
  assert.equal('permissionMode' in t.turns[0], false);
  const events = t.sent.filter(([, f]) => f.type === 'event').map(([, f]) => f);
  assert.deepEqual(events.map((f) => f.command), ['chat.delta', 'chat.done']);
  assert.deepEqual(events.map((f) => f.replyTo), ['c-9', 'c-9']);
  assert.equal(events[0].payload.text, 'hi');
  const revs = t.sent.map(([, f]) => f.rev);
  assert.deepEqual(revs, [...revs].sort((a, b) => a - b));
  assert.equal(revs.at(-1), 2);
  await flush();
  assert.deepEqual(t.saved, [['u1', 'chat-1', { role: 'user', content: 'hello' }], ['u1', 'chat-1', { role: 'assistant', content: 'hi' }]]);
  // Ownership ended at the terminal frame: the same id may run again.
  await t.g.receive(s, req('c-9', 'chat.send', { text: 'again' }));
  assert.equal(t.last().type === 'error', false);
});

test('a reused in-flight chat.send id is busy', async () => {
  const t = harness({ hold: true });
  const s = {};
  await t.paired(s);
  await t.g.receive(s, req('c-9', 'chat.send', { text: 'a' }));
  await t.g.receive(s, req('c-9', 'chat.send', { text: 'b' }));
  assert.equal(t.lastError(), 'busy');
  await t.g.receive(s, req('c-10', 'chat.send', { text: 'c' }));
  assert.equal(t.lastError(), 'busy');
  assert.equal(t.turns.length, 1);
});

test('cancel ends the turn as a cancelled done', async () => {
  const t = harness({ hold: true });
  const s = {};
  await t.paired(s);
  await t.g.receive(s, req('c-9', 'chat.send', { text: 'hello' }));
  await t.g.receive(s, req('c-x', 'chat.cancel'));
  assert.deepEqual(t.cancelled, [['u1', 'chat-1']]);
  assert.deepEqual(t.last().result, { cancelled: true });
  // The real engine ends an aborted turn without an error event: the turn just resolves.
  t.pending[0]();
  await flush();
  assert.equal(t.last().command, 'chat.done');
  assert.deepEqual(t.last().payload, { requestId: 'c-9', stopReason: 'cancelled' });
  assert.deepEqual(t.saved, [['u1', 'chat-1', { role: 'user', content: 'hello' }]], 'a cancelled turn keeps only the user line');
  await t.g.receive(s, req('c-y', 'chat.cancel'));
  assert.deepEqual(t.last().result, { cancelled: false });
});

test('approvals.answer: not_found when not owned; owned answers carry the init sdkSessionId', async () => {
  const t = harness({ hold: true });
  const s = {};
  await t.paired(s);
  await t.g.receive(s, req('c-a', 'approvals.answer', { requestId: 'r1', commandId: 'someone-else', answers: {} }));
  assert.equal(t.lastError(), 'not_found');
  await t.g.receive(s, req('c-9', 'chat.send', { text: 'hello' }));
  await t.g.receive(s, req('c-a2', 'approvals.answer', { requestId: 'r1', commandId: 'c-9', answers: {} }));
  assert.equal(t.lastError(), 'not_found', 'the request id is not open');
  t.turns[0].onEvent({ type: 'approval_request', requestId: 'r1', kind: 'AskUserQuestion', questions: [{ question: 'Q?', options: [{ label: 'A' }] }] });
  assert.equal(t.last().command, 'approval.request');
  assert.equal(t.last().payload.commandId, 'c-9');
  await t.g.receive(s, req('c-a3', 'approvals.answer', { requestId: 'r1', commandId: 'c-9', answers: { 'Q?': 'A' } }));
  assert.deepEqual(t.last().result, { accepted: true });
  assert.deepEqual(t.decided, [{ requestId: 'r1', sdkSessionId: 'sdk-1', userId: 'u1', action: 'answer', answers: { 'Q?': 'A' } }]);
  assert.equal(t.decided.length, 1);
});

test('toolApprovals.answer needs its capability served; with it, allow_once is an allow', async () => {
  const t = harness({ hold: true, toolApprovals: true }); // paired while served, so it is granted
  const s = {};
  await t.paired(s);
  t.toolApprovals = false;
  t.g.capabilitiesChanged();
  assert.deepEqual(t.last().payload.capabilities, ['host', 'chat', 'approvals']);
  await t.g.receive(s, req('c-t', 'toolApprovals.answer', { requestId: 'r2', commandId: 'c-9', decision: 'allow_once' }));
  assert.equal(t.lastError(), 'capability_unavailable');
  const before = t.sent.length;
  t.g.capabilitiesChanged();
  assert.equal(t.sent.length, before, 'no broadcast without a real change');
  t.toolApprovals = true;
  t.g.capabilitiesChanged();
  assert.equal(t.last().command, 'host.capabilities');
  assert.ok(t.last().payload.capabilities.includes('tool_approvals'));
  await t.g.receive(s, req('c-9', 'chat.send', { text: 'hello' }));
  t.turns[0].onEvent({ type: 'approval_request', requestId: 'r2', kind: 'ToolApproval', toolName: 'Bash', argsSummary: 'ls' });
  await t.g.receive(s, req('c-t2', 'toolApprovals.answer', { requestId: 'r2', commandId: 'c-9', decision: 'allow_once' }));
  assert.deepEqual(t.last().result, { accepted: true });
  assert.deepEqual(t.decided, [{ requestId: 'r2', sdkSessionId: 'sdk-1', userId: 'u1', action: 'allow' }]);
});

test('chat.history.clear: denied without the flag, cleared with it, busy while a turn runs', async () => {
  const off = harness();
  const s = {};
  await off.paired(s);
  await off.g.receive(s, req('c-c', 'chat.history.clear'));
  assert.equal(off.lastError(), 'denied');
  assert.deepEqual(off.cleared, []);

  const t = harness({ chatClear: true, hold: true });
  const s2 = {};
  await t.paired(s2);
  await t.g.receive(s2, req('c-9', 'chat.send', { text: 'hello' }));
  await t.g.receive(s2, req('c-c', 'chat.history.clear'));
  assert.equal(t.lastError(), 'busy');
  assert.deepEqual(t.cleared, []);
  t.pending[0]();
  await flush();
  await t.g.receive(s2, req('c-c2', 'chat.history.clear'));
  assert.deepEqual(t.last().result, { cleared: true });
  assert.deepEqual(t.cleared, [['u1', 'chat-1']]);
});

test('snapshot serves chat only, user and assistant lines only', async () => {
  const t = harness();
  const s = {};
  await t.paired(s);
  await t.g.receive(s, req('c-s', 'host.snapshot', { topics: ['chat'] }));
  assert.deepEqual(t.last().result, { snapshots: { chat: { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }] } } });
  await t.g.receive(s, req('c-s2', 'host.snapshot', { topics: ['chat', 'loop'] }));
  assert.equal(t.lastError(), 'capability_unavailable');
  await t.g.receive(s, req('c-s3', 'chat.snapshot', { limit: 1 }));
  assert.deepEqual(t.last().result, { messages: [{ role: 'assistant', content: 'yo' }] });
});

test('a long chat snapshot stays under the frame cap and keeps the newest messages', async () => {
  // 20 lines of 90k two-byte characters (~3.6 MB) — far past one frame.
  const long = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i}:${'é'.repeat(90_000)}` }));
  const t = harness({ history: async () => long });
  const s = {};
  await t.paired(s);
  for (const [id, command, payload] of [['c-l1', 'chat.snapshot', { limit: 20 }], ['c-l2', 'host.snapshot', { topics: ['chat'] }]]) {
    await t.g.receive(s, req(id, command, payload));
    const frame = t.last();
    assert.equal(frame.type, 'response', JSON.stringify(frame.error));
    assert.ok(Buffer.byteLength(JSON.stringify(frame)) < 1_048_576);
    const messages = frame.result.messages ?? frame.result.snapshots.chat.messages;
    assert.ok(messages.length >= 1 && messages.length < 20);
    assert.deepEqual(messages, long.slice(-messages.length));
  }
  // One newest message alone is always served, whole (within the 100k clamp).
  const t2 = harness({ history: async () => [{ role: 'user', content: 'old' }, { role: 'assistant', content: '\u0001'.repeat(100_000) }] });
  await t2.paired(s);
  await t2.g.receive(s, req('c-l3', 'chat.snapshot', { limit: 2 }));
  assert.equal(t2.last().result.messages.at(-1).content.length, 100_000);
});

test('self-revoke: another token is denied; its own token revokes and closes every session of the device', async () => {
  const t = harness();
  const s1 = { n: 1 };
  await t.paired(s1);
  const token = t.sent.find(([, f]) => f.replyTo === 'c-p')[1].result.token;
  const s2 = { n: 2 };
  t.g.opened(s2, '127.0.0.1');
  await t.g.receive(s2, req('c-h', 'host.hello', HELLO));
  await t.g.receive(s2, req('c-t', 'host.auth.token', { token }));
  await t.g.receive(s1, req('c-r', 'host.auth.revoke', { token: 'tok-h1-other-0123456789' }));
  assert.equal(t.lastError(), 'denied');
  assert.deepEqual(t.closed, []);
  await t.g.receive(s1, req('c-r2', 'host.auth.revoke', { token }));
  const response = t.sent.find(([, f]) => f.replyTo === 'c-r2')[1];
  assert.deepEqual(response.result, { revoked: true });
  assert.equal(t.tokens.size, 0);
  assert.deepEqual(new Set(t.closed), new Set([s1, s2]));
});

test('closeAll cancels every in-flight turn and closes every session', async () => {
  const t = harness({ hold: true });
  const s1 = { n: 1 };
  const s2 = { n: 2 };
  await t.paired(s1);
  await t.paired(s2);
  await t.g.receive(s1, req('c-1', 'chat.send', { text: 'a' }));
  await t.g.receive(s2, req('c-2', 'chat.send', { text: 'b' }));
  const before = t.sent.length;
  t.g.closeAll();
  assert.equal(t.cancelled.length, 2, 'shutdown cancels even detached turns');
  assert.deepEqual(new Set(t.closed), new Set([s1, s2]));
  // Late engine events after close are dropped.
  t.turns[0].onEvent({ type: 'delta', text: 'late' });
  t.turns[0].onEvent({ type: 'result' });
  assert.equal(t.sent.length, before);
});

test('hello returns the desktop host shape', async () => {
  const t = harness();
  const s = {};
  t.g.opened(s, '127.0.0.1');
  await t.g.receive(s, req('c-h', 'host.hello', HELLO));
  assert.deepEqual(t.last().result, {
    hostName: 'Test Computer', hostKind: 'desktop', apiVersion: 1, apiVersions: [1],
    capabilities: ['host', 'chat', 'approvals'], protocolVersion: 1, requiresAuth: true,
  });
});

test('hello carries certificateFingerprint when the host has one', async () => {
  const fp = `sha256:${'A'.repeat(43)}`;
  const t = harness({ fingerprint: fp });
  const s = {};
  t.g.opened(s, '127.0.0.1');
  await t.g.receive(s, req('c-h', 'host.hello', HELLO));
  assert.equal(t.last().result.certificateFingerprint, fp);
});

test('the hub-wide session cap is 64, and an unauthenticated session closes after 10 s', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const t = harness();
    const ss = Array.from({ length: 64 }, (_, i) => ({ i }));
    ss.forEach((s, i) => t.g.opened(s, `10.0.${i}.1`)); // distinct peers: one peer may hold only 2 before auth
    const over = {};
    t.g.opened(over, '10.9.9.9');
    assert.equal(t.lastError(), 'busy');
    assert.match(t.last().error.message, /hub/, 'the global refusal names the hub, not "this computer"');
    assert.deepEqual(t.closed, [over]);
    await t.g.receive(ss[0], req('c-h', 'host.hello', HELLO));
    await t.g.receive(ss[0], req('c-p', 'host.auth.pair', { pin: '123456' }));
    mock.timers.tick(10_000);
    assert.equal(new Set(t.closed).size, 64, 'the over-cap session and every unauthenticated one (except the paired one) are closed');
    assert.ok(t.closed.includes(over));
  } finally {
    mock.timers.reset();
  }
});

test('a rejected turn is a chat.error; SESSION_TOKEN_LIMIT is not retryable; an engine-callback throw never escapes', async () => {
  const t = harness();
  const s = {};
  await t.paired(s);
  let code = 'TURN_IN_PROGRESS';
  const g = createGateway({
    send: (_s, text) => t.sent.push([_s, JSON.parse(text)]), close: () => {}, hostName: () => 'X', capabilities: () => ['host', 'chat', 'approvals'], log: () => {},
    member: () => ({ teamRole: 'owner', maxMode: 'execute' }),
    pins: { consumePin: () => 'u1' }, devices: t.devices,
    quickChat: { get: () => 'chat-1', set: () => {}, create: () => 'chat-1' },
    turn: () => Promise.reject(Object.assign(new Error('Busy.'), { code })),
    append: (...a) => t.saved.push(a),
  });
  const s2 = {};
  g.opened(s2, '127.0.0.1');
  await g.receive(s2, req('c-h', 'host.hello', HELLO));
  await g.receive(s2, req('c-p', 'host.auth.pair', { pin: '123456' }));
  await g.receive(s2, req('c-1', 'chat.send', { text: 'a' }));
  await flush();
  assert.equal(t.last().command, 'chat.error');
  assert.equal(t.last().payload.retryable, true);
  code = 'SESSION_TOKEN_LIMIT';
  await g.receive(s2, req('c-2', 'chat.send', { text: 'a' }));
  await flush();
  assert.equal(t.last().command, 'chat.error');
  assert.equal(t.last().payload.retryable, false);
  assert.deepEqual(t.saved, [], 'a refused turn stores nothing');
  // onEvent swallows a send failure rather than throwing into the engine.
  let thrown = null;
  const g2 = createGateway({
    send: (_s, text) => { if (JSON.parse(text).type === 'event') throw new Error('socket gone'); }, close: () => {}, hostName: () => 'X', capabilities: () => ['host', 'chat', 'approvals'], log: () => {},
    member: () => ({ teamRole: 'owner', maxMode: 'execute' }),
    pins: { consumePin: () => 'u1' }, devices: t.devices,
    quickChat: { get: () => 'chat-1', set: () => {}, create: () => 'chat-1' },
    turn: ({ onEvent }) => { try { onEvent({ type: 'delta', text: 'x' }); onEvent({ type: 'result' }); } catch (e) { thrown = e; } return Promise.resolve(); },
  });
  const s3 = {};
  g2.opened(s3, '127.0.0.1');
  await g2.receive(s3, req('c-h', 'host.hello', HELLO));
  await g2.receive(s3, req('c-p', 'host.auth.pair', { pin: '123456' }));
  await g2.receive(s3, req('c-1', 'chat.send', { text: 'a' }));
  await flush();
  assert.equal(thrown, null);
});

test('a session closed before init detaches; the turn is not cancelled and keeps running', async () => {
  const t = harness({ hold: true, skipInit: () => true });
  const s = {};
  await t.paired(s);
  await t.g.receive(s, req('c-9', 'chat.send', { text: 'hello' }));
  t.g.closed(s);
  t.turns[0].onEvent({ type: 'init', sessionId: 'sdk-1' });
  assert.deepEqual(t.cancelled, [], 'a dropped connection never cancels');
  const before = t.sent.length;
  t.turns[0].onEvent({ type: 'delta', text: 'late' });
  t.pending[0]();
  await flush();
  assert.equal(t.sent.length, before, 'a closed session gets nothing');
});

test('chat.cancel before init aborts the turn at init and ends it cancelled', async () => {
  const t = harness({ hold: true, skipInit: () => true });
  const s = {};
  await t.paired(s);
  await t.g.receive(s, req('c-9', 'chat.send', { text: 'hello' }));
  await t.g.receive(s, req('c-x', 'chat.cancel'));
  assert.deepEqual(t.last().result, { cancelled: true });
  assert.deepEqual(t.cancelled, []);
  t.turns[0].onEvent({ type: 'init', sessionId: 'sdk-1' });
  assert.deepEqual(t.cancelled, [['u1', 'chat-1']]);
  t.pending[0]();
  await flush();
  assert.equal(t.last().command, 'chat.done');
  assert.deepEqual(t.last().payload, { requestId: 'c-9', stopReason: 'cancelled' });
});

test('cancelling a not-started send never aborts another session\'s running turn on the same chat', async () => {
  const t = harness({ hold: true, skipInit: (i) => i === 1 });
  const b = { n: 'B' };
  const a = { n: 'A' };
  await t.paired(b);
  await t.paired(a);
  await t.g.receive(b, req('c-b', 'chat.send', { text: 'b' }));
  await t.g.receive(a, req('c-a', 'chat.send', { text: 'a' }));
  await t.g.receive(a, req('c-x', 'chat.cancel'));
  assert.deepEqual(t.last().result, { cancelled: true });
  assert.deepEqual(t.cancelled, []);
});

test('an in-stream engine error with an unknown code sends a generic message', async () => {
  const t = harness({ hold: true });
  const s = {};
  await t.paired(s);
  await t.g.receive(s, req('c-9', 'chat.send', { text: 'hello' }));
  t.turns[0].onEvent({ type: 'error', code: 'ENGINE_ERROR', message: 'spawn /secret/path ENOENT', retryable: false });
  assert.equal(t.last().command, 'chat.error');
  assert.equal(t.last().payload.message, 'The turn failed on this computer.');
});

test('a throwing handler answers internal with replyTo', async () => {
  const t = harness({ history: async () => { throw new Error('db gone'); } });
  const s = {};
  await t.paired(s);
  await t.g.receive(s, req('c-s', 'chat.snapshot'));
  assert.equal(t.lastError(), 'internal');
  assert.equal(t.last().replyTo, 'c-s');
});

test('rev is per connection: events to one session never advance another\'s', async () => {
  const t = harness({ hold: true });
  const a = { n: 'A' };
  const b = { n: 'B' };
  await t.paired(a);
  await t.paired(b);
  const of = (s) => t.sent.filter(([x]) => x === s).map(([, f]) => f);
  assert.deepEqual(of(b).map((f) => f.rev), [0, 0], 'a new session starts at 0');
  await t.g.receive(a, req('c-1', 'chat.send', { text: 'hello' }));
  const q = [{ question: 'Q?', options: [{ label: 'A' }] }];
  t.turns[0].onEvent({ type: 'approval_request', requestId: 'r1', kind: 'AskUserQuestion', questions: q });
  t.turns[0].onEvent({ type: 'approval_resolved', requestId: 'r1', outcome: 'answered' });
  t.turns[0].onEvent({ type: 'delta', text: 'x' });
  t.turns[0].onEvent({ type: 'result' });
  assert.deepEqual(of(a).filter((f) => f.type === 'event').map((f) => f.rev), [1, 2, 3, 4], 'strictly +1 per event');
  await t.g.receive(a, req('c-p', 'host.ping'));
  assert.equal(t.last().rev, 4, 'a response carries the session\'s current rev');
  await t.g.receive(b, req('c-p', 'host.ping'));
  assert.equal(t.last().rev, 0, 'session B did not move');
  await t.g.receive(b, req('c-u', 'nope.cmd'));
  assert.equal(t.last().type, 'error');
  assert.equal(t.last().rev, 0);
});

test('reads: not served by default — capability_unavailable, the store is never touched', async () => {
  const t = harness();
  const s = {};
  await t.paired(s);
  await t.g.receive(s, req('c-1', 'chat.sessions', {}));
  assert.equal(t.lastError(), 'capability_unavailable');
  assert.equal(t.readCalls.length, 0);
});

test('reads: served and granted at pairing — sessions, history and usage answer for the session user only', async () => {
  const t = harness({ read: true });
  const s = {};
  await t.paired(s);
  assert.deepEqual(t.last().result.capabilities, ['host', 'chat', 'approvals', 'read']);
  await t.g.receive(s, req('c-1', 'chat.sessions', { limit: 1 }));
  assert.deepEqual(t.last().result, { sessions: [{ id: 'chat-1', title: 'Phone chat', updatedAt: 1000 }], nextOffset: 1 });
  assert.deepEqual(t.readCalls.at(-1), ['sessions', 'u1', { limit: 2, offset: 0, projectId: null }]);
  await t.g.receive(s, req('c-2', 'chat.history', { sessionId: 'chat-2' }));
  assert.deepEqual(t.last().result.messages.map((m) => m.seq), [1, 2]);
  assert.deepEqual(t.readCalls.at(-1), ['history', 'u1', 'chat-2', { limit: 100, beforeSeq: undefined }]);
  await t.g.receive(s, req('c-3', 'usage.get', {}));
  assert.deepEqual(t.last().result, { providers: [] });
  assert.deepEqual(t.readCalls.at(-1), ['usage', 'u1']);
});

test('reads: an unknown or foreign chat id is not_found', async () => {
  const t = harness({ read: true });
  const s = {};
  await t.paired(s);
  await t.g.receive(s, req('c-1', 'chat.history', { sessionId: 'someone-elses' }));
  assert.equal(t.lastError(), 'not_found');
});

test('reads: the phone chat is flagged', async () => {
  const t = harness({ read: true });
  const s = {};
  await t.paired(s);
  await t.g.receive(s, req('c-0', 'chat.send', { text: 'hi' })); // creates the phone chat 'chat-1'
  await t.g.receive(s, req('c-1', 'chat.sessions', {}));
  assert.equal(t.last().result.sessions[0].phoneChat, true);
  assert.equal(t.last().result.sessions[1].phoneChat, undefined);
});

test('reads: a token paired before read was served is denied with a re-pair hint', async () => {
  const t = harness();
  await t.paired({ n: 1 });
  const token = t.last().result.token;
  // A host now serving read, holding the same device row: the old token's scopes lack read.
  const t2 = harness({ read: true });
  t2.tokens.set(token, t.tokens.get(token));
  const s2 = { n: 2 };
  t2.g.opened(s2, '127.0.0.1');
  await t2.g.receive(s2, req('c-h', 'host.hello', HELLO));
  await t2.g.receive(s2, req('c-t', 'host.auth.token', { token }));
  assert.deepEqual(t2.last().result.capabilities, ['host', 'chat', 'approvals']);
  await t2.g.receive(s2, req('c-1', 'usage.get', {}));
  assert.equal(t2.lastError(), 'denied');
  assert.match(t2.last().error.message, /pair again/);
  assert.equal(t2.readCalls.length, 0);
});

test('reads: the per-device read bucket refuses with rate_limited and retryAfterMs', async () => {
  const t = harness({ read: true });
  const s = {};
  await t.paired(s);
  for (let i = 0; i < 20; i += 1) await t.g.receive(s, req(`c-${i}`, 'usage.get', {}));
  await t.g.receive(s, req('c-x', 'usage.get', {}));
  assert.equal(t.lastError(), 'rate_limited');
  assert.ok(t.last().error.details.retryAfterMs > 0);
});

test('hostApiCapabilities: read only with LLMIDE_HOST_API_READ=1', async () => {
  const { hostApiCapabilities } = await import('../routes/host-api/gateway.mjs');
  assert.deepEqual(hostApiCapabilities({}), ['host', 'chat', 'approvals']);
  assert.deepEqual(hostApiCapabilities({ LLMIDE_HOST_API_READ: '1' }), ['host', 'chat', 'approvals', 'read']);
  assert.deepEqual(hostApiCapabilities({ LLMIDE_HOST_API_READ: '1', LLMIDE_HOST_API_TOOL_APPROVALS: '1' }), ['host', 'chat', 'approvals', 'tool_approvals', 'read']);
});

test('compose: not served by default — chat.options is capability_unavailable, no model list is asked', async () => {
  const t = harness(); const s = {}; await t.paired(s);
  await t.g.receive(s, req('c-1', 'chat.options', {}));
  assert.equal(t.lastError(), 'capability_unavailable'); assert.equal(t.modelCalls, 0);
});
test('compose: chat.options offers execute only when tool approvals are served and granted', async () => {
  const t = harness({ compose: true }); const s = {}; await t.paired(s);
  await t.g.receive(s, req('c-1', 'chat.options', {}));
  assert.equal(t.last().result.modes.includes('execute'), false, 'the phone could not answer its approval prompts');
});
test('compose: served and granted — chat.options lists the read-only modes and the SDK models, audited once a minute', async () => {
  const t = harness({ compose: true, toolApprovals: true }); const s = {}; await t.paired(s);
  assert.deepEqual(t.last().result.capabilities, ['host', 'chat', 'approvals', 'tool_approvals', 'compose']);
  await t.g.receive(s, req('c-1', 'chat.options', {}));
  assert.deepEqual(t.last().result, { modes: ['auto', 'ask', 'plan', 'assist_plan', 'review', 'document', 'execute'], models: [{ model: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }] });
  await t.g.receive(s, req('c-2', 'chat.options', {}));
  const rows = t.audits.filter(([e]) => e === 'chat_options');
  assert.equal(rows.length, 2, 'the sink de-duplicates; the gateway passes a dedupeKey'); assert.equal(rows[0][1].dedupeKey, rows[0][1].deviceId);
  assert.equal(JSON.stringify(rows).includes('Sonnet'), false, 'no list content in audit');
});
test('compose: an SDK that cannot list models still answers, with no models', async () => {
  const t = harness({ compose: true, models: new Error('not logged in') }); const s = {}; await t.paired(s);
  await t.g.receive(s, req('c-1', 'chat.options', {})); assert.deepEqual(t.last().result.models, []);
});
test('compose: chat.options uses the per-device read bucket', async () => {
  const t = harness({ compose: true }); const s = {}; await t.paired(s);
  for (let i = 0; i < 20; i += 1) await t.g.receive(s, req(`c-${i}`, 'chat.options', {}));
  await t.g.receive(s, req('c-x', 'chat.options', {})); assert.equal(t.lastError(), 'rate_limited');
});
test('hostApiCapabilities: compose only with LLMIDE_HOST_API_COMPOSE=1', async () => {
  const { hostApiCapabilities } = await import('../routes/host-api/gateway.mjs');
  assert.deepEqual(hostApiCapabilities({ LLMIDE_HOST_API_COMPOSE: '1' }), ['host', 'chat', 'approvals', 'compose']);
  assert.deepEqual(hostApiCapabilities({ LLMIDE_HOST_API_COMPOSE: '1', LLMIDE_HOST_API_READ: '1' }), ['host', 'chat', 'approvals', 'read', 'compose']);
});

test('compose send: without compose, a mode or model is refused before any turn (old sends unchanged)', async () => {
  const t = harness(); const s = {}; await t.paired(s);
  await t.g.receive(s, req('c-1', 'chat.send', { text: 'hi', mode: 'plan' }));
  assert.equal(t.lastError(), 'capability_unavailable'); assert.equal(t.turns.length, 0);
  await t.g.receive(s, req('c-2', 'chat.send', { text: 'hi' })); await flush();
  assert.equal(t.turns.length, 1); assert.equal(t.turns[0].mode, 'auto'); assert.equal(t.turns[0].model, null);
});
test('compose send: a device paired before compose was served is denied with a re-pair hint and audited', async () => {
  const t = harness(); await t.paired({ n: 1 }); const token = t.last().result.token;
  const t2 = harness({ compose: true }); t2.tokens.set(token, t.tokens.get(token)); const s2 = { n: 2 };
  t2.g.opened(s2, '127.0.0.1'); await t2.g.receive(s2, req('c-h', 'host.hello', HELLO));
  await t2.g.receive(s2, req('c-t', 'host.auth.token', { token }));
  await t2.g.receive(s2, req('c-1', 'chat.send', { text: 'hi', model: 'claude-sonnet-5-5' }));
  assert.equal(t2.lastError(), 'denied'); assert.match(t2.last().error.message, /pair again/); assert.equal(t2.turns.length, 0);
  assert.equal(t2.audits.at(-1)[0], 'scope_denied'); assert.equal(t2.audits.at(-1)[1].detail, 'compose');
});
test('compose send: granted — the mode and a listed model reach the turn; the audit has no text', async () => {
  const t = harness({ compose: true }); const s = {}; await t.paired(s);
  await t.g.receive(s, req('c-1', 'chat.send', { text: 'secret plan text', mode: 'plan', model: 'claude-sonnet-5-5', attachments: [{ name: 'a.md', text: 'body' }] })); await flush();
  assert.equal(t.turns[0].mode, 'plan'); assert.equal(t.turns[0].model, 'claude-sonnet-5-5');
  const row = t.audits.find(([e]) => e === 'compose_send');
  assert.equal(row[1].detail, 'mode=plan model=claude-sonnet-5-5 files=1');
  assert.equal(JSON.stringify(t.audits).includes('secret'), false); assert.equal(JSON.stringify(t.audits).includes('a.md'), false);
});
test('compose send: a model the desktop does not list is denied, no turn starts', async () => {
  const t = harness({ compose: true }); const s = {}; await t.paired(s);
  await t.g.receive(s, req('c-1', 'chat.send', { text: 'hi', model: 'claude-opus-9' }));
  assert.equal(t.lastError(), 'denied'); assert.equal(t.turns.length, 0);
});
test('compose send: execute reaches the turn for an owner with execute authority', async () => {
  const t = harness({ compose: true, toolApprovals: true }); const s = {}; await t.paired(s);
  await t.g.receive(s, req('c-1', 'chat.send', { text: 'hi', mode: 'execute' })); await flush();
  assert.equal(t.lastError(), undefined); assert.equal(t.turns.length, 1); assert.equal(t.turns[0].mode, 'execute'); assert.equal(t.turns[0].allowExecute, true);
});
test('chat.send: an image attachment is invalid_payload and no turn starts', async () => {
  const t = harness(); const s = {}; await t.paired(s);
  await t.g.receive(s, req('c-1', 'chat.send', { text: 'hi', attachments: [{ name: 'p.png', text: '[binary:image/png]\nAAAA' }] }));
  assert.equal(t.lastError(), 'invalid_payload'); assert.equal(t.turns.length, 0);
});
test('chat.new: starts a fresh phone chat; the next send goes there; audited', async () => {
  const t = harness({ compose: true, read: true }); const s = {}; await t.paired(s);
  await t.g.receive(s, req('c-0', 'chat.send', { text: 'first' })); await flush(); assert.equal(t.turns[0].chatSessionId, 'chat-1');
  await t.g.receive(s, req('c-1', 'chat.new', {})); assert.deepEqual(t.last().result, { sessionId: 'chat-2' }); assert.equal(t.audits.at(-1)[0], 'chat_new');
  await t.g.receive(s, req('c-2', 'chat.send', { text: 'second' })); await flush(); assert.equal(t.turns[1].chatSessionId, 'chat-2');
});
test('surfaces keep separate chats: an execute chat never shares the ask chat; chat.new on one leaves the other', async () => {
  const t = harness({ compose: true, read: true }); const s = {}; await t.paired(s);
  await t.g.receive(s, req('c-0', 'chat.send', { text: 'ask' })); await flush();
  await t.g.receive(s, req('c-1', 'chat.send', { text: 'run', surface: 'execute' })); await flush();
  assert.equal(t.turns[0].chatSessionId, 'chat-1'); assert.equal(t.turns[1].chatSessionId, 'chat-2');
  await t.g.receive(s, req('c-2', 'chat.new', { surface: 'execute' })); assert.deepEqual(t.last().result, { sessionId: 'chat-3' });
  await t.g.receive(s, req('c-3', 'chat.send', { text: 'again' })); await flush(); assert.equal(t.turns[2].chatSessionId, 'chat-1');
  await t.g.receive(s, req('c-4', 'chat.send', { text: 'again', surface: 'execute' })); await flush(); assert.equal(t.turns[3].chatSessionId, 'chat-3');
});
test('chat.new: refused busy while a turn of this user runs', async () => {
  const t = harness({ compose: true, hold: true }); const s = {}; await t.paired(s);
  await t.g.receive(s, req('c-0', 'chat.send', { text: 'long' })); await flush();
  await t.g.receive(s, req('c-1', 'chat.new', {})); assert.equal(t.lastError(), 'busy'); assert.equal(t.last().error.retryable, true);
});
test('chat.new: not served without compose', async () => {
  const t = harness(); const s = {}; await t.paired(s);
  await t.g.receive(s, req('c-1', 'chat.new', {})); assert.equal(t.lastError(), 'capability_unavailable');
});

// --- team authority at pairing (ADR 0021, plan Task 3) ---------------------
// A viewer or a `max_mode` none member is served host + read + push only: chat, approvals,
// tool_approvals and compose never enter the pairing token, and a re-auth recomputes from the stored
// scopes ∩ the same filter, so a demotion applies on the next connect.

const VIEWER = () => ({ userId: 'u1', teamRole: 'viewer', maxMode: 'execute', usdCapMonth: 20 });
const NO_TURNS = () => ({ userId: 'u1', teamRole: 'member', maxMode: 'none', usdCapMonth: 20 });
const READER = () => ({ userId: 'u1', teamRole: 'member', maxMode: 'read_only', usdCapMonth: 20 });

test('pairing as a viewer grants Ask: host, chat, approvals and read', async () => {
  const t = harness({ read: true, member: VIEWER });
  const s = {};
  await t.paired(s);
  assert.deepEqual(t.last().result.capabilities, ['host', 'chat', 'approvals', 'read']);
  const token = t.last().result.token;
  assert.deepEqual(t.tokens.get(token).scopes, ['host', 'chat', 'approvals', 'read']);
});

test('pairing as a max_mode none member grants the same minimum', async () => {
  const t = harness({ read: true, compose: true, toolApprovals: true, member: NO_TURNS });
  await t.paired({});
  assert.deepEqual(t.last().result.capabilities, ['host', 'read']);
});

test('pairing as a read_only or execute member keeps everything served', async () => {
  for (const member of [READER, () => ({ teamRole: 'member', maxMode: 'execute' })]) {
    const t = harness({ read: true, member });
    await t.paired({});
    assert.deepEqual(t.last().result.capabilities, ['host', 'chat', 'approvals', 'read']);
  }
});

test('a demoted member loses chat on the next token auth (stored scopes ∩ the filter)', async () => {
  let current = READER;
  const t = harness({ read: true, member: () => current() });
  const s1 = {};
  await t.paired(s1);
  const token = t.last().result.token;
  assert.deepEqual(t.tokens.get(token).scopes, ['host', 'chat', 'approvals', 'read']);

  current = NO_TURNS;
  const s2 = { n: 2 };
  t.g.opened(s2, '127.0.0.1');
  await t.g.receive(s2, req('c-h', 'host.hello', HELLO));
  await t.g.receive(s2, req('c-t', 'host.auth.token', { token }));
  assert.deepEqual(t.last().result.capabilities, ['host', 'read']);
  // The stored token still carries the old scopes; the connection's grants are the filtered set, so
  // chat.send is refused on this connection.
  await t.g.receive(s2, req('c-send', 'chat.send', { text: 'hi' }));
  assert.equal(t.lastError(), 'denied');
  assert.equal(t.turns.length, 0);
});

test('every Host API command has a class (null only for pairing and heartbeat)', async () => {
  const { COMMAND_CLASS } = await import('../routes/host-api/gateway.mjs');
  const { HOST_API_COMMANDS } = await import('../routes/host-api/commands.generated.mjs');
  for (const name of Object.keys(HOST_API_COMMANDS)) {
    assert.ok(Object.prototype.hasOwnProperty.call(COMMAND_CLASS, name), `${name} has no class`);
  }
  for (const name of ['host.hello', 'host.auth.pair', 'host.auth.token', 'host.auth.revoke', 'host.ping']) {
    assert.equal(COMMAND_CLASS[name], null, name);
  }
  assert.equal(COMMAND_CLASS['chat.send'], 'model.ask');
  assert.equal(COMMAND_CLASS['approvals.answer'], 'model.ask');
  assert.equal(COMMAND_CLASS['toolApprovals.answer'], 'model.exec');
});

test('a member demoted while connected loses chat on the very next frame', async () => {
  let current = READER;
  const t = harness({ read: true, member: () => current() });
  const s = {};
  await t.paired(s);
  current = NO_TURNS;
  await t.g.receive(s, req('c-send', 'chat.send', { text: 'hi' }));
  assert.equal(t.lastError(), 'denied');
  assert.equal(t.turns.length, 0);
  assert.ok(t.audits.some(([event]) => event === 'role_denied'));
  await t.g.receive(s, req('c-sessions', 'chat.sessions', {}));
  assert.equal(t.last().error, undefined, 'a max_mode none member may still read');
});

test('a viewer paired on a phone may Ask', async () => {
  const t = harness({ read: true, member: VIEWER });
  const s = {};
  await t.paired(s);
  await t.g.receive(s, req('c-send', 'chat.send', { text: 'what changed today?' }));
  assert.equal(t.turns.length, 1, 'the turn starts; runV2Turn forces it to ask');
});

test('R-023 #7: a session open across the 90-day boundary is refused on the next frame', async () => {
  const t = harness();
  const s1 = { n: 1 };
  await t.paired(s1);
  const { token } = t.last().result;
  const s2 = { n: 2 };
  t.g.opened(s2, '127.0.0.1');
  await t.g.receive(s2, req('c-h', 'host.hello', HELLO));
  // The token was issued on day 89 and the session stays open across day 90 (the fake authenticator accepts it;
  // the real store would delete it at auth — the point is the per-frame check on an already-open session).
  t.tokens.get(token).pairedAt = Date.now() - 91 * 24 * 3600 * 1000;
  await t.g.receive(s2, req('c-t', 'host.auth.token', { token }));
  assert.equal(t.last().type, 'response');
  await t.g.receive(s2, req('c-p', 'host.ping'));
  assert.equal(t.lastError(), 'auth_failed');
  assert.ok(t.closed.includes(s2), 'the expired session is closed');
});

// --- execute needs tool approvals the phone can answer ----------------------
test('compose send: execute is capability_unavailable when tool approvals are not served; no turn', async () => {
  const t = harness({ compose: true }); const s = {}; await t.paired(s);
  await t.g.receive(s, req('c-1', 'chat.send', { text: 'hi', mode: 'execute' })); await flush();
  assert.equal(t.lastError(), 'capability_unavailable'); assert.equal(t.turns.length, 0);
  await t.g.receive(s, req('c-2', 'chat.send', { text: 'hi', mode: 'plan' })); await flush();
  assert.equal(t.turns.length, 1, 'a read-only mode still runs');
});
test('compose send: execute on a device paired before tool approvals were served is denied with a re-pair hint', async () => {
  const t = harness({ compose: true }); await t.paired({ n: 1 }); const token = t.last().result.token;
  const t2 = harness({ compose: true, toolApprovals: true }); t2.tokens.set(token, t.tokens.get(token)); const s2 = { n: 2 };
  t2.g.opened(s2, '127.0.0.1'); await t2.g.receive(s2, req('c-h', 'host.hello', HELLO));
  await t2.g.receive(s2, req('c-t', 'host.auth.token', { token }));
  await t2.g.receive(s2, req('c-1', 'chat.send', { text: 'hi', mode: 'execute' })); await flush();
  assert.equal(t2.lastError(), 'denied'); assert.match(t2.last().error.message, /pair again/); assert.equal(t2.turns.length, 0);
  assert.equal(t2.audits.at(-1)[0], 'scope_denied'); assert.equal(t2.audits.at(-1)[1].detail, 'tool_approvals');
});

// --- stale sessions and evicted devices --------------------------------------
async function tokenSession(t, token, n) {
  const s = { n };
  t.g.opened(s, `10.0.0.${n}`); await t.g.receive(s, req('c-h', 'host.hello', HELLO));
  await t.g.receive(s, req('c-t', 'host.auth.token', { token }));
  return s;
}
test('a device reconnecting at the per-user cap replaces its own stale sessions instead of answering busy', async () => {
  const { MAX_SESSIONS_PER_USER } = await import('../routes/host-api/gateway.mjs');
  const t = harness(); const s1 = { n: 1 }; await t.paired(s1); const token = t.last().result.token;
  const old = [s1];
  for (let i = 2; i <= MAX_SESSIONS_PER_USER; i += 1) old.push(await tokenSession(t, token, i));
  assert.equal(t.closed.length, 0);
  for (const o of old) o.lastHeard = Date.now() - 60_000; // silent for longer than a ping interval
  const fresh = await tokenSession(t, token, 99);
  assert.ok(t.last().result?.capabilities, JSON.stringify(t.last()));
  assert.deepEqual(t.closed, old, 'every older socket of this device is closed');
  assert.ok(!t.sent.some(([s, f]) => old.includes(s) && f.error?.code === 'auth_failed'), 'no auth_failed: the client keeps its token');
  assert.equal(t.audits.filter(([e]) => e === 'session_replaced').length, MAX_SESSIONS_PER_USER);
  await t.g.receive(fresh, req('c-1', 'host.ping', {})); assert.deepEqual(t.last().result, {});
});
test('at the cap a recently heard same-device session is NOT replaced: the newcomer gets busy', async () => {
  const { MAX_SESSIONS_PER_USER } = await import('../routes/host-api/gateway.mjs');
  const t = harness(); const s1 = { n: 1 }; await t.paired(s1); const token = t.last().result.token;
  const old = [s1];
  for (let i = 2; i <= MAX_SESSIONS_PER_USER; i += 1) old.push(await tokenSession(t, token, i));
  for (const o of old) o.lastHeard = Date.now();
  await tokenSession(t, token, 99);
  assert.equal(t.lastError(), 'busy');
  assert.deepEqual(t.closed.filter((c) => old.includes(c)), []);
  assert.equal(t.audits.filter(([e]) => e === 'session_replaced').length, 0);
});
test('at the cap only the silent same-device session is replaced', async () => {
  const { MAX_SESSIONS_PER_USER } = await import('../routes/host-api/gateway.mjs');
  const t = harness(); const s1 = { n: 1 }; await t.paired(s1); const token = t.last().result.token;
  const old = [s1];
  for (let i = 2; i <= MAX_SESSIONS_PER_USER; i += 1) old.push(await tokenSession(t, token, i));
  for (const o of old) o.lastHeard = Date.now();
  old[0].lastHeard = Date.now() - 60_000;
  await tokenSession(t, token, 99);
  assert.ok(t.last().result?.capabilities, JSON.stringify(t.last()));
  assert.deepEqual(t.closed, [old[0]]);
});
test('below the cap a second socket of the same device is left open (two tabs of one web token)', async () => {
  const t = harness(); const s1 = { n: 1 }; await t.paired(s1); const token = t.last().result.token;
  await tokenSession(t, token, 2);
  assert.deepEqual(t.closed, []);
  await t.g.receive(s1, req('c-1', 'host.ping', {})); assert.deepEqual(t.last().result, {});
});
test('at the cap, sessions of OTHER devices are not replaced: still busy', async () => {
  const { MAX_SESSIONS_PER_USER } = await import('../routes/host-api/gateway.mjs');
  const t = harness();
  for (let i = 1; i <= MAX_SESSIONS_PER_USER; i += 1) await t.paired({ n: i });
  const other = t.last().result.token;
  t.tokens.set('tok-another-device-0123456789', { ...t.tokens.get(other), deviceId: 'h1-other' });
  await tokenSession(t, 'tok-another-device-0123456789', 99);
  assert.equal(t.lastError(), 'busy');
});
test('pairing a device that evicts the oldest at the device cap disconnects the evicted device', async () => {
  const t = harness(); const s1 = { n: 1 }; await t.paired(s1);
  const issue = t.devices.issueDeviceToken;
  t.devices.issueDeviceToken = (...a) => ({ ...issue(...a), evicted: ['h1-dev1'] });
  const s2 = { n: 2 }; await t.paired(s2);
  assert.ok(t.last().result?.token, 'the new pairing succeeds');
  assert.deepEqual(t.closed, [s1]);
  assert.ok(t.sent.some(([s, f]) => s === s1 && f.error?.code === 'auth_failed'), 'the evicted device is told it was removed');
});

// --- chat.delete: gated like chat.history.clear ------------------------------
test('chat.delete: refused busy (retryable) while a turn of this user runs', async () => {
  const t = harness({ chatClear: true, hold: true, read: true }); const s = {}; await t.paired(s);
  await t.g.receive(s, req('c-0', 'chat.send', { text: 'long' })); await flush();
  await t.g.receive(s, req('c-1', 'chat.delete', { sessionId: 'chat-2' }));
  assert.equal(t.lastError(), 'busy'); assert.equal(t.last().error.retryable, true);
});
test('chat.delete: denied when clear/delete is turned off on this computer', async () => {
  const t = harness({ read: true }); const s = {}; await t.paired(s);
  await t.g.receive(s, req('c-1', 'chat.delete', { sessionId: 'chat-2' }));
  assert.equal(t.lastError(), 'denied');
});

// ---- detach + chat.resume ----
const events = (t, name) => t.sent.map(([, f]) => f).filter((f) => f.type === 'event' && f.command === name);
const reconnect = async (t, s, token) => {
  t.g.opened(s, '127.0.0.1');
  await t.g.receive(s, req('c-h', 'host.hello', HELLO));
  await t.g.receive(s, req('c-t', 'host.auth.token', { token }));
};
const tokenOf = (t) => [...t.tokens.keys()][0];

test('deltas stream before the result, in coalesced chunks (4 KB flushes at once)', async () => {
  const t = harness({ hold: true });
  const s = {};
  await t.paired(s);
  await t.g.receive(s, req('c-1', 'chat.send', { text: 'go' }));
  t.turns[0].onEvent({ type: 'delta', text: 'a'.repeat(5000) });
  assert.equal(events(t, 'chat.delta').length, 1, 'streamed before any result');
  t.turns[0].onEvent({ type: 'delta', text: 'tail' });
  assert.equal(events(t, 'chat.delta').length, 1, 'small text waits for the timer');
  t.turns[0].onEvent({ type: 'result', stopReason: 'end_turn' });
  const names = t.sent.map(([, f]) => f.command).filter((c) => c?.startsWith('chat.d'));
  assert.deepEqual(names, ['chat.delta', 'chat.delta', 'chat.done'], 'the tail is flushed before done');
  t.pending[0]();
});

test('order with approvals: pending text flushes before the approval event', async () => {
  const t = harness({ hold: true, toolApprovals: true });
  const s = {};
  await t.paired(s);
  await t.g.receive(s, req('c-1', 'chat.send', { text: 'go' }));
  t.turns[0].onEvent({ type: 'delta', text: 'before' });
  t.turns[0].onEvent({ type: 'approval_request', kind: 'ToolApproval', requestId: 'r-1', toolName: 'Edit' });
  const cmds = t.sent.map(([, f]) => f.command).filter((c) => c === 'chat.delta' || c === 'toolApproval.request');
  assert.deepEqual(cmds, ['chat.delta', 'toolApproval.request']);
  t.pending[0]();
});

test('a disconnect does not cancel; resume returns the text so far, later deltas and pending approvals go to the new session', async () => {
  const t = harness({ hold: true, toolApprovals: true });
  const s1 = { n: 1 };
  await t.paired(s1);
  await t.g.receive(s1, req('c-1', 'chat.send', { text: 'go' }));
  t.turns[0].onEvent({ type: 'delta', text: 'Hello ' });
  t.turns[0].onEvent({ type: 'approval_request', kind: 'ToolApproval', requestId: 'r-1', toolName: 'Edit', argsSummary: 'x' });
  t.g.closed(s1);
  assert.deepEqual(t.cancelled, []);
  t.turns[0].onEvent({ type: 'delta', text: 'world' });
  const s2 = { n: 2 };
  await reconnect(t, s2, tokenOf(t));
  const mark = t.sent.length;
  await t.g.receive(s2, req('r-1', 'chat.resume', { requestId: 'c-1' }));
  const after = t.sent.slice(mark).filter(([s]) => s === s2).map(([, f]) => f);
  assert.deepEqual(after[0].result, { state: 'running', text: 'Hello world' });
  assert.equal(after[1].command, 'toolApproval.request', 'pending approval re-emitted after the response');
  assert.equal(after[1].payload.requestId, 'r-1');
  // answering works from the new session, later events flow there
  await t.g.receive(s2, req('a-1', 'toolApprovals.answer', { commandId: 'c-1', requestId: 'r-1', decision: 'allow_once' }));
  assert.deepEqual(t.last().result, { accepted: true });
  t.turns[0].onEvent({ type: 'result', stopReason: 'end_turn' });
  assert.equal(t.sent.at(-1)[0], s2);
  assert.equal(t.last().command, 'chat.done');
  t.pending[0]();
});

test('chat.cancel from the resumed session cancels the turn', async () => {
  const t = harness({ hold: true });
  const s1 = { n: 1 };
  await t.paired(s1);
  await t.g.receive(s1, req('c-1', 'chat.send', { text: 'go' }));
  t.g.closed(s1);
  const s2 = { n: 2 };
  await reconnect(t, s2, tokenOf(t));
  await t.g.receive(s2, req('r-1', 'chat.resume', { requestId: 'c-1' }));
  await t.g.receive(s2, req('x-1', 'chat.cancel'));
  assert.deepEqual(t.last().result, { cancelled: true });
  assert.deepEqual(t.cancelled, [['u1', 'chat-1']]);
  t.pending[0]();
});

test('resume after the turn finished while detached returns the kept outcome (done and error)', async () => {
  const t = harness({ hold: true });
  const s1 = { n: 1 };
  await t.paired(s1);
  await t.g.receive(s1, req('c-1', 'chat.send', { text: 'go' }));
  t.turns[0].onEvent({ type: 'delta', text: 'answer' });
  t.g.closed(s1);
  t.turns[0].onEvent({ type: 'result', stopReason: 'end_turn' });
  t.pending[0]();
  await flush();
  const s2 = { n: 2 };
  await reconnect(t, s2, tokenOf(t));
  await t.g.receive(s2, req('r-1', 'chat.resume', { requestId: 'c-1' }));
  assert.deepEqual(t.last().result, { state: 'done', text: 'answer', stopReason: 'end_turn' });
  await t.g.receive(s2, req('c-2', 'chat.send', { text: 'again' }));
  t.turns[1].onEvent({ type: 'delta', text: 'half' });
  t.g.closed(s2);
  t.turns[1].onEvent({ type: 'error', message: 'boom', code: 'X' });
  t.pending[1]();
  await flush();
  const s3 = { n: 3 };
  await reconnect(t, s3, tokenOf(t));
  await t.g.receive(s3, req('r-2', 'chat.resume', { requestId: 'c-2' }));
  assert.deepEqual(t.last().result, { state: 'error', text: 'half', message: 'The turn failed on this computer.' });
  await t.g.receive(s3, req('r-3', 'chat.resume', { requestId: 'nope' }));
  assert.deepEqual(t.last().result, { state: 'unknown' });
});

test('another device or user resumes nothing: unknown, and the turn stays with its owner', async () => {
  let who = 'u1';
  const t = harness({ hold: true, pinUser: () => who });
  const s1 = { n: 1 };
  await t.paired(s1);
  await t.g.receive(s1, req('c-1', 'chat.send', { text: 'go' }));
  t.g.closed(s1);
  const other = { n: 2 };
  await t.paired(other); // a second device of the same user
  await t.g.receive(other, req('r-1', 'chat.resume', { requestId: 'c-1' }));
  assert.deepEqual(t.last().result, { state: 'unknown' }, 'same user, other device');
  who = 'u2';
  const stranger = { n: 3 };
  await t.paired(stranger);
  await t.g.receive(stranger, req('r-2', 'chat.resume', { requestId: 'c-1' }));
  assert.deepEqual(t.last().result, { state: 'unknown' }, 'other user');
  assert.deepEqual(t.cancelled, []);
  t.pending[0]();
});

test('kept outcomes expire after 10 minutes and are bounded to 20 per user', async () => {
  const t = harness({ hold: true });
  const s1 = { n: 1 };
  await t.paired(s1);
  for (let i = 0; i < 22; i += 1) {
    t.skew += 11_000; // refill the turn bucket
    await t.g.receive(s1, req(`c-${i}`, 'chat.send', { text: 'go' }));
    t.g.closed(s1);
    t.turns[i].onEvent({ type: 'result' });
    t.pending[i]();
    await flush();
    await reconnect(t, s1, tokenOf(t));
  }
  await t.g.receive(s1, req('r-old', 'chat.resume', { requestId: 'c-0' }));
  assert.deepEqual(t.last().result, { state: 'unknown' }, 'the oldest outcome was evicted');
  await t.g.receive(s1, req('r-new', 'chat.resume', { requestId: 'c-21' }));
  assert.equal(t.last().result.state, 'done');
});

test('a kept outcome expires with the clock', async () => {
  const t = harness({ hold: true });
  const s1 = { n: 1 };
  await t.paired(s1);
  await t.g.receive(s1, req('c-1', 'chat.send', { text: 'go' }));
  t.g.closed(s1);
  t.turns[0].onEvent({ type: 'result' });
  t.pending[0]();
  await flush();
  await reconnect(t, s1, tokenOf(t));
  t.skew = 10 * 60_000 + 1;
  await t.g.receive(s1, req('r-1', 'chat.resume', { requestId: 'c-1' }));
  assert.deepEqual(t.last().result, { state: 'unknown' });
});

test('revoking the device cancels its detached turn and drops its outcomes', async () => {
  const t = harness({ hold: true });
  const s1 = { n: 1 };
  await t.paired(s1);
  await t.g.receive(s1, req('c-1', 'chat.send', { text: 'go' }));
  const s2 = { n: 2 };
  await reconnect(t, s2, tokenOf(t));
  t.g.closed(s1);
  t.g.disconnectDevice('u1', 'h1-dev1');
  assert.deepEqual(t.cancelled, [['u1', 'chat-1']]);
  t.pending[0]();
});
