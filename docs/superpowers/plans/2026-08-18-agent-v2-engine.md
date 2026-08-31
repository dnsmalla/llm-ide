# Agent v2 Engine (P1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Claude Agent SDK as a read-only chat engine behind the Mac Code Assistant (default-off "Agent engine (beta)" toggle), with the v2 SSE wire protocol, AskUserQuestion approval round-trip, and server-side session mapping.

**Architecture:** `POST /agent/v2/stream` per user message (SSE events mapped from the SDK stream) + `POST /agent/v2/decision` resolving parked `canUseTool` promises + `DELETE /agent/v2/session`. Server state between turns lives in an `agent_sessions` SQLite mapping; the SDK's own JSONL transcripts provide resume. Mac adds `AgentV2Transport` behind the existing `ChatTransport` protocol.

**Tech Stack:** Node 22 ESM (no framework) · `@anthropic-ai/claude-agent-sdk@0.3.234` (exact-pinned, already installed) · better-sqlite3 · node:test · Swift 6 / SwiftUI / swift-testing

**Spec:** `docs/superpowers/specs/2026-08-18-agent-v2-engine-design.md` — read it first; this plan argues from it.

## Global Constraints

- SDK stays exact-pinned at `@anthropic-ai/claude-agent-sdk@0.3.234`; only `extension/llm_agent/sdk/` modules may import it (isolation rule; eslint enforces layers, not package imports — keep the discipline by convention).
- Legacy `/code-assist` path is byte-identical — no edits to `llm_agent/runtime/route.mjs` or `loop.mjs` behavior.
- `SERVER_API_VERSION` becomes `33`; new endpoints registered in `ENDPOINTS` (server.mjs).
- ESLint module-boundary ratchet stays at zero violations (`cd extension && npm run lint`).
- P1 is **read-only**: no Bash/Edit/Write in `allowedTools`; non-question tools get an explanatory deny.
- Every state-mutating KB helper takes `userId` first (repo invariant).
- Commits: Conventional Commits (`feat(server):`, `feat(mac):`, `test:`), one concern per commit, Co-Authored-By trailer. Do not push.
- Tests: extension `node --test tests/<file>` from `extension/`; Mac `cd mac && swift test --filter <XCTestName>` (swift-testing).
- Engine module (`engine.mjs`) is DB-free and injectable (`queryFactory`) so all approval/session logic is testable without spawning the SDK.

---

### Task 1: events.mjs — promote the spike mapper, add usage + args index

**Files:**
- Create: `extension/llm_agent/sdk/events.mjs`
- Modify: `extension/llm_agent/sdk/spike-engine.mjs` (delete local mapper, import from events.mjs)
- Test: `extension/tests/agent-v2-events.test.mjs`

**Interfaces:**
- Consumes: none (pure).
- Produces: `mapSdkMessage(msg) -> Array<Event>` where Event is one of `{type:'init',sessionId,claudeCodeVersion,model,tools,capabilities,mcpServers}`, `{type:'delta',text}`, `{type:'tool_use_start',id,name}`, `{type:'tool_args_delta',index,partialJson}`, `{type:'tool_result',toolUseId,isError,text,truncated}`, `{type:'usage',inputTokens,outputTokens,cacheReadTokens}`, `{type:'result',subtype,costUsd,numTurns,durationMs,sessionId,stopReason}`, `{type:'sdk',sdkType,subtype,raw}`.

- [ ] **Step 1: Write the failing tests** — copy the pure-mapper tests from `tests/agent-sdk-spike.test.mjs` into `tests/agent-v2-events.test.mjs`, import from `../llm_agent/sdk/events.mjs`, and add:

```js
test('tool_args_delta carries the block index for multi-tool turns', () => {
  assert.deepEqual(
    mapSdkMessage({ type: 'stream_event', event: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"q"' } } }),
    [{ type: 'tool_args_delta', index: 2, partialJson: '{"q"' }],
  );
});

test('assistant message maps to a usage event from message.message.usage', () => {
  const [ev] = mapSdkMessage({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 40 } },
  });
  assert.equal(ev.type, 'usage');
  assert.equal(ev.inputTokens, 100);
  assert.equal(ev.outputTokens, 5);
  assert.equal(ev.cacheReadTokens, 40);
});
```

- [ ] **Step 2: Run — expect FAIL** (module not found). `node --test tests/agent-v2-events.test.mjs`
- [ ] **Step 3: Implement** — move `mapSdkMessage` + `textOfToolResultContent` from `spike-engine.mjs` into `events.mjs` verbatim, then apply two changes: (a) `tool_args_delta` includes `index: ev.index ?? 0`; (b) add before the `result` branch:

```js
if (msg.type === 'assistant') {
  const u = msg?.message?.usage;
  if (u && (u.input_tokens != null || u.output_tokens != null)) {
    return [{ type: 'usage', inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0 }];
  }
  return []; // complete assistant messages otherwise ride the sdk passthrough
}
```

