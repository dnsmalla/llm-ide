import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const { classifyEmail } = await import('../agents/email-classify.mjs');

test('note-worthy email parses category + summary + todos', async () => {
  const stub = async () => JSON.stringify({
    category: 'action_request', noteWorthy: true,
    summary: 'Aki needs the Q3 numbers by Friday.',
    todos: [{ title: 'Send Q3 numbers to Aki', detail: 'Q3 figures by Fri', due: '2026-07-10', priority: 'high' }],
  });
  const out = await classifyEmail({ subject: 'Q3 numbers', from: 'aki@co.com', date: '2026-07-04T09:00:00Z', body: '…', _runClaude: stub });
  assert.equal(out.category, 'action_request');
  assert.equal(out.noteWorthy, true);
  assert.equal(out.todos.length, 1);
  assert.equal(out.todos[0].priority, 'high');
  assert.equal(out.todos[0].due, '2026-07-10');
});

test('skip category forces noteWorthy false and empty todos', async () => {
  const stub = async () => JSON.stringify({
    category: 'newsletter', noteWorthy: true, // model wrongly says true …
    summary: 'weekly digest', todos: [{ title: 'x', detail: 'y', due: null, priority: 'low' }],
  });
  const out = await classifyEmail({ subject: 'Weekly', from: 'news@co.com', date: '2026-07-04T09:00:00Z', body: '…', _runClaude: stub });
  assert.equal(out.noteWorthy, false); // … server overrides for skip categories
  assert.deepEqual(out.todos, []);
});

test('malformed JSON triggers a stricter retry', async () => {
  let calls = 0;
  const stub = async () => {
    calls++;
    if (calls === 1) return 'sure, here you go: ...';
    return JSON.stringify({ category: 'personal', noteWorthy: true, summary: 'hi', todos: [] });
  };
  const out = await classifyEmail({ subject: 'Hi', from: 'a@b.com', date: '2026-07-04T09:00:00Z', body: 'hi', _runClaude: stub });
  assert.equal(calls, 2);
  assert.equal(out.category, 'personal');
});

test('unparseable output throws EMAIL_CLASSIFY_FAILED', async () => {
  const stub = async () => 'not json at all';
  await assert.rejects(
    classifyEmail({ subject: 's', from: 'a@b.com', date: '2026-07-04T09:00:00Z', body: 'b', _runClaude: stub }),
    (e) => e.code === 'EMAIL_CLASSIFY_FAILED');
});

test('bad priority/category are normalized to safe defaults', async () => {
  const stub = async () => JSON.stringify({
    category: 'weird', noteWorthy: true, summary: 's',
    todos: [{ title: 't', detail: 'd', due: 'nope', priority: 'urgent' }],
  });
  const out = await classifyEmail({ subject: 's', from: 'a@b.com', date: '2026-07-04T09:00:00Z', body: 'b', _runClaude: stub });
  assert.equal(out.category, 'other');       // unknown category → 'other'
  assert.equal(out.todos[0].priority, 'med'); // unknown priority → 'med'
  assert.equal(out.todos[0].due, null);       // unparseable due → null
});
