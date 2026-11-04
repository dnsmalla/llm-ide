import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranslator } from '../routes/host-api/translator.mjs';

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
  t.push({ type: 'delta', text: 'a'.repeat(250_000) }, {});
  const d = t.push({ type: 'result' }, {}).events.filter((e) => e.command === 'chat.delta').map((e) => e.payload.text.length);
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
