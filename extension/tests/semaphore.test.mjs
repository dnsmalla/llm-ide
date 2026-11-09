// R-034 #18: the turn gate must bound its queue and remove a timed-out waiter, or a refused turn
// stays queued and later takes (and leaks) the slot it no longer wants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Semaphore } from '../core/semaphore.mjs';

const tick = () => new Promise((r) => setTimeout(r, 0));

test('a bounded queue sheds load instead of growing without limit', async () => {
  const s = new Semaphore(1, { maxQueue: 1 });
  await s.acquire();
  const waiting = s.acquire();
  await assert.rejects(s.acquire(), /queue full/);
  s.release();
  await waiting;
  assert.equal(s.active, 1);
  s.release();
  assert.equal(s.active, 0);
});

test('a timed-out waiter leaves the queue and never consumes a later slot', async () => {
  const s = new Semaphore(1, { maxQueue: 2 });
  await s.acquire();
  await assert.rejects(s.acquire(20), /timeout/);
  assert.equal(s.waiting, 0, 'the waiter was removed, not left to be resolved later');
  s.release();
  assert.equal(s.active, 0, 'releasing with no waiters frees the slot');
  // A fresh acquire works immediately and is not handed a stale slot.
  await s.acquire();
  assert.equal(s.active, 1);
  s.release();
});

test('a released slot is handed to the next waiter exactly once', async () => {
  const s = new Semaphore(1);
  await s.acquire();
  const order = [];
  const a = s.acquire().then(() => order.push('a'));
  const b = s.acquire().then(() => order.push('b'));
  s.release();
  await a;
  s.release();
  await b;
  await tick();
  assert.deepEqual(order, ['a', 'b']);
  s.release();
  assert.equal(s.active, 0);
});