Export both `mapSdkMessage`. In `spike-engine.mjs` replace the deleted code with `import { mapSdkMessage } from './events.mjs'; export { mapSdkMessage };` (spike tests keep passing unchanged).

- [ ] **Step 4: Run both suites — expect PASS**: `node --test tests/agent-v2-events.test.mjs tests/agent-sdk-spike.test.mjs`
- [ ] **Step 5: Commit** `git add extension/llm_agent/sdk/events.mjs extension/llm_agent/sdk/spike-engine.mjs extension/tests/agent-v2-events.test.mjs && git commit -m "feat(server): extract v2 event mapper with usage + args-index events"`

---

### Task 2: tools.mjs — extract the llmide in-process MCP server

**Files:**
- Create: `extension/llm_agent/sdk/tools.mjs`
- Modify: `extension/llm_agent/sdk/spike-engine.mjs` (import from tools.mjs, delete local builder)
- Test: `extension/tests/agent-v2-tools.test.mjs`

**Interfaces:**
- Consumes: `kb.search(userId, {q, kind, limit})` from `kb/db.mjs`; `redactFence` from `../runtime/redaction.mjs`.
- Produces: `buildLlmIdeServer(userId) -> McpSdkServerConfigWithInstance` (SDK type; server name `'llmide'`, tool `kb_search` with `alwaysLoad: true`).

- [ ] **Step 1: Failing test** (uses a scratch DB + registered user — copy the env-var preamble from `tests/agent-sdk-spike.test.mjs`):

```js
test('kb_search handler returns redacted hits for a tenanted user', async () => {
  const { registerUser } = await import('../server/users.mjs');
  const { getDb } = await import('../kb/db.mjs');
  const u = registerUser(getDb(), { email: 'v2tools@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  const { buildLlmIdeServer } = await import('../llm_agent/sdk/tools.mjs');
  const server = buildLlmIdeServer(u.id);
  assert.equal(server.name, 'llmide');
  const kbSearch = server.tools.find((t) => t.name === 'kb_search');
  assert.ok(kbSearch, 'kb_search registered');
  const out = await kbSearch.handler({ query: 'meeting', limit: 3 });
  const parsed = JSON.parse(out.content[0].text);
  assert.ok(Array.isArray(parsed.hits));
  assert.equal(typeof parsed.total, 'number');
});
```

Note: the SDK's `createSdkMcpServer` return exposes `.name` and `.tools` — if the property shape differs (check `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` `CreateSdkMcpServerOptions` / return type), adapt the assertions to the actual fields while keeping the test's intent (server named `llmide`, `kb_search` callable).

- [ ] **Step 2: Run — FAIL** (no module). `node --test tests/agent-v2-tools.test.mjs`
- [ ] **Step 3: Implement** — move `buildLlmIdeServer(userId)` from `spike-engine.mjs` into `tools.mjs` unchanged (including `MAX_TOOL_RESULT_CHARS`-style caps are not needed here — the handler JSON-serializes capped hit lists already); `spike-engine.mjs` imports it: `import { buildLlmIdeServer } from './tools.mjs';`.
- [ ] **Step 4: Run — PASS** (both new test and spike suite).
- [ ] **Step 5: Commit** `feat(server): extract llmide in-process MCP tool server`

---

### Task 3: decisions.mjs — pending-approval registry

**Files:**
- Create: `extension/llm_agent/sdk/decisions.mjs`
- Test: `extension/tests/agent-v2-decisions.test.mjs`

**Interfaces:**
- Produces:
  - `registerDecision({ sdkSessionId, userId, questions, timeoutMs = 900_000 }) -> { requestId, promise }` where `promise` resolves to `{ action: 'answer', answers }` | `{ action: 'expired' }` | `{ action: 'aborted' }`.
  - `answerDecision({ requestId, sdkSessionId, userId, answers }) -> { ok: true } | { ok: false, reason: 'unknown' | 'tenancy' | 'expired' }`
  - `abortDecisionsForSession(sdkSessionId) -> number` (denies all pending for that session).
  - Internal 15-minute timer per decision auto-resolves `{action:'expired'}` and clears the timer on any resolution.

- [ ] **Step 1: Failing tests**:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerDecision, answerDecision, abortDecisionsForSession } from '../llm_agent/sdk/decisions.mjs';

test('register → answer resolves the promise; registry empties', async () => {
  const { requestId, promise } = registerDecision({ sdkSessionId: 's1', userId: 'u1', questions: [] });
  const res = answerDecision({ requestId, sdkSessionId: 's1', userId: 'u1', answers: { 'Pick one?': 'A' } });
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(await promise, { action: 'answer', answers: { 'Pick one?': 'A' } });
  assert.equal(answerDecision({ requestId, sdkSessionId: 's1', userId: 'u1', answers: {} }).reason, 'unknown');
});

