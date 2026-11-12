import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createTranslator, FLUSH_BYTES } from '../routes/host-api/translator.mjs';

test('deltas accumulate and the result emits chunked deltas then done', () => {
  const t = createTranslator({ external: 'c-1' });
  assert.deepEqual(t.push({ type: 'init', sessionId: 's' }, {}), { events: [], terminal: false });
  t.push({ type: 'delta', text: 'Hel' }, {});
  t.push({ type: 'delta', text: 'lo' }, {});
  const done = t.push({ type: 'result', subtype: 'success', stopReason: 'end_turn' }, {});
  assert.deepEqual(done.events.map((e) => e.command), ['chat.delta', 'chat.done']);
  assert.equal(done.events[0].payload.text, 'Hello');
  assert.deepEqual(done.events[1].payload, { requestId: 'c-1', stopReason: 'end_turn' });
  assert.equal(done.terminal, true);
});

test('a long reply is split into 100,000-unit deltas', () => {
  const t = createTranslator({ external: 'c-1' });
  const d = t.push({ type: 'delta', text: 'a'.repeat(250_000) }, {}).events.filter((e) => e.command === 'chat.delta').map((e) => e.payload.text.length);
  assert.deepEqual(d, [100_000, 100_000, 50_000]);
});

test('errors end the turn; a client cancel ends it as a cancelled done', () => {
  assert.deepEqual(createTranslator({ external: 'c-1' }).push({ type: 'error', message: 'boom', retryable: true }, {}),
    { events: [{ command: 'chat.error', payload: { message: 'boom', retryable: true } }], terminal: true });
  assert.deepEqual(createTranslator({ external: 'c-1' }).push({ type: 'error', message: 'aborted' }, { cancelledByClient: true }).events[0],
    { command: 'chat.done', payload: { requestId: 'c-1', stopReason: 'cancelled' } });
});

test('approvals map with the external command id, are filtered and capped, and never carry a truncated id', () => {
  const t = createTranslator({ external: 'c-1' });
  const ask = t.push({ type: 'approval_request', kind: 'AskUserQuestion', requestId: 'r-1', questions: [
    { question: 'Pick', header: 'A very long header', multiSelect: false, options: [{ label: 'Yes' }, { label: '' }] },
    { question: '', options: [{ label: 'x' }], multiSelect: false },
  ] }, {});
  assert.equal(ask.events[0].command, 'approval.request');
  assert.equal(ask.events[0].payload.commandId, 'c-1');
  assert.equal(ask.events[0].payload.questions.length, 1);
  assert.equal(ask.events[0].payload.questions[0].header, 'A very long ');
  assert.equal(ask.events[0].payload.questions[0].options.length, 1);
  const tool = t.push({ type: 'approval_request', kind: 'ToolApproval', requestId: 'r-2', toolName: '', argsSummary: 'x'.repeat(3000) }, {});
  assert.equal(tool.events[0].payload.toolName, 'tool');
  assert.equal(tool.events[0].payload.summary.length, 2000);
  assert.equal(tool.events[0].payload.truncated, true);
  assert.deepEqual(t.push({ type: 'approval_request', kind: 'ToolApproval', requestId: 'r'.repeat(65), toolName: 'Edit' }, {}).events, []);
  assert.deepEqual(t.push({ type: 'approval_resolved', requestId: 'r-1', outcome: 'answer' }, {}).events[0],
    { command: 'approval.cleared', payload: { requestId: 'r-1', commandId: 'c-1', reason: 'answer' } });
});

test('an error after deltas flushes them then emits chat.error; later events emit nothing', () => {
  const t = createTranslator({ external: 'c-1' });
  t.push({ type: 'delta', text: 'partial' }, {});
  const r = t.push({ type: 'error', message: 'boom' }, {});
  assert.deepEqual(r.events.map((e) => e.command), ['chat.delta', 'chat.error'], 'pending text is flushed before the error');
  assert.deepEqual(t.push({ type: 'result' }, {}), { events: [], terminal: true });
});

test('a chunk boundary on a surrogate pair keeps the pair whole', () => {
  const t = createTranslator({ external: 'c-1' });
  const d = t.push({ type: 'delta', text: `${'a'.repeat(99_999)}😀b` }, {}).events.filter((e) => e.command === 'chat.delta').map((e) => e.payload.text);
  assert.equal(d[0].length, 99_999);
  assert.ok(d[1].startsWith('😀'));
});

test('an AskUserQuestion whose questions all filter out emits nothing', () => {
  const t = createTranslator({ external: 'c-1' });
  assert.deepEqual(t.push({ type: 'approval_request', kind: 'AskUserQuestion', requestId: 'r-1', questions: [{ question: '', options: [{ label: 'x' }] }] }, {}),
    { events: [], terminal: false });
});

test('deltas stream: >= 4 KB flushes at once, smaller text waits for the 250 ms timer', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const flushed = [];
    const t = createTranslator({ external: 'c-1', onFlush: (events) => flushed.push(...events) });
    assert.deepEqual(t.push({ type: 'delta', text: 'ab' }, {}), { events: [], terminal: false });
    mock.timers.tick(249);
    assert.equal(flushed.length, 0);
    t.push({ type: 'delta', text: 'cd' }, {});
    mock.timers.tick(1);
    assert.deepEqual(flushed.map((e) => e.payload.text), ['abcd'], 'one coalesced chunk, 250 ms after the first byte');
    const big = t.push({ type: 'delta', text: 'x'.repeat(FLUSH_BYTES) }, {});
    assert.equal(big.events.length, 1);
    assert.equal(big.events[0].payload.text.length, FLUSH_BYTES);
    assert.equal(t.text(), `abcd${'x'.repeat(FLUSH_BYTES)}`, 'the full reply is kept after flushes');
  } finally { mock.timers.reset(); }
});

test('pending deltas flush before approval events and before done; the timer is cleared at terminal', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const flushed = [];
    const t = createTranslator({ external: 'c-1', onFlush: (events) => flushed.push(...events) });
    t.push({ type: 'delta', text: 'one' }, {});
    const a = t.push({ type: 'approval_request', kind: 'ToolApproval', requestId: 'r-1', toolName: 'Edit' }, {});
    assert.deepEqual(a.events.map((e) => e.command), ['chat.delta', 'toolApproval.request']);
    t.push({ type: 'delta', text: 'two' }, {});
    const d = t.push({ type: 'result' }, {});
    assert.deepEqual(d.events.map((e) => e.command), ['chat.delta', 'chat.done']);
    mock.timers.tick(1000);
    assert.equal(flushed.length, 0, 'no timer flush after the terminal event');
  } finally { mock.timers.reset(); }
});
