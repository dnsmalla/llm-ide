// Regression tests for codegen output validation — specifically that a
// generated file is NEVER silently truncated (a partial file written to disk
// and committed in the auto-PR flow would be a corruption bug).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, selectRelevantFiles, MAX_FILE_BYTES } from '../agents/codegen.mjs';

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

// selectRelevantFiles — narrows FTS-matched candidates to symbol-confirmed
// ones (token reduction) without ever handing codegen a truncated file body.
test('selectRelevantFiles narrows to the symbol-confirmed subset', () => {
  const files = [
    { ref: '/repo/src/a.ts', title: 'a.ts' },
    { ref: '/repo/src/b.ts', title: 'b.ts' },
    { ref: '/repo/src/unrelated.ts', title: 'unrelated.ts' },
  ];
  const symbols = [
    { repo_id: '/repo', source_file: 'src/a.ts', title: 'Foo' },
    { repo_id: '/repo', source_file: 'src/b.ts', title: 'Bar' },
  ];
  const out = selectRelevantFiles(files, symbols);
  assert.deepEqual(out.map((f) => f.ref).sort(), ['/repo/src/a.ts', '/repo/src/b.ts']);
});

test('selectRelevantFiles falls back to the full FTS list when no symbols are present (no SCIP graph yet)', () => {
  const files = [{ ref: '/repo/src/a.ts' }, { ref: '/repo/src/b.ts' }];
  assert.deepEqual(selectRelevantFiles(files, []), files);
  assert.deepEqual(selectRelevantFiles(files, undefined), files);
});

test('selectRelevantFiles falls back to the full FTS list when symbols confirm none of them', () => {
  const files = [{ ref: '/repo/src/a.ts' }, { ref: '/repo/src/b.ts' }];
  const symbols = [{ repo_id: '/other-repo', source_file: 'src/z.ts', title: 'Zed' }];
  assert.deepEqual(selectRelevantFiles(files, symbols), files);
});

test('selectRelevantFiles handles empty/malformed input without throwing', () => {
  assert.deepEqual(selectRelevantFiles(undefined, undefined), []);
  assert.deepEqual(selectRelevantFiles([{ ref: '/a.ts' }], [{ title: 'no repo_id or source_file' }]), [{ ref: '/a.ts' }]);
});
