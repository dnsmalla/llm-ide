import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirtyOf, conflictText, saveAllowed } from '../src/workspace/model.ts';

test('dirty is false when the buffer matches the saved text', () => {
  assert.equal(dirtyOf('a', 'a'), false);
  assert.equal(dirtyOf('a', 'b'), true);
});

test('a conflict explains how to recover', () => {
  assert.match(conflictText('changed'), /reload/i);
});

test('Save is enabled only for a dirty, idle buffer', () => {
  assert.equal(saveAllowed({ dirty: false, saving: false }), false);
  assert.equal(saveAllowed({ dirty: true, saving: false }), true);
  assert.equal(saveAllowed({ dirty: true, saving: true }), false);
});
