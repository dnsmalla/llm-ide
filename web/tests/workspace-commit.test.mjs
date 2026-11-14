import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitReady } from '../src/workspace/model.ts';

test('commit needs a message, a file and no busy state', () => {
  assert.equal(commitReady('msg', ['a.txt'], false), true);
  assert.equal(commitReady('   ', ['a.txt'], false), false);
  assert.equal(commitReady('msg', [], false), false);
  assert.equal(commitReady('msg', ['a.txt'], true), false);
});
