// F7: safeRead's bounded fd path reads the first N bytes then decodes UTF-8. If
// byte N lands inside a multibyte character, toString('utf8') emits a U+FFFD
// replacement char at the tail — a garbage glyph injected into the prompt.
// trimReplacementTail strips a single trailing replacement char; safeRead
// applies it on the fd path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trimReplacementTail, safeRead } from '../graphkit/memory.mjs';

test('trimReplacementTail strips a single trailing replacement char', () => {
  assert.equal(trimReplacementTail('hello�'), 'hello');
});

test('trimReplacementTail leaves clean text and interior U+FFFD untouched', () => {
  assert.equal(trimReplacementTail('hello'), 'hello');
  assert.equal(trimReplacementTail('a�b'), 'a�b'); // only the tail
});

test('safeRead fd path returns no trailing replacement char across a multibyte split', () => {
  const dir = mkdtempSync(join(tmpdir(), 'saferead-'));
  const file = join(dir, 'big.md');
  // '€' is 3 UTF-8 bytes. A run of them, sized so the file exceeds maxChars*4
  // (forcing the fd path) and the maxChars-th byte lands mid-character.
  const maxChars = 1000;
  writeFileSync(file, '€'.repeat(maxChars * 5), 'utf8'); // ~15000 bytes > 4000
  const out = safeRead(file, maxChars);
  assert.ok(out.length > 0);
  assert.ok(!out.endsWith('�'), 'no replacement char at the clipped tail');
});
