import { test } from 'node:test';
import assert from 'node:assert/strict';
import { V2_EXECUTE_GUIDANCE } from '../llm_agent/runtime/execute-guidance.mjs';

// Plan modes and the legacy engine already say this; execute mode listed
// find-code as one option among Read/Grep/Glob, so the model read whole files.
test('execute guidance makes find-code the first step for locating code', () => {
  assert.match(V2_EXECUTE_GUIDANCE, /call `find-code` first/);
  assert.match(V2_EXECUTE_GUIDANCE, /only the lines it points at/);
});
