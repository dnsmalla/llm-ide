// Bounds on concurrent CLI subprocesses. Two layers:
//  1. The `Semaphore` primitive — never exceeds max in-flight, FIFO handoff,
//     releases on throw.
//  2. `spawnCli`'s integration — a pre-aborted signal fails fast without
//     spawning (so a request cancelled while queued never forks a child).

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const { Semaphore } = await import('../core/semaphore.mjs');
const { spawnCli } = await import('../agents/providers.mjs');

const defer = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

test('Semaphore: never exceeds max concurrent holders', async () => {
  const sem = new Semaphore(3);
  let active = 0;
  let peak = 0;
  const gates = Array.from({ length: 10 }, defer);

  const tasks = gates.map((gate, i) =>
    sem.run(async () => {
      active++;
      peak = Math.max(peak, active);
      await gate.promise;
      active--;
      return i;
    }),
  );

  // Let the first wave acquire, then release the gates in order.
  await new Promise((r) => setImmediate(r));
  assert.equal(peak, 3, 'no more than max should run before any release');
  gates.forEach((g) => g.resolve());

  const results = await Promise.all(tasks);
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(active, 0);
  assert.equal(sem.active, 0, 'all slots freed');
  assert.equal(sem.waiting, 0);
});

test('Semaphore: FIFO — queued waiters acquire in arrival order', async () => {
  const sem = new Semaphore(1);
  const order = [];
  const hold = defer();

  // First holder blocks the single slot.
  const first = sem.run(async () => { order.push('a'); await hold.promise; });
  await new Promise((r) => setImmediate(r));

  // b then c queue behind a.
  const second = sem.run(async () => { order.push('b'); });
  const third = sem.run(async () => { order.push('c'); });

  hold.resolve();
  await Promise.all([first, second, third]);
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.equal(sem.active, 0);
});

test('Semaphore: releases the slot even when the task throws', async () => {
  const sem = new Semaphore(1);
  await assert.rejects(sem.run(async () => { throw new Error('boom'); }), /boom/);
  // Slot must be free for the next caller.
  let ran = false;
  await sem.run(async () => { ran = true; });
  assert.equal(ran, true);
  assert.equal(sem.active, 0);
});

test('Semaphore: max clamps to >= 1 for bad input', () => {
  assert.equal(new Semaphore(0).max, 1);
  assert.equal(new Semaphore(-5).max, 1);
  assert.equal(new Semaphore(NaN).max, 1);
  assert.equal(new Semaphore(4).max, 4);
});

test('spawnCli: pre-aborted signal fails fast without spawning', async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    spawnCli('anthropic', 'hello', { signal: ac.signal }),
    (err) => err.name === 'AbortError' && /aborted/.test(err.message),
  );
});
