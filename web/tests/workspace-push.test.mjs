import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushReady } from '../src/workspace/model.ts';

test('push is offered only when ahead and idle', () => {
  assert.equal(pushReady(1, false), true);
  assert.equal(pushReady(0, false), false);
  assert.equal(pushReady(2, true), false);
});