test('tenancy: a different user cannot answer', async () => {
  const { requestId, promise } = registerDecision({ sdkSessionId: 's2', userId: 'u1', questions: [] });
  assert.equal(answerDecision({ requestId, sdkSessionId: 's2', userId: 'u2', answers: {} }).reason, 'tenancy');
  assert.equal(answerDecision({ requestId, sdkSessionId: 'other', userId: 'u1', answers: {} }).reason, 'tenancy');
  abortDecisionsForSession('s2');
  assert.deepEqual(await promise, { action: 'aborted' });
});

test('timeout expires unanswered decisions', async () => {
  const { requestId, promise } = registerDecision({ sdkSessionId: 's3', userId: 'u1', questions: [], timeoutMs: 20 });
  assert.deepEqual(await promise, { action: 'expired' });
  assert.equal(answerDecision({ requestId, sdkSessionId: 's3', userId: 'u1', answers: {} }).reason, 'expired');
});
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — a module-level `Map` keyed by `requestId` (crypto.randomUUID), each entry `{ sdkSessionId, userId, resolve, timer }`. All resolution paths clear the timer and delete the entry. `abortDecisionsForSession` iterates and resolves `{action:'aborted'}`.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** `feat(server): add v2 approval decision registry`

---

### Task 4: agent_sessions migration + kb/agent-sessions.mjs

**Files:**
- Create: `extension/kb/migrations/0029_agent_sessions.sql`
- Create: `extension/kb/agent-sessions.mjs`
- Test: `extension/tests/agent-v2-sessions.test.mjs`

**Interfaces:**
- Consumes: `applyMigrations` picks up numbered SQL files automatically (pattern of 0001–0028).
- Produces (all take `db` first, `userId` second — repo invariant):
  - `getOrCreateAgentSession(db, userId, chatSessionId, chatScope) -> { id, sdk_session_id, model, last_mode }`
  - `markAgentSessionUsed(db, userId, chatSessionId, { sdkSessionId, model, mode }) -> void` (upserts the sdk id on first turn)
  - `replaceAgentSession(db, userId, chatSessionId)` — nulls `sdk_session_id` for a fresh start
  - `deleteAgentSession(db, userId, chatSessionId) -> { sdkSessionId } | null` (returns the sdk id so the caller can clean transcripts)

- [ ] **Step 1: Failing test** (scratch-DB preamble as in spike tests):

```js
test('agent_sessions: create, mark used, replace, delete', () => {
  const { registerUser } = await import('../server/users.mjs');   // use top-level await imports instead
  // ...preamble: scratch DB, registered user u
  const row1 = getOrCreateAgentSession(db, u.id, 'chat-1', 'explorer');
  assert.equal(row1.sdk_session_id, null);
  markAgentSessionUsed(db, u.id, 'chat-1', { sdkSessionId: 'sdk-1', model: 'claude-sonnet-5', mode: 'execute' });
  const row2 = getOrCreateAgentSession(db, u.id, 'chat-1', 'explorer');
  assert.equal(row2.sdk_session_id, 'sdk-1');
  // tenancy: another user's chat id is a different row
  const other = getOrCreateAgentSession(db, u2.id, 'chat-1', 'explorer');
  assert.notEqual(other.id, row2.id);
  replaceAgentSession(db, u.id, 'chat-1');
  assert.equal(getOrCreateAgentSession(db, u.id, 'chat-1', 'explorer').sdk_session_id, null);
  assert.equal(deleteAgentSession(db, u.id, 'chat-1').sdkSessionId, null); // already nulled by replace
});
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** SQL:

```sql
-- 0029: Agent v2 engine sessions — maps a Mac ChatSession UUID to the
-- Claude Agent SDK session id so turns can resume server-side.
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  chat_scope TEXT NOT NULL DEFAULT 'explorer',
  mac_chat_session_id TEXT NOT NULL,
  sdk_session_id TEXT,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_mode TEXT,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_sessions_user_chat ON agent_sessions(user_id, mac_chat_session_id);
