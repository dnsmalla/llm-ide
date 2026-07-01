// The Graphify repo-memory block is bounded (16 KB). When a file exceeds the
// remaining room it must be truncated on a LINE boundary, never mid-fact, so a
// curated memory bullet is never split mid-sentence. `clipToBoundary` is the
// pure helper that does this (memory.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const { clipToBoundary } = await import('../graphkit/memory.mjs');

test('clipToBoundary returns short text unchanged', () => {
  assert.equal(clipToBoundary('- one\n- two', 100), '- one\n- two');
});

test('clipToBoundary cuts on a line boundary, not mid-fact', () => {
  const facts = '- fact one about auth\n- fact two about the database layer\n- fact three';
  // room lands inside "fact two"; a naive slice would split it. The newline
  // after "fact one" (index 21) is past 60% of room, so clip backs up to it
  // and drops "fact two" whole rather than cutting it mid-word.
  const out = clipToBoundary(facts, 30);
  assert.ok(out.endsWith('…(truncated)'), 'marks truncation');
  assert.ok(out.includes('- fact one about auth'), 'keeps the first whole fact');
  assert.ok(!out.includes('database'), 'never emits a half-cut fact');
});

test('clipToBoundary hard-cuts a single over-long line (no boundary to use)', () => {
  const oneLine = 'x'.repeat(200);
  const out = clipToBoundary(oneLine, 40);
  assert.ok(out.startsWith('x'.repeat(40)), 'uses the room when there is no line break');
  assert.ok(out.endsWith('…(truncated)'));
});
