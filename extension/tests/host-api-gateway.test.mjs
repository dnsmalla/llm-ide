// Host API v1 desktop gateway — scenarios ported from the retired Swift app's HostApiV1GatewayTests.swift,
// driven with injected fakes (no engine, no DB, no network).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../routes/host-api/gateway.mjs';

const flush = () => new Promise((r) => setImmediate(r));
const HELLO = { clientName: 't', clientVersion: '1', platform: 'web', apiVersions: [1] };
const req = (id, command, payload = {}) => JSON.stringify({ apiVersion: 1, id, type: 'request', command, payload, ts: 1 });

function harness({ toolApprovals = false, chatClear = false, hold = false, skipInit = () => false, history = null, fingerprint = null, read = false, reads = null, compose = false, models = null } = {}) {
  const t = { sent: [], closed: [], turns: [], cancelled: [], decided: [], cleared: [], saved: [], toolApprovals, read, compose, readCalls: [], pending: [], audits: [], modelCalls: 0 };
  const tokens = new Map(); // token -> { userId, deviceId, scopes }
  let n = 0;
  let quick = null;
  let made = 0;
  t.tokens = tokens;
  t.devices = {
    issueDeviceToken(userId, _name, _now, scopes) { n += 1; const deviceId = `h1-dev${n}`; const token = `tok-${deviceId}-0123456789`; tokens.set(token, { userId, deviceId, scopes }); return { deviceId, token }; },
    authenticateDeviceToken: (token) => tokens.get(token) ?? null,
    revokeDevice(userId, deviceId) { for (const [k, v] of tokens) if (v.userId === userId && v.deviceId === deviceId) tokens.delete(k); return true; },
  };
  t.g = createGateway({
    send: (s, text) => t.sent.push([s, JSON.parse(text)]),
    close: (s) => t.closed.push(s),
    hostName: () => 'Test Computer',
    certificateFingerprint: () => fingerprint,
    capabilities: () => ['host', 'chat', 'approvals', ...(t.toolApprovals ? ['tool_approvals'] : []), ...(t.read ? ['read'] : []), ...(t.compose ? ['compose'] : [])],
    log: () => {},
    chatClearEnabled: () => chatClear,
    pins: { consumePin: (pin) => (pin === '123456' ? 'u1' : null) },
    devices: t.devices,
    quickChat: { get: () => quick, set: (_u, id) => { quick = id; }, create: () => `chat-${++made}` },
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
  assert.equal(t.cancelled.length, 2);
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

test('a fifth session is refused busy; an unauthenticated session closes after 10 s', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const t = harness();
    const ss = [{}, {}, {}, {}];
    ss.forEach((s, i) => t.g.opened(s, `10.0.0.${i + 1}`)); // distinct peers: one peer may hold only 2 before auth
    const fifth = {};
    t.g.opened(fifth, '10.0.0.9');
    assert.equal(t.lastError(), 'busy');
    assert.deepEqual(t.closed, [fifth]);
    await t.g.receive(ss[0], req('c-h', 'host.hello', HELLO));
    await t.g.receive(ss[0], req('c-p', 'host.auth.pair', { pin: '123456' }));
    mock.timers.tick(10_000);
    assert.deepEqual(new Set(t.closed), new Set([fifth, ss[1], ss[2], ss[3]]));
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

test('a session closed before init re-issues the cancel when init arrives', async () => {
  const t = harness({ hold: true, skipInit: () => true });
  const s = {};
  await t.paired(s);
  await t.g.receive(s, req('c-9', 'chat.send', { text: 'hello' }));
  t.g.closed(s);
  assert.deepEqual(t.cancelled, [], 'nothing holds the engine lock yet');
  const before = t.sent.length;
  t.turns[0].onEvent({ type: 'init', sessionId: 'sdk-1' });
  assert.deepEqual(t.cancelled, [['u1', 'chat-1']]);
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
  assert.deepEqual(t.readCalls.at(-1), ['sessions', 'u1', { limit: 2, offset: 0 }]);
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
test('compose: served and granted — chat.options lists modes and models, audited per call', async () => {
  const t = harness({ compose: true }); const s = {}; await t.paired(s);
  assert.deepEqual(t.last().result.capabilities, ['host', 'chat', 'approvals', 'compose']);
  await t.g.receive(s, req('c-1', 'chat.options', {}));
  assert.deepEqual(t.last().result, { modes: ['auto', 'ask', 'plan', 'assist_plan', 'review', 'document'], models: [{ model: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }] });
  await t.g.receive(s, req('c-2', 'chat.options', {}));
  const rows = t.audits.filter(([e]) => e === 'chat_options');
  assert.equal(rows.length, 2); assert.equal(rows[0][1].dedupeKey, rows[0][1].deviceId);
  assert.equal(JSON.stringify(rows).includes('Sonnet'), false);
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
test('compose send: execute never passes the schema', async () => {
  const t = harness({ compose: true }); const s = {}; await t.paired(s);
  await t.g.receive(s, req('c-1', 'chat.send', { text: 'hi', mode: 'execute' }));
  assert.equal(t.lastError(), 'invalid_payload'); assert.equal(t.turns.length, 0);
});
test('chat.new: starts a fresh phone chat; the next send goes there; audited', async () => {
  const t = harness({ compose: true, read: true }); const s = {}; await t.paired(s);
  await t.g.receive(s, req('c-0', 'chat.send', { text: 'first' })); await flush(); assert.equal(t.turns[0].chatSessionId, 'chat-1');
  await t.g.receive(s, req('c-1', 'chat.new', {})); assert.deepEqual(t.last().result, { sessionId: 'chat-2' }); assert.equal(t.audits.at(-1)[0], 'chat_new');
  await t.g.receive(s, req('c-2', 'chat.send', { text: 'second' })); await flush(); assert.equal(t.turns[1].chatSessionId, 'chat-2');
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
