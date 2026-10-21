// compact-system-prompt tests — pin the wording that distinguishes the two
// base prompts so a future edit to one can't silently drift onto the other.
//
// Why this matters: LOOP_BASE_PROMPT used to say "No unrelated refactors,
// renames or reformatting" inside a pipeline whose whole job IS a refactor —
// self-contradictory guidance a refactor-loop step would have to ignore.
// COMPACT_BASE_PROMPT (the chat/general-purpose prompt) keeps the original
// wording, since "unrelated" is the correct qualifier there.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { COMPACT_BASE_PROMPT, LOOP_BASE_PROMPT } = await import('../llm_agent/sdk/compact-system-prompt.mjs');

test('LOOP_BASE_PROMPT no longer carries the unrelated-refactors wording', () => {
  assert.ok(!LOOP_BASE_PROMPT.includes('No unrelated refactors'));
  assert.ok(LOOP_BASE_PROMPT.includes('No refactors, renames or reformatting beyond what the task asks.'));
});

test('COMPACT_BASE_PROMPT (chat) keeps the unrelated-refactors wording', () => {
  assert.ok(COMPACT_BASE_PROMPT.includes('No unrelated refactors, renames or reformatting.'));
});
