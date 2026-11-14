import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgv, terminalReady } from '../src/workspace/model.ts';

test('argv splits without a shell and requires a command', () => {
  assert.deepEqual(parseArgv('  git   status --porcelain '), ['git', 'status', '--porcelain']);
  assert.equal(terminalReady([], false), false);
  assert.equal(terminalReady(['pwd'], false), true);
  assert.equal(terminalReady(['pwd'], true), false);
});
