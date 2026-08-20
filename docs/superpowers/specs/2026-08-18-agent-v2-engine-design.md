# Agent v2 Engine — P1 Design (Mac Chat on the Claude Agent SDK)

- **Date:** 2026-08-18
- **Status:** Approved design, pre-implementation
- **Precedes:** P1 implementation plan (writing-plans)
- **Groundwork:** research rounds 2026-08-18 (Claude Agent SDK, Cursor/ACP, staying-current), pipeline map of `/code-assist`, live P0 spike (`extension/llm_agent/sdk/spike-engine.mjs`, SDK `0.3.234` / CLI `2.1.234`)

## 1. Context

The Mac app's Code Assistant chat runs a homegrown agent loop (fence protocol, client-replayed history, one-write-per-turn `pendingTool` acks). Roughly 30% of extension maintenance duplicates what the Claude Agent SDK provides as a library. P0 spike proved with running code: SDK streaming over SSE, an in-process `llmide` MCP domain tool (`kb_search`) called by the model, the auth ladder (vault → env → operator ambient login), tool-error resilience, and cost/session telemetry.

**P1 goal:** ship the SDK engine behind the existing SwiftUI chat — read-only — as the default-off "Agent engine (beta)".

## 2. Locked decisions

| # | Decision | Choice |
|---|---|---|
| D1 | Write execution | **Staged** — P1 is read-only; server-side writes + tool approvals + guardrail hooks land in P2 |
| D2 | Rollout surface | **All four Code Assistant scopes + phone bridge**, behind a Mac-local default-off toggle |
| D3 | Existing chats | **Clean cut** — legacy chats stay on the legacy engine forever; new chats get SDK sessions |
| D4 | Modes | **Mapped** — mode chip stays; plan/assist_plan → SDK `permissionMode: "plan"` + persona; others → default + persona append |
| D5 | Connection model | **Approach A** — `POST /agent/v2/stream` per user message (SSE) + `POST /agent/v2/decision`; no WebSocket, no long-lived streaming-input sessions |

Non-goals for P1: file writes / Bash execution, guardrail `PreToolUse` hooks, checkpoints/rewind, skills-as-plugins loading (selected skills are prompt-injected), ACP adapter, canary CI, SDK-native todo surfacing, per-tool "always allow".

## 3. Architecture

```
Mac CodeAssistantPanel / phone explore_chat (unchanged UI)
  └─ ChatEngine → AgentV2Transport (implements existing ChatTransport protocol)
        │ POST /agent/v2/stream   (SSE: init/delta/tool_*/usage/approval_*/mode_set/result/error/sdk)
        │ POST /agent/v2/decision (approval answers)
        │ DELETE /agent/v2/session (chat deletion)
  ▼
Node server (pure HTTP, unchanged pipeline: CORS → JWT → rate-limit)
  routes: agent-v2.mjs (L4)
  └─ llm_agent/sdk/engine.mjs  ← only module importing @anthropic-ai/claude-agent-sdk (exact-pinned)
        ├─ events.mjs   mapSdkMessage → v2 wire events (pure, unit-tested)
        ├─ tools.mjs    createSdkMcpServer "llmide" (kb_search; graph/issues next)
        ├─ decisions.mjs pending-decision registry (in-process)
        └─ sessions     agent_sessions table (migration 0029) + per-user CLAUDE_CONFIG_DIR
```

Toggle is **Mac-local** (`UserDefaults`), not server state: the Mac picks the endpoint; the phone inherits via the shared engine. When provider ≠ anthropic the Mac auto-falls back to legacy `/code-assist` with a hint.

## 4. Wire protocol — `POST /agent/v2/stream`

