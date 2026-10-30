// The update-file skill doc keeps the guardrail against rewriting a partially-read file with `content`.
// (The cross-field validator these tests used to drive lived in the classic fence loop, removed in
// K1 P6 T6.8; v2 edits go through the SDK's own Edit tool.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('skill doc warns against whole-file content for a partially-read file', () => {
  const doc = readFileSync(new URL('../llm_agent/global/update-file.md', import.meta.url), 'utf8');
  assert.match(doc, /Never guess `content` for a file you only saw an excerpt of/);
  assert.match(doc, /match \*\*exactly once\*\*/);
});
