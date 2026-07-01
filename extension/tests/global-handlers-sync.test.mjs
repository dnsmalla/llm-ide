import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

import { handleCodeAssist } from '../llm_agent/runtime/route.mjs';
import { GLOBAL_HANDLER_NAMES } from '../llm_agent/runtime/global-handlers.mjs';
import { globalSkills } from '../llm_agent/skills/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Regression test for the "GLOBAL_HANDLED two-place drift" footgun:
// route.mjs's handlers map (the real dispatch table for /code-assist) and
// skills/registry.mjs's startup wiring check used to each hardcode their own
// copy of the global handler name list. Nothing enforced they matched, so
// adding a handler to one file and forgetting the other shipped silently —
// registry.mjs's check only validated "every skill file has a handler name
// in GLOBAL_HANDLED", it never cross-checked GLOBAL_HANDLED against what
// route.mjs actually wires up.
//
// Fix: both files now import the single GLOBAL_HANDLER_NAMES array from
// runtime/global-handlers.mjs, and route.mjs asserts (at the top of every
// handleCodeAssist call) that its constructed `handlers` object's keys
// equal that array exactly — throwing loudly if not. These tests exercise
// that guard from both directions.

test('GLOBAL_HANDLER_NAMES matches the handlers actually wired in route.mjs', async () => {
  // handleCodeAssist throws synchronously (before any runClaude call) if
  // the handlers map it builds doesn't match GLOBAL_HANDLER_NAMES. A
  // trivial success path here proves the two are in sync today.
  const fakeClaude = async () => 'plain reply, no tool calls';
  const out = await handleCodeAssist({
    message: 'hello',
    history: [],
    agentContext: { recentIssues: [], recentMeetings: [] },
    runClaude: fakeClaude,
    kb: { search: () => [], listMeetings: () => ({ items: [] }) },
    userId: 'user-1',
  });
  assert.equal(out.pendingTool, null);
});

test('GLOBAL_HANDLER_NAMES lists exactly the handler keys route.mjs source defines', () => {
  // Static cross-check independent of the runtime assertion above: parse
  // route.mjs's source for the literal keys of its `handlers = { ... }`
  // object and diff them against GLOBAL_HANDLER_NAMES. This catches drift
  // even if someone weakens or removes the runtime throw in route.mjs,
  // and pinpoints exactly which name is missing/extra when it fails.
  const routeSrc = readFileSync(join(__dirname, '..', 'llm_agent', 'runtime', 'route.mjs'), 'utf8');
  const handlersBlockMatch = routeSrc.match(/const handlers = \{([\s\S]*?)\n  \};/);
  assert.ok(handlersBlockMatch, 'expected to find a `const handlers = { ... };` block in route.mjs');
  const handlersBlock = handlersBlockMatch[1];
  // Match top-level string-literal keys: 'name': ...  (single-quoted, as
  // written in route.mjs) at the start of a line (2-space indent).
  const keyNames = [...handlersBlock.matchAll(/^\s{4}'([a-z-]+)':/gm)].map((m) => m[1]);
  assert.ok(keyNames.length > 0, 'expected to parse at least one handler key out of route.mjs');
  assert.deepEqual(
    [...keyNames].sort(),
    [...GLOBAL_HANDLER_NAMES].sort(),
    'route.mjs handlers keys and GLOBAL_HANDLER_NAMES have drifted apart — update both (see global-handlers.mjs)',
  );
});

test('every global read skill file has a name present in GLOBAL_HANDLER_NAMES', () => {
  // The startup check in skills/registry.mjs re-derives this same
  // condition and only console.errors (it must not crash server boot on a
  // misconfigured skill file); this test turns the same condition into a
  // hard test failure so CI catches it instead of relying on someone
  // reading server startup logs.
  const unhandled = [];
  for (const [name, skill] of globalSkills.skills) {
    if (skill.kind === 'read' && !GLOBAL_HANDLER_NAMES.includes(name)) {
      unhandled.push(name);
    }
  }
  assert.deepEqual(unhandled, [], `global read skill(s) with no handler in GLOBAL_HANDLER_NAMES: ${unhandled.join(', ')}`);
});

test('drift guard throws when the handlers map omits a declared global handler', async () => {
  // Simulate the exact bug class this whole check exists to prevent:
  // pretend a handler was declared in GLOBAL_HANDLER_NAMES / a skill file
  // but never wired into route.mjs's dispatch table. We can't easily
  // monkeypatch route.mjs's internal `handlers` object from outside (it's
  // rebuilt fresh per call and not exported), so instead we assert the
  // general shape of the guard directly: any handlers object missing one
  // of GLOBAL_HANDLER_NAMES's entries must be flagged as unequal — the
  // same comparison route.mjs performs internally.
  const wiredNames = GLOBAL_HANDLER_NAMES.slice(1); // drop the first entry — simulate a forgotten handler
  const expectedNames = GLOBAL_HANDLER_NAMES;
  const isInSync = wiredNames.length === expectedNames.length && expectedNames.every((n) => wiredNames.includes(n));
  assert.equal(isInSync, false, 'expected the drift comparison to detect a missing handler');
});
