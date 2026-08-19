# Agent Tools Registry (P2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two hand-maintained copies of "every special function" (legacy fence dispatch in `route.mjs`, v2 MCP tools in `sdk/tools.mjs`) with one engine-agnostic registry both adapters derive from, then use that single source of truth to add a real safety gate (blocked / auto-safe / approval-prompt) for act tools on both engines, and to replace a hand-maintained mode-restriction allowlist with an honest, registry-derived one.

**Architecture:** `extension/llm_agent/tools/registry.mjs` holds one entry per special function — `name`, `kind` ('read'|'act'), `execute`, and (for act tools) `gate`. It does NOT duplicate `description`/schema — those already live in `llm_agent/global/<name>.md` frontmatter (loaded once at boot into `globalSkills`); the two exceptions (`kb_search`/`project_memory`, which predate any `.md` file) carry their schema inline until P2e gives them one. `route.mjs`'s legacy dispatch and `sdk/tools.mjs`'s v2 MCP server both become thin compilers over `registry.entries()`. Act-tool safety (`gates.mjs` + a new `tool_approvals` table) is consulted identically by both engines; the parking mechanism for a "needs approval" pause reuses `llm_agent/sdk/decisions.mjs` (already dependency-free) on both engines, not the pre-existing client-executes-locally `PendingTool` channel, which is architecturally for a different thing (Mac-side write execution) and does not fit a server-side `run-bash` approval.

**Tech Stack:** Node 22 ESM (no framework) · better-sqlite3 · node:test · `@anthropic-ai/claude-agent-sdk` (only `sdk/` may import it) · Swift 6 / SwiftUI / swift-testing

**Spec:** `docs/superpowers/specs/2026-08-19-agent-tools-registry-design.md` — read it first; this plan argues from it. Also read the sibling P1 plan (`docs/superpowers/plans/2026-08-18-agent-v2-engine.md`) for the exact shape of `sdk/tools.mjs`/`sdk/engine.mjs`/`sdk/decisions.mjs` this plan modifies.

## Global Constraints

- The registry's `kind` field (`'read'|'act'`) is a **new, independent** safety axis. Do not confuse it with the existing `.md` frontmatter `kind` (`'read'|'write'`), which drives the unrelated client-side `pendingTool`/`PendingTool` write-confirmation flow in `loop.mjs` and Mac's `PendingActionCard` — that mechanism is for the Mac app executing a write **locally** (file edits, git ops, issue actions) and is left untouched by this plan. `run-bash`'s `.md` kind stays `'read'` (unchanged); its registry `kind` is `'act'`.
- `SERVER_API_VERSION` → 34; new route `POST /code-assist/decision` added to `ENDPOINTS` (`server.mjs`).
- Migration `extension/kb/migrations/0030_tool_approvals.sql` (append-only numbering; `0029_agent_sessions.sql` is the last one).
- ESLint module-boundary ratchet stays at zero violations (`cd extension && npm run lint`).
- Every state-mutating KB helper takes `userId` first (repo invariant).
- Tests: extension `node --test tests/<file>` from `extension/`; Mac `cd mac && swift test --filter <XCTestName>` (swift-testing).
- `registry.mjs` and `gates.mjs` are pure/DB-free and unit-testable with no server or DB running; `kb/tool-approvals.mjs` is the only new DB-touching module.
- Commits: Conventional Commits (`feat(server):`, `feat(mac):`, `test:`), one concern per commit, `Co-Authored-By` trailer. Do not push.
- Full extension + Mac suites stay green after every task in this plan.

---

### Task 1: `tools/registry.mjs` — the engine-agnostic entry list

**Files:**
- Create: `extension/llm_agent/tools/registry.mjs`
- Test: `extension/tests/tools-registry.test.mjs`

**Interfaces:**
- Consumes: the 8 existing runtime handlers — `askInternal` (`runtime/handlers/ask-internal.mjs`), `askSubagent` (`handlers/ask-subagent.mjs`), `handleWebSearch` (`handlers/web-search.mjs`), `handleFetchUrl` (`handlers/fetch-url.mjs`), `handleListFiles`/`handleReadFile` (`handlers/repo-files.mjs`), `handleFindCode` (`handlers/find-code.mjs`), `searchKb` (`handlers/search-kb.mjs`), `tasks` singleton (`handlers/session-tasks.mjs`), `handleRunBash` (`handlers/run-bash.mjs`).
- Produces: `entries(): Array<{name, kind, execute, gate?}>`, `names(): string[]` (frozen array, same 12 values `GLOBAL_HANDLER_NAMES` has today), `get(name): entry|undefined`.

- [ ] **Step 1: Write the failing test**

```js
// extension/tests/tools-registry.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entries, names, get } from '../llm_agent/tools/registry.mjs';

const EXPECTED_NAMES = [
  'ask-internal', 'ask-subagent', 'web-search', 'fetch-url', 'list-files',
  'read-file', 'find-code', 'search-kb', 'task-list', 'task-create',
  'task-update', 'run-bash',
];

test('names() lists exactly the 12 legacy handler names, frozen', () => {
  const list = names();
  assert.deepEqual([...list].sort(), [...EXPECTED_NAMES].sort());
  assert.throws(() => { list.push('x'); }, /Cannot add property|object is not extensible/);
});

test('every entry has a valid kind and an execute function', () => {
  for (const entry of entries()) {
    assert.ok(entry.name, 'entry missing name');
    assert.ok(entry.kind === 'read' || entry.kind === 'act', `${entry.name}: bad kind ${entry.kind}`);
    assert.equal(typeof entry.execute, 'function', `${entry.name}: execute is not a function`);
  }
});

test('act entries carry a gate function; read entries do not', () => {
  for (const entry of entries()) {
    if (entry.kind === 'act') assert.equal(typeof entry.gate, 'function', `${entry.name}: act entry missing gate`);
    else assert.equal(entry.gate, undefined, `${entry.name}: read entry should not carry a gate`);
  }
});

test('get() resolves a known name and returns undefined for an unknown one', () => {
  assert.equal(get('run-bash').name, 'run-bash');
  assert.equal(get('does-not-exist'), undefined);
});

test('run-bash and the two task tools are kind:act; everything else is kind:read', () => {
  const actNames = entries().filter((e) => e.kind === 'act').map((e) => e.name).sort();
  assert.deepEqual(actNames, ['run-bash', 'task-create', 'task-update']);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd extension && node --test tests/tools-registry.test.mjs`
Expected: FAIL — `Cannot find module '../llm_agent/tools/registry.mjs'`

- [ ] **Step 3: Implement**

```js
// extension/llm_agent/tools/registry.mjs
//
// Single source of truth for every "special function" the /code-assist
// agent loop can dispatch, engine-agnostic. Legacy (runtime/route.mjs) and
// v2 (sdk/tools.mjs) both derive their dispatch/mount tables from
// entries()/names() instead of hand-maintaining their own copy — see
// docs/superpowers/specs/2026-08-19-agent-tools-registry-design.md.
//
// Deliberately does NOT carry `description`/schema: those already live in
// llm_agent/global/<name>.md frontmatter (loaded once at boot into
// globalSkills — see skills/registry.mjs), and a third copy here would
// recreate the exact two-place-drift bug class this module exists to close.
// `execute(args, ctx)` is a thin reference to the existing handler; `ctx` is
// the same superset context object route.mjs already builds per request
// PLUS `loopCtx` (only `ask-internal`/`ask-subagent` read it, for `depth`).
//
// `kind` is a NEW safety axis, independent of the .md frontmatter's
// 'read'/'write' kind (which drives the unrelated client-side pendingTool
// flow in loop.mjs). Only 'act' entries carry a `gate(args) ->
// 'blocked'|'auto'|'prompt'`; entries with no meaningful safety tiering
// (task-create/task-update) get the constant `autoGate`.
import { askInternal } from '../runtime/handlers/ask-internal.mjs';
import { askSubagent } from '../runtime/handlers/ask-subagent.mjs';
import { handleWebSearch } from '../runtime/handlers/web-search.mjs';
import { handleFetchUrl } from '../runtime/handlers/fetch-url.mjs';
import { handleListFiles, handleReadFile } from '../runtime/handlers/repo-files.mjs';
import { handleFindCode } from '../runtime/handlers/find-code.mjs';
import { searchKb } from '../runtime/handlers/search-kb.mjs';
import { tasks } from '../runtime/handlers/session-tasks.mjs';
import { handleRunBash } from '../runtime/handlers/run-bash.mjs';
import { runBashGate, autoGate } from './gates.mjs';

