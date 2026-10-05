import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProgressGuard, REPEAT_WARN_AT, ERROR_STREAK_LIMIT } from '../llm_agent/sdk/loop-progress.mjs';

const read = { file_path: 'a.js' };

test('a repeat is first WARNED (denied with a hint), and only a further repeat stops the step', () => {
  const g = createProgressGuard();
  for (let i = 1; i < REPEAT_WARN_AT; i += 1) assert.deepEqual(g.onCall('Read', read), { action: 'ok' });
  const warned = g.onCall('Read', read);
  assert.equal(warned.action, 'warn');
  assert.match(warned.message, /already returned to you/);
  assert.equal(g.stopReason, null, 'one redundant read never ends a step by itself');
  const stopped = g.onCall('Read', read);
  assert.equal(stopped.action, 'stop');
  assert.match(stopped.reason, /same Read call/);
  assert.equal(g.stopReason, stopped.reason);
});

test('argument order does not hide a repeat; different arguments are new calls', () => {
  const g = createProgressGuard();
  g.onCall('Grep', { pattern: 'x', path: 'src' });
  g.onCall('Grep', { path: 'src', pattern: 'x' });
  assert.equal(g.onCall('Grep', { pattern: 'y', path: 'src' }).action, 'ok');
  assert.equal(g.onCall('Grep', { pattern: 'x', path: 'src' }).action, 'warn', 'third identical call');
});

test('a successful write resets the repeat count — re-reading a changed file is progress', () => {
  const g = createProgressGuard();
  for (let i = 0; i < 10; i += 1) {
    assert.equal(g.onCall('Read', read).action, 'ok');
    g.onWrite();
  }
});

test('ERROR_STREAK_LIMIT failed results in a row stop the step; a success breaks the streak', () => {
  const g = createProgressGuard();
  for (let i = 1; i < ERROR_STREAK_LIMIT; i += 1) assert.equal(g.onResult(true), null);
  assert.equal(g.onResult(false), null, 'a success resets');
  for (let i = 1; i < ERROR_STREAK_LIMIT; i += 1) assert.equal(g.onResult(true), null);
  assert.match(g.onResult(true), /in a row failed/);
});

test('once stopped, the reason sticks', () => {
  const g = createProgressGuard({ repeatWarnAt: 1 });
  g.onCall('Glob', { pattern: '*' });
  const { reason } = g.onCall('Glob', { pattern: '*' });
  assert.ok(reason);
  assert.deepEqual(g.onCall('Read', { file_path: 'new.js' }), { action: 'stop', reason });
  g.onWrite();
  assert.equal(g.stopReason, reason);
});