```

`agent-sessions.mjs` uses `db.prepare` statements inside `db.transaction()` for the upsert (repo invariant: multi-step mutations wrapped).

- [ ] **Step 4: Run — PASS** (and confirm the migration number is the next free one: `ls extension/kb/migrations | tail -1` must be `0029_agent_sessions.sql`).
- [ ] **Step 5: Commit** `feat(server): add agent_sessions mapping (migration 0029)`

---

### Task 5: engine.mjs — pure options composition

**Files:**
- Create: `extension/llm_agent/sdk/engine.mjs`
- Test: `extension/tests/agent-v2-engine.test.mjs`

**Interfaces:**
- Consumes: `personaForMode(mode)` and `PLAN_LIKE_MODES` from `../runtime/mode-personas.mjs`; `readSkillInstructions(id, userId)` from `../skills/index.mjs`; `buildReadableRoots({userId, workspaceRoot})` from `../runtime/handlers/repo-files.mjs`; `resolveAnthropicKey(userId)` (moved here from `spike-engine.mjs` — re-export from spike for compat).
- Produces: `buildEngineOptions({ userId, mode, model, language, skills, agentContext, attachments }) -> { queryOptions, prompt, meta }` (pure except `readSkillInstructions`/`buildReadableRoots`, both injected-overridable via optional second arg `{ readSkill = readSkillInstructions, roots = buildReadableRoots }` for tests).

- [ ] **Step 1: Failing tests** (inject fakes — no DB, no SDK):

```js
test('mode mapping: plan-like modes become SDK plan mode with persona instructions', () => {
  for (const mode of ['plan', 'assist_plan']) {
    const { queryOptions } = buildEngineOptions({ userId: 'u', mode, agentContext: { workspaceRoot: '/tmp/w' } },
      { readSkill: () => null, roots: () => ['/tmp/w'] });
    assert.equal(queryOptions.permissionMode, 'plan');
    assert.equal(typeof queryOptions.planModeInstructions, 'string');
  }
});
test('mode mapping: execute/auto default; review/document persona-only', () => {
  const base = { readSkill: () => null, roots: () => ['/tmp/w'] };
  assert.equal(buildEngineOptions({ userId: 'u', mode: 'auto', agentContext: {} }, base).queryOptions.permissionMode, 'default');
  const rev = buildEngineOptions({ userId: 'u', mode: 'review', agentContext: {} }, base);
  assert.equal(rev.queryOptions.permissionMode, 'default');
  assert.ok(rev.queryOptions.systemPrompt.append.length > 0);
});
test('allowlist is read-only + llmide; skills inject via append; cwd + dirs from workspace', () => {
  const { queryOptions } = buildEngineOptions({
    userId: 'u', mode: 'execute', language: 'Japanese',
    skills: ['family/one'], agentContext: { workspaceRoot: '/tmp/w', indexedRepos: ['/tmp/r'] },
  }, { readSkill: () => ({ name: 'one', content: '# One\ninstructions' }), roots: () => ['/tmp/w', '/tmp/r'] });
  assert.deepEqual(queryOptions.allowedTools, ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'mcp__llmide__*']);
  assert.equal(queryOptions.cwd, '/tmp/w');
  assert.deepEqual(queryOptions.additionalDirectories, ['/tmp/r']);
  assert.match(queryOptions.systemPrompt.append, /One/);
  assert.match(queryOptions.systemPrompt.append, /Japanese/);
  assert.deepEqual(queryOptions.settingSources, []);
  assert.equal(queryOptions.systemPrompt.type, 'preset');
});
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** `buildEngineOptions` composes (no query start): `model` passthrough when string; `includePartialMessages: true`; allowlist exactly `['Read','Glob','Grep','WebSearch','WebFetch','mcp__llmide__*']`; `mcpServers` is NOT set here (the runner adds `{ llmide: buildLlmIdeServer(userId) }` — options composition stays pure). `systemPrompt: { type:'preset', preset:'claude_code', append }` where append = languageDirective (`Always respond in <language>.` when `language` set) + `\n` + `personaForMode(mode)` + skill blocks (`## Skill: <name>\n<content>`, ≤ 5, trusted-instructions framing copied from ai-routes.mjs:324-348) + fenced attachments (`## <path>\n<<<BEGIN>>>…<<<END>>>`, caps 30 files / 80k per file / 200k total — copy `selectAttachments` semantics; import it from `server/ai-routes.mjs` is NOT allowed (route layer) — re-implement the caps locally or move the helper to `core/utils.mjs` and have ai-routes keep using its own copy; choose: small local helper `capAttachments(attachments)` in engine.mjs). `prompt` = the user message (sanitized via `sanitizeForPrompt` from `core/utils.mjs`, 20k cap).

- [ ] **Step 4: Run — PASS** (also `npm run lint`).
- [ ] **Step 5: Commit** `feat(server): v2 engine option composition (modes, skills, allowlist)`

---

### Task 6: engine.mjs — runAgentV2Turn with the approval round-trip

**Files:**
- Modify: `extension/llm_agent/sdk/engine.mjs`
- Test: `extension/tests/agent-v2-engine.test.mjs` (append)

**Interfaces:**
- Produces: `runAgentV2Turn({ message, userId, mode, model, language, skills, agentContext, attachments, resumeSdkSessionId, onEvent, signal, queryFactory }) -> { result, usageTotals }`. `queryFactory` defaults to the real SDK `query`; tests inject a fake that receives `(prompt, options)` and can invoke `options.canUseTool(...)`.
- Errors: throws `Object.assign(new Error(msg), { code: 'SESSION_UNRESUMABLE' })` when `resumeSdkSessionId` was set and the query fails on its first message with /session|conversation|resume/i.

- [ ] **Step 1: Failing tests** — with a fake query:

