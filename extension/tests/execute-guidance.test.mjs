import { test } from 'node:test';
import assert from 'node:assert/strict';
import { V2_EXECUTE_GUIDANCE, V2_LOCATE_CODE_GUIDANCE } from '../llm_agent/runtime/execute-guidance.mjs';

// Plan modes and the legacy engine already say this; execute mode listed
// find-code as one option among Read/Grep/Glob, so the model read whole files.
// The rule now lives in its own section shared by every non-plan mode.
test('locate guidance makes find-code the first step, by the name the model sees', () => {
  assert.match(V2_LOCATE_CODE_GUIDANCE, /mcp__llmide__find-code/);
  assert.match(V2_LOCATE_CODE_GUIDANCE, /FIRST/);
  assert.match(V2_LOCATE_CODE_GUIDANCE, /only the lines it points at/);
  assert.match(V2_LOCATE_CODE_GUIDANCE, /Grep/, 'it says when to fall back');
  assert.ok(V2_LOCATE_CODE_GUIDANCE.length < 900, 'it rides in every turn, so it stays short');
});

test('execute guidance does not repeat the locate rule', () => {
  assert.doesNotMatch(V2_EXECUTE_GUIDANCE, /find-code` first/);
});

// Hops multiply cost: each one re-reads the whole context. The guidance asks
// for independent tool calls in ONE response and for ranged reads — and stays
// short, because it rides in every execute turn's system prompt.
test('execute guidance asks for batched tool calls and ranged reads, briefly', async () => {
  const mod = await import('../llm_agent/runtime/execute-guidance.mjs');
  const text = Object.values(mod).filter((v) => typeof v === 'string').join('\n');
  assert.match(text, /# Context budget/);
  assert.match(text, /in ONE response/);
  assert.match(text, /offset\/limit/);
  const section = text.slice(text.indexOf('# Context budget'));
  assert.ok(section.split('\n\n')[0].length < 600, 'the section is a few lines, not an essay');
});
