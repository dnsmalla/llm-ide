// extension/tests/session-tasks.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionTaskStore, taskStatusIcon } from '../llm_agent/runtime/handlers/session-tasks.mjs';

test('hasPendingWork is true while a task is pending', () => {
  const store = sessionTaskStore();
  store.createTask('u1', 's1', 'Do the thing');
  assert.equal(store.hasPendingWork('u1', 's1'), true);
});

test('hasPendingWork is true while a task is in_progress', () => {
  const store = sessionTaskStore();
  const t = store.createTask('u1', 's2', 'Do the thing');
  store.updateTask('u1', 's2', t.id, { status: 'in_progress' });
  assert.equal(store.hasPendingWork('u1', 's2'), true);
});

test('hasPendingWork is false once all tasks are completed or skipped', () => {
  const store = sessionTaskStore();
  const a = store.createTask('u1', 's3', 'A');
  const b = store.createTask('u1', 's3', 'B');
  store.updateTask('u1', 's3', a.id, { status: 'completed' });
  store.updateTask('u1', 's3', b.id, { status: 'skipped' });
  assert.equal(store.hasPendingWork('u1', 's3'), false);
});

test('hasPendingWork is false once any task has failed, even with other tasks still pending', () => {
  const store = sessionTaskStore();
  const a = store.createTask('u1', 's4', 'A — will fail');
  store.createTask('u1', 's4', 'B — still pending behind the failure');
  store.updateTask('u1', 's4', a.id, { status: 'failed' });
  assert.equal(store.hasPendingWork('u1', 's4'), false);
});

test('sessions are isolated by userId:sessionId key', () => {
  const store = sessionTaskStore();
  const t = store.createTask('u1', 'sA', 'A');
  store.updateTask('u1', 'sA', t.id, { status: 'failed' });
  // A different session must not see the other session's failure.
  store.createTask('u2', 'sB', 'B');
  assert.equal(store.hasPendingWork('u2', 'sB'), true);
});

test('taskStatusIcon maps every status to its legend glyph', () => {
  assert.equal(taskStatusIcon('pending'), '[ ]');
  assert.equal(taskStatusIcon('in_progress'), '[~]');
  assert.equal(taskStatusIcon('completed'), '[x]');
  assert.equal(taskStatusIcon('skipped'), '[-]');
  assert.equal(taskStatusIcon('failed'), '[!]');
  assert.equal(taskStatusIcon('something-unknown'), '[ ]');
});