**Request** (reuses today's shapes): `{message, language, model, mode, agentContext, skills:[ids], attachments:[{path,content}]}`.

**Response** — SSE, one `data: <json>\n\n` per event:

| Event | Shape | Notes |
|---|---|---|
| `init` | `{type, sessionId, claudeCodeVersion, model, capabilities:[], tools:[], mcpServers:[]}` | first event; Mac logs `claudeCodeVersion` per session; capability-gates UI |
| `delta` | `{type, text}` | streamed assistant text |
| `tool_use_start` | `{type, id, name}` | open a tool card |
| `tool_args_delta` | `{type, index, partialJson}` | live args assembly |
| `tool_result` | `{type, toolUseId, isError, text, truncated}` | 20,000-char cap; `truncated` marks cuts |
| `usage` | `{type, inputTokens, outputTokens, cacheReadTokens, contextPercent}` | per assistant message; % computed server-side |
| `approval_request` | `{type, requestId, kind:"AskUserQuestion", questions:[{question, header, options:[{label, description}], multiSelect}]}` | P1 kind is `AskUserQuestion` only; shape is tool-approval-ready for P2 |
| `approval_resolved` | `{type, requestId, outcome}` | emitted to all stream holders |
| `mode_set` | `{type, mode}` | resolved-mode echo (replaces legacy `done.mode`) |
| `result` | `{type, subtype, costUsd, numTurns, durationMs, sessionId, stopReason}` | terminal on success |
| `error` | `{type, code, message, retryable}` | terminal on failure |
| `sdk` | `{type, sdkType, subtype, raw}` | observation passthrough for everything unmapped |

**Forward-compatibility rules:** unknown event types → ignore + log; unknown fields → ignore. Only ordering guarantees: `init` first; `result` or `error` last. (The staying-current contract: the UI never version-sniffs.)

## 5. Approval round-trip (P1: AskUserQuestion only)

1. Engine's `canUseTool("AskUserQuestion", input)` → `decisions.mjs` registers `{requestId, sessionId, userId, resolve, expiresAt}` → SSE `approval_request`.
2. Mac renders a native question card (header ≤ 12 chars, 2–4 options, multi-select; previews later).
3. `POST /agent/v2/decision {sessionId, requestId, action:"answer", answers:{[questionText]: label}}` (multi-select answers are comma-joined labels) → registry resolves → `canUseTool` returns `{behavior:"allow", updatedInput:{questions, answers}}` → engine continues → `approval_resolved`.

Rules:
- **Tenancy:** the deciding user must own the session (JWT user vs `agent_sessions.user_id`); foreign decisions are 403 + logged.
- **Timeout:** 5 minutes unanswered → resolve as deny with "the user didn't answer"; the turn ends gracefully with the model informed.
- **Abort:** SSE closes with a decision pending → deny + abort the query signal; the SDK session persists and a later turn resumes cleanly.
- **Phone turns:** the Mac panel owns the card (it owns the shared engine); the phone receives a "question pending on Mac" note. Phone-side answering is a fast-follow (requires SharedProtocol additions). *(Judgment call ①.)*
- **Non-question tools in P1:** if the model attempts Bash/Edit/Write/other write tools, `canUseTool` denies with an explanatory message ("file changes arrive in the next engine release") so the model re-plans instead of failing silently.

## 6. Session mapping & persistence

- New table **`agent_sessions`** (migration `0029`): `id TEXT PK, user_id, chat_scope, mac_chat_session_id, sdk_session_id, model, created_at, last_used_at, last_mode, status`; `UNIQUE(user_id, mac_chat_session_id)`.
- The **Mac never tracks SDK session ids**. Each request carries `agentContext.chatSessionId`; the server resolves or creates the mapping; resume = `query({resume: sdkSessionId})`. Restart-tolerant between turns (no live connection). *(Judgment call ④.)*
- Per-user engine homes: `CLAUDE_CONFIG_DIR = <app-support>/agent-sdk/<userId>/` isolating SDK transcripts and credentials per tenant. **Amended 2026-08-20: keyed turns only.** An ambient-auth turn (operator `claude login`, no per-user key) must NOT get the override — the login lives under the operator's default config dir, and redirecting it leaves the subprocess "Not logged in", failing every ambient turn. Transcript cleanup on session delete scans both roots.
- Mac `ChatSessionStore` remains the UI source of truth (list/titles/delete). Chat deletion → `DELETE /agent/v2/session {chatSessionId}` → drop mapping row + best-effort SDK transcript cleanup + the existing session-memory cleanup.
- Old chats never migrate (clean cut, D3). A v2 chat whose SDK session file is missing/corrupt → server 409 `SESSION_UNRESUMABLE` → Mac starts a fresh SDK session for that chat (mapping row replaced) and says so in-chat.

## 7. Engine construction (server, `llm_agent/sdk/`)

Per-request `query()` options:
- `model` from the picker (anthropic ids only); default from config
- `includePartialMessages: true`; `settingSources: []` (operator-config isolation, spike-proven)
- `cwd` = `agentContext.workspaceRoot`; `additionalDirectories` = the same readable-roots set the legacy engine gates (`buildReadableRoots({userId, workspaceRoot})`)
- `permissionMode` per D4; `planModeInstructions` carries the assist_plan persona for plan/assist_plan
- `allowedTools`: read-only set — `Read, Glob, Grep, WebSearch, WebFetch, mcp__llmide__*` *(judgment call ② includes web tools)*
- `mcpServers: {llmide: buildServer(userId)}` — `kb_search` first (spike-proven), graph/issues next
- `systemPrompt: {type:"preset", preset:"claude_code", append: languageDirective + persona + selected skills' SKILL.md bodies}` — skills via existing `readSkillInstructions` (≤ 5, same trust rules as legacy)
- Auth ladder: vault `claude.apiKey` → `ANTHROPIC_API_KEY` env → operator ambient login (`allowAmbientAuth`)
- `maxTurns: 40`; `maxBudgetUsd` from the user's model-limits config when set; every `result` writes into the existing usage ledger (per-model caps keep working)
- Attachments remain fenced prompt blocks (explicit user context) alongside engine-side `Read` within readable roots

Legacy concepts that do not exist in v2 turns and are **not emulated**: `pendingTool`, `"(continue)"` acks, auto-continue, `tasks`/`continueNeeded`. The PlanTimelineCard is hidden in v2 chats (SDK-native todos arrive later); assist_plan's plan approval rides `AskUserQuestion`, and save-plan is a client-side action on the plan message via the existing `ProposedPlanResolver` → `llm-doc/plans/`. *(Judgment call ③.)*

## 8. Mac integration

- `AgentV2Transport` implements the existing `ChatTransport` protocol: `delta` → streaming append; tool events → `toolSteps` (existing SF Symbol icons); `result` → turn finish + metadata (cost/model); `approval_request` → engine approval-card state; `mode_set` → ModeBadge.
- Engine selection: `useV2 = toggle && provider ∈ anthropic`; otherwise legacy. Stale-server guard: if `/agent/v2/stream` is absent from the server's endpoint list, the toggle surfaces "server update needed" instead of failing turns.
- Model picker filters to anthropic models when v2 is on. Sessions UI unchanged.
- Phone: `explore_chat` drives the shared engine unchanged (auto-continue/autoChain already suppressed for external turns).

## 9. Testing

- **Server unit:** mapper events (extend the spike suite); decision registry register/resolve/timeout/**tenancy rejection**; `agent_sessions` CRUD + migration; mode→options mapping; deny-message for non-question tools; SSE routes via req/res doubles (spike pattern).
- **Live smoke (opt-in env, canary seed):** v2 stream end-to-end with a scripted `AskUserQuestion` decision posted server-side — proves the round-trip against the real engine.
- **Mac (swift-testing):** `AgentV2Transport` event decoding; approval lifecycle state machine; `ChatStoreOverrideGate` discipline wherever stores are touched.
- **Regression:** the legacy path is byte-identical; all existing suites stay green.

## 10. Rollout & versioning

- `SERVER_API_VERSION` → 33; new endpoints `/agent/v2/stream`, `/agent/v2/decision`, `DELETE /agent/v2/session`; `ENDPOINTS` + `SERVER_API_VERSION` per invariant.
- Both engines coexist until P2 deprecates the fence loop for anthropic.
- Observability P1: `claudeCodeVersion` + per-turn cost logged; activity-feed integration deferred.
- Staying-current hooks (SDK exact-pin, capability detection, changelog watching) per the 2026-08-18 research; canary CI is P1.5/P2 scope.

## 11. Security & tenancy

Every engine call is user-scoped: KB tool handlers take `userId` first (tenancy guard spike-proven — `userId: null` is rejected inside the tool); decisions are tenancy-checked; per-user `CLAUDE_CONFIG_DIR` (keyed turns only — see the amendment above) + `settingSources: []` isolate operator config; attachments/skills keep the legacy trust boundaries (attachments are DATA-fenced; skills are trusted-instruction blocks read server-side by id).

## 12. Phase pointers

- **P2:** server-side writes (`Edit/Write/Bash`) + tool approvals (same `approval_request` shape, new kinds) + guardrail `PreToolUse` hooks + "always allow" persistence (`updatedPermissions`) + skills-as-plugins.
- **P2/P3:** checkpoints (`enableFileCheckpointing`), context-meter UI, canary CI, SDK-native todos, phone-side approval answering.
- **P4:** provider routing table (SDK vs native loop), fence-loop deprecation for anthropic, optional ACP adapter.