```js
function makeFakeQuery(script) {
  return async (prompt, options) => {
    script.options = options;
    return (async function* () { for (const m of script.messages) yield m; })();
  };
}

test('AskUserQuestion round-trip: request event → answer → allow with updatedInput', async () => {
  const script = { messages: [{ type: 'system', subtype: 'init', session_id: 'sdk-9', tools: [], capabilities: [] }] };
  const events = [];
  const p = runAgentV2Turn({
    message: 'hi', userId: 'u1', mode: 'execute', agentContext: { workspaceRoot: '/tmp/w' },
    resumeSdkSessionId: 'sdk-9', onEvent: (e) => events.push(e),
    queryFactory: makeFakeQuery(script),
  }, { readSkill: () => null, roots: () => [] });
  await new Promise((r) => setTimeout(r, 10)); // let canUseTool be armed? — instead: drive it explicitly below
  // Drive the approval: the fake captured options; simulate the SDK asking.
  const decision = await script.options.canUseTool('AskUserQuestion', {
    questions: [{ question: 'Pick one?', header: 'Pick', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }],
  });
  // not yet answered → still pending; now answer via the registry
  const req = events.find((e) => e.type === 'approval_request');
  assert.ok(req, 'approval_request emitted');
  const res = answerDecision({ requestId: req.requestId, sdkSessionId: 'sdk-9', userId: 'u1', answers: { 'Pick one?': 'A' } });
  assert.equal(res.ok, true);
  assert.equal((await decision).behavior, 'allow');
  assert.deepEqual((await decision).updatedInput.answers, { 'Pick one?': 'A' });
  assert.ok(events.some((e) => e.type === 'approval_resolved'));
  await p;
});
```

(The exact await-choreography may need a small helper — e.g. `canUseTool` returns the promise and you assert after `answerDecision`; keep the assertions, adjust awaits.)

```js
test('non-question tools are denied with an explanatory message', async () => {
  const script = { messages: [{ type: 'result', subtype: 'success', session_id: 's' }] };
  await runAgentV2Turn({ message: 'm', userId: 'u1', mode: 'execute', agentContext: {},
    onEvent: () => {}, queryFactory: makeFakeQuery(script) }, { readSkill: () => null, roots: () => [] });
  const d = await script.options.canUseTool('Bash', { command: 'rm -rf /' });
  assert.equal(d.behavior, 'deny');
  assert.match(d.message, /next engine release/);
});

test('resume failure maps to SESSION_UNRESUMABLE', async () => {
  const boom = async () => { const it = (async function* () { throw new Error('No conversation found with session id: x'); })(); return it; };
  await assert.rejects(
    runAgentV2Turn({ message: 'm', userId: 'u1', mode: 'execute', agentContext: {}, resumeSdkSessionId: 'x',
      onEvent: () => {}, queryFactory: boom }, { readSkill: () => null, roots: () => [] }),
    (e) => e.code === 'SESSION_UNRESUMABLE',
  );
});
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** `runAgentV2Turn(deps)`:
  - Build options via `buildEngineOptions` + `mcpServers: { llmide: buildLlmIdeServer(userId) }` + auth (`resolveAnthropicKey`; `env` spread only when a key exists; no key → ambient allowed) + `resume` when `resumeSdkSessionId` + `signal` passthrough + `maxTurns: 40`.
  - `canUseTool: async (toolName, input)`: if `toolName === 'AskUserQuestion'` → `const { requestId, promise } = registerDecision({ sdkSessionId: currentSdkSessionId, userId, questions: input.questions })`; `onEvent({ type:'approval_request', requestId, kind:'AskUserQuestion', questions: input.questions })`; `const outcome = await promise;` on `answer` → `onEvent approval_resolved {requestId, outcome:'answer'}` + return `{ behavior:'allow', updatedInput:{ questions: input.questions, answers: outcome.answers } }`; on expired/aborted → `approval_resolved` + `{ behavior:'deny', message:'The user did not answer the question.' }`. `currentSdkSessionId` = `resumeSdkSessionId` or the id captured from the init message (track as messages stream).
  - Any other tool → `{ behavior:'deny', message:'Writes and shell commands arrive in the next engine release; re-plan using read-only tools.' }`.
  - Iterate `for await (const msg of q)`: capture `msg.session_id` when present; `mapSdkMessage(msg)` → `onEvent` each; accumulate `usageTotals` from `usage`/`result` events.
  - Wrap the iteration in try/catch: if `resumeSdkSessionId` && error message matches /session|conversation|resume/i → rethrow with `code:'SESSION_UNRESUMABLE'`.
- [ ] **Step 4: Run — PASS**; also re-run `tests/agent-sdk-spike.test.mjs` (spike untouched).
- [ ] **Step 5: Commit** `feat(server): v2 turn runner with AskUserQuestion approval round-trip`

---

### Task 7: routes/agent-v2.mjs + mounting + version 33

**Files:**
- Create: `extension/routes/agent-v2.mjs`
- Modify: `extension/routes/router.mjs` (mount after `handleAgentRoutes`), `extension/server.mjs` (ENDPOINTS + `SERVER_API_VERSION = 33`, comment line like the 31→32 one)
- Test: `extension/tests/agent-v2-routes.test.mjs`

**Interfaces:**
- Produces: `handleAgentV2Routes(req, res, deps = { runTurn: runAgentV2Turn }) -> Promise<boolean>`; endpoints:
  - `POST /agent/v2/stream` body `{message, language, model, mode, skills, agentContext, attachments, fresh?}` → SSE events (spec §4) + `mode_set` right after `init`.
  - `POST /agent/v2/decision` body `{requestId, sdkSessionId, answers}` → `{ok:true}` | 403 tenancy | 404 unknown/expired.
  - `DELETE /agent/v2/session` body `{chatSessionId}` → drops the mapping + best-effort deletes SDK transcript files under `CLAUDE_CONFIG_DIR/projects/` matching the sdk id.

- [ ] **Step 1: Failing tests** (req/res doubles copied from `tests/agent-sdk-spike.test.mjs`; inject `deps.runTurn`):

```js
test('stream: happy path emits init → mode_set → … → result, maps session, records usage', async () => {
  // seed: registered user; agentContext = { chatSessionId: 'chat-1', workspaceRoot: '/tmp/w' }
  const fakeTurn = async ({ onEvent }) => {
    onEvent({ type: 'init', sessionId: 'sdk-1', claudeCodeVersion: '2.1.234', tools: [], capabilities: [] });
    onEvent({ type: 'delta', text: 'hi' });
    onEvent({ type: 'result', subtype: 'success', costUsd: 0.01, numTurns: 1, durationMs: 5, sessionId: 'sdk-1', stopReason: 'end_turn' });
    return { result: { subtype: 'success' }, usageTotals: { inputTokens: 10, outputTokens: 2 } };
  };
  const res = makeRes();
  await handleAgentV2Routes(makeReq({ method: 'POST', url: '/agent/v2/stream', body: {...}, user }), res, { runTurn: fakeTurn });
  const evs = res.sseEvents();
  assert.equal(evs[0].type, 'init');
  assert.equal(evs[1].type, 'mode_set');
  assert.ok(evs.at(-1).type === 'result');
  assert.equal(getOrCreateAgentSession(db, user.id, 'chat-1', 'explorer').sdk_session_id, 'sdk-1'); // marked used
});

