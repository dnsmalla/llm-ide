// Regression tests for codegen output validation — specifically that a
// generated file is NEVER silently truncated (a partial file written to disk
// and committed in the auto-PR flow would be a corruption bug).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, MAX_FILE_BYTES } from '../agents/codegen.mjs';

test('validate passes normal file content through untouched', () => {
  const content = 'export const x = 1;\n';
  const out = validate({ summary: 's', files: [{ path: 'src/x.ts', kind: 'create', content }], tests: [] });
  assert.equal(out.files.length, 1);
  assert.equal(out.files[0].content, content, 'content must not be altered/truncated');
});

test('validate throws (never truncates) when a file exceeds MAX_FILE_BYTES', () => {
  const big = 'a'.repeat(MAX_FILE_BYTES + 1);
  assert.throws(
    () => validate({ summary: 's', files: [{ path: 'src/big.ts', kind: 'modify', content: big }], tests: [] }),
    /exceed|limit|truncat/i,
  );
});

test('validate measures UTF-8 bytes, not UTF-16 code units', () => {
  // Each '✓' is 3 UTF-8 bytes but a single UTF-16 code unit, so a string
  // with fewer code units than the cap can still exceed it in bytes.
  const overInBytes = '✓'.repeat(Math.ceil(MAX_FILE_BYTES / 3) + 1);
  assert.ok(overInBytes.length < MAX_FILE_BYTES, 'fewer code units than the byte cap');
  assert.throws(
    () => validate({ summary: 's', files: [{ path: 'a.ts', content: overInBytes }], tests: [] }),
    /exceed|limit/i,
  );
});

test('validate at exactly MAX_FILE_BYTES is allowed and not truncated', () => {
  const content = 'a'.repeat(MAX_FILE_BYTES);
  const out = validate({ summary: 's', files: [{ path: 'a.ts', content }], tests: [] });
  assert.equal(out.files[0].content.length, MAX_FILE_BYTES);
});

test('validate drops empty/non-string content without throwing', () => {
  const out = validate({
    summary: 's',
    files: [{ path: 'a.ts', content: '' }, { path: 'b.ts', content: null }],
    tests: [],
    notes: 'n',
  });
  assert.equal(out.files.length, 0);
  assert.equal(out.notes, 'n');
});

test('validate flags the oversize test file too, not just src files', () => {
  const big = 'b'.repeat(MAX_FILE_BYTES + 10);
  assert.throws(
    () => validate({ summary: 's', files: [], tests: [{ path: 'a.test.ts', content: big }] }),
    /a\.test\.ts/,
  );
});
