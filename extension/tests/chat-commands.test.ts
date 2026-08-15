// Built-in chat slash-command recognition — see src/sidepanel/chat-commands.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBuiltinClearCommand } from '../src/sidepanel/chat-commands.ts';

test('recognizes /clear and its documented aliases', () => {
  assert.equal(isBuiltinClearCommand('/clear'), true);
  assert.equal(isBuiltinClearCommand('/reset'), true);
  assert.equal(isBuiltinClearCommand('/new'), true);
});

test('is case-insensitive and tolerates surrounding whitespace', () => {
  assert.equal(isBuiltinClearCommand('/CLEAR'), true);
  assert.equal(isBuiltinClearCommand('  /clear  '), true);
});

test('does not match ordinary messages, including ones that start with /clear', () => {
  assert.equal(isBuiltinClearCommand('clear'), false);
  assert.equal(isBuiltinClearCommand('/clearly not a command'), false);
  assert.equal(isBuiltinClearCommand('/clear the table for me'), false);
  assert.equal(isBuiltinClearCommand(''), false);
  assert.equal(isBuiltinClearCommand('/model'), false);
});