test('stream: SESSION_UNRESUMABLE surfaces as an error event, not a crash', async () => {
  const fakeTurn = async () => { throw Object.assign(new Error('no conversation'), { code: 'SESSION_UNRESUMABLE' }); };
  // existing mapping with sdk_session_id set (markAgentSessionUsed first)
  const res = makeRes();
  await handleAgentV2Routes(reqWithAgentContextChat('chat-1'), res, { runTurn: fakeTurn });
  assert.equal(res.sseEvents().at(-1).type, 'error');
  assert.equal(res.sseEvents().at(-1).code, 'SESSION_UNRESUMABLE');
});

test('decision endpoint enforces tenancy (403) and unknown (404)', async () => { /* registerDecision for u1; post as u2 → 403; unknown id → 404 */ });
test('missing message → 400; unauthenticated user id → 401', async () => { /* doubles */ });
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Route shape mirrors ai-routes.mjs:455-528 (SSE headers incl. `X-Accel-Buffering: no`, `req.on('close')` → AbortController, `data: <json>\n\n` writes, always `res.end()`). Flow: parse body → validate `message` + `req.user?.id` + `agentContext.chatSessionId` → `getOrCreateAgentSession` → `sdk = fresh ? null : row.sdk_session_id` → run `deps.runTurn({ ..., resumeSdkSessionId: sdk ?? undefined, onEvent: writeEvent })` with a wrapper that injects `mode_set` after the first `init` → on success `markAgentSessionUsed(...)` + `recordUsage(db, { userId, provider: 'anthropic', model, ...usageTotals, costUsd: result.costUsd, source: 'agent-v2' })` (match exact parameter names at `kb/usage.mjs:194` — read it first; if `source` isn't a field, drop it) → on `err.code === 'SESSION_UNRESUMABLE'` write `error` event with that code. Decision endpoint: `answerDecision` mapped to 200/403/404. Delete endpoint: `deleteAgentSession` + best-effort `fs.rm` of `<CLAUDE_CONFIG_DIR>/projects/*<sdkSessionId>*` (glob via `fs.readdir` + match — never a shell call). Mount in `router.mjs` next to the other `handle*Routes` calls; add the three endpoints to `ENDPOINTS` + bump version with a `32→33` comment.
- [ ] **Step 4: Run — PASS** + `node server.mjs` smoke on a free port? **No** — the live server may be running; instead assert registration via the route unit tests + `node --check`. Run full extension suite: `npm test` (all green — legacy untouched).
- [ ] **Step 5: Commit** `feat(server): /agent/v2/* routes — stream, decision, session delete (api v33)`

---

### Task 8: live smoke — scripted AskUserQuestion e2e (opt-in)

**Files:**
- Test: `extension/tests/agent-v2-live.test.mjs` (skipped unless `RUN_AGENT_SDK_SPIKE=1`)

- [ ] **Step 1: Write the test** — call `handleAgentV2Routes` with the real `deps` (no injection), a scratch DB + registered user, `agentContext = { chatSessionId: 'live-1', workspaceRoot: <extension dir> }`, prompt: `"Ask me which color I prefer using AskUserQuestion (options: red, blue), then say which I picked."` — run the route promise, and concurrently poll the captured SSE events for `approval_request`, then call the decision endpoint via doubles, and finally assert: `approval_request` → `approval_resolved {outcome:'answer'}` → final assistant `delta`s mention the chosen color → `result.subtype === 'success'` → `agent_sessions.sdk_session_id` set. Same env preamble as spike tests + `allowAmbientAuth` path (engine falls back to ambient when no key).
- [ ] **Step 2: Run with the env var** — `RUN_AGENT_SDK_SPIKE=1 node --test tests/agent-v2-live.test.mjs` — expect PASS (this spends ~$0.10). Without the env var: SKIP.
- [ ] **Step 3: Commit** `test(server): live v2 approval round-trip smoke (opt-in)`

---

### Task 9: Mac — LlmIdeAPIClient v2 methods + AgentV2Event model

**Files:**
- Create: `mac/Sources/LlmIdeMac/Views/CodeAssistant/Chat/AgentV2Event.swift`
- Modify: `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+CodeAssist.swift` (add three methods)
- Test: `mac/Tests/LlmIdeMacTests/AgentV2EventTests.swift`

**Interfaces:**
- Produces:
  - `enum AgentV2Event: Sendable, Equatable` with cases `init_(AgentV2Init)`, `delta(String)`, `toolUseStart(id: String?, name: String?)`, `toolArgsDelta(index: Int, partialJson: String)`, `toolResult(AgentV2ToolResult)`, `usage(AgentV2Usage)`, `approvalRequest(AgentV2Approval)`, `approvalResolved(requestId: String, outcome: String)`, `modeSet(String)`, `result(AgentV2Result)`, `error(code: String?, message: String)`, `sdk(String?)` + `static func decode(fromJSON data: Data) -> AgentV2Event?` (unknown types → `.sdk`, never nil-throw).
  - `LlmIdeAPIClient.agentV2Stream(_ body: [String: Any], onEvent: @escaping (AgentV2Event) -> Void) async throws` (SSE reader copied from `codeAssistStream` at L199 — `bytes.lines`, `data:` prefix), `agentV2Decision(requestId: String, sdkSessionId: String, answers: [String: String]) async throws -> Bool`, `agentV2DeleteSession(chatSessionId: String) async throws`.

- [ ] **Step 1: Failing swift tests** — decode fixtures for every event case (write the JSON literals matching the spec §4 table exactly, e.g. `{"type":"approval_request","requestId":"r1","kind":"AskUserQuestion","questions":[{"question":"Pick?","header":"Pick","options":[{"label":"A","description":"aye"}],"multiSelect":false}]}`); assert unknown type `{"type":"brand_new_thing"}` decodes to `.sdk`.
- [ ] **Step 2: Run — FAIL.** `cd mac && swift test --filter AgentV2EventTests`
- [ ] **Step 3: Implement** both files (manual `Codable` structs with `CodingKeys` mapping snake_case; decode via a `type` discriminator string).
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** `feat(mac): v2 event model + API client stream/decision/delete-session`

---

### Task 10: Mac — ChatTransport.onApproval + AgentV2Transport

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/CodeAssistant/Chat/ChatTransport.swift`
- Create: `mac/Sources/LlmIdeMac/Views/CodeAssistant/Chat/AgentV2Transport.swift`
- Test: `mac/Tests/LlmIdeMacTests/AgentV2TransportTests.swift`

**Interfaces:**
- Consumes: `ChatTransport.roundTrip(_:onProgress:onChunk:)`, `ChatTransportInput`, `ChatTransportResult`, Task 9's client methods + event model.
- Produces: protocol gains `func roundTrip(_ input: ChatTransportInput, onProgress:..., onChunk:..., onApproval: @escaping @MainActor (AgentV2Approval) -> Void) async throws -> ChatTransportResult` — provided as a protocol extension default that forwards to the two-callback variant with `onApproval` ignored, so `CodeAssistTransport` and the scripted test double compile unchanged. `AgentV2Transport(client:)` accumulates `delta` text (final reply = concatenation), maps tool events to `AgentProgress`-style progress callbacks (reuse `progressLabel`/`toolVerb` conventions), surfaces `approvalRequest` via `onApproval`, posts nothing itself (the panel/engine posts decisions), and maps `result` → `ChatTransportResult(reply: accumulated, pendingTool: nil, tasks: nil, continueNeeded: false, usage: mapped, mode: input.mode)`. `error(code: "SESSION_UNRESUMABLE")` throws a typed `AgentV2Error.sessionUnresumable`.

- [ ] **Step 1: Failing tests** — a scripted `URLSession` double is overkill; instead inject the event source: `AgentV2Transport(client:fake)` where `fake` is a small protocol `AgentV2Streaming` (`agentV2Stream(_:onEvent:)`) with a test double yielding a fixed event sequence. Assert: reply accumulation, `onApproval` fires once for `approvalRequest`, `result` maps fields, unknown event ignored, `sessionUnresumable` error thrown.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — PASS** + full `swift build` (protocol change compiles the legacy transport + existing doubles untouched thanks to the extension default).
- [ ] **Step 5: Commit** `feat(mac): AgentV2Transport behind ChatTransport with approval callback`

---

### Task 11: Mac — approval card, engine state, phone-turn note

**Files:**
- Create: `mac/Sources/LlmIdeMac/Views/CodeAssistant/ApprovalQuestionCard.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/Chat/ChatEngine.swift` (+`AgentV2ApprovalState`), `Views/CodeAssistant/ChatMessageList.swift` (render card under last assistant turn when pending), `CodeAssistantPanel` wiring
- Test: `mac/Tests/LlmIdeMacTests/AgentV2ApprovalTests.swift`

**Interfaces:**
- Produces: `ChatEngine.pendingApproval: AgentV2Approval?` (@MainActor state), `func submitApproval(answers: [String: String]) async` (calls client + clears state), `func dismissApproval()`. During an external (phone) turn, `onApproval` records a tool-step "⏸ Question pending on Mac…" into the streaming turn content so the phone's mirrored view shows it.

- [ ] **Step 1: Failing tests** — engine state machine: approval arrives → `pendingApproval` set; `submitApproval` posts via a client double and clears; second approval replaces state; external-turn flag routes to the note path (assert via turn content). Use the existing scripted-transport doubles + `ChatStoreOverrideGate` if any store is touched (per test discipline memory).
- [ ] **Step 2: Run — FAIL.** **Step 3: Implement** — `ApprovalQuestionCard` renders header, question text, option buttons (multi-select → toggle set + Submit), posts via `submitApproval`. **Step 4: Run — PASS.** **Step 5: Commit** `feat(mac): AskUserQuestion approval card + engine approval state`

---

### Task 12: Mac — engine selection, toggle, stale-server guard, save-plan, delete-session

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel.swift` (+`CodeAssistantModelState.swift`), `CodeAssistantPanel+Session.swift` (delete-session hook), `CodeAssistant+Plan.swift` (client-side save-plan for v2 plan turns)
- Test: `mac/Tests/LlmIdeMacTests/AgentV2SelectionTests.swift`

**Interfaces:**
- Produces: `@AppStorage("chat.useAgentV2") var useAgentV2 = false`; selection rule `useV2 = useAgentV2 && providerIsAnthropic(selectedProvider)`; Settings row "Agent engine (beta)" with caption; guard: on `AgentV2Error.sessionUnresumable` the panel retries once with `fresh: true` and posts an in-chat note ("Started a fresh engine session for this chat"); on any other v2 failure with HTTP 404 → banner "Server update needed for the Agent engine" + this turn falls back to legacy transport. Plan-mode v2 turns get a "Save Plan" message action using the existing `ProposedPlanResolver` path (`llm-doc/plans/`). `deleteSession` additionally calls `agentV2DeleteSession` best-effort.

- [ ] **Step 1: Failing tests** — selection rule truth table (toggle × provider); fallback-on-404 path with a double transport; save-plan action appears only for plan-like modes in v2 results.
- [ ] **Step 2: Run — FAIL.** **Step 3: Implement.** **Step 4: Run — PASS.**
- [ ] **Step 5: Full regression** — `cd extension && npm test && npm run lint`; `cd mac && swift test` (676+ tests, all green; legacy suites untouched).
- [ ] **Step 6: Commit** `feat(mac): agent engine (beta) toggle, fallbacks, v2 save-plan + session cleanup`

---

## Self-Review (done)

- **Spec coverage:** wire protocol (T1, T7, T9), approval round-trip incl. tenancy/timeout/abort + phone note (T3, T6, T8, T11), session mapping + migration 0029 + delete (T4, T7, T12), engine options/modes/skills/allowlist (T5), ledger (T7), Mac transport + toggle + guards + save-plan (T9–T12), version 33 + ENDPOINTS (T7). Checkpoints/hooks/ACP intentionally out (P2+).
- **Placeholders:** none — every step carries code or an exact file:line reference.
- **Type consistency:** `mapSdkMessage` event names match the Swift `AgentV2Event` cases field-for-field; `runAgentV2Turn`/`handleAgentV2Routes`/`deps.runTurn` signatures consistent across T6–T8; `answerDecision` signature identical in T3/T6/T7.