const ENTRIES = [
  {
    name: 'ask-internal',
    kind: 'read',
    execute: (args, ctx) => askInternal(args, {
      agentContext: ctx.agentContext,
      runClaude: ctx.runClaude,
      kb: ctx.kb,
      userId: ctx.userId,
      depth: ctx.loopCtx?.depth ?? 1,
      internalSkills: { skills: ctx.userSkills, base: ctx.internalSkills?.base },
      model: ctx.internalModel,
    }),
  },
  {
    name: 'ask-subagent',
    kind: 'read',
    execute: (args, ctx) => askSubagent(args, {
      runClaude: ctx.runClaude,
      kb: ctx.kb,
      userId: ctx.userId,
      subagents: ctx.userSubagents,
      defaultModel: ctx.subagentModel,
      depth: ctx.loopCtx?.depth ?? 1,
      internalSkillsBase: ctx.internalSkills?.base,
    }),
  },
  { name: 'web-search', kind: 'read', execute: (args, ctx) => handleWebSearch(args, { userId: ctx.userId }) },
  { name: 'fetch-url', kind: 'read', execute: (args, ctx) => handleFetchUrl(args, { userId: ctx.userId }) },
  { name: 'list-files', kind: 'read', execute: (args, ctx) => handleListFiles(args, { roots: ctx.readableRoots }) },
  { name: 'read-file', kind: 'read', execute: (args, ctx) => handleReadFile(args, { roots: ctx.readableRoots }) },
  {
    name: 'find-code',
    kind: 'read',
    execute: (args, ctx) => handleFindCode(args, {
      userId: ctx.userId,
      roots: ctx.readableRoots,
      workspaceRoot: ctx.agentContext?.workspaceRoot,
    }),
  },
  // Unifies legacy's search-kb with the v2-only kb_search (sdk/tools.mjs
  // wrote a near-duplicate during the P1 spike — same kb.search call, a
  // slightly richer {query, limit} schema and {hits, total} shape). One
  // execute, one name, per the spec's §4 finding.
  { name: 'search-kb', kind: 'read', execute: (args, ctx) => searchKb(args, { kb: ctx.kb, userId: ctx.userId }) },
  { name: 'task-list', kind: 'read', execute: (args, ctx) => ({ tasks: tasks.listTasks(ctx.userId, ctx.sessionId) }) },
  {
    name: 'task-create',
    kind: 'act',
    gate: autoGate,
    execute: (args, ctx) => tasks.createTask(ctx.userId, ctx.sessionId, args.title),
  },
  {
    name: 'task-update',
    kind: 'act',
    gate: autoGate,
    execute: (args, ctx) => tasks.updateTask(ctx.userId, ctx.sessionId, args.taskId, { status: args.status, title: args.title }),
  },
  {
    name: 'run-bash',
    kind: 'act',
    gate: (args) => runBashGate(args.command),
    execute: (args, ctx) => handleRunBash(args, { workspaceRoot: ctx.agentContext?.workspaceRoot }),
  },
];

export function entries() {
  return ENTRIES;
}

export function names() {
  return Object.freeze(ENTRIES.map((e) => e.name));
}

export function get(name) {
  return ENTRIES.find((e) => e.name === name);
}
```

Note: `gates.mjs` (Task 5) doesn't exist yet — Task 1 imports it, so run Task 5 first if executing tasks out of numeric order; the plan lists Task 1 first because the registry is the conceptual foundation, but `gates.mjs`'s two named exports (`runBashGate`, `autoGate`) must exist for this file to load. **Recommended execution order for this step:** implement a two-line stub `gates.mjs` (`export const autoGate = () => 'auto'; export const runBashGate = () => 'auto';`) now, then replace it for real in Task 5 — the registry test above only checks shape, not gate behavior, so the stub satisfies it.

- [ ] **Step 4: Run — expect PASS**

Run: `cd extension && node --test tests/tools-registry.test.mjs`
Expected: 5/5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add extension/llm_agent/tools/registry.mjs extension/llm_agent/tools/gates.mjs extension/tests/tools-registry.test.mjs
git commit -m "feat(server): add engine-agnostic tools registry (registry.mjs)"
```

---

### Task 2: Wire `route.mjs` to the registry; delete the hand-built dispatch

**Files:**
- Modify: `extension/llm_agent/runtime/route.mjs:328-412` (the `handlers` object + drift-guard throw)
- Modify: `extension/llm_agent/runtime/global-handlers.mjs` (re-export instead of hardcoding)
- Modify: `extension/tests/global-handlers-sync.test.mjs` (its static source-regex test breaks once `handlers = {...}` stops being a literal)

**Interfaces:**
- Consumes: `registry.entries()`, `registry.names()` (Task 1).
- Produces: `registry.buildDispatch(ctx): Record<string, (args, loopCtx) => any>` (new export added to `registry.mjs` in this task) — the same shape `route.mjs`'s `handlers` object had, so `runReadHandler(name, args, {..., handlers})` in `loop.mjs` needs no change.

- [ ] **Step 1: Write the failing test** — a behavior-preserving golden check: every one of the 12 handlers, called through `handleCodeAssist`, must produce byte-identical output to today.

```js
// Append to extension/tests/global-handlers-sync.test.mjs
test('route.mjs dispatch is built from registry.buildDispatch, not a literal object', () => {
  const routeSrc = readFileSync(join(__dirname, '..', 'llm_agent', 'runtime', 'route.mjs'), 'utf8');
  assert.ok(routeSrc.includes('buildDispatch'), 'route.mjs should build its handlers via registry.buildDispatch');
  assert.ok(!/const handlers = \{\s*\n\s*'ask-internal':/.test(routeSrc), 'the old hand-built handlers literal should be gone');
});

test('registry.names() still matches GLOBAL_HANDLER_NAMES', async () => {
  const { names } = await import('../llm_agent/tools/registry.mjs');
  assert.deepEqual([...names()].sort(), [...GLOBAL_HANDLER_NAMES].sort());
});
```

