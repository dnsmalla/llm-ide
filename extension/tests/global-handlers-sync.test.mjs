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

// (Removed: 'drift guard throws when the handlers map omits a declared global
// handler'. It imported no production code — it re-implemented a comparison
// inline and asserted that comparison worked — and it described a runtime
// throw that no longer exists anywhere: route.mjs builds its dispatch via
// registry.buildDispatch, so the keys ARE registry.names() by construction and
// there is no drift check left to guard. The tests above/below cover the real
// invariant.)

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

test('legacy dispatch, v2 mounted tools, and registry.names() name exactly the same set', async () => {
  const { names } = await import('../llm_agent/tools/registry.mjs');
  const { buildLlmIdeServer } = await import('../llm_agent/sdk/tools.mjs');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

  const server = buildLlmIdeServer('sync-test-user', { workspaceRoot: process.cwd() });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'sync-test', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.instance.connect(serverTransport)]);
  const v2Names = new Set((await client.listTools()).tools.map((t) => t.name));

  // names()/buildDispatch() both iterate ALL registry entries, which already
  // includes project_memory (added in Task 3) alongside the original 12
  // GLOBAL_HANDLER_NAMES — so registryNames/legacyNames are 13 names, not 12,
  // with no manual addition needed here.
  const registryNames = new Set(names());
  const { buildDispatch } = await import('../llm_agent/tools/registry.mjs');
  const legacyNames = new Set(Object.keys(buildDispatch({})));

  assert.deepEqual([...v2Names].sort(), [...registryNames].sort(), 'a v2-mounted tool name diverged from the registry');
  assert.deepEqual([...legacyNames].sort(), [...registryNames].sort(), 'a legacy-dispatched tool name diverged from the registry');

  await client.close();
  await server.instance.close();
});

// The FOURTH list that used to drift: engine.mjs's V2_ALLOWED_TOOLS (the SDK
// `allowedTools` option). It was hand-maintained and already went stale once
// on this branch — task-list was omitted when the act tools were added. It is
// now derived from registry.entries(), and this pins both halves of that
// derivation:
//   * every kind:'read' entry IS auto-allowed (so a read tool never needs a
//     canUseTool round-trip), and
//   * every kind:'act' entry is NOT — `allowedTools` means "auto-allowed
//     without prompting for permission" per the SDK's own sdk.d.ts, so an act
//     tool listed there would never reach canUseTool, silently bypassing the
//     blocked/auto/prompt safety gate. That is exactly the bug this test
//     exists to prevent recurring.
test('V2_ALLOWED_TOOLS auto-allows every read registry tool and no act one', async () => {
  const { entries } = await import('../llm_agent/tools/registry.mjs');
  const { buildEngineOptions } = await import('../llm_agent/sdk/engine.mjs');
  const { queryOptions } = buildEngineOptions(
    { userId: 'sync-u', mode: 'execute', agentContext: { workspaceRoot: '/tmp/w' } },
    { readSkill: () => null, roots: () => ['/tmp/w'], sessionMemory: () => [], getPersona: () => null },
  );
  const allowed = new Set(queryOptions.allowedTools);
  for (const e of entries()) {
    const mcpName = `mcp__llmide__${e.name}`;
    if (e.kind === 'read') {
      assert.ok(allowed.has(mcpName), `${mcpName} is kind:'read' but is not auto-allowed`);
    } else {
      assert.ok(!allowed.has(mcpName), `${mcpName} is kind:'act' — pre-approving it bypasses the canUseTool safety gate`);
    }
  }
});
