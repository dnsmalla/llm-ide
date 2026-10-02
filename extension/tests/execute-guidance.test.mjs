import { test } from 'node:test';
import assert from 'node:assert/strict';
import { V2_EXECUTE_GUIDANCE } from '../llm_agent/runtime/execute-guidance.mjs';

// Plan modes and the legacy engine already say this; execute mode listed
// find-code as one option among Read/Grep/Glob, so the model read whole files.
test('execute guidance makes find-code the first step for locating code', () => {
  assert.match(V2_EXECUTE_GUIDANCE, /call `find-code` first/);
  assert.match(V2_EXECUTE_GUIDANCE, /only the lines it points at/);
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