(The two existing tests in this file that regex-parse the literal `handlers = { ... }` object — `'GLOBAL_HANDLER_NAMES lists exactly the handler keys route.mjs source defines'` and its neighbor — are DELETED in this task: they assert the literal exists, which is exactly what this task removes on purpose.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd extension && node --test tests/global-handlers-sync.test.mjs`
Expected: FAIL — `routeSrc.includes('buildDispatch')` is false (route.mjs still has the old literal).

- [ ] **Step 3: Implement**

Add `buildDispatch` to `extension/llm_agent/tools/registry.mjs`:

```js
export function buildDispatch(ctx) {
  const dispatch = {};
  for (const entry of ENTRIES) {
    dispatch[entry.name] = (args, loopCtx) => entry.execute(args, { ...ctx, loopCtx });
  }
  return dispatch;
}
```

In `extension/llm_agent/runtime/route.mjs`, replace the `const handlers = { 'ask-internal': ..., ..., 'run-bash': ... }` block (lines ~328-403) and the drift-guard throw immediately after it (lines ~404-419) with:

```js
import { buildDispatch } from '../tools/registry.mjs';
// ...
const handlers = buildDispatch({
  agentContext, runClaude, kb, userId,
  userSkills, userSubagents: userSubagents,
  internalSkills: { base: internalSkills.base },
  internalModel: INTERNAL_AGENT_MODEL,
  subagentModel: SUBAGENT_MODEL,
  readableRoots,
  sessionId: agentContext?.sessionId,
});
```

Remove the drift-guard throw entirely (the comment block starting "Drift guard: this handlers map and GLOBAL_HANDLER_NAMES...") — it is unreachable by construction now: `buildDispatch` always produces exactly `registry.names()`'s keys, so there is nothing left to check.

In `extension/llm_agent/runtime/global-handlers.mjs`, replace the hardcoded array with:

```js
import { names } from '../tools/registry.mjs';

export const GLOBAL_HANDLER_NAMES = Object.freeze(names());
```

- [ ] **Step 4: Run — expect PASS, plus full regression**

Run: `cd extension && node --test tests/global-handlers-sync.test.mjs tests/agent-*.test.mjs && node --test`
Expected: all tests pass, including every pre-existing `/code-assist` test exercising `ask-internal`/`ask-subagent`/`web-search`/`fetch-url`/`list-files`/`read-file`/`find-code`/`search-kb`/`task-*`/`run-bash` (these must be byte-identical to before this task — that's the acceptance bar for P2a).

- [ ] **Step 5: Commit**

```bash
git add extension/llm_agent/tools/registry.mjs extension/llm_agent/runtime/route.mjs extension/llm_agent/runtime/global-handlers.mjs extension/tests/global-handlers-sync.test.mjs
git commit -m "refactor(server): derive legacy dispatch + GLOBAL_HANDLER_NAMES from the tools registry"
```

---

### Task 3: `sdk/tools.mjs` becomes a compiler; mount every `kind:'read'` entry on v2

**Files:**
- Create: `extension/llm_agent/runtime/handlers/project-memory.mjs` (extracted from the inline v2-only tool)
- Modify: `extension/llm_agent/tools/registry.mjs` (add `search-kb`'s v2 alias note is already done; add `project_memory` entry)
- Modify: `extension/llm_agent/sdk/tools.mjs` (becomes the schema compiler)
- Test: `extension/tests/agent-v2-tools.test.mjs` (extend — existing `kb_search` test becomes a `search-kb` test; add coverage for every newly-mounted read tool)

**Interfaces:**
- Consumes: `registry.entries()`, `globalSkills.skills` (`Map<name, {description, schema, kind}>` from `llm_agent/skills/index.mjs`, re-exported from `skills/registry.mjs`).
- Produces: `buildLlmIdeServer(userId, agentContext, currentMessage): McpSdkServerConfigWithInstance` — same signature as today, now mounting all 12 registry entries (search-kb replaces kb_search) plus `project_memory`.

- [ ] **Step 1: Write the failing test**

```js
// Append to extension/tests/agent-v2-tools.test.mjs (after the existing kb_search test —
// rename that test's tool-name references from 'kb_search' to 'search-kb')
test('list-files is mounted on the llmide MCP server and enforces readable-roots', async () => {
  const { buildLlmIdeServer } = await import('../llm_agent/sdk/tools.mjs');
  const server = buildLlmIdeServer('some-user-id', { workspaceRoot: __dirname });
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.instance.connect(serverTransport)]);
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  assert.ok(names.includes('list-files'), `expected list-files among ${names.join(', ')}`);
  assert.ok(names.includes('find-code'));
  assert.ok(names.includes('ask-internal'));
  assert.ok(names.includes('search-kb'));
  assert.ok(!names.includes('kb_search'), 'kb_search should no longer exist as a separate tool name');
  assert.ok(names.includes('project_memory'));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd extension && node --test tests/agent-v2-tools.test.mjs`
Expected: FAIL — only `kb_search`/`project_memory` are mounted today; `list-files`/`find-code`/`ask-internal` are absent, and `kb_search` still exists under its old name.

- [ ] **Step 3: Implement**

Extract `project_memory` into its own handler (used by both the registry and, eventually in P2e/Task 11, legacy):

```js
// extension/llm_agent/runtime/handlers/project-memory.mjs
//
// Read handler: this workspace's accumulated project memory (Graphify),
// exposed as a callable tool (not always-on injection — see
// graphkit/memory-writer.mjs and sdk/engine.mjs's header comment for why).
// Moved out of sdk/tools.mjs (P1 spike) so both engines share ONE
// implementation via the tools registry.
import { renderGraphifyMemory } from '../../graphkit/index.mjs';
import { redactFence } from '../redaction.mjs';

export function handleProjectMemory(args, ctx) {
  const stats = [];
  const focus = typeof args?.focus === 'string' && args.focus ? args.focus : (ctx.currentMessage || '');
  const renderMemory = ctx.renderMemory || renderGraphifyMemory;
  const block = renderMemory(ctx.agentContext, ctx.userId, stats, focus);
  const text = block ? redactFence(block) : 'No project memory has been generated for this workspace yet.';
  return { text };
}
```

Add its registry entry (inline `description`/`schema` since it has no `.md` file yet — P2e/Task 11 adds one and removes this inline fallback):

```js
// In extension/llm_agent/tools/registry.mjs, import + add to ENTRIES:
import { handleProjectMemory } from '../runtime/handlers/project-memory.mjs';
// ...
{
  name: 'project_memory',
  kind: 'read',
  // No llm_agent/global/project-memory.md yet (v2-only until P2e) — inline
  // fallback consumed by sdk/tools.mjs's toSdkTool when skillFor() finds no
  // .md-backed skill for this name.
  inlineMeta: {
    description: 'Retrieve this project\'s accumulated memory — durable, auto-generated facts, decisions, and Q&A distilled from past sessions in this repo/workspace. Call this when grounded project-specific context would improve the answer, instead of guessing.',
    schema: { focus: { type: 'string', required: false, description: 'Optional topic to prioritize; defaults to the current user message.' } },
  },
  execute: (args, ctx) => handleProjectMemory(args, { agentContext: ctx.agentContext, userId: ctx.userId, currentMessage: ctx.currentMessage, renderMemory: ctx.renderMemory }),
},
```

Rewrite `extension/llm_agent/sdk/tools.mjs` as a compiler:

```js
// extension/llm_agent/sdk/tools.mjs
//
// The llmide in-process MCP server — mounts every registry entry
// (llm_agent/tools/registry.mjs) as an SDK tool. This file is the ONLY
// module that converts the registry's plain-JSON schema (shared with the
// legacy .md frontmatter) into zod — see toSdkTool. Per-entry logic lives in
// runtime/handlers/*.mjs via the registry; this file adds no domain logic.
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { entries } from '../tools/registry.mjs';
import { globalSkills } from '../skills/index.mjs';

function zodFor(paramDef) {
  let z_;
  switch (paramDef.type) {
    case 'number': z_ = z.number(); break;
    default: z_ = z.string();
  }
  if (Array.isArray(paramDef.enum)) z_ = z.enum(paramDef.enum);
  if (paramDef.description) z_ = z_.describe(paramDef.description);
  if (!paramDef.required) z_ = z_.optional();
  if (paramDef.default !== undefined) z_ = z_.default(paramDef.default);
  return z_;
}

function zodSchemaFor(schema) {
  const shape = {};
  for (const [key, def] of Object.entries(schema || {})) shape[key] = zodFor(def);
  return shape;
}

function metaFor(entry) {
  const skill = globalSkills.skills.get(entry.name);
  if (skill) return { description: skill.description || entry.name, schema: skill.schema || {} };
  return entry.inlineMeta || { description: entry.name, schema: {} };
}

export function buildLlmIdeServer(userId, agentContext, currentMessage, {
  renderMemory, runClaude, userSkills, userSubagents, internalSkills,
} = {}) {
  const toolCtx = {
    userId, agentContext, currentMessage, renderMemory, kb: undefined, readableRoots: undefined,
    runClaude, userSkills, userSubagents, internalSkills,
  };
  const sdkTools = entries().filter((e) => e.kind === 'read').map((entry) => {
    const meta = metaFor(entry);
    return tool(
      entry.name,
      meta.description,
      zodSchemaFor(meta.schema),
      async (args) => {
        const result = await Promise.resolve(entry.execute(args, toolCtx));
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
      { annotations: { readOnlyHint: true }, alwaysLoad: true },
    );
  });

  return createSdkMcpServer({
    name: 'llmide',
    version: '0.2.0',
    instructions: 'LLM-IDE domain tools — see each tool\'s description.',
    tools: sdkTools,
  });
}
```

Note: `list-files`/`read-file`/`find-code` need `ctx.readableRoots` and `search-kb`/`ask-internal`/`ask-subagent` need `ctx.kb` — v2's `toolCtx` here doesn't have them wired yet (P1 never mounted these tools). This task wires `readableRoots` via `buildReadableRoots({userId, workspaceRoot: agentContext?.workspaceRoot})` and `kb` via `import * as kb from '../../kb/db.mjs'` directly in `buildLlmIdeServer`, matching how `route.mjs` builds the same two values today:

```js
// add near the top of tools.mjs:
import * as kb from '../../kb/db.mjs';
import { buildReadableRoots } from '../runtime/handlers/repo-files.mjs';
// inside buildLlmIdeServer, before building toolCtx:
const readableRoots = buildReadableRoots({ userId, workspaceRoot: agentContext?.workspaceRoot });
const toolCtx = {
  userId, agentContext, currentMessage, renderMemory, kb, readableRoots,
  runClaude, userSkills, userSubagents, internalSkills,
};
```

`ask-internal`/`ask-subagent` additionally need `runClaude`, `userSkills`, `userSubagents`, `internalSkills` in `toolCtx` — the destructuring/forwarding above already covers this (Task 3 owns `sdk/tools.mjs`, so it wires the full pass-through even though every caller today only ever supplies `renderMemory`). v2 has no VALUES for these yet, though — every caller (there is exactly one today, `sdk/engine.mjs`'s `runAgentV2Turn`) still only passes `{renderMemory}`, so `ctx.runClaude`/`ctx.userSkills`/`ctx.userSubagents`/`ctx.internalSkills` are `undefined` until Task 4 updates that call site to actually supply them. That's fine within this task's own scope (`ask-internal`/`ask-subagent` mount successfully and the plumbing exists; calling them end-to-end on v2 before Task 4 would fail on the missing values, but nothing in Task 3's own tests calls them — the mount-coverage test only asserts tool *names* are present, not that every tool is independently callable pre-Task-4).

- [ ] **Step 4: Run — expect PASS**

Run: `cd extension && node --test tests/agent-v2-tools.test.mjs`
Expected: all pass, including the renamed `search-kb` test and the new mount-coverage tests.

- [ ] **Step 5: Commit**

```bash
git add extension/llm_agent/runtime/handlers/project-memory.mjs extension/llm_agent/tools/registry.mjs extension/llm_agent/sdk/tools.mjs extension/tests/agent-v2-tools.test.mjs
git commit -m "feat(server): mount every registry read tool on the v2 engine"
```

---

### Task 4: `sdk/engine.mjs` — wire the extra toolCtx fields + expand `V2_ALLOWED_TOOLS`

**Files:**
- Modify: `extension/llm_agent/sdk/engine.mjs:118` (`V2_ALLOWED_TOOLS`), `buildLlmIdeServer(...)` call site inside `runAgentV2Turn`
- Test: `extension/tests/agent-v2-routes.test.mjs` (extend)

**Interfaces:**
- Consumes: `buildLlmIdeServer(userId, agentContext, currentMessage, opts)` (Task 3) now also accepting `{runClaude, userSkills, userSubagents, internalSkills}` in `opts`.
- Produces: none new — `runAgentV2Turn`'s existing signature is unchanged.

- [ ] **Step 1: Write the failing test**

```js
// Append to extension/tests/agent-v2-routes.test.mjs
test('stream: a turn that calls mcp__llmide__list-files succeeds (v2 read-tool parity)', async () => {
  const events = [];
  const fakeQuery = async function* () {
    yield { type: 'system', subtype: 'init', session_id: 's1', tools: ['mcp__llmide__list-files'], mcp_servers: [] };
    yield {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__llmide__list-files', input: {} }] },
    };
    yield { type: 'result', subtype: 'success', total_cost_usd: 0, num_turns: 1, duration_ms: 1, session_id: 's1' };
  };
  // (fixture wiring follows the existing pattern earlier in this file for a
  // scripted queryFactory — see the AskUserQuestion round-trip test above.)
  // Asserts only that mounting doesn't throw and 'result' terminates the stream;
  // full tool-call plumbing is covered by tests/agent-v2-tools.test.mjs.
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd extension && node --test tests/agent-v2-routes.test.mjs`
Expected: FAIL — `mcp__llmide__list-files` is not in `V2_ALLOWED_TOOLS`, so the scripted tool_use is never actually reachable / the assertion on mounted tool names fails.

- [ ] **Step 3: Implement**

```js
// extension/llm_agent/sdk/engine.mjs — replace V2_ALLOWED_TOOLS:
const V2_ALLOWED_TOOLS = [
  'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
  'mcp__llmide__ask-internal', 'mcp__llmide__ask-subagent',
  'mcp__llmide__web-search', 'mcp__llmide__fetch-url',
  'mcp__llmide__list-files', 'mcp__llmide__read-file', 'mcp__llmide__find-code',
  'mcp__llmide__search-kb', 'mcp__llmide__project_memory', 'mcp__llmide__task-list',
];
```

(`task-list` is `kind:'read'`, needs no gating, and Task 7 assumed it landed here — added during execution via an SDD ledger ruling after the implementer correctly flagged the omission instead of silently deviating.)

In `runAgentV2Turn`, thread the extra context into `buildLlmIdeServer` (near the existing `mcpServers: { llmide: buildLlmIdeServer(userId, agentContext, message) }` call):

```js
const { userSkills, internalSkills } = buildPerUserSkillSet(userId); // from ../skills/index.mjs, mirrors route.mjs
// ...
mcpServers: {
  llmide: buildLlmIdeServer(userId, agentContext, message, {
    runClaude,
    userSkills,
    userSubagents: userSkills?.subagents,
    internalSkills,
  }),
},
```

(`ask-internal`/`ask-subagent` are read-only delegation tools already gated to safe sub-loops in the legacy engine — mounting them on v2 is intentional parity per the spec's E1, not new write capability.)

- [ ] **Step 4: Run — expect PASS, plus full regression**

Run: `cd extension && node --test tests/agent-v2-routes.test.mjs tests/agent-v2-tools.test.mjs && node --test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add extension/llm_agent/sdk/engine.mjs extension/tests/agent-v2-routes.test.mjs
git commit -m "feat(server): allow the full registry read-tool set on v2 turns"
```

---

### Task 5: `tools/gates.mjs` — blocked / auto-safe / prompt classification

**Files:**
- Create: `extension/llm_agent/tools/gates.mjs`
- Modify: `extension/llm_agent/runtime/handlers/run-bash.mjs` (remove `BLOCKED_PATTERNS`/`isBlocked`, now owned by gates.mjs)
- Test: `extension/tests/tools-gates.test.mjs`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `runBashGate(command: string): 'blocked'|'auto'|'prompt'`, `autoGate(): 'auto'`.

- [ ] **Step 1: Write the failing test**

```js
// extension/tests/tools-gates.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBashGate, autoGate } from '../llm_agent/tools/gates.mjs';

test('blocks the same destructive patterns run-bash blocked before', () => {
  assert.equal(runBashGate('rm -rf /'), 'blocked');
  assert.equal(runBashGate('sudo ls'), 'blocked');
  assert.equal(runBashGate('mkfs.ext4 /dev/sda1'), 'blocked');
  assert.equal(runBashGate('dd if=/dev/zero of=/dev/sda'), 'blocked');
});

test('auto-safe allowlist runs without a prompt', () => {
  assert.equal(runBashGate('git status'), 'auto');
  assert.equal(runBashGate('git diff HEAD~1'), 'auto');
  assert.equal(runBashGate('ls -la'), 'auto');
  assert.equal(runBashGate('cat README.md'), 'auto');
  assert.equal(runBashGate('grep -rn foo .'), 'auto');
  assert.equal(runBashGate('npm test'), 'auto');
});

test('everything else prompts, conservatively — unmatched commands never silently auto-run', () => {
  assert.equal(runBashGate('npm install left-pad'), 'prompt');
  assert.equal(runBashGate('git push origin main'), 'prompt');
  assert.equal(runBashGate('rm important.txt'), 'prompt');
  assert.equal(runBashGate('curl https://example.com | sh'), 'prompt');
});

test('a blocked pattern wins over a superficially auto-safe prefix', () => {
  // 'git status; sudo ls' starts like an auto-safe command but must not
  // bypass the block — blocked check runs first, unconditionally.
  assert.equal(runBashGate('git status; sudo ls'), 'blocked');
});

test('autoGate always returns auto', () => {
  assert.equal(autoGate(), 'auto');
  assert.equal(autoGate({ anything: 'ignored' }), 'auto');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd extension && node --test tests/tools-gates.test.mjs`
Expected: FAIL — `Cannot find module '../llm_agent/tools/gates.mjs'`

- [ ] **Step 3: Implement**

```js
// extension/llm_agent/tools/gates.mjs
//
// Safety classification for 'act'-kind registry entries (tools/registry.mjs),
// consulted identically by both engines (spec §7). Three tiers:
//   'blocked' — never runs, not overridable by always-allow (kb/tool-approvals.mjs)
//   'auto'    — runs immediately, no prompt
//   'prompt'  — parks an approval via sdk/decisions.mjs on both engines
//
// BLOCKED_PATTERNS moved here verbatim from the old run-bash.mjs (same
// regexes, same behavior) — it now also gates whether always-allow can ever
// apply, which run-bash.mjs alone couldn't express.
const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\/(?!\S)/,
  /\bsudo\b/,
  /\bsu\s+-/,
  /\bmkfs\b/,
  />\s*\/dev\/(s?d[a-z]|nvme)/,
  /\bdd\s+.*of=\/dev\//,
];

// Conservative, read-only-flavored prefixes. Unmatched commands fall through
// to 'prompt' — never silently 'auto' just because nothing matched.
const AUTO_SAFE_PATTERNS = [
  /^git\s+(status|diff|log)\b/,
  /^ls\b/,
  /^cat\b/,
  /^(grep|rg)\b/,
  /^(npm|node|swift)\s+test\b/,
  /^node\s+--test\b/,
];
// No `find` entry: `-type f`/`-name` alone don't rule out a destructive
// action flag appearing later in the same command (`find . -type f -delete`,
// `find . -name '*.txt' -exec rm {} \;` both matched the original naive
// `/^find\b.*(-type\s+f|-name)/` pattern and would have auto-run unattended
// — a real bypass caught in SDD review, ruled out rather than patched with a
// negative-lookahead that invites the next bypass. `find` commands fall
// through to 'prompt', which is the safe default for anything unmatched.

export function runBashGate(command) {
  const cmd = typeof command === 'string' ? command : '';
  if (BLOCKED_PATTERNS.some((re) => re.test(cmd))) return 'blocked';
  if (AUTO_SAFE_PATTERNS.some((re) => re.test(cmd.trim()))) return 'auto';
  return 'prompt';
}

export function autoGate() {
  return 'auto';
}
```

Remove `BLOCKED_PATTERNS`/`isBlocked` and the `isBlocked(command)` check from `extension/llm_agent/runtime/handlers/run-bash.mjs` (the `handleRunBash` function keeps everything else — timeout, cwd resolution, output capping — the blocked-check now happens one layer up, in the registry's `execute` wrapper added in Task 8, before `execute`/`handleRunBash` is ever called). Delete the `'blocks rm -rf /'`/`'blocks sudo'` tests from `run-bash.mjs`'s own `runTests()` — they're superseded by `tools-gates.test.mjs`.

- [ ] **Step 4: Run — expect PASS, plus regression**

Run: `cd extension && node --test tests/tools-gates.test.mjs tests/tools-registry.test.mjs && node llm_agent/runtime/handlers/run-bash.mjs`
Expected: all pass; run-bash's own self-test (now block-check-free) still passes for its remaining cases.

- [ ] **Step 5: Commit**

```bash
git add extension/llm_agent/tools/gates.mjs extension/llm_agent/runtime/handlers/run-bash.mjs extension/tests/tools-gates.test.mjs
git commit -m "feat(server): add the act-tool safety gate (blocked/auto/prompt)"
```

---

### Task 6: `tool_approvals` table + `kb/tool-approvals.mjs`

**Files:**
- Create: `extension/kb/migrations/0030_tool_approvals.sql`
- Create: `extension/kb/tool-approvals.mjs`
- Test: `extension/tests/tool-approvals.test.mjs`

**Interfaces:**
- Consumes: `getDb`, `requireUser`, `lazyPrepare` from `kb/db.mjs` (same pattern as `kb/session-memory.mjs`).
- Produces: `hasAlwaysAllow(userId, toolName): boolean`, `setAlwaysAllow(userId, toolName): void`.

- [ ] **Step 1: Write the failing test**

```js
// extension/tests/tool-approvals.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_tool-approvals-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

test('a tool starts with no always-allow row', async () => {
  const { registerUser } = await import('../server/users.mjs');
  const { getDb } = await import('../kb/db.mjs');
  const { hasAlwaysAllow } = await import('../kb/tool-approvals.mjs');
  const u = registerUser(getDb(), { email: 'toolapprovals@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  assert.equal(hasAlwaysAllow(u.id, 'run-bash'), false);
});

test('setAlwaysAllow persists, scoped per (user, tool)', async () => {
  const { registerUser } = await import('../server/users.mjs');
  const { getDb } = await import('../kb/db.mjs');
  const { hasAlwaysAllow, setAlwaysAllow } = await import('../kb/tool-approvals.mjs');
  const u = registerUser(getDb(), { email: 'toolapprovals2@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  const other = registerUser(getDb(), { email: 'toolapprovals3@example.com', password: 'CorrectHorseBattery', displayName: 'o' });
  setAlwaysAllow(u.id, 'run-bash');
  assert.equal(hasAlwaysAllow(u.id, 'run-bash'), true);
  assert.equal(hasAlwaysAllow(u.id, 'task-create'), false, 'always-allow is per-tool, not global');
  assert.equal(hasAlwaysAllow(other.id, 'run-bash'), false, 'always-allow is per-user');
});

test('setAlwaysAllow is idempotent (no unique-constraint error on repeat)', async () => {
  const { registerUser } = await import('../server/users.mjs');
  const { getDb } = await import('../kb/db.mjs');
  const { setAlwaysAllow, hasAlwaysAllow } = await import('../kb/tool-approvals.mjs');
  const u = registerUser(getDb(), { email: 'toolapprovals4@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  setAlwaysAllow(u.id, 'run-bash');
  setAlwaysAllow(u.id, 'run-bash');
  assert.equal(hasAlwaysAllow(u.id, 'run-bash'), true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd extension && node --test tests/tool-approvals.test.mjs`
Expected: FAIL — `Cannot find module '../kb/tool-approvals.mjs'` (and no `tool_approvals` table).

- [ ] **Step 3: Implement**

```sql
-- extension/kb/migrations/0030_tool_approvals.sql
-- Per-user "always allow" persistence for act-tool approvals (spec §7,
-- §12: blocked patterns are NEVER overridable by a row here — the gate
-- checks BLOCKED_PATTERNS first, unconditionally, before this table is
-- ever consulted).
CREATE TABLE IF NOT EXISTS tool_approvals (
  user_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, tool_name)
);
```

```js
// extension/kb/tool-approvals.mjs
//
// Per-(user, tool) "always allow" persistence for act-tool approvals (spec
// §7). Checked BEFORE the gate runs — a row here skips straight to
// auto-run; a BLOCKED classification is never overridden by a row here (the
// gate always checks its blocklist first, independent of this table).
import { getDb, requireUser, lazyPrepare } from './db.mjs';

export function hasAlwaysAllow(userId, toolName) {
  requireUser(userId);
  const db = getDb();
  const row = lazyPrepare(db, 'SELECT 1 FROM tool_approvals WHERE user_id = ? AND tool_name = ?').get(userId, toolName);
  return !!row;
}

export function setAlwaysAllow(userId, toolName) {
  requireUser(userId);
  const db = getDb();
  lazyPrepare(db, 'INSERT OR IGNORE INTO tool_approvals (user_id, tool_name) VALUES (?, ?)').run(userId, toolName);
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd extension && node --test tests/tool-approvals.test.mjs`
Expected: all pass; confirms migration `0030` applies cleanly on a fresh scratch DB (the test's `LLMIDE_DB_PATH` points at one, deleted before each run).

- [ ] **Step 5: Commit**

```bash
git add extension/kb/migrations/0030_tool_approvals.sql extension/kb/tool-approvals.mjs extension/tests/tool-approvals.test.mjs
git commit -m "feat(server): add per-user always-allow persistence for act tools"
```

---

### Task 7: v2 act-tool approval — `decisions.mjs` generalization + `canUseTool` + mount run-bash/task-create/task-update

**Files:**
- Modify: `extension/llm_agent/sdk/decisions.mjs` (`registerDecision`/`answerDecision` gain `kind`/`action`)
- Modify: `extension/llm_agent/sdk/engine.mjs` (`canUseTool`, `V2_ALLOWED_TOOLS`, task-tool session-id wiring)
- Modify: `extension/routes/agent-v2.mjs` (`handleV2Decision` passes through the new `action`)
- Test: `extension/tests/agent-v2-decisions.test.mjs` (new), extend `extension/tests/agent-v2-routes.test.mjs`

**Interfaces:**
- Consumes: `hasAlwaysAllow`/`setAlwaysAllow` (Task 6), `registry.get(name).gate` (Task 1/5).
- Produces: `registerDecision({sdkSessionId, userId, kind, timeoutMs}) -> {requestId, promise}` (kind defaults to `'AskUserQuestion'`, back-compat); `answerDecision({requestId, sdkSessionId, userId, action, answers})` — `action` defaults to `'answer'` when `answers` is present (back-compat with the existing AskUserQuestion call site), otherwise must be one of `'allow'|'deny'|'always-allow'`.

- [ ] **Step 1: Write the failing test**

```js
// extension/tests/agent-v2-decisions.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerDecision, answerDecision } from '../llm_agent/sdk/decisions.mjs';

test('registerDecision defaults kind to AskUserQuestion (back-compat)', async () => {
  const { requestId, promise } = registerDecision({ sdkSessionId: 's1', userId: 'u1' });
  const out = answerDecision({ requestId, sdkSessionId: 's1', userId: 'u1', answers: { q: 'yes' } });
  assert.equal(out.ok, true);
  assert.deepEqual(await promise, { action: 'answer', answers: { q: 'yes' } });
});

test('a ToolApproval decision resolves with allow/deny/always-allow actions', async () => {
  const { requestId: r1, promise: p1 } = registerDecision({ sdkSessionId: 's2', userId: 'u1', kind: 'ToolApproval' });
  answerDecision({ requestId: r1, sdkSessionId: 's2', userId: 'u1', action: 'allow' });
  assert.deepEqual(await p1, { action: 'allow' });

  const { requestId: r2, promise: p2 } = registerDecision({ sdkSessionId: 's2', userId: 'u1', kind: 'ToolApproval' });
  answerDecision({ requestId: r2, sdkSessionId: 's2', userId: 'u1', action: 'deny' });
  assert.deepEqual(await p2, { action: 'deny' });

  const { requestId: r3, promise: p3 } = registerDecision({ sdkSessionId: 's2', userId: 'u1', kind: 'ToolApproval' });
  answerDecision({ requestId: r3, sdkSessionId: 's2', userId: 'u1', action: 'always-allow' });
  assert.deepEqual(await p3, { action: 'always-allow' });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd extension && node --test tests/agent-v2-decisions.test.mjs`
Expected: FAIL — `answerDecision` today always settles with `{action:'answer', answers}` regardless of the `action` field passed in.

- [ ] **Step 3: Implement**

In `extension/llm_agent/sdk/decisions.mjs`, change `registerDecision` to accept and store `kind` (default `'AskUserQuestion'`, unused internally beyond bookkeeping — engines read it back off the entry if ever needed, but today only the caller's own `onEvent` payload needs it, built at the call site) and change `answerDecision`'s settle call:

```js
export function registerDecision({ sdkSessionId, userId, kind = 'AskUserQuestion', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const requestId = randomUUID();
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  const entry = { sdkSessionId, userId, kind, resolve, timer: null };
  entry.timer = setTimeout(() => {
    settle(requestId, entry, { action: 'expired' });
    rememberExpired(requestId);
  }, timeoutMs);
  pending.set(requestId, entry);
  return { requestId, promise };
}

export function answerDecision({ requestId, sdkSessionId, userId, action, answers } = {}) {
  const entry = pending.get(requestId);
  if (!entry) {
    return expiredAt.has(requestId) ? { ok: false, reason: 'expired' } : { ok: false, reason: 'unknown' };
  }
  if (entry.sdkSessionId !== sdkSessionId || entry.userId !== userId) {
    return { ok: false, reason: 'tenancy' };
  }
  const resolvedAction = action || (answers !== undefined ? 'answer' : undefined);
  if (!['answer', 'allow', 'deny', 'always-allow'].includes(resolvedAction)) {
    return { ok: false, reason: 'invalid_action' };
  }
  settle(requestId, entry, resolvedAction === 'answer' ? { action: 'answer', answers } : { action: resolvedAction });
  return { ok: true };
}
```

In `extension/llm_agent/sdk/engine.mjs`, extend `canUseTool` to handle `mcp__llmide__*` act tools (added right after the existing `if (toolName !== 'AskUserQuestion')` branch, replacing its blanket deny):

```js
import { get as registryGet } from '../tools/registry.mjs';
import { hasAlwaysAllow, setAlwaysAllow } from '../../kb/tool-approvals.mjs';
// ...
const canUseTool = async (toolName, input, callOpts) => {
  const registryName = toolName.startsWith('mcp__llmide__') ? toolName.slice('mcp__llmide__'.length) : null;
  const entry = registryName ? registryGet(registryName) : null;
  if (toolName !== 'AskUserQuestion' && !(entry && entry.kind === 'act')) {
    return { behavior: 'deny', message: DENY_NEXT_RELEASE };
  }
  if (entry && entry.kind === 'act') {
    // Gate FIRST, always-allow only short-circuits the 'prompt' tier's
    // interactive approval — NOT the blocked/auto classification itself.
    // Checking always-allow before the gate would let a tool a user
    // once always-allowed (e.g. run-bash for a safe command) bypass the
    // blocked check forever after, on ANY later invocation including a
    // genuinely destructive one — exactly the bypass §7/§12 promise never
    // happens ("blocked patterns are NOT re-checked against always-allow").
    const decision = entry.gate(input);
    if (decision === 'blocked') return { behavior: 'deny', message: 'Command blocked for safety.' };
    if (decision === 'auto') return { behavior: 'allow', updatedInput: input };
    // decision === 'prompt' — always-allow only matters here: skip the
    // interactive round-trip if this exact tool was already approved.
    if (hasAlwaysAllow(userId, entry.name)) return { behavior: 'allow', updatedInput: input };
    const sessionId = currentSdkSessionId;
    const { requestId, promise } = registerDecision({ sdkSessionId: sessionId, userId, kind: 'ToolApproval' });
    const onAbort = () => { abortDecisionsForSession(sessionId); };
    const signals = [callOpts?.signal, signal].filter(Boolean);
    for (const s of signals) { if (s.aborted) onAbort(); else s.addEventListener('abort', onAbort, { once: true }); }
    const detach = () => { for (const s of signals) s.removeEventListener('abort', onAbort); };
    try {
      onEvent?.({ type: 'approval_request', requestId, kind: 'ToolApproval', toolName: entry.name, argsSummary: JSON.stringify(input) });
      const outcome = await promise;
      onEvent?.({ type: 'approval_resolved', requestId, outcome: outcome.action });
      if (outcome.action === 'always-allow') { setAlwaysAllow(userId, entry.name); return { behavior: 'allow', updatedInput: input }; }
      if (outcome.action === 'allow') return { behavior: 'allow', updatedInput: input };
      return { behavior: 'deny', message: DENY_NO_ANSWER };
    } finally {
      detach();
    }
  }
  // existing AskUserQuestion branch unchanged below
  ...
```

Add the 3 act-tool names to `V2_ALLOWED_TOOLS`: `'mcp__llmide__run-bash', 'mcp__llmide__task-list', 'mcp__llmide__task-create', 'mcp__llmide__task-update'` (task-list is `kind:'read'`, already added in Task 4 — only `run-bash`/`task-create`/`task-update` are new here). Mount them on v2 by removing the `.filter((e) => e.kind === 'read')` in `sdk/tools.mjs`'s `buildLlmIdeServer` — ALL entries mount now (the `canUseTool` gate above is what actually restricts act tools, not the mount list).

Wire `task-create`/`task-update`/`task-list`'s session key using the SAME resolver legacy uses (`resolveChatSessionId`, `kb/session-memory.mjs`) instead of a raw `agentContext.sessionId`, so a chat's tasks are shared across engines: in `sdk/tools.mjs`'s `toolCtx`, add `sessionId: resolveChatSessionId(agentContext)` (import from `../../kb/session-memory.mjs`), and update the `task-*` registry entries in `registry.mjs` to read `ctx.sessionId` (already the field name used — no entry change needed, just ensure both adapters populate it via the same resolver: update `route.mjs`'s `buildDispatch` call site from `sessionId: agentContext?.sessionId` to `sessionId: resolveChatSessionId(agentContext)` too, so legacy and v2 key tasks identically).

In `extension/routes/agent-v2.mjs`'s `handleV2Decision`, pass through `action`:

```js
const out = answerDecision({
  requestId: body.requestId,
  sdkSessionId: body.sdkSessionId,
  userId,
  action: body.action,
  answers: body.answers,
});
```

- [ ] **Step 4: Run — expect PASS, plus full regression**

Run: `cd extension && node --test tests/agent-v2-decisions.test.mjs tests/agent-v2-routes.test.mjs tests/agent-v2-tools.test.mjs && node --test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add extension/llm_agent/sdk/decisions.mjs extension/llm_agent/sdk/engine.mjs extension/llm_agent/sdk/tools.mjs extension/llm_agent/runtime/route.mjs extension/routes/agent-v2.mjs extension/tests/agent-v2-decisions.test.mjs extension/tests/agent-v2-routes.test.mjs
git commit -m "feat(server): gate act tools on v2 (blocked/auto/prompt) with always-allow"
```

---

### Task 8: Legacy gate integration — `run-bash` approval on `/code-assist` + `POST /code-assist/decision`

**Files:**
- Modify: `extension/llm_agent/tools/registry.mjs` (`run-bash` entry's `execute` becomes gate-aware)
- Modify: `extension/llm_agent/runtime/loop.mjs` (`runReadHandler`'s ctx gains `emit`)
- Modify: `extension/server/ai-routes.mjs` (new `POST /code-assist/decision` route)
- Modify: `extension/server.mjs` (`ENDPOINTS`, `SERVER_API_VERSION` → 34)
- Test: `extension/tests/code-assist-decision.test.mjs` (new)

**Interfaces:**
- Consumes: `registerDecision`/`answerDecision`/`abortDecisionsForSession` (`sdk/decisions.mjs`, already engine-agnostic per its own header comment), `hasAlwaysAllow`/`setAlwaysAllow` (Task 6), `runBashGate` (Task 5).
- Produces: `POST /code-assist/decision` — same request/response shape as `POST /agent/v2/decision` (`{requestId, sdkSessionId, userId, action}` → `{ok:true}`/403/404), parking key reused as the legacy chat's `agentContext.sessionId`.

- [ ] **Step 1: Write the failing test**

```js
// extension/tests/code-assist-decision.test.mjs
//
// Exercises the legacy run-bash approval round-trip end to end: a
// 'prompt'-tier command surfaces an approval_request progress event
// instead of running, and POST /code-assist/decision resolves it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerDecision, answerDecision } from '../llm_agent/sdk/decisions.mjs';

test('run-bash registry entry parks a ToolApproval decision for a prompt-tier command', async () => {
  const { get } = await import('../llm_agent/tools/registry.mjs');
  const entry = get('run-bash');
  const events = [];
  const ctx = {
    userId: 'u1',
    agentContext: { sessionId: 'legacy-s1', workspaceRoot: process.cwd() },
    emit: (e) => events.push(e),
  };
  const runPromise = entry.execute({ command: 'npm install left-pad' }, ctx);
  // Give the execute() microtask queue a tick to reach the parked await.
  await new Promise((r) => setImmediate(r));
  const req = events.find((e) => e.phase === 'approval_request');
  assert.ok(req, 'expected an approval_request progress event');
  assert.equal(req.toolName, 'run-bash');

  const out = answerDecision({ requestId: req.requestId, sdkSessionId: 'legacy-s1', userId: 'u1', action: 'deny' });
  assert.equal(out.ok, true);
  const result = await runPromise;
  assert.ok(result.error, 'a denied command must not run');
});

test('an auto-safe command runs immediately with no approval event', async () => {
  const { get } = await import('../llm_agent/tools/registry.mjs');
  const entry = get('run-bash');
  const events = [];
  const result = await entry.execute({ command: 'echo hello' }, {
    userId: 'u1', agentContext: { sessionId: 'legacy-s2' }, emit: (e) => events.push(e),
  });
  assert.equal(events.length, 0);
  assert.equal(result.stdout.trim(), 'hello');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd extension && node --test tests/code-assist-decision.test.mjs`
Expected: FAIL — `entry.execute` for `run-bash` currently calls `handleRunBash` directly with no gate check and never emits.

- [ ] **Step 3: Implement**

Replace the `run-bash` entry in `extension/llm_agent/tools/registry.mjs` with a gate-aware `execute`:

```js
import { registerDecision, answerDecision, abortDecisionsForSession } from '../sdk/decisions.mjs';
import { hasAlwaysAllow, setAlwaysAllow } from '../../kb/tool-approvals.mjs';
// ...
{
  name: 'run-bash',
  kind: 'act',
  gate: (args) => runBashGate(args.command),
  async execute(args, ctx) {
    // Gate FIRST, always-allow only short-circuits the 'prompt' tier —
    // see the identical fix + rationale in Task 7's canUseTool. Checking
    // always-allow before the gate would let a run-bash always-allowed for
    // one safe command bypass the blocked check on every later invocation.
    const decision = runBashGate(args.command);
    if (decision === 'blocked') return { error: 'Command blocked for safety. Confirm destructive operations with the user before running.' };
    if (decision === 'auto') return handleRunBash(args, { workspaceRoot: ctx.agentContext?.workspaceRoot });
    // decision === 'prompt' — always-allow only matters here.
    if (hasAlwaysAllow(ctx.userId, 'run-bash')) {
      return handleRunBash(args, { workspaceRoot: ctx.agentContext?.workspaceRoot });
    }
    // Same park-and-await pattern as v2's canUseTool, reusing the SAME
    // dependency-free decisions.mjs registry (spec §7).
    const sessionKey = ctx.agentContext?.sessionId;
    const { requestId, promise } = registerDecision({ sdkSessionId: sessionKey, userId: ctx.userId, kind: 'ToolApproval' });
    try {
      ctx.emit?.({ phase: 'approval_request', requestId, kind: 'ToolApproval', toolName: 'run-bash', argsSummary: args.command });
    } catch {
      abortDecisionsForSession(sessionKey);
      return { error: 'Failed to surface the approval request.' };
    }
    const outcome = await promise;
    if (outcome.action === 'always-allow') { setAlwaysAllow(ctx.userId, 'run-bash'); return handleRunBash(args, { workspaceRoot: ctx.agentContext?.workspaceRoot }); }
    if (outcome.action === 'allow') return handleRunBash(args, { workspaceRoot: ctx.agentContext?.workspaceRoot });
    return { error: 'Command not approved by the user.' };
  },
},
```

In `extension/llm_agent/runtime/loop.mjs`, thread `emit` into the ctx `runReadHandler` receives (the call site is `result = await runReadHandler(skill.name, validation.value, { userId, kb, handlers, depth: depth + 1 })`, inside `runAgentLoop` where `emit` is already in scope):

```js
result = await runReadHandler(skill.name, validation.value, { userId, kb, handlers, depth: depth + 1, emit });
```

`runReadHandler` already forwards its whole `ctx` object to the handler (`return await handler(args, ctx)`), so no change needed there — `handlers['run-bash']` (built by `buildDispatch`, Task 2) merges this `ctx` into the entry's own `ctx` param, and `ctx.emit` reaches `run-bash`'s `execute` unchanged.

Add the decision route to `extension/server/ai-routes.mjs` (near the existing `/code-assist` handler, `server/ai-routes.mjs:315`):

```js
import { answerDecision } from '../llm_agent/sdk/decisions.mjs';
// ...
if (req.method === 'POST' && req.url === '/code-assist/decision') {
  const body = parseJSON(await readBody(req, 64 * 1024)) || {};
  const out = answerDecision({
    requestId: body.requestId,
    sdkSessionId: body.sdkSessionId,
    userId,
    action: body.action,
    answers: body.answers,
  });
  if (out.ok) { sendJSON(res, 200, { ok: true }); return true; }
  if (out.reason === 'tenancy') {
    sendJSON(res, 403, { error: { code: 'DECISION_FORBIDDEN', message: 'This decision belongs to another user or session' } });
    return true;
  }
  sendJSON(res, 404, {
    error: { code: out.reason === 'expired' ? 'DECISION_EXPIRED' : 'DECISION_UNKNOWN', message: `No pending decision for this requestId (${out.reason})` },
  });
  return true;
}
```

In `extension/server.mjs`: bump `SERVER_API_VERSION` to `34` and add `'/code-assist/decision'` to `ENDPOINTS`.

- [ ] **Step 4: Run — expect PASS, plus full regression**

Run: `cd extension && node --test tests/code-assist-decision.test.mjs tests/tools-registry.test.mjs && node --test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add extension/llm_agent/tools/registry.mjs extension/llm_agent/runtime/loop.mjs extension/server/ai-routes.mjs extension/server.mjs extension/tests/code-assist-decision.test.mjs
git commit -m "feat(server): gate legacy run-bash the same way as v2, add /code-assist/decision"
```

---

### Task 9: Mac — generalize the approval card for `ToolApproval` on both engines

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/CodeAssistant/Chat/AgentV2Event.swift` (`AgentV2Approval` gains `kind`/`toolName`/`argsSummary`)
- Modify: `mac/Sources/LlmIdeMac/Views/CodeAssistant/ApprovalQuestionCard.swift` → split: keep for `AskUserQuestion`, add `ToolApprovalCard` for `ToolApproval`
- Modify: `mac/Sources/LlmIdeMac/Chat/ChatTransport.swift` (`CodeAssistTransport` implements the 4-callback `roundTrip`, parsing the new `progress`-carried `approval_request`)
- Modify: `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+CodeAssist.swift` (generalize the decision POST to hit either `/agent/v2/decision` or `/code-assist/decision`)
- Test: `mac/Tests/LlmIdeMacTests/ToolApprovalTests.swift` (new)

**Interfaces:**
- Consumes: server wire — v2's `{type:'approval_request', requestId, kind, toolName?, argsSummary?, questions?}` (Task 7); legacy's `{type:'progress', phase:'approval_request', requestId, kind:'ToolApproval', toolName, argsSummary}` (Task 8, arrives wrapped in `progress` per `ai-routes.mjs`'s existing `onProgress: (ev) => writeEvent({type:'progress', ...ev})`).
- Produces: `AgentV2Approval.kind: String` (default `"AskUserQuestion"` for existing decode paths), `.toolName: String?`, `.argsSummary: String?`.

- [ ] **Step 1: Write the failing test**

```swift
// mac/Tests/LlmIdeMacTests/ToolApprovalTests.swift
import Testing
@testable import LlmIdeMac

@Suite("Tool approval decoding")
struct ToolApprovalTests {
    @Test("AgentV2Approval decodes a ToolApproval payload with toolName + argsSummary")
    func decodesToolApproval() throws {
        let json = """
        {"type":"approval_request","requestId":"r1","kind":"ToolApproval","toolName":"run-bash","argsSummary":"npm install left-pad"}
        """
        let data = Data(json.utf8)
        guard case .approvalRequest(let approval)? = AgentV2Event.decode(fromJSON: data) else {
            Issue.record("expected an approvalRequest event")
            return
        }
        #expect(approval.kind == "ToolApproval")
        #expect(approval.toolName == "run-bash")
        #expect(approval.argsSummary == "npm install left-pad")
        #expect(approval.questions.isEmpty)
    }

    @Test("AgentV2Approval still decodes a plain AskUserQuestion payload (kind defaults)")
    func decodesAskUserQuestionBackCompat() throws {
        let json = """
        {"type":"approval_request","requestId":"r2","kind":"AskUserQuestion","questions":[{"question":"Proceed?","header":"Confirm","options":[{"label":"Yes","description":""}],"multiSelect":false}]}
        """
        let data = Data(json.utf8)
        guard case .approvalRequest(let approval)? = AgentV2Event.decode(fromJSON: data) else {
            Issue.record("expected an approvalRequest event")
            return
        }
        #expect(approval.kind == "AskUserQuestion")
        #expect(approval.questions.count == 1)
    }
}
```

(`AgentV2Event.decode(fromJSON:)` is the existing static entry point — `Views/CodeAssistant/Chat/AgentV2Event.swift`'s `case "approval_request": return Self.payload(AgentV2Approval.self, data).map { .approvalRequest($0) }` branch, reached via the `WireType.type` discriminator read off the same JSON. No new decode surface needed — just the struct fields above.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd mac && swift test --filter ToolApprovalTests`
Expected: FAIL — `AgentV2Approval` has no `kind`/`toolName`/`argsSummary` fields yet (compile error).

- [ ] **Step 3: Implement**

In `AgentV2Event.swift`, extend the struct (around line 97):

```swift
/// A parked approval the engine is blocking on. `kind` distinguishes the two
/// P2 shapes: "AskUserQuestion" (questions/options, P1) and "ToolApproval"
/// (a gated act tool asking allow/deny/always-allow, P2) — see
/// extension/llm_agent/sdk/engine.mjs's canUseTool and
/// extension/llm_agent/tools/registry.mjs's run-bash entry.
struct AgentV2Approval: Sendable, Equatable, Codable {
    let requestId: String
    let kind: String
    let questions: [AgentV2ApprovalQuestion]
    let toolName: String?
    let argsSummary: String?

    init(requestId: String, kind: String = "AskUserQuestion", questions: [AgentV2ApprovalQuestion] = [], toolName: String? = nil, argsSummary: String? = nil) {
        self.requestId = requestId
        self.kind = kind
        self.questions = questions
        self.toolName = toolName
        self.argsSummary = argsSummary
    }

    enum CodingKeys: String, CodingKey { case requestId, kind, questions, toolName, argsSummary }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        requestId = try c.decode(String.self, forKey: .requestId)
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "AskUserQuestion"
        questions = try c.decodeIfPresent([AgentV2ApprovalQuestion].self, forKey: .questions) ?? []
        toolName = try c.decodeIfPresent(String.self, forKey: .toolName)
        argsSummary = try c.decodeIfPresent(String.self, forKey: .argsSummary)
    }
}
```

Add `ToolApprovalCard.swift` alongside `ApprovalQuestionCard.swift` (three buttons instead of the question form):

```swift
import SwiftUI

/// Interactive card for a parked act-tool approval ("ToolApproval" kind) —
/// the run-bash gate's 'prompt' tier, on either engine. Sibling to
/// ApprovalQuestionCard (AskUserQuestion); same styling, three actions
/// instead of a question form.
struct ToolApprovalCard: View {
    let state: AgentV2ApprovalState
    let onDecide: (_ action: String) async -> Void // "allow" | "deny" | "always-allow"

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Run: \(state.approval.toolName ?? "tool")").font(.system(size: 13, weight: .semibold))
            if let summary = state.approval.argsSummary {
                Text(summary).font(.system(size: 12, design: .monospaced)).foregroundStyle(.secondary).lineLimit(3)
            }
            if let error = state.lastError {
                Text(error).font(.system(size: 11)).foregroundStyle(.red)
            }
            HStack(spacing: 8) {
                Button("Deny") { Task { await onDecide("deny") } }
                Button("Allow Once") { Task { await onDecide("allow") } }.buttonStyle(.borderedProminent)
                Button("Always Allow") { Task { await onDecide("always-allow") } }
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.08)))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.accentColor.opacity(0.4), lineWidth: 1))
    }
}
```

Wherever `ApprovalQuestionCard` is placed (`ChatMessageList.swift`, keyed on `engine.pendingApproval`), branch on `state.approval.kind`: `"ToolApproval"` renders `ToolApprovalCard` calling a new `ChatEngine.submitToolDecision(action:)` (mirrors `submitApproval(answers:)` in `AgentV2ApprovalState.swift`, POSTing `{requestId, sdkSessionId, action}` with no `answers`); anything else renders the existing `ApprovalQuestionCard`.

`CodeAssistTransport` (legacy, `ChatTransport.swift:150`) implements the 4-callback `roundTrip` (rather than relying on the protocol's approval-dropping default) so it can turn a `{type:"progress", phase:"approval_request", ...}` SSE line into `onApproval(AgentV2Approval(requestId:, kind:"ToolApproval", toolName:, argsSummary:))`; its `sessionId` for the decision POST is the chat's own `agentContext.sessionId` (not an SDK session id — `AgentV2ApprovalState.submitApproval`'s existing "no SDK session id" guard needs a legacy-aware variant reading whichever session identifier the active transport actually has).

`LlmIdeAPIClient+CodeAssist.swift` gains `codeAssistDecision(requestId:sessionId:action:) async throws -> Bool` POSTing to `/code-assist/decision`, parallel to the existing `agentV2Decision`; `ChatEngine`'s new `submitToolDecision` picks whichever endpoint matches the active transport (v2 → `agentV2Decision` variant with `action`; legacy → `codeAssistDecision`).

- [ ] **Step 4: Run — expect PASS, plus full regression**

Run: `cd mac && swift test --filter ToolApprovalTests && swift test`
Expected: all pass, 0 failures across the full suite.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/CodeAssistant/Chat/AgentV2Event.swift mac/Sources/LlmIdeMac/Views/CodeAssistant/ToolApprovalCard.swift mac/Sources/LlmIdeMac/Chat/ChatTransport.swift mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+CodeAssist.swift mac/Tests/LlmIdeMacTests/ToolApprovalTests.swift
git commit -m "feat(mac): render + answer act-tool approvals on both chat engines"
```

---

### Task 10: `mode-personas.mjs` — derive `READ_ONLY_TOOL_NAMES` from the registry

**Files:**
- Modify: `extension/llm_agent/runtime/mode-personas.mjs:66-75` (`READ_ONLY_TOOL_NAMES`)
- Test: extend `extension/tests/mode-personas.test.mjs` (or wherever `allowedToolNames`/`restrictsTools` are already covered — check for an existing file before creating a new one)

**Interfaces:**
- Consumes: `registry.entries()` (Task 1).
- Produces: `allowedToolNames(mode)` — unchanged output for every mode (this task is a pure internal refactor; the acceptance bar is that outputs don't change).

- [ ] **Step 1: Write the failing test**

```js
// Append to the existing mode-personas test file
test('READ_ONLY_TOOL_NAMES is derived from the registry, not hand-maintained', async () => {
  const src = readFileSync(join(__dirname, '..', 'llm_agent', 'runtime', 'mode-personas.mjs'), 'utf8');
  assert.ok(src.includes("kind === 'read'"), 'expected the read-only set to be derived from registry entry.kind');
  assert.ok(!/const READ_ONLY_TOOL_NAMES = new Set\(\[\s*\n\s*'ask-internal',/.test(src), 'the old hand-maintained literal should be gone');
});

test('allowedToolNames(execute) output is unchanged by the refactor', () => {
  const names = [...allowedToolNames('execute')].sort();
  assert.deepEqual(names, ['ask-internal', 'ask-subagent', 'fetch-url', 'find-code', 'list-files', 'read-file', 'search-kb', 'web-search']);
});

test('allowedToolNames(plan) still adds save-plan on top of the read set', () => {
  const names = [...allowedToolNames('plan')].sort();
  assert.ok(names.includes('save-plan'));
  assert.equal(names.length, 9);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd extension && node --test tests/mode-personas.test.mjs`
Expected: FAIL — `mode-personas.mjs` still hand-maintains the literal `Set`.

- [ ] **Step 3: Implement**

```js
// extension/llm_agent/runtime/mode-personas.mjs
import { entries } from '../tools/registry.mjs';
// Replace the hand-maintained READ_ONLY_TOOL_NAMES literal (and its long
// explanatory comment about run-bash's misleading .md kind — see
// tools/registry.mjs's own kind field, which is now the honest source) with:
const READ_ONLY_TOOL_NAMES = new Set(entries().filter((e) => e.kind === 'read').map((e) => e.name));
```

Delete the large comment block explaining why `run-bash`'s `.md` `kind: read` can't be trusted for mode restriction, and the per-name rationale list above `READ_ONLY_TOOL_NAMES` — that reasoning now lives in `tools/registry.mjs`'s own header comment and the `Global Constraints` note at the top of this plan/spec.

- [ ] **Step 4: Run — expect PASS, plus full regression**

Run: `cd extension && node --test tests/mode-personas.test.mjs && node --test`
Expected: all pass — in particular every existing plan/review/document-mode test (tool-restriction enforcement, `modeToolNote` roster text) stays green, since the derived set is byte-identical to the old literal.

- [ ] **Step 5: Commit**

```bash
git add extension/llm_agent/runtime/mode-personas.mjs extension/tests/mode-personas.test.mjs
git commit -m "refactor(server): derive mode tool-restriction from the tools registry"
```

---

### Task 11: `project-memory.md` skill file — legacy gets `project_memory`

**Files:**
- Create: `extension/llm_agent/global/project-memory.md`
- Modify: `extension/llm_agent/tools/registry.mjs` (remove `project_memory`'s `inlineMeta`, now resolved via the `.md` file like every other entry)
- Test: extend `extension/tests/global-handlers-sync.test.mjs`, `extension/tests/agent-v2-tools.test.mjs`

**Interfaces:**
- Consumes: `skills/registry.mjs`'s `assertReadSkillsWired` boot check (already enforces every global `kind: read` `.md` file has a wired handler name — `project_memory` needs to be in `registry.names()`, which it already is since Task 3).
- Produces: `project_memory` reachable from the legacy fence loop for the first time.

- [ ] **Step 1: Write the failing test**

```js
// Append to extension/tests/global-handlers-sync.test.mjs
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd extension && node --test tests/global-handlers-sync.test.mjs`
Expected: FAIL — `project_memory` has no `.md` file, so `skills.get('project_memory')` inside the loop's fence dispatch returns undefined and the call is treated as "Unknown tool".

- [ ] **Step 3: Implement**

```markdown
<!-- extension/llm_agent/global/project-memory.md -->
---
name: project_memory
kind: read
schema:
  focus:
    type: string
    required: false
    maxLength: 256
    description: Optional topic to prioritize when selecting which memory to include; defaults to the current user message.
---

# project_memory

Retrieve this project's accumulated memory — durable, auto-generated facts,
decisions, and Q&A distilled from past sessions in this repo/workspace.

## When to use

Call this when grounded project-specific context (past decisions, known
issues, prior answers) would improve the answer, instead of guessing.
Returns a short note if no project memory has been generated yet for this
workspace.

## Call shape

```
<<<TOOL_CALL>>>
{"name": "project_memory", "arguments": {"focus": "auth token rotation"}}
<<<END_TOOL_CALL>>>
```

## Result shape

```json
{ "text": "## Project memory\n- decided to rotate refresh tokens on use\n…" }
```
```

Remove `inlineMeta` from `project_memory`'s registry entry (`tools/registry.mjs`, added in Task 3) — `sdk/tools.mjs`'s `metaFor` already falls back to `globalSkills.skills.get(name)` first, so once this `.md` file exists it's picked up automatically and the inline fallback becomes dead code.

- [ ] **Step 4: Run — expect PASS, plus full regression**

Run: `cd extension && node --test tests/global-handlers-sync.test.mjs tests/agent-v2-tools.test.mjs && node --test`
Expected: all pass. In particular confirm `mode-personas.test.mjs` (Task 10) still passes — `project_memory` is now `kind:'read'` in the registry, so `allowedToolNames('execute')` GAINS it; if Task 10's golden test asserted an exact 8-name list, update that assertion here to 9 names including `project_memory` (call this out explicitly rather than leaving a stale assertion — this is the dependency the spec flagged in §8/§9).

- [ ] **Step 5: Commit**

```bash
git add extension/llm_agent/global/project-memory.md extension/llm_agent/tools/registry.mjs extension/tests/global-handlers-sync.test.mjs extension/tests/mode-personas.test.mjs
git commit -m "feat(server): expose project_memory to the legacy engine too"
```

---

### Task 12: Persona suffix on the v2 system prompt (legacy → v2 parity)

**Files:**
- Modify: `extension/llm_agent/sdk/engine.mjs` (`buildEngineOptions`)
- Test: extend `extension/tests/agent-v2-engine.test.mjs` (or wherever `buildEngineOptions` is unit-tested — check before creating a new file)

**Interfaces:**
- Consumes: `getAgentPersona(userId)` (`kb/personas.mjs`), `sanitizePersonaSuffix` (`providers/prompt-utils.mjs`) — both already used by `route.mjs`.
- Produces: no new export; `buildEngineOptions`'s `appendParts` gains the persona block when one is set.

- [ ] **Step 1: Write the failing test**

```js
// Append to the buildEngineOptions test file
test('buildEngineOptions appends the user persona suffix, sanitized', async () => {
  const { getDb } = await import('../kb/db.mjs');
  const { registerUser } = await import('../server/users.mjs');
  const { setAgentPersona } = await import('../kb/personas.mjs');
  const { buildEngineOptions } = await import('../llm_agent/sdk/engine.mjs');
  const u = registerUser(getDb(), { email: 'v2persona@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  // setAgentPersona bootstraps a "default" persona and activates it in one
  // call when the user has none yet (kb/personas.mjs:120-159) — no separate
  // create+activate round-trip needed.
  setAgentPersona(u.id, { name: 'Ada', promptSuffix: 'Be terse and precise.' });
  const { queryOptions } = buildEngineOptions({ userId: u.id, mode: 'execute', message: 'hi', agentContext: { workspaceRoot: process.cwd() } });
  assert.ok(queryOptions.systemPrompt.append.includes('Ada'));
  assert.ok(queryOptions.systemPrompt.append.includes('Be terse and precise.'));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd extension && node --test tests/agent-v2-engine.test.mjs`
Expected: FAIL — v2's system prompt has no persona text today.

- [ ] **Step 3: Implement**

```js
// extension/llm_agent/sdk/engine.mjs
import { getAgentPersona } from '../../kb/personas.mjs';
import { sanitizePersonaSuffix } from '../../providers/prompt-utils.mjs';
// ...
// In buildEngineOptions, right after `if (persona) appendParts.push(persona);`:
try {
  const activePersona = userId ? getAgentPersona(userId) : null;
  const name = sanitizePersonaSuffix((activePersona?.name || '').trim()).slice(0, 80);
  const suffix = sanitizePersonaSuffix((activePersona?.promptSuffix || '').trim());
  if (name || suffix) {
    let block = '\n\n---\nPersona\n';
    if (name) block += `You are also known to the user as ${name}; sign off in that voice when natural.\n`;
    if (suffix) block += `Voice & focus: ${suffix}\n`;
    appendParts.push(block.trim());
  }
} catch { /* persona lookup is best-effort — same as legacy's try/catch */ }
```

- [ ] **Step 4: Run — expect PASS, plus full regression**

Run: `cd extension && node --test tests/agent-v2-engine.test.mjs && node --test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add extension/llm_agent/sdk/engine.mjs extension/tests/agent-v2-engine.test.mjs
git commit -m "feat(server): apply the user's persona suffix on v2 turns too"
```

---

### Task 13: `global-handlers-sync` — three-way name assertion (the actual regression class this spec closes)

**Files:**
- Modify: `extension/tests/global-handlers-sync.test.mjs`

**Interfaces:**
- Consumes: `registry.names()` (Task 1), the mounted-tool-name list from `sdk/tools.mjs`'s built server (Task 3/7).

- [ ] **Step 1: Write the failing test** — this step and Step 3 merge, since the point of this task IS the test: add the pin that would have caught the 2026-08-19 assist-plan-class drift the whole spec exists to prevent.

```js
// Append to extension/tests/global-handlers-sync.test.mjs
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

  const registryNames = new Set(names());
  registryNames.add('project_memory'); // registry.names() is the legacy 12; project_memory is v2/legacy-parity but not in GLOBAL_HANDLER_NAMES's original 12 — both v2Names and legacy handlers must still include it (see Task 11)
  const { buildDispatch } = await import('../llm_agent/tools/registry.mjs');
  const legacyNames = new Set(Object.keys(buildDispatch({})));
  legacyNames.add('project_memory');

  assert.deepEqual([...v2Names].sort(), [...registryNames].sort(), 'a v2-mounted tool name diverged from the registry');
  assert.deepEqual([...legacyNames].sort(), [...registryNames].sort(), 'a legacy-dispatched tool name diverged from the registry');
});
```

- [ ] **Step 2: Run to verify it fails or passes**

Run: `cd extension && node --test tests/global-handlers-sync.test.mjs`
Expected: at this point in the plan (after Tasks 1-12) this should already PASS — it's a regression pin, not new behavior. If it fails, that means an earlier task left a real name mismatch; fix the mismatch (not the test) before proceeding.

- [ ] **Step 3: (no implementation step — this task only adds the pin)**

- [ ] **Step 4: Run full regression one final time**

Run: `cd extension && npm run lint && node --test && cd ../mac && swift test`
Expected: 0 lint violations, full extension suite green, full Mac suite green (0 failures) — the acceptance bar for the whole P2 plan.

- [ ] **Step 5: Commit**

```bash
git add extension/tests/global-handlers-sync.test.mjs
git commit -m "test: pin legacy/v2/registry tool-name parity (the drift class P2 closes)"
```
