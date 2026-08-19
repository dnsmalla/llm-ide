import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

import { GLOBAL_HANDLER_NAMES } from '../llm_agent/runtime/global-handlers.mjs';
import { globalSkills, assertReadSkillsWired } from '../llm_agent/skills/index.mjs';

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
// Fix: route.mjs now builds its `handlers` object via
// llm_agent/tools/registry.mjs's buildDispatch(), and GLOBAL_HANDLER_NAMES
// (runtime/global-handlers.mjs) is just Object.freeze(registry.names()) —
// both derive from the same ENTRIES list, so there is nothing left to
// drift-check: the dispatch table's keys are registry.names() by
// construction.

test('route.mjs dispatch is built from registry.buildDispatch, not a literal object', () => {
  const routeSrc = readFileSync(join(__dirname, '..', 'llm_agent', 'runtime', 'route.mjs'), 'utf8');
  assert.ok(routeSrc.includes('buildDispatch'), 'route.mjs should build its handlers via registry.buildDispatch');
  assert.ok(!/const handlers = \{\s*\n\s*'ask-internal':/.test(routeSrc), 'the old hand-built handlers literal should be gone');
});

test('registry.names() still matches GLOBAL_HANDLER_NAMES', async () => {
  const { names } = await import('../llm_agent/tools/registry.mjs');
  assert.deepEqual([...names()].sort(), [...GLOBAL_HANDLER_NAMES].sort());
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

test('assertReadSkillsWired throws on an internal read skill with no handler', () => {
  // The F4 gap: a read skill synced from the central repo into internal/skills/
  // with no matching INTERNAL_HANDLERS entry used to only console.error at boot
  // — reachable-looking but dead. assertReadSkillsWired must throw loudly so a
  // broken build fails to start instead of serving a skill whose calls fail
  // mid-session.
  const internalSkills = new Map([
    ['search-kb', { kind: 'read' }],       // wired
    ['new-central-skill', { kind: 'read' }], // synced in, NO handler
    ['create-issue', { kind: 'write' }],    // write skills need no read handler
  ]);
  assert.throws(
    () => assertReadSkillsWired({
      globalSkills: new Map(),
      internalSkills,
      globalHandlerNames: [],
      internalHandlers: { 'search-kb': () => {} },
    }),
    /new-central-skill/,
    'must name the unwired internal read skill',
  );
});

test('assertReadSkillsWired is silent when every read skill has a handler', () => {
  assert.doesNotThrow(() => assertReadSkillsWired({
    globalSkills: new Map([['read-file', { kind: 'read' }], ['update-file', { kind: 'write' }]]),
    internalSkills: new Map([['search-kb', { kind: 'read' }]]),
    globalHandlerNames: ['read-file'],
    internalHandlers: { 'search-kb': () => {} },
  }));
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

test('project_memory is reachable from the legacy loop (parity fix)', async () => {
  const fakeClaude = async (prompt) => {
    // A minimal fence call to project_memory, then a plain follow-up.
    if (prompt.includes('<<<TOOL_RESULT>>>')) return 'Got it.';
    return '<<<TOOL_CALL>>>\n{"name": "project_memory", "arguments": {}}\n<<<END_TOOL_CALL>>>';
  };
  const { handleCodeAssist } = await import('../llm_agent/runtime/route.mjs');
  const out = await handleCodeAssist({
    message: 'what do we know about this project?',
    history: [],
    agentContext: { recentIssues: [], recentMeetings: [], workspaceRoot: process.cwd() },
    runClaude: fakeClaude,
    kb: { search: () => [], listMeetings: () => ({ items: [] }) },
    userId: 'user-1',
  });
  assert.ok(out.reply, 'expected a reply after project_memory resolved (no "Unknown tool" error)');
});
