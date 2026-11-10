import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reviewPromptFor } from '../agents/tasks/review.mjs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('review.doc uses the registry prompt verbatim', () => {
  // Captured from the pre-migration reviewPrompt('doc') (extension/tests/fixtures), byte for byte.
  assert.equal(reviewPromptFor('review.doc', ''), read('./fixtures/review-prompt-doc.txt'));
});

test('the doc focus lives in the prompt file only, not in the review route or the agent module', () => {
  const phrase = 'stale commands or paths';
  const promptFile = read('../../schema/tasks/prompts/review.doc.md');
  assert.equal(promptFile.split(phrase).length - 1, 1);
  assert.equal(read('../routes/bus/review.mjs').includes(phrase), false);
  assert.equal(read('../agents/tasks/review.mjs').includes(phrase), false);
});
