// Attachment selection + truncation reporting for /code-assist. The
// server caps prompt size by cutting oversized attachments; it must tell
// the client WHICH files it cut. That `truncatedPaths` signal is the
// data-loss guard for the Mac auto-edit fast path: the agent only sees the
// head of a cut file, so a "rewrite the whole file" edit built from that
// partial view would silently drop the tail. Auto-edit refuses to
// overwrite a file that appears in truncatedPaths.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const { selectAttachments } = await import('../server/ai-routes.mjs');

test('selectAttachments: small files are kept whole and not flagged', () => {
  const { files, truncatedPaths } = selectAttachments(
    [{ path: '/Users/me/proj/a.txt', content: 'hello' }, { path: '/Users/me/proj/b.txt', content: 'world' }],
    { maxPerFileChars: 100, maxTotalChars: 1000 },
  );
  assert.equal(files.length, 2);
  assert.deepEqual(truncatedPaths, []);
  assert.equal(files[0].path, '~/proj/a.txt'); // /Users/<user>/ stripped for the prompt
});

test('selectAttachments: a file over the per-file cap is cut AND flagged', () => {
  const big = 'x'.repeat(500);
  const { files, truncatedPaths } = selectAttachments(
    [{ path: '/Users/me/proj/big.txt', content: big }],
    { maxPerFileChars: 100, maxTotalChars: 1000 },
  );
  assert.equal(files[0].content.length, 100, 'content cut to the per-file cap');
  assert.deepEqual(truncatedPaths, ['~/proj/big.txt'], 'cut file must be reported');
});

test('selectAttachments: a file cut only by the TOTAL cap is still flagged', () => {
  // First file fills most of the total budget; the second is small on its
  // own but gets clamped by the remaining total budget.
  const { files, truncatedPaths } = selectAttachments(
    [
      { path: '/Users/me/proj/first.txt', content: 'a'.repeat(90) },
      { path: '/Users/me/proj/second.txt', content: 'b'.repeat(50) },
    ],
    { maxPerFileChars: 1000, maxTotalChars: 100 },
  );
  assert.equal(files.length, 2);
  assert.equal(files[1].content.length, 10, 'second file clamped by total budget');
  assert.ok(truncatedPaths.includes('~/proj/second.txt'), 'total-cap cut must be reported');
  assert.ok(!truncatedPaths.includes('~/proj/first.txt'), 'untouched file not flagged');
});

test('selectAttachments: caps the number of files', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ path: `/Users/me/proj/f${i}.txt`, content: 'c' }));
  const { files } = selectAttachments(many, { maxFiles: 5 });
  assert.equal(files.length, 5);
});

test('selectAttachments: de-dupes by normalized path and skips malformed entries', () => {
  const { files } = selectAttachments(
    [
      { path: '/Users/me/proj/dup.txt', content: 'one' },
      { path: '/Users/me/proj/dup.txt', content: 'two' }, // same normalized path → dropped
      { path: '/Users/me/proj/ok.txt' },                  // missing content → skipped
      null,                                                // malformed → skipped
    ],
  );
  assert.equal(files.length, 1);
  assert.equal(files[0].path, '~/proj/dup.txt');
});

test('selectAttachments: non-array input yields empty result', () => {
  const { files, totalChars, truncatedPaths } = selectAttachments(undefined);
  assert.deepEqual(files, []);
  assert.equal(totalChars, 0);
  assert.deepEqual(truncatedPaths, []);
});
