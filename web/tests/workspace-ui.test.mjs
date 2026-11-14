import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parentOf, joinPath, isTextLike } from '../src/workspace/model.ts';

test('paths join and go up without a leading slash', () => {
  assert.equal(joinPath('', 'a.txt'), 'a.txt');
  assert.equal(joinPath('src', 'a.ts'), 'src/a.ts');
  assert.equal(parentOf('src/a.ts'), 'src');
  assert.equal(parentOf('a.txt'), '');
});

test('binary extensions are not opened as text', () => {
  assert.equal(isTextLike('src/a.ts'), true);
  assert.equal(isTextLike('assets/logo.png'), false);
});
