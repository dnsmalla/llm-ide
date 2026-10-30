# agent-kit

Status: **K0 Map**, written 2026-10-29. No code was changed. Citations are `path:line`, read on 2026-10-29 at `main` (`16358bcf`). Counts say how they were taken (grep, `wc`, or run). Section 11 lists where the migration plan's premises do not match the code; section 12 lists what could not be verified.

## 1. Purpose

agent-kit is the **north-star kit**: the model-facing half of LLM-IDE. It is the chat the user talks to (Mac Code Assistant panel, menu-bar quick chat, phone chat through the Mac, extension side-panel chat), the server engines that answer it, the provider layer that reaches the models, and the extension surface (plugins, MCP servers, LLM sources, skills) that is delivered into a turn. Its job under the plan's principle (*skeleton for ever-improving LLMs*) is to stay a thin adapter over the Claude Agent SDK and own only project control: permission, budget, routing, memory, contract.

The plan row (`docs/superpowers/plans/2026-10-27-kit-by-kit-migration.md:103`, kit 5) names: `llm_agent/`, `providers/`, `mcp/`, `plugins/`, `llm-sources/`, `agents/agent-prompt`, `kb/` chat-sessions, agent-sessions, session-memory, turn-composition, personas, tool-*; `Features/Chat`, `ClaudeLink/`; side-panel chat. Key `agent_chat` (never off); contract groups `agent`, `providers-usage` and the plugin, MCP and LLM-source rows of `health-auth`; depends on core. The plan's "known hard spot" (`:116`) says chat sessions are double-stored (Mac JSON files vs `unified_chat_sessions` / `agent_sessions`) and that K1a decides the home. This map confirms the problem and finds it is a different shape than the plan states (section 5): the server table the plan names is not read by the Mac at all, and `agent_sessions` is a mapping, not a transcript.

Since the plan was written (2026-10-27), the **agent store** landed (`docs/superpowers/plans/2026-10-28-agent-store.md`): agent history (runs, tool events, turn composition, activity) moved out of the main DB into a separate `agent.db`. Section 2a maps it as it is now.

## 2. Code on every side

### 2a. Server (Node, `extension/`)

Line counts by `wc -l` on 2026-10-29.

| Piece | Path | Lines | Notes |
|---|---|---|---|
| v2 engine (Agent SDK) | `llm_agent/sdk/` (20 `.mjs`, plus `sdk-surface.json` 733) | 4 692 | `engine.mjs` 2 025: `buildEngineOptions` `:559`, `runAgentV2Turn` `:1204`, `MAX_TURNS = 40` `:1064`, `settingSources: []` `:853`, SDK `plugins:` `:1663`, `maxBudgetUsd` `:1617,1690`, `resume` `:1336,1725`. `events.mjs` 165 maps SDK messages to wire events. `tools.mjs` 272 mounts the llmide in-process MCP server. `decisions.mjs` 128 parks approvals. `models.mjs` 205 asks the SDK for `supportedModels()`. `updater.mjs` 204 installs a newer SDK. `loop-agent.mjs` 783 is the Loop's headless engine (route is automation-kit's). SDK pinned `0.3.301` (`package.json:31`) |
| Classic engine (fence loop), deleted in P6; its shared survivors were relocated in K4 (P7) to `llm_agent/{tools,modes,memory,plan,tasks}/`, no `runtime/` folder remains | former `llm_agent/runtime/` (18 `.mjs`) | 4 047 | `loop.mjs` 976 (`runAgentLoop` `:463`, `runNativeAgentLoop` `:831`), `fence.mjs` 209 (`<<<TOOL_CALL>>>` sentinels `:5-6`), `route.mjs` 752 (`handleCodeAssist` `:132`), `openai-tools.mjs` 70, `modes/mode-classify.mjs` 232, `modes/mode-personas.mjs` 124, `plan/plan-pipeline.mjs` 428, `memory/memory-extract.mjs` 441, `memory/memory-persist.mjs` 155, `tools/decide.mjs` 329 |
| Tool handlers and registry | `llm_agent/tools/handlers/` (14), `llm_agent/tools/` (2) | 2 078 + 589 | One registry (`tools/registry.mjs:1-8`) feeds both engines; `gates.mjs` 266 classifies act tools `blocked` / `auto` / `prompt` |
| Skills loader | `llm_agent/skills/` (5) | 1 203 | `registry.mjs` 496, `loader.mjs` 320; skill text still delivered as prompt blocks (`engine.mjs:1578` `readSkill`) beside native `plugins:` |
| Agent content | `llm_agent/global/`, `internal/` | 31 `.md`, 1 798 | Prompts and tool frontmatter; `README.md:1-20` |
| Whole `llm_agent/` | | 65 `.mjs`, 12 837 | Counted by `find`/`wc` |
| Provider layer | `providers/` (10) | 4 075 | `providers.mjs` 1 432 (routing, OpenAI/Google adapters, CLI spawn), `runtime.mjs` 1 047 (`runClaude`, Anthropic HTTP + CLI), `warm-cli-pool.mjs` 416 (one pre-spawned `claude` for the classifier, `:1-12`), `tier-routing.mjs` 294, `web-client.mjs` 282, `jev.mjs` 264, `route-health.mjs` 162, `claude-plugin-cli.mjs` 82, `prompt-utils.mjs` 81, `backoff.mjs` 15 (`RETRY_DELAYS_MS = [1000, 3000]` `:7`) |
| MCP registry | `mcp/` (7) | 1 107 | `state.mjs` 531 (JSON registry plus per-user consent, `:4`), `catalog.mjs` 200, `mcp-config.mjs` 93 (builds the per-user `mcpServers`), `claude-source.mjs` 61, `codex-source.mjs` 49 |
| Plugins | `plugins/` (12) | 3 481 | `loader.mjs` 931, `claude-adapter.mjs` 501, `codex-adapter.mjs` 404, `installer.mjs` 334, `claude-update.mjs` 308; trust in `hook-trust.mjs`, `import-trust.mjs`. State in `plugin-state.json` (`state.mjs:30`) |
| LLM sources | `llm-sources/` (2) | 1 137 | `registry.mjs` 939 (`llm-sources.json` `:84`), `state.mjs` 198 |
| Agent prompt | `agents/agent-prompt.mjs` | 228 | **Meeting-agent** question generator (`:1`), imported by `agents/meeting-agent.mjs` and `routes/agent.mjs`; see section 11, P3 |
| Routes | `routes/agent-v2.mjs` 770, `routes/agent.mjs` 550, `routes/chat.mjs` 131, `routes/agent-history.mjs` 107; `server/ai-routes.mjs` 925 (`/chat` `:348`, `/code-assist` `:449`, `/code-assist/decision` `:766`); `server/auth-routes.mjs` 1 996 holds 68 plugin, claude-plugin, codex-plugin, llm-source and mcp-plugin path literals (first `:985`, last `:1917`) | | `agent-v2.mjs`: `/agent/v2/stream` `:283`, `/decision` `:286`, `/session` `:289`, `/cancel` `:292`; one turn per (user, chat) via `chatSessionLockKey` `:156` |
| Session and policy tables (main DB) | `kb/chat-sessions.mjs` 202, `agent-sessions.mjs` 117, `session-memory.mjs` 187, `personas.mjs` 373, `tool-approvals.mjs` 58, `tool-permissions.mjs` 199, `memory-ledger.mjs` 117 | 1 253 | Migrations: `0004` agent_feedback, `0007` agent_ask_messages, `0023` chat_sessions + chat_messages, `0028` session_memory, `0029` agent_sessions, `0030` tool_approvals, `0034` tool_permission_rules, `0038` project_memory_ledger, `0049` pending_agent_purges. Personas are one JSON blob in `user_flags['agent.persona']` (`personas.mjs:9`), not a table |
| Agent history store (`agent.db`) | `kb/agent-db.mjs` 497, `agent-store.mjs` 613, `agent-runs.mjs` 55, `agent-jobs.mjs` 171, `agent-history-api.mjs` 163, `agent-history-copy.mjs` 311, `agent-usage.mjs` 235; wrappers `turn-composition.mjs` 124, `tool-events.mjs` 32, `tool-events-summary.mjs` 81, `activity.mjs` 139 | 2 045 (first seven) | Agent migrations `0001_agent_store.sql`, `0002_usage_calls.sql`. Tables `agent_runs`, `agent_tool_events`, `turn_composition`, `activity`, daily rollups, `store_meta`, `usage_calls` (the shadow). Metadata only (`0001_agent_store.sql:7-8`). Routes `/kb/storage`, `/kb/agent-history/{settings,clear,compact}` (`routes/agent-history.mjs:41-89`) |

What the agent store is, accurately (the plan row predates it):

- **History moved, live state stayed** (`agent-store.md` section 0, decision 1). `agent.db` holds runs, tool events, turn composition and activity. `agent_sessions`, `session_memory`, `tool_permission_rules`, `tool_approvals`, personas, feedback, `project_memory_ledger`, `model_limits`, `quota_state` and `usage_ledger` stay in the main DB.
- `kb/tool-events.mjs:1-3` and `kb/turn-composition.mjs:1-8` now write only to `agent.db` through its queue. The main-DB tables `turn_tool_events` and `turn_composition` are the pre-move history, copied once (`agent-history-copy.mjs:1-5`) and never deleted by it (`:8`).
- **Usage is shadowed, not moved.** `agent-usage.mjs:1-8` mirrors every `usage_ledger` row into `usage_calls` and compares them; the ledger stays authoritative and no budget read changed (agent-store plan section 0.1, "Stage 2a (shadow, shipped)"). Stage 2b (the cutover) is not started.
- `agent.db` is **not** an eligible home for chat transcripts: it stores "no prompt, response, tool argument or error message" (`0001_agent_store.sql:7-8`; plan decision 4).
- Location: `<dataDir>/agent.db` beside `data.db`, plus `<dataDir>/agent-sdk/` (`core/data-dir.mjs:1-6,86`). The Mac sets `LLMIDE_DATA_DIR` to `~/Library/Application Support/llm-ide/system`.
- Boot and lifecycle: `agent-jobs.mjs:1-14` (open before listen; quick_check, the one-time copy and the daily rollup after listen; flush on shutdown).

Server-side SDK transcripts are a **third copy of every v2 conversation** (section 5): the SDK writes its own session transcript under `CLAUDE_CONFIG_DIR`. For API-key and gateway turns that is a per-user home `<dataDir>/agent-sdk/<userId>` (`sdk/auth.mjs:49-52`); for subscription (`claude login`) turns it is the operator's real `~/.claude` (`sdk/transcripts.mjs:32-38`). The server only deletes them (`transcripts.mjs:26-39`); it never reads them.

### 2b. Mac app (Swift, `mac/Sources/LlmIdeMac/`)

`Features/Chat/` is 99 files, 24 118 lines (`find`/`cat | wc -l`; the plan's "~24 k" holds).

| Folder | Files | Lines | What is there |
|---|---:|---:|---|
| `Models/` | 7 | 1 358 | `ChatMessage.swift` 573 (tool steps, tool results, metadata, plan-card state: `:365-372`), `ChatSession.swift` 147 (v2 envelope, `engine` marker `:35`, `projectId` `:45`), `ProposedEdit`, `ProposedPlan`, `SubagentActivity`, `DiffStats` |
| `Engine/` | 11 | 3 033 | `ChatEngine.swift` 1 565 (turn state machine; injected `forgetSessionMemory` `:501` and `deleteAgentV2Session` `:510`), `+ExternalTurn` 368 (phone and external turns), `+PanelWrites`, `+History`, `PlanExecutionTracker` 160, `PlanCitationCheck` 199, `ChatAutoChainPolicy`, `ChatStreamBuffer`, `ToolStepLog/Merge`, `ChatEngineHooks` |
| `Session/` | 3 | 1 424 | `ChatEngine+Session.swift` 804 (persist `:81`, `persistedMessageCap = 500` `:79`, switch `:546`, delete `:707`), `ChatSessionStore.swift` 206, `QuickChatContext.swift` 414 |
| `Transport/` | 2 | 564 | `AgentV2Selection.swift` 440 (toggle, capable-provider set, `useV2` `:84`), `CodeAssistTransport.swift` 124 (classic engine) |
| `Services/` | 11 | 2 332 | `ChatEngineRegistry.swift` 463 (`:65`; `backgroundLimit = 6` `:89`), `ChatMobileHost.swift` 249, `ExplorerMobileEngineResolver.swift` 221 (the phone's off-screen engine pool, `:49`), `CodeWorkflowService.swift` 845, `VoiceInputService`, `ChatAttachmentReader`, `ChatModule.swift` 20 (the `.agentChat` module; it starts the Live session mirror, `:3-4`) |
| `Views/` | 4 + `Panel` 49 + `Quick` 6 + `Shared` 6 | 976 + 11 715 + 1 678 + 1 038 | Code Assistant panel (CodeAssistantPanel and extensions), menu-bar and sheet quick chat, `CodeWorkflowSheet` 619, `QuickFixSheet` 263 |
| `ClaudeLink/` (Core layer by `feature-map.txt`) | 7 | 1 837 | `AgentV2Transport` 588, `AgentV2Event` 420 + `+FieldReport` 185, `ClaudeToolPresentation` 247, `ClaudeSubscriptionUsageClient` 229, `ClaudeCLI` 117, `TokenCostPolicy` 51 |

Core backing code (line counts by `wc -l`):

| Piece | Path | Lines |
|---|---|---:|
| Contracts | `Core/Contracts/ChatTransport` 272, `ChatPanelProviding` 133, `ChatOutputProviding` 48, `MobileChatHosting` 165, `EditAcceptanceMode` 80, `ChatEnginePreference` 12, `ChatScope` 18, `SessionScoped` | 728 (the first seven) |
| Platform | `AgentTypes.swift` 428 (`AgentContext`, `chatSessionId` stable handle), `TierRouting*.swift` (`TierRouting` 497, `+Images` 70, `+Labels` 46, `TierRoutingServerState` 209, `TierDefaults` 416, `TierDefaults+Reconcile` 115), `ProviderCatalog` 106, `ProviderAvailability` 180, `CustomProvider` 295, `LiveModelCache` 77, `PurposeModelPolicy` 111 | |
| API client | `Core/Networking/API/LlmIdeAPIClient+CodeAssist` 776 (`agentV2Stream` `:576`, `agentV2DeleteSession` `:762`, legacy `codeAssist` `:130`), `+Agent` 179, `+AgentMeta` 260, `+Providers` 123, `+Usage` 213, `+McpPlugins` 356, `+LlmSources` 286, `+AgentSdk`, `+LoopAgent` 168 (Loop's, via `LoopAgentRunning`) | 2 361 (eight files) |
| Settings cards that drive agent-kit routes | `AgentSdkSettingsSection` 195, `CustomProvidersSection` 638, `ProvidersSettingsSection` 363, `TierRoutingSection` 452 + `+Roles` 195, `TokenSavingSettingsSection` 90, `ToolApprovalsSettingsSection` 201, `MemorySettingsSection` 83, `AgentHistorySettingsCard` 311 + `AgentHistoryModel` 294 | 2 822 |

`Core/Platform/SessionStore.swift` is **auth** (access and refresh token), not chat: the name in the plan row is a trap. Chat persistence is `Features/Chat/Session/ChatSessionStore.swift`.

Plugin, MCP and LLM-source UI lived in `Features/Library/` (K0 count); Track Q moved 27 of those files (5 355 lines) to the sealed, always-compiled `Features/Extensions/`, and Library reaches them through `ExtensionsLibraryRegistry` in `Core/Contracts/`. K0 count before the move, not in Chat: 28 files, 5 457 of 12 108 lines (45%), reproduced by file-name pattern (`Plugin*`, `Mcp*`, `LlmSource*`, `ClaudePluginImport`, `CodexPluginImport`). One of the 28, `Services/McpConnectorAdapter.swift` (102 lines), is the MCP-backed **ingest** adapter and belongs to knowledge-kit regardless; the rest is 5 355 lines (44%). See Q4.

### 2c. Extension (Chrome side panel)

| Piece | Path | Lines | Notes |
|---|---|---:|---|
| Chat hook | `src/sidepanel/hooks/useChat.ts` | 228 | Posts `/chat` (`:145`, buffered, not the v2 engine) with prior messages; persists to the **server** table via `unified-chat.ts` (`appendChatMessage` `:115,175`) |
| Server-backed transcript session | `src/lib/unified-chat.ts` | 131 | Calls `/kb/chat/sessions` list/create/get/append/clear; stores the session id in `chrome.storage.local` key `unifiedChatSessionId` (`:24`); surface `extension`, mode `transcript` (`:111,118-119`) |
| View, commands, persona | `ChatView.tsx` 208, `chat-commands.ts` 14, `AgentPersonaSettings.tsx` 141 | 363 | |
| Not chat | `useAgent.ts` 199 | | **Meeting agent** attach/stop/runs (`/kb/agent/dispatch`, `/stop`, `/runs`), capture-kit |
| Required endpoints | `App.tsx:57-75` | | `REQUIRED_ENDPOINTS` includes `/chat` and `/kb/chat/sessions`; `MIN_SERVER_API_VERSION = 20` `:84` |

### 2d. iOS and Mobile Control touchpoints

- The phone never reads chat storage. It speaks the Mobile Control WebSocket and the Mac answers from its own `ChatSessionStore`: tags `explore_list_sessions`, `explore_load_session`, `explore_new_session`, `explore_delete_session`, `explore_chat`, `explore_rename_session`, `explore_cancel`, `llmide_chat_history_*` (`ios_app/SharedProtocol/Sources/SharedProtocol/MobileProtocol.swift:74-96`).
- The Mac side is seam-only: `Core/Contracts/MobileChatHosting.swift:1-14` (Mobile Control names no Chat type); Chat implements it as `ChatMobileHost` (`Services/ChatMobileHost.swift:12`); Shell sets `manager.chatHost` (`Shell/FeatureCatalog.swift:682`). The session list push is driven by a file watcher on the Mac session directory (`ChatMobileHost.swift:161`; `MobileControlManager.swift:1630-1637`).
- The phone keeps its own copy of the session list and current transcript (`ios_app/MyApp/Services/ExplorerChatStore.swift` 543 lines, `:12-14`): a fourth transcript copy, volatile by design.

### 2e. Contract schemas and fixtures

| Group | Rows (`endpoints` count, python over the schema) | Fixture files | Notes |
|---|---:|---:|---|
| `agent` | 37 | 68 | `/agent/v2/*`, `/kb/agent/*` (ask, ask/history, personas, persona, feedback, catalog, commands, skill-library, generation-library, project-memory, session-memory, tool-approvals, runs, dispatch, stop), `/kb/chat/sessions*` |
| `providers-usage` | 14 | 45 | `/kb/providers/{verify,models}`, `/kb/agent-sdk`, `/kb/agent-sdk/update`, `/kb/custom-providers`, `/kb/routing-tiers`, `/kb/usage/*` |
| `health-auth` | 65 | 154 | Of which 37 are plugin, claude-plugin, codex-plugin, llm-source and mcp-plugin rows (filter on those substrings, excluding `GET /auth/mcp-connector/callback`); these live in `server/auth-routes.mjs`, feature `core` |
| `agent-history` | 5 | 10 | New since the plan: `/kb/storage`, `/kb/agent-history/*`. Not in the plan's group list |
| `agent-v2` (SSE events) | 16 event types | 19 | `schema/agent-v2/agent-v2.schema.json` (267 lines; `init, delta, tool_use_start, tool_args_delta, tool_result, usage, result, error, approval_request, approval_resolved, mode_set, memory, tasks, tasks_progress, context_usage, sdk`); checked by `scripts/conformance-agent-v2.mjs` (282 lines, `Makefile:190`). `SERVER_API_VERSION = 83` (`server.mjs:288`) |

Endpoints in the `agent` and `providers-usage` groups with **no live client** (`schema/http/INVENTORY.md:55-75`): `/kb/agent/ask` (tests only), `/kb/agent/ask/history`, `/kb/agent/personas*`, `/kb/agent/feedback*` (comments/docs only), `/kb/usage/turn-composition`, `/agent-sdk/spike` (tests only). The Mac's `LlmIdeAPIClient.swift:605-612` records that the Ask-the-Agent trio was removed when the `.quick` engine took over its transcript. Six `/kb/chat/sessions` rows are marked "no Mac caller" in `mac/Sources/APIContractLab/Routes.swift:114-157`.

### 2f. Feature key `agent_chat`

- `agent_chat` is in `FEATURE_KEYS` (`extension/core/config.mjs:81`) and is always added to the enabled set (`:119`); `AppFeature.agentChat` (`Core/FeatureToggles/AppFeature.swift:5`); `LlmIdeMacApp.swift:221-227` forces it into `LLMIDE_FEATURES`. It owns **no** server route group in `feature-routes.mjs` and no `#if FEATURE_*` (grep: 0 in `Features/Chat` and `ClaudeLink`). It is the base the other seven keys are subtracted from.
- `make build-mac-min` (`Makefile:70`) builds with `LLMIDE_FEATURES=agent_chat` only; `build-mac-lite` and `build-mac-mobile-only` are the other quadrants (`:62`, `:79`). Boundary gate on 2026-10-29: `bash mac/Scripts/feature-boundaries.sh` prints `total: 0  sealed violations: 0` and `none` / "all exist" for every other section.
- Plugins, MCP servers, LLM sources, the classic engine and Jev have **no key**: they are always compiled and always served.

### 2g. Tests and gates

| Suite | Count | How counted |
|---|---:|---|
| Server tests in agent-kit scope | 139 `.mjs` files (plus 1 `.ts`); **1 698 tests by the runner**, 1 533 `test(`/`it(` by grep | `git ls-files tests` filtered by name (agent-*, agent-v2-*, agent-store-*, mcp-*, plugin*, providers*, tier-*, tool-*, sdk-*, llm-sources*, skills-*, fence-*, mode-*, route-*, warm-cli-pool, web-client, chat-sessions, jev, etc.; excludes usage*, graphify-memory*, project-memory, memory-ledger, install-project-skills, mcp-connector*, meeting-agent); grep `^\s*(test\|it)\(`; the runner count is higher because of tests generated in loops |
| Server tests, usage (core, adjacent) | not counted | `usage*.test.mjs` stay with core |
| Extension | 3 | `tests/chat-commands.test.ts` grep |
| Mac `Tests/LlmIdeMacTests/Chat/` | 43 files, 8 381 lines, 382 test funcs | `find`/`cat`; grep `func test…(` and `@Test` |
| Mac tests beside it | 12 files, 128 | `ChatEngineStopNoticeTests`, `ChatPanelRegistryTests`, `CodeAssistModeTests`, `CodeAssistTransportTests`, `ExplorerMobileEngineResolverTests`, `ProposedEdit/PlanResolverTests`, `PlanSavedPayloadTests`, `TierDefaults/TierRouteFallback/TierRoutingTests`, `SessionScopedResetTests` |
| Mac Mobile Control tests | 25 files | `ls \| grep -ic mobile` (plan: "25 Mobile test files" holds); they pin the phone-chat bridge |
| `chat-contract-lab` | 2 184 lines, 521 assert-like lines | `Sources/ChatContractLab/main.swift`; `make chat-gates` (`Makefile:187`) |
| Contract | `make contract-gates`, `scripts/conformance-http.mjs`, `scripts/conformance-agent-v2.mjs` | Not run here |
| Token bench | 7 scenarios, committed baseline | `schema/bench/token-baseline.json` (haiku-5-5, 2026-10-26); `make token-bench` |

Run results are in section 13.

## 3. Cross-kit edges

Server edges are in-process imports (the Node layers); Mac edges must go through `Core/Contracts`.

### 3a. Who consumes agent-kit

| Consumer | Edge | Through | Violation? |
|---|---|---|---|
| Explorer, ReviewConflicts, Doc Gen, Visual | Embed the chat panel for scopes `explorer`, `conflicts`, `docGen`, `visual` | `ChatPanelView(request:)` in `Core/Contracts/ChatPanelProviding.swift` (grep: ExplorerView, ReviewView, DocGenView, VisualView) | No |
| ReviewConflicts | Code-change sheets | `CodeWorkflowSheetView` (same contract) | No |
| Doc Gen | Reads the last chat reply | `ChatOutputRegistry` (`GenerationSaveChatOutputRow.swift`) | No |
| MobileControl | Phone chat turns, session list/load/delete, parked approvals | `MobileChatHosting` / `MobileChatTurnEngine` (`Core/Contracts/MobileChatHosting.swift`) | No |
| MobileControl (chat permission mode) | Reads the Manual/Bypass chip | `EditAcceptanceMode` (`MobileExploreBridge`, `MobileUsageBridge`) | No |
| Settings | Writes the Agent v2 toggle | `ChatEnginePreference.useAgentV2DefaultsKey` | No |
| Loop | Headless agent runs | HTTP `/kb/loop/agent-run` via `LlmIdeAPIClient+LoopAgent.swift` and `Core/Contracts/LoopAgentRunning` | No (route is automation-kit's; engine `llm_agent/sdk/loop-agent.mjs` is in this kit's folder) |
| Loop (RegressionRunner) | **Classic** `/code-assist` | `api.codeAssist(` at `Features/Loop/Services/Verification/RegressionRunner.swift:434,506` through the Core API client | No, but it blocks retiring the classic engine (section 8, K2) |
| AutoTask, Loop | Tier routing, usage record | `Core/Platform/TierRouting*`, `/kb/usage/record` | No |
| Server agents (planner, summarize, codegen, dispatcher, email-classify, connector-classify, agent-prompt) | `runClaude` and tier routing | In-process import of `providers/` (grep: 7 files in `agents/`) | Allowed by the layer table (`agents → L0–L2`); it means work-kit, knowledge-kit and capture-kit all depend on `providers/` |
| `routes/doc-gen.mjs`, `server/export-routes.mjs`, `routes/router.mjs` | `providers/` | Import | Allowed |
| `routes/loop-agent.mjs` | `llm_agent/sdk/loop-agent.mjs` | Import | Allowed (L4 → L3) |
| Chrome extension | `/chat`, `/kb/chat/sessions`, `/kb/agent/*` | HTTP | n/a |

### 3b. What agent-kit consumes

| Dependency | Edge | Through | Note |
|---|---|---|---|
| core | `kb/db.mjs` (9 imports), `kb/usage.mjs` (4), `kb/user.mjs` (3), `server/vault.mjs`, tier routing, auth | In-process | Expected: row 5 depends on core |
| graph-kit | `graphkit/index.mjs`, `memory.mjs`, `memory-writer.mjs` (14 imports from `llm_agent/`) | In-process | Project memory (chat-memory.md, Graphify) is graph-kit code that chat reads and writes; the plan lists `graphkit/` under kit 3 |
| knowledge-kit | `search-kb` handler uses `searchKb` over `kb/` sources (`tools/registry.mjs:31`) | In-process | Agent reads the KB; no cycle (knowledge-kit depends on agent-kit only for `providers/`) |
| Library (Mac) | Chat reads the Library list | `LibraryItemStore` in `Core/Notes` (1 reference in `Features/Chat`) | Through Core |
| Issues | Existing-issue picker and recent issues in turns | `IssueSeamRegistry`, `RecentIssuesProviding` in `Core/Contracts/IssueSeams.swift` | Through Core; the seam that removed the agent ↔ work cycle (plan "Cycle rule") |
| Explorer | Project memory viewer in Code Assistant | `ProjectMemoryRegistry` | Through Core |
| Repo, SourceControl backing code | `RepoManager` (23 references), `SourceControlService`, `RepoBackendFactory` | `Core/Repo/` | Through Core |
| Live | `ChatModule` starts `LiveSessionMirror` | Injected `any FeatureService` (`ChatModule.swift:3-12`) | Chat's module owns a capture-kit service lifecycle |

### 3c. Cycles and violations

- **Mac:** none. The gate prints zero cross-feature references and zero Core-to-feature or feature-to-Shell references (run 2026-10-29). The nine mentions of `ChatSessionStore` and `ChatEngineRegistry` outside `Features/Chat/` are comments only (`LlmIdeAPIClient.swift:608`, `MobileChatHosting.swift:7`, `ChatScope.swift:4`, `AppShell.swift:700`, others).
- **Server:** `npx eslint llm_agent providers mcp plugins llm-sources agents kb routes server` exits with no output (zero violations, ran). `llm_agent` imports: `kb` 27, `providers` 20, `graphkit` 14, `plugins` 4, `llm-sources` 4, `mcp` 3 (grep). `providers`, `mcp`, `plugins`, `llm-sources` import only core-side modules (and `plugins → providers/claude-plugin-cli`).
- **Layer oddity:** the plugin, MCP and LLM-source **routes** are in `server/auth-routes.mjs` (core), reached by dynamic `await import('../plugins/…')`, `'../mcp/…'`, `'../llm-sources/…'` (`:996-1923`). The edge is legal; it means those 37 rows' handlers sit inside a 1 996-line core file, and K1 for them is an extraction.
- **Hidden coupling:** `kb/session-memory.mjs:1-6` keys on the Mac's `ChatSessionStore` UUID with no existence check; `routes/agent-v2.mjs:329-331` requires `agentContext.chatSessionId`; so the Mac session id is the join key for four server tables. There is no FK.
- **Two ownership overlaps in the plan table:** `kb/tool-*` is listed under agent-kit (row 5) and `kb/ … tool-permissions/activity` under core (plan core row). `kb/activity.mjs` moved into `agent.db` yet is read by the os-kit aggregate.

## 4. Delegated vs owned

Under the plan: *delegated* pieces are thin adapters; *owned* pieces are project control and get the tests. "Re-implements" marks code that does what the SDK or CLI already does.

| Piece | Label | Evidence |
|---|---|---|
| The v2 tool-use loop | **Delegated** | `query()` from the SDK (`engine.mjs:48`); `MAX_TURNS = 40` is the only loop policy (`:1064`) |
| Prompt cache, resume, usage per session | **Delegated**, thin owned shims | `resume` (`engine.mjs:1336,1725`). `usage-baseline.mjs:1-12` differences the SDK's running `modelUsage` totals (SDK 0.3.277+); `turn-context.mjs:1-15` keeps per-turn blocks out of the cached prefix. Both exist because of SDK behaviour, so they track it |
| Context compaction | **Delegated** | `settings.autoCompactWindow` (`engine.mjs:226,889`); owned re-delivery after a compaction (`:1823-1830`) |
| Model list | **Delegated** | `supportedModels()` (`sdk/models.mjs:1-12`) |
| Subagents, plugin loading into a turn | **Delegated** (partly) | SDK `plugins:` (`engine.mjs:1663`), per-user `subagents` (`:1626`). Skill text is **also** injected as prompt blocks (`:1578`, `core/prompt-framing.mjs`): two delivery paths |
| MCP servers | **Delegated** for protocol, **owned** for registry, consent and pinned package spec | `mcp/state.mjs:1-5`; `engine.mjs:1660-1668`; `claude-plugin-cli.mjs:1-3` ("the ONLY place that knows `claude plugin …` argv") |
| Web search and fetch | **Delegated** | Anthropic-native `web_search`/`web_fetch` first (`web-client.mjs:1-12`); SerpAPI and raw fetch are fallbacks |
| Plan mode | **Delegated** mechanism, **owned** pipeline | `mode → permissionMode/persona` (`engine.mjs:5-6`); upstream skills drive the stages (`plan-pipeline.mjs:1-14`) |
| Tool permission policy | **Owned** | SDK `canUseTool` and hooks are the mechanism; `tools/gates.mjs:1-12` (blocked/auto/prompt), `kb/tool-permissions.mjs:1-14`, `kb/tool-approvals.mjs:1-12`, `sdk/decisions.mjs`. `sdk-surface.json` records "canUseTool is our only permission" as an ignored SDK item |
| Budget | **Owned** value, delegated enforcement | `maxBudgetUsd` passed to the SDK from `model_limits` (`engine.mjs:1107,1617,1690`); tier routing `providers/tier-routing.mjs:1-20`, Mac `TierRouting.swift` |
| Provider dispatch, OpenAI/Google/custom adapters | **Owned** | `providers/providers.mjs:1-10`; the SDK speaks only the Anthropic Messages API, so `AgentV2Selection.agentCapableProviders` (`:45`) limits v2 to Anthropic and Anthropic-compatible custom providers |
| Retry and backoff for model calls | **Owned, partly re-implemented** | `backoff.mjs:7` (1 s, 3 s, three attempts) shared by the CLI and HTTP paths; the SDK emits its own `SDKAPIRetryMessage` (`sdk-surface.json:4`, status `needs-human`) |
| Classic fence tool loop | **Re-implements** the SDK | `runtime/loop.mjs` 976 + `fence.mjs` 209 + `route.mjs` 752 + `openai-tools.mjs` 70 (about 2 000 lines) parse `<<<TOOL_CALL>>>` text and dispatch handlers; the SDK ships native tool use. Still needed today for non-Anthropic providers (`runNativeAgentLoop` `loop.mjs:831`), chats stamped legacy, Loop's RegressionRunner, and the extension `/chat` |
| Session-fact extraction | **Owned**, candidate to measure | `memory-extract.mjs:1-12` makes one extra model call per turn; `docs/explanation/invariants.md:467` says session memory is injected only for a session **without** a transcript, so on a resumed v2 chat its value is limited to fresh, unresumable, restart and post-compaction cases |
| Mode classifier | **Owned** | One model call before every auto-mode turn (`mode-classify.mjs:1-7`); `warm-cli-pool.mjs:1-12` exists only to hide ~5 s of its ~10 s spawn cost |
| SDK update tooling | **Owned** | `sdk/updater.mjs:1-12`; `sdk-surface.json` ledger: 182 items, 43 adopted, 10 ignored, **129 `needs-human` with reason "seed: not yet reviewed"** (python count). The plan's upgrade-and-tune loop has a ledger but 71% of it has never been triaged |
| Wire protocol (SSE, 16 events) | **Owned** | `schema/agent-v2/agent-v2.schema.json`; `sdk/events.mjs:1-10` is the single mapper |
| Tenancy and secrets for the SDK subprocess | **Owned** | `sdk/subprocess-env.mjs:1-12` (env denylist), per-user `CLAUDE_CONFIG_DIR` (`auth.mjs:49-52`), `redactSecretsForStorage` on stored chat text (`chat-sessions.mjs:166-170`) |
| Plugin and MCP trust | **Owned** | `plugins/hook-trust.mjs`, `import-trust.mjs`; hooks gated three ways (`sdk/hooks.mjs:1-14`) |
| Plugin format readers | **Owned** | `claude-adapter.mjs` 501, `codex-adapter.mjs` 404 read vendor formats; Claude's are partly superseded by SDK-native delivery, Codex's are not |
| Jev decisions | **Owned**, optional vendor | `providers/jev.mjs:1-14`, `tools/decide.mjs:1-12`; decision-only, never a chat model |
| Mac chat UI and engine | **Owned** | `ChatEngine` is UI state (messages, parked approvals, plan tracker); `ClaudeLink/` is the thin adapter (`AgentV2Transport` implements the Core `ChatTransport` contract; docs `docs/explanation/claude-linker.md`) |
| Mac chat persistence | **Owned** | section 5 |
| Agent history store (`agent.db`) | **Owned** (observability) | metadata only, queue, rollups, retention |

Honest reading: the v2 path already delegates what the SDK does well, with owned code concentrated on permission, budget, tenancy, memory and the contract. The sizeable re-implementation is the classic engine (about 2 000 lines on the server plus the Mac classic transport and `LlmIdeAPIClient+CodeAssist.swift`'s legacy half), and it is held up by four consumers (section 8, K2), not by neglect.

## 5. State and data: the chat-session stores (feeds K1a)

### 5.1 The stores

| # | Store | Location | Written by | Holds | Per user? |
|---|---|---|---|---|---|
| C1 | **Mac session files** | `~/Library/Application Support/llm-ide/sessions/<uuid>.json` (`ChatSessionStore.swift:4-9,48-55`) | `ChatEngine.persistCurrentChat` (`ChatEngine+Session.swift:81`), debounced while streaming, last **500** messages (`:79`) | The full UI transcript: `ChatMessage` with tool steps, tool results, plan-card state, usage (`ChatMessage.swift:365-372`), plus `scope`, `engine` marker, `projectId` (`ChatSession.swift:35,45`) | **No.** One directory; wiped on sign-out (`ChatEngineRegistry.swift:459-462`) |
| C2 | **SDK transcript** | `<dataDir>/agent-sdk/<userId>/projects/…` or the operator's `~/.claude/projects/…` (subscription) (`transcripts.mjs:32-38`) | The Agent SDK, on every v2 turn | The conversation the model actually resumes from | Yes for API-key turns; operator-shared for subscription turns |
| C3 | **`agent_sessions`** | main DB, `0029_agent_sessions.sql` | `getOrCreateAgentSession` (`agent-sessions.mjs:40`), `markAgentSessionUsed` (`:66`), `replaceAgentSession` (`:88`), `deleteAgentSession` (`:102`) | Mapping `mac_chat_session_id` to `sdk_session_id`, model, last mode. **Not a transcript** | Yes, `UNIQUE (user_id, mac_chat_session_id)` |
| C4 | **`session_memory`** | main DB, `0028` | `memory-persist.mjs`, `kb/session-memory.mjs` | Extracted facts per chat UUID, deleted with the chat | Yes, no FK (`session-memory.mjs:3-6`) |
| C5 | **`chat_sessions` + `chat_messages`** | main DB, `0023_unified_chat_sessions.sql` (the **table** names are `chat_sessions` and `chat_messages`) | `routes/chat.mjs`, used only by the extension transcript chat (`unified-chat.ts`) | role, content (≤64 000), `meta_json` (≤32 000), 2 000 messages per session, secrets redacted at write (`chat-sessions.mjs:10-16,166-170`) | Yes |
| C6 | `agent_ask_messages` | main DB, `0007` | `/kb/agent/ask` | Ask-the-Agent history; no live client (INVENTORY `:74-75`) | Yes |
| C7 | Phone's session list and transcript | `ExplorerChatStore` on the iPhone | WebSocket replies from the Mac | A cache of C1 | n/a |

Not stores of the transcript but part of the picture: `agent_runs` / `agent_tool_events` / `turn_composition` in `agent.db` (metadata, run id equals the chat turn id), `usage_ledger`, `project_memory_ledger`.

So the same v2 conversation exists three times: C1 (what the user sees), C2 (what the model sees) and, in summary form, C4. They are written by different processes at different moments and are never compared.

### 5.2 Source of truth, per datum

| Datum | Truth today | Notes |
|---|---|---|
| What the user sees: messages, tool-step cards, plan cards, titles, scope, project | **C1** (Mac) | Nothing server-side can render a Mac chat; C5 cannot hold `toolSteps` or plan state except as a 32 KB `meta_json` blob |
| What the model remembers on a v2 chat | **C2** (SDK transcript), reached through **C3** | The Mac does not resend history on a normal v2 turn: the body carries `message`, skills, attachments, `agentContext` and, only when `fresh`, the packed history (`AgentV2Transport.swift:244-282`) |
| Which SDK session belongs to a chat | **C3** | Server-owned binding (`agent-v2.mjs:310-314`) |
| Chat id ownership and scope | **C1** | C3 stores `chat_scope` default `explorer` (`agent-sessions.mjs:16`) while the Mac scope is one of five (`ChatScope.swift:11-17`): the server does not know the real scope |
| Per-turn facts | **C4** | Keyed by the Mac UUID |
| Which engine a chat runs on | **C1** (`ChatSession.engine`, stamped at creation, "never rewritten", `ChatSession.swift:23-34`) | The classic engine is therefore tied to chats written before the marker, for ever |
| Extension transcript chat | **C5** | The only consumer |
| Run history and token totals | `agent.db` (display) and `usage_ledger` (authority) | |

### 5.3 Where they disagree today (findings)

1. **The plan's server table is not read by the Mac.** `kb/chat-sessions.mjs:1-4` says so in its header; `Routes.swift:114,115,138,139,157` list the rows as "no Mac caller"; `rg` of `mac/Sources` and `ios_app` for `kb/chat` finds only `APIContractLab`. C5 is the extension's store. The Mac and the extension therefore do **not** share chat history, despite `routes/chat.mjs:1` ("shared by macOS + extension") and the migration comment ("shared across macOS Code Assistant, extension…", `0023_unified_chat_sessions.sql:1-3`).
2. **Delete does not cover everything.** A Mac delete removes C1, then forgets C4 and drops C3 plus the SDK files (`ChatEngine+Session.swift:707-745`; server `agent-v2.mjs:751-770`), best-effort: a failed call "just leaves a stale mapping" (`:737-745` comment). **Sign-out** wipes C1 (`ChatEngineRegistry.swift:459-462`) but not C2, C3 or C4, so a later sign-in by the same user finds server state for chats that no longer exist locally. Not run; by reading.
3. **A Mac chat is not per user; the server state is.** C1 is a shared directory cleared on sign-out; C2 to C4 are tenant-scoped. Account switch is handled by deletion on the Mac only.
4. **Redaction differs.** C5 redacts pasted keys at write (`chat-sessions.mjs:166-170`); `ChatSessionStore` writes raw (`SecretRedactor` is not used in `Features/Chat/Session`; its only Chat use is a git error string, `CodeAssistant+Git.swift:135`).
5. **Caps differ.** C1 keeps 500 messages (`persistedMessageCap`); C5 keeps 2 000 with 64 KB per message.
6. **The classic engine and the v2 engine split chats permanently.** `AgentV2Selection.useV2` needs toggle on **and** the chat stamped `agentV2` **and** a capable provider (`:84-88`). The toggle defaults on for new chats (`:107`), so every pre-marker chat stays classic.
7. **`agent_sessions.chat_scope`** has a single default value and no validation set (`agent-sessions.mjs:14-16`): dead dimension.
8. **Two server tables outlive their clients:** `agent_ask_messages` (C6) and `agent_feedback` have no live caller (INVENTORY), but still sit in `deleteUserCascade` (`kb/db.mjs:973,977-979,1021`).

### 5.4 How the phone sees sessions

Through the Mac only. The phone sends `explore_list_sessions`; Mobile Control asks `MobileChatHosting`, whose Chat implementation reads `ChatSessionStore.list(for: .explorer, …)` and engines from the registry; a kqueue-style watcher on `sessions/` re-pushes the list when files change (`MobileControlManager.swift:1630-1637`, debounce 1.0 s). If the Mac app is not running the phone has no sessions. This is the property the plan's sync-kit (relay + phone PWA) cannot keep while C1 stays on the Mac.

### 5.5 The session rules that any K1a must keep

From `CLAUDE.md` memory ("background chat sessions") and the code:

- **One live engine per session.** `ChatEngineRegistry` (`ChatEngineRegistry.swift:1-14`) must be able to see the phone's off-screen pool (`ExternalEngineHolder` `:16-28`, implemented by `ExplorerMobileEngineResolver`) so a session the phone runs is not loaded into a second engine. The failure it prevents is "two writers, one file".
- **Switching goes through the registry.** `switchDisplayedSession` (`:228`) parks a *busy* engine (limit 6, `:89`) instead of cancelling; idle engines are never parked. A parked engine keeps persisting without an observer (`persistsUnobserved`, `ChatEngine.swift:282`).
- **Disk is the hand-off.** A finished parked engine is dropped because its reply "is on disk" (`ChatEngineRegistry.swift:84-86`). Any K1a that moves persistence behind HTTP changes that guarantee.
- **Flush before switch/new/quit** (`invariants.md:419`; `ChatEngineRegistry.flushAll` `:324`).
- **Quarantine rather than lose:** undecodable files become `.corrupt-<ts>` (`ChatSessionStore.swift:196-205`); a bad message is dropped, not the chat (`ChatSession.swift` decode comment, "lossy" `LossyChatMessage`).
- **Interrupted turns are repaired on load:** a persisted `.streaming` message becomes `.stopped` (`ChatSession.swift` decode).
- **One v2 turn at a time per (user, chat)** on the server (`agent-v2.mjs:142-148,156`); a second returns `TURN_IN_PROGRESS` (`:204`).

## User decisions 2026-10-29

The user decided an architecture principle that applies to both kits (full text and the table of every data kind: [data-lifecycle.md](data-lifecycle.md)). In the user's words: "i want best and no duplicate data save but can be accessible from mac app and mobile app. the web is connector but extension is to call mac app, no data access to that." For chat transcripts: "i want only in live time in DB and when end save in mac app and delete the DB data".

Read as: (1) **one stored copy**, readable by the Mac app and, through it, the phone; (2) **live then archive**: while a chat is live its working data is in the server DB; when it ends it is saved once into the Mac chat store (`sessions/<uuid>.json`) and the server rows are deleted; (3) the extension has **no data access of its own** (no store, no read-back); (4) metadata-only history (`agent.db` runs, tool events, rollups; `usage_ledger`) is not a transcript and is outside the rule (**my assumption, to be confirmed**).

What this changes for this kit, by reading:

- **Section 6's recommendation (option A, server rows as the truth, then retire the Mac file) is reversed.** The server rows are working state only; the Mac store is the single archive. Options B and C and D are also not it. The decision is a fifth option, **E: live in the server DB, archive to the Mac at the end, delete the rows.**
- **This is the reverse of today for Mac chat.** The Mac writes its own file while the chat runs (`ChatEngine+Session.swift:79,81`) and the server tables are used only by the extension (`kb/chat-sessions.mjs:1-4`). Live-in-DB for a Mac chat is new design: a Mac client for the live rows, a write path in `ChatEngine+Session`, and a new meaning for the registry's "disk is the hand-off" rule (5.5).
- **What the live rows are:** `chat_sessions` + `chat_messages` (C5, migration `0023`) are the natural live tables, with their caps and write-time redaction (`kb/chat-sessions.mjs:166-170`). C3 (`agent_sessions`), C4 (`session_memory`) and the SDK transcript (C2) are working state that the end of the session deletes, through the existing delete route (`routes/agent-v2.mjs:751-770`).
- **What breaks:** (a) **resuming an ended chat**: the SDK transcript is gone, so a new turn needs `fresh` plus archived history (`AgentV2Transport.swift:276-282`), which loses the prompt cache and session-memory continuity; (b) **sign-out** wipes the Mac store (`ChatEngineRegistry.swift:459-462`), which is now the only copy; (c) **a chat that never ends** keeps its rows on the server as the only copy; (d) the **extension chat** (`unified-chat.ts`, `/chat` at `useChat.ts:145`, `/kb/chat/sessions`) is the only consumer of C5 today and has no archive path to the Mac; (e) **per-message latency**: persisting through the server is now on the live path of every message, where the K1 budget assumed an off-stream shadow (section 8); (f) agent `search_kb` and the planner cannot see an ended chat unless a Mac-side index exists. The phone is unaffected after the end (it reads the Mac store, 5.4); a live session's visibility to the phone is open (lifecycle R5).

**Second round, 2026-10-29 (decided, see [data-lifecycle.md](data-lifecycle.md) section 1a):**

- A **meeting-attached chat** is **deleted when its meeting ends**: not archived, not continued.
- A **normal Mac chat** is **saved in the Mac app** and kept until the **user** deletes it. Deleting a chat deletes it **everywhere** (Mac file, server rows, mapping, facts, SDK transcript).
- The **live DB copy** of a chat or app session ends at **app quit**: archive, verify, delete; a **next-start recovery sweep** covers crashes. This replaces the open "chat that never ends" rule (R8).
- An **ended normal chat can be opened**. **Continuing** it is **not decided** (lifecycle R2b). DEFAULT-ASSUMPTION, not a decision: replay archived history into a fresh SDK session; read-only is the alternative.
- The **extension** calls the Mac app live for reads, including its own chat, and stores nothing (R1). The local Mac-app API for that is **unverified**.
- A rebuildable index with no unique data may stay on the server (R3), so agent `search_kb` and the planner can read it for archived chats and notes.
- Still open, each with a labelled default: R4 redaction timing, R5 live-session visibility with the Mac closed, R6 plans, R7 metadata stays on the server.

### Status of Q1 to Q11 after the decision

| # | Status | How |
|---|---|---|
| Q1 | **Answered** | Live in the server DB; a normal chat is archived in the Mac chat store at app quit and kept until the user deletes it; a meeting-attached chat is deleted at meeting end; rows deleted. Not A, B, C or D as written |
| Q2 | **Partially answered, still open** | One archived copy on the Mac is raw today. The original reason for redaction (no secret replayed into later model calls) holds only during the live phase, so the open choice is live-only, also at archive, or never (lifecycle R4, open; DEFAULT-ASSUMPTION: live phase only) |
| Q3 | Open, one consumer fewer | The extension `/chat` leaves the picture if Q8's answer below stands; the other three consumers (legacy chats, non-Anthropic providers, Loop's RegressionRunner) remain |
| Q4 | Open | Unaffected |
| Q5 | **Partially answered, reframed** | The Mac store is per install and is now the only copy, kept until the user deletes it, so wiping it on sign-out destroys finished work. Open: archive-then-wipe, keep, or per-user folders (lifecycle risks) |
| Q6 | Open | Personas are configuration (`kb/personas.mjs:9`), assumed to stay on the server, so the question is only ownership |
| Q7 | Open | `agent_ask_messages` (C6) is not session data to archive; removal still proposed |
| Q8 | **Answered** (R1, 2026-10-29) | The extension keeps no chat store. `/kb/chat/sessions` and `unified-chat.ts` go, and the side-panel chat calls the Mac app live (decided; the call path is unverified). `REQUIRED_ENDPOINTS` (`App.tsx:57-75`) must change with it |
| Q9 | Open | Unaffected |
| Q10 | Open | Unaffected |
| Q11 | Open | Unaffected |

## User decisions 2026-10-30

Recorded in the user's meaning. The plan that applies them is [agent-kit K1](../superpowers/plans/2026-10-30-agent-kit-k1.md); this section only records what was decided and what is still open.

### Decided

- **Q3 (engine).** The Claude Agent SDK is the **only** agent engine for Claude. The classic homegrown loop (`llm_agent/runtime`: `loop.mjs`, `fence.mjs`, `route.mjs`, `openai-tools.mjs`; Mac `CodeAssistTransport`) is retired in stages. Non-Anthropic providers get a small separate completion/tool adapter (evaluate the Vercel AI SDK against keeping only the OpenAI-compatible path; **not LiteLLM**, because of the 2026 supply-chain incidents). Plain chat for them needs no loop. This answers the open Q3 above and the "classic engine held up by four consumers" finding (section 4).
- **Token burn is mostly our configuration.** The first track is a *lean SDK configuration* pass measured on the token bench before and after: compact system prompt as default with an exploration cap (evidence: -16% on edit tasks, +55% on read-only search, so a hop bound or a Haiku search subagent comes first); drop `Bash` from modes that do not need it (5.8k); verify `settingSources`, git instructions and attachments; revisit `snapshot: false` (`engine.mjs:888`); a 1-hour cache TTL experiment; a compaction window of about 100k; check built-in tool-result clearing before building our own; Haiku subagents for search; keep `promptSuggestions` and `agentProgressSummaries` off; re-measure tool-search deferral on the current CLI; measure and cut our own per-turn memory-extract call and mode-classifier call. Bench gates: 15% token and 30% time regression thresholds.
- **Q2 (ended chats).** An ended chat continues on a **fresh SDK session** seeded with a short per-chat summary (made on a cheap model at archive time) plus the last 4 to 6 turns; older detail comes back on demand through `search-kb`. **Resume, not fresh, only when the chat is warm** (last activity under the cache TTL). A long transcript is never cold-resumed (about 156k billable for the first turn at 125k context). This is the answer to lifecycle R2b for the Claude engine.
- **Q9 (SDK surface).** Triage the 129 `needs-human` rows by *removes our own code, then saves tokens, then improves safety*; ignore about 20 rows of irrelevant tools and UI plumbing. Adopt first, as separate bench-gated tasks and never inside K1: `options.sessionStore`; `options.agents` + `tools.AgentInput` (Haiku search subagent); `options.fallbackModel`; `messages.SDKAPIRetryMessage`; `messages.SDKRateLimitEvent`; `messages.SDKPermissionDeniedMessage`; `messages.SDKModelRefusalFallbackMessage` / `NoFallbackMessage`; `messages.SDKThinkingTokensMessage`; `tools.Task*` (replacing our `task-create` / `task-update` MCP tools, availability to be checked); `options.skills`; `options.sandbox`; `query.mcpServerStatus`; `options.resumeSessionAt` + `resumeDropsTurn`; `options.agent` (persona and mode without rewriting the system prompt, which would allow `snapshot: true`); `tools.EnterPlanMode` / `ExitPlanMode` (lower priority). The ledger is extended to module-level functions (`listSessions`, `getSessionMessages`, `deleteSession`, `forkSession`). Updating `sdk-surface.json` is a task; the human approval is the user's approval of this list on 2026-10-30.
- **Q4 (ownership).** The plugin, MCP and LLM-source UI (about 5 457 lines in `Features/Library`) and its 37 routes in `server/auth-routes.mjs` **move to agent-kit ownership**. Library keeps notes and sources only (`McpConnectorAdapter`, the MCP ingest adapter, stays with Library).
- **Migration order.** (1) lean-config pass; (2) SDK triage and top-15 adoption; (3) `RegressionRunner` to a plain completion route (it sends prompt-only, `history: []`); (4) extension `/chat` removal per the data-lifecycle decision (remove `/chat` and `/kb/chat/sessions` from `REQUIRED_ENDPOINTS`, bump `MIN_SERVER_API_VERSION`), coordinated with live-then-archive; (5) legacy chats continue on v2 through the summary-plus-recent-turns path and new chats are no longer stamped classic; (6) non-Anthropic adapter, then delete the fence loop and `CodeAssistTransport`; (7) retire `runtime/` after one release (K4) with an API version bump for the removed routes.

### Open: not decided

- **Subscription login and the SDK terms.** The SDK terms say third-party developers may not offer claude.ai login or its rate limits without Anthropic's approval. LLM-IDE has a `claude login` subscription path (`llm_agent/sdk/transcripts.mjs:32-38`, `llm_agent/sdk/auth.mjs:37-38`) and a CLI fallback. This is a business and terms decision, not an engineering one. The plan keeps the **API-key path first-class** and adds a single switch for the subscription path without deleting code. The terms text itself was not read when this was written.

### Status of Q1 to Q11 after this round

| # | Status | How |
|---|---|---|
| Q3 | **Answered** (2026-10-30) | SDK-only for Claude; classic retired in stages; separate adapter for other providers |
| Q2 | **Answered for continuation** (2026-10-30) | Summary plus recent turns on a fresh session, resume only when warm. Redaction timing stays as recorded under 2026-10-29 |
| Q4 | **Answered** (2026-10-30) | The plugin / MCP / LLM-source UI and routes move to agent-kit; the target folder is a question in the K1 plan (Q-T2) |
| Q9 | **Answered** (2026-10-30) | Triage rule and the top-15 list above |

Two findings from the 2026-10-30 reading that the K0 map above does not state: `llm_agent/runtime/` is **not** only the classic loop (the v2 engine imports most of the folder, so retiring it means deleting four files and relocating the rest), and the `ask` mode currently exposes `Bash`, `Edit` and `Write` to the model (only `plan`, `assist_plan`, `review` and `document` are restricted). Details and file:line evidence are in section 0.4 of the plan.

## 6. K1a data plan (home of chat session state after K1)

Constraints from the plan template (K1a: one-way migration, N-1 readability, rollback, a real old-format fixture) and from this map:

- The stream protocol and the 16 event types do not change.
- Additive routes only; wire changes bump `SERVER_API_VERSION` (83 today).
- `agent.db` cannot hold transcripts (its own decision 4); the main DB or files can.
- The Mac keeps working against an older adopted server (`AgentV2Selection.swift:222-228` already falls back on a 404; same pattern).
- C2 (SDK transcript) is not a candidate for truth: it is an SDK-private jsonl, lives in an operator's `~/.claude` for subscription turns, and cannot render tool-step cards.

### 6.1 Options

| Option | Home | Migration | N-1 | Rollback | Pros | Cons and risks |
|---|---|---|---|---|---|---|
| **A. Server rows** | New per-message rows in the main DB (id, session, seq, JSON body), plus a session row (id, user, scope, project, title, engine, updated) | Mac uploads `sessions/*.json` once, idempotent by UUID | Old Mac keeps C1 untouched | Pref flips reads back to C1; Mac files are never deleted during the window | Phone, relay and Tauri read sessions without the Mac; one deletion path (cascade, `deleteUserCascade` test); per-user; redaction available; backups include it | Transcript content in the DB (privacy decision); rewrites the disk-as-hand-off guarantee; the largest Swift change (`ChatEngine+Session`, registry flush); message JSON sizes (tool results) |
| **B. Stay on the Mac, add a server index** | C1 stays truth; server mirrors `(id, title, scope, project, updated)` best-effort | None for transcripts | Trivial | Drop the mirror | Smallest risk; phone can list while Mac is off | Does not fix relay (no transcripts), nor cleanup drift; a fourth store |
| **C. Server files** | Node owns `<dataDir>/sessions/<user>/<uuid>.json` with the same envelope | Copy files; Swift struct stays the schema | Old Mac reads its own dir | Same pref | No SQL schema for rich messages; atomic write already proven | Same Mac behaviour change as A; no query, no cascade; backup treatment differs |
| **D. Hybrid** | A for the *session index and light transcript*, C1 as local cache | A phased A | | | | Two truths unless write-through is strict |

### 6.2 Recommendation

**A, reached in two stages, with a shadow phase.** The repository already has the precedent: the agent store shipped `usage_calls` as a shadow beside the ledger with a compare job before any read moved (`agent-usage.mjs:1-12`; agent-store plan section 0.1). Apply it:

1. **Shadow write.** Mac keeps C1 as truth and also PUTs each persisted message to the server behind a pref (default off). A compare job counts disagreements. No read changes.
2. **Import.** One-time upload of existing `sessions/*.json` with real old-format fixtures: v1 files with `history` and no `scope`, v2 files, files with an unreadable message, `.corrupt-` files, legacy scope-named files (`ChatSessionStore.swift:166-194`), a session with `engine == nil` and one with `agentV2`.
3. **Cutover reads.** List and load by route, C1 as fallback; the registry keeps its "disk is the hand-off" meaning by making a local write-through the first step of persistence.
4. **Retire** C1 as truth only after one release (plan K4 rule), keeping rollback by pref.

Why not B or C alone: B leaves the property the plan cares about (the phone and a future Tauri app without the Mac) unsolved; C moves the problem to a file tree with no query or cascade. Why not do nothing: the three-copy drift in 5.3 is real (items 2 to 4), and every K3 screen (Tauri) needs to list sessions without scanning a folder (`ChatSessionStore.list` reads every JSON file in the directory, `:70-88`).

### 6.3 Risks of the recommendation

- **Product behaviour:** server redaction changes what a reloaded chat shows (a pasted key becomes a marker) versus today's raw files; and sign-out would no longer wipe the transcript. Both are Q2 and Q5.
- **Write rate:** `persistCurrentChat` runs on every history change and debounced during streaming; per-message upsert must stay off the stream path (budgets, section 8).
- **Two writers to one session** (Mac and phone engines) is the failure the registry exists to prevent; server rows need an `updated` precondition or a single writer per session.
- **Size:** `persistedMessageCap` says "a few MB worst case" (`ChatEngine+Session.swift:70-79`); the server cap today is 32 KB `meta_json` and 64 KB content.
- **Backup and retention:** main-DB growth; the agent store solved this for metadata with retention and Clear (agent-store plan decision 2), not for content.
- **N-1:** an old app against a new server is safe (additive); a new app against an old adopted server must keep working from C1.

## 7. Open questions for the user

**2026-10-29: Q1 and Q8 are answered, Q2 and Q5 partially, by "User decisions 2026-10-29" above; the table below is the original list.**

| # | Question | Options | Consequence |
|---|---|---|---|
| Q1 | Where do chat transcripts live after K1? | A server rows (recommended technically), B Mac stays truth plus an index, C server files, D hybrid | A unlocks phone/relay/Tauri without the Mac; B is cheapest; decides the size of K1 (section 8) |
| Q2 | Should the server copy be redacted (as C5 is) or raw (as C1 is)? | Redact at write; raw plus at-rest encryption; raw only | Redaction changes reload fidelity; raw puts pasted secrets in the DB |
| Q3 | What happens to the classic engine and to chats stamped legacy? | Keep until legacy chats are gone; migrate legacy chats to v2 by replaying history into a fresh SDK session (`fresh` plus `history` already exists, `AgentV2Transport.swift:276-282`); sunset with a cut-off date | The plan's first retirement candidate is held up by legacy chats, non-Anthropic providers (OpenAI/Google/DeepSeek/custom), Loop RegressionRunner (`:434,506`) and the extension `/chat` |
| Q4 | Who owns the 28 files, 5 457 lines of plugin, MCP and LLM-source UI in `Features/Library` (and the 37 server rows in `auth-routes.mjs`)? | agent-kit K3/K4 (knowledge-kit map suggested this); knowledge-kit; a third "extensions" unit | Not decided here. If agent-kit, K3 grows by about 5.4 k lines and the folder boundary `Features/Library` vs `Features/Chat` needs a seal rule; `McpConnectorAdapter` (102 lines) stays with knowledge |
| Q5 | Should a Mac chat be per user (server rows) or per install (today: wiped on sign-out)? | Per user, kept across sign-out; per install, wipe on sign-out; per user but wipe on "disconnect all accounts" (`accountCredentialsRevoked`, `SessionScoped.swift`) | Changes the sign-out promise users may rely on |
| Q6 | Where do the meeting-agent pieces go: `agents/agent-prompt`, `kb/personas`, `routes/agent.mjs` dispatch/stop/runs, `useAgent.ts`, `agent`-group rows? | capture-kit (row 8 already owns `agents/meeting-agent`); agent-kit as the plan says | `agent-prompt.mjs:1-12` is imported by `meeting-agent.mjs` only; leaving it here creates a capture ↔ agent edge |
| Q7 | Remove the dead routes (`/kb/agent/ask*`, personas, feedback, `/kb/usage/turn-composition`, `/agent-sdk/spike`)? | Remove in K2 with an API version bump; keep as documented legacy | Removes ~3 tables' writers and 6+ contract rows; extension REQUIRED_ENDPOINTS unaffected |
| Q8 | The extension side-panel chat: keep `/chat` plus `/kb/chat/sessions`, or move it to the v2 engine and the same session store? | Keep (smallest); move (one engine, one store) | It is the only consumer of C5 and of `/chat`; `REQUIRED_ENDPOINTS` pins both (`App.tsx:57-75`) |
| Q9 | Who triages `sdk-surface.json` (129 of 182 items "not yet reviewed") and when: before K1, as its own branch, or after? | Triage first (cheap, high token payoff); after K1; never | The plan says behaviour-changing SDK adoption never rides in a K1 |
| Q10 | Settle ownership overlaps in the plan table | `kb/tool-permissions` and `tool-approvals` to core or agent-kit; `kb/activity` (now `agent.db`) to core; `project_memory_ledger`, `memory-ledger.mjs` and project memory (`graphkit/memory*`) to agent-kit or graph-kit | Affects K1 route boundaries |
| Q11 | Does Stage 2b of the agent store (move the usage ledger and budget reads) happen before or inside agent-kit K1? | Before; with K1; deferred | `usage.mjs` is core's, but `providers/runtime.mjs:19` and `engine.mjs:1107` read it on the model-call path |

## 8. K1 task breakdown (proposal, assumes option A)

**Revised 2026-10-29** (see "User decisions 2026-10-29"): option A is superseded by live-then-archive. The table below is the original. What changes:

- **T1, T2:** the server store becomes **live and ephemeral**: the routes and tables are for in-progress sessions only, and every table must be on the delete-at-end path as well as `deleteUserCascade`.
- **T3, T4 (shadow write, compare job):** replaced. There is no second truth to shadow; the live write is the only write during a session. The compare job becomes a verifier for the archive (archived file equals the live rows).
- **T5 (one-time import of `sessions/*.json`):** not needed. The files are already the archive; nothing is uploaded.
- **T6 (cutover reads and write-through):** becomes "live writes to the server, archive to `ChatSessionStore` at end". Still the riskiest task, now on the hot path.
- **New: app-quit archive with verify-then-delete.** At app quit write the archive, read it back, then delete the rows, the `agent_sessions` mapping, the facts and the SDK transcript (R8, decided).
- **New: startup recovery sweep.** A session found in both places is finished (delete); a live session with no archive, left by a crash, is archived first, never deleted.
- **New: meeting-end cleanup of the meeting-attached chat.** At meeting end delete its rows, mapping, facts and SDK transcript; no archive (R2, decided).
- **New: delete-everywhere on user chat delete.** The Mac file plus any server rows, mapping, facts, SDK transcript and index entry, retried at next start from a tombstone if a part fails.
- **New: extension read path via live Mac calls.** Replace the extension's `/chat`, `/kb/chat/sessions`, search, conflict questions and stats with calls to the Mac app; first verify the local Mac-app API exists and is enough (R1).
- **New: index rebuild-from-files job** for the rebuildable server index that `search_kb` and the planner read (R3, decided), with a drop-and-rebuild test.
- **Conditional: resume of an ended normal chat** by replaying archived history into a fresh SDK session. Only if the user confirms continuing is wanted (lifecycle R2b, open; DEFAULT-ASSUMPTION yes); otherwise read-only.
- **T7 (phone bridge):** mostly unchanged, because the phone reads the Mac store; the directory watcher stays (`MobileControlManager.swift:1630-1637`). Live-session visibility is lifecycle R5.
- **T8 (unified delete and sign-out):** user delete removes the chat everywhere (decided); also decides archive-before-wipe at sign-out.
- **T9 (port Swift tests):** the Swift store tests are **not** ported or deleted, because `ChatSessionStore` stays as the archive.
- **T10 (extension):** no longer optional; the extension chat store and routes are removed and replaced by live calls to the Mac app (Q8, R1 decided), after the Mac API is verified.
- **Budgets:** the per-message upsert line below no longer holds. Persisting is on the live path, so it must stay coalesced and off the stream path, with a measured budget before any change.
- K4 (retire) no longer retires `ChatSessionStore`; it retires the server tables' durable role.

Plan size: 15–20 tasks for K0–K2, 8–10 if K1 is "sessions/history/plan-tracker only". This proposal is the narrow variant; the wider variant (moving more of `ChatEngine` into Node) is not proposed because the engine is UI state.

| # | Task | Size | Notes |
|---|---|---|---|
| T1 | Session envelope and routes: schema, fixtures, additive `/kb/chat/*` extension (upsert message, list, load, delete), `SERVER_API_VERSION` bump | S | Extends the `agent` group; keep the extension's use of the same table working |
| T2 | Server store module + migration `0050`, user cascade, redaction rule per Q2, node tests | M | `deleteUserCascade` enumerator test (`tests/user-delete-cascade.test.mjs`) must list the new tables |
| T3 | Mac remote store client + shadow write behind a pref | M | `ChatSessionRemote` beside `ChatSessionStore`; `ChatEngine+Session.persistCurrentChat` stays truth |
| T4 | Compare job and metric (shadow vs C1) | S | Same shape as `compareLedgerShadow` |
| T5 | One-time import with old-format fixtures | M | `ChatSessionV1Fixtures.swift` exists as a seed (`Tests/…/Chat/`) |
| T6 | Cutover reads and write-through; registry flush semantics | L | The riskiest task; touches `ChatEngine+Session` (804), `ChatEngineRegistry` (463), `ChatSessionStore` (206) |
| T7 | Phone bridge adaptation (watcher → server change feed) | S | `MobileControlManager.swift:1630-1637`, `ChatMobileHost.swift:161` |
| T8 | Unified delete and sign-out (`DELETE /agent/v2/session` also deletes the transcript) | S | Per Q5 |
| T9 | Port Swift tests for moved logic (`ChatSessionStoreTests`, `ChatSessionDecodeToleranceTests`, `ChatSessionProjectScopingTests`, `ChatSessionStoreIsolationTests`) to node or `chat-contract-lab` **before** deleting them | M | Plan template K1 rule |
| T10 | Extension: leave as is, or adopt the new routes (Q8) | S | |

Total: 8–10 tasks, about 5–8 M agent tokens at the plan's 0.4–0.7 M per task. If Q1 is B, T2–T6 collapse to about 3 tasks.

**Latency budgets** (to be confirmed with a measured baseline in T1; streaming protocol unchanged):

| Path | Budget | Basis |
|---|---|---|
| Local session list (50 sessions) | under 50 ms | Plan K1 template example |
| Load one session (up to 500 messages) | under 50 ms warm, under 150 ms cold | Same |
| Per-message upsert | off the stream path; returns under 20 ms; coalesced like the existing debounce (`ChatEngine+Session.swift` comment, "debounced during streaming") | Do not add a round trip before the first token |
| Time to first token for a v2 turn | no more than +5% on the committed baseline medians (greeting 1 328 ms, explain-file 2 430 ms, small-edit 7 595 ms; `schema/bench/token-baseline.json`, haiku-5-5, 2026-10-26) | The bench's own gate is 15% tokens and 30% time with a 500 ms floor (`docs/how-to/run-the-token-bench.md`); baselines are machine and account dependent |
| Token cost per turn | unchanged (nothing in K1 touches the prompt) | Greeting 2 315 billable tokens, explain-file 12 968 |
| Stream protocol | unchanged: SSE, 16 event types, `AgentV2Event` decode | `agent-v2.schema.json`; `conformance-agent-v2.mjs` |

## 9. K2, K3, K4

**K2 Remove.** `agent_chat` is never off, so "removal" for this kit means two things:

1. **Prove the floor:** with the other seven keys off the kit still builds and serves. This already exists: `make build-mac-min` (`LLMIDE_FEATURES=agent_chat`, `Makefile:70`), `make feature-matrix` (`scripts/feature-matrix.mjs`: 7 single-off rows, closure row, three quadrants), plus the boundary gate. K2 adds an assert that `agent-kit` code references no excludable feature without a guard (check 1 already covers always-compiled layers).
2. **Make optional parts removable.** Nothing inside agent-kit has a key today. Candidates, each a decision (Q3, Q4, Q7): the classic engine (about 2 000 server lines plus `CodeAssistTransport` 124 and the legacy half of `LlmIdeAPIClient+CodeAssist`); plugins/MCP/LLM-source UI and routes; Jev; the dead routes and their tables. Removal there needs either a key (an eighth feature) or deletion; both are product decisions, not mechanical K2 work.

**K3 Screen.** Tauri screens read only the K1 routes: chat list/load, the stream, the approval card (`/agent/v2/decision`), providers, tier routing, usage, SDK status, agent history. The Mac chat UI is the largest in the product (Views/Panel 11 715 lines); K3 should reuse ui-kit and not port panel logic. A WebView cannot scan `~/Library/Application Support/llm-ide/sessions`, so K3 depends on T6.

**K4 Retire.** After one release with both, delete `ChatSessionStore` as truth, `QuickChatContext`'s file paths and the directory watcher, and the Swift tests for moved logic. `ClaudeLink/` and `ChatEngine` stay (they are the UI engine and the thin adapter).

## 10. Risks

| # | Risk | Evidence | Mitigation |
|---|---|---|---|
| R1 | Moving persistence behind HTTP breaks "disk is the hand-off" and one-live-engine rules | `ChatEngineRegistry.swift:1-14,84-86` | Local write-through first; keep registry semantics; port its tests (`ChatEngineRegistryTests`, `ChatEngineBackgroundSessionTests`) before any change |
| R2 | Two writers on one session (Mac engine, phone engine) | Registry header | Single writer per session, version precondition on upsert |
| R3 | Latency regression on the chat path | Bench baseline | Section 8 budgets; no added await before the first token |
| R4 | Redaction or sign-out behaviour surprises users | 5.3 items 3, 4 | Q2, Q5 decided first |
| R10 | A chat lives only in the DB until app quit; a crash or lost machine before quit loses the only copy; a meeting-attached chat deleted at meeting end cannot be recovered | lifecycle sections 4 and 6 | Next-start sweep archives before deleting; reliable meeting-end signal; DB backup during live sessions |
| R5 | Classic engine retired while four consumers remain | section 4 | Q3; inventory callers; keep until each is migrated |
| R6 | Plugin/MCP routes extracted from `auth-routes.mjs` (1 996 lines, shared auth namespace) | `auth-routes.mjs:985-1923` | Route-module extraction behind identical paths; contract fixtures (37 rows, 154-file group) as the gate |
| R7 | SDK upgrades change behaviour under us | `package.json:31` exact pin; 129 unreviewed surface items | Q9; token bench on each bump |
| R8 | Data drift if K1a stops after the shadow phase | 5.3 | Shadow compare must alarm; do not leave both truths live |
| R9 | `agent.db` shadow cutover (Stage 2b) collides with K1 | agent-store plan section 0.1 | Q11 |
| R10 | Test pollution and flaky local runs | `extension/tests/` has 2 304 entries including hundreds of `_llm-sources-discovery-fixture-*` dirs (`ls \| wc -l`; gitignored) | Clean before full runs |

## 11. Drift, gaps and corrections to the plan's premises

| # | Finding | Evidence |
|---|---|---|
| P1 | The server session table is `chat_sessions` / `chat_messages` (migration file name `unified_chat_sessions`), and the **Mac does not use it**; the real server-side session state for the Mac is `agent_sessions` (a mapping to the SDK transcript), `session_memory` and the SDK transcript itself. "Double-stored" understates it: at least three copies of a v2 conversation (C1, C2, C4) and a separate extension-only store (C5) | 5.1, 5.3 item 1 |
| P2 | The agent store changed the kit's `kb/` list: `turn-composition`, `tool-events`, `activity` now write to `agent.db`, which is metadata-only and cannot hold transcripts; the plan row still names them as main-DB `kb/` files | 2a |
| P3 | `agents/agent-prompt`, `kb/personas` (meeting-agent personas and Ask-the-Agent history), `routes/agent.mjs` dispatch/stop/runs and `useAgent.ts` are the **meeting agent**; the side-panel chat is `useChat.ts` plus `unified-chat.ts` | `agent-prompt.mjs:1-12`, `personas.mjs:1-2`, `useAgent.ts:1-6` |
| P4 | Plugin, MCP and LLM-source **UI** is in `Features/Library` (44–45%) and the **routes** are in the core file `server/auth-routes.mjs`; the plan lists them under agent-kit's server dirs but they are not physically there | 2a, 2b |
| P5 | Plugin, MCP and LLM-source **state** is JSON files under `~/Library/Application Support/llm-ide/` (`plugin-state.json`, `mcp-plugins.json`, `llm-sources.json`), not SQLite and not in the server data dir (`core/data-dir.mjs` mentions only `data.db`, `agent.db`, `backups`, `agent-sdk`) | `plugins/state.mjs:30`, `mcp/state.mjs:18-19`, `llm-sources/registry.mjs:84` |
| P6 | Contract group list is incomplete: `agent-history` (5 rows, 10 fixtures) is new; `agent` also holds meeting-agent routes and six rows with no client | 2e |
| P7 | `Core/Platform/SessionStore.swift` in the plan's `Core/Platform` inventory is the **auth** session store, not chat sessions | `SessionStore.swift:1-15` |
| P8 | `kb/tool-permissions` and `kb/activity` are claimed by both core and agent-kit rows | plan `:103` vs core row |
| P9 | `connectors/mcp-client.mjs` (MCP for ingest) is a second MCP stack beside `mcp/` (MCP servers for the agent); knowledge-kit owns the first | knowledge-kit map 2a |
| P10 | The "upgrade-and-tune loop" ledger exists but is unreviewed (129 of 182 items) | `sdk-surface.json` count |
| P11 | The plan said the token bench would gate "once a baseline exists": a baseline is committed (2026-10-26) | `schema/bench/token-baseline.json` |
| P12 | The classic engine is not only the Mac's fallback: Loop's RegressionRunner calls `/code-assist` directly (2 call sites) and the extension `/chat` uses the classic path | `RegressionRunner.swift:434,506`; `useChat.ts:145` |
| P13 | Mac chat is not per user (one directory, wiped on sign-out) while every server table is | `ChatSessionStore.swift:155-164` |
| P14 | `ChatModule` (the `.agentChat` module) starts the Live session mirror; the key gates a capture-kit service | `ChatModule.swift:3-12` |
| P15 | The plan's "Chat ~24 k lines, 25 Mobile test files" both reproduce (24 118; 25) | 2b, 2g |

## 12. What I could not verify

- **Real data.** I did not open the user's live `data.db`, `agent.db`, session files or SDK transcripts. Findings about drift (5.3 items 2, 3) come from reading the code paths, not from comparing real stores.
- **Mac tests were not run.** Counts are greps. No Mac pass or fail is claimed; `swift test` and `make regression` were not run (shared `.build` lock, minutes with the memory keychain).
- **Contract and live gates** (`make contract-gates`, `make feature-matrix`, `make chat-gates`) were not run.
- **Token bench** was not run (it spends tokens); the baseline numbers are the committed file, on one account and machine.
- **Subscription-turn transcript location.** I read that ambient turns use the operator's real config dir (`transcripts.mjs:32-38`) but did not run a subscription turn to see the files.
- **Whether sign-out leaves server state** (5.3 item 2) is by reading `resetForSignOut` and the delete route; no sign-out was exercised.
- **How `/chat` (extension) answers** beyond its route registration and `runClaude` import; I did not trace `ai-routes.mjs:348-448` line by line.
- **iOS app** read at the wire constants and `ExplorerChatStore` header only.
- **Unread in depth:** `ChatEngine.swift` (1 565 lines) beyond the persistence and approval seams, `providers.mjs` provider adapters, `plugins/loader.mjs`, `llm-sources/registry.mjs` bodies, `routes/agent.mjs` ask handlers.
- **Test counts:** server count is by the runner (1 698); the grep count (1 533) undercounts generated tests. Mac and extension counts are grep counts. The selection is by file name and is a judgement: a few files (for example `tier-routing`, `agent-store-*`) serve work-kit, core or os-kit as well.

## 13. Verification log

| Command | Outcome (2026-10-29) |
|---|---|
| `node --test tests/chat-sessions.test.mjs tests/agent-v2-sessions.test.mjs tests/chat-session-key-parity.test.mjs` (sandboxed) | 10 tests, 10 pass (grep counted 10) |
| `node --test --test-concurrency=4` on the 139 `.mjs` files of the agent-kit selection, unsandboxed | 1 698 tests, 1 696 pass, 0 fail, 2 skipped, 47.6 s |
| Same run sandboxed | 1 698 tests, 1 672 pass, 24 fail: 23 `listen EPERM` (sandbox), 1 `ETIMEDOUT` (`claude -p --mcp-config` e2e), counted from the TAP output; all pass unsandboxed |
| `bash mac/Scripts/feature-boundaries.sh` | `total: 0  sealed violations: 0`; every other section `none` or "exist" |
| `npx eslint llm_agent providers mcp plugins llm-sources agents kb routes server` | no output |
| Python count of `schema/http/{agent,providers-usage,health-auth,agent-history}.schema.json` endpoints; `ls` of fixture directories | 37 / 14 / 65 / 5 rows; 68 / 45 / 154 / 10 files; 37 plugin/MCP/LLM-source rows in `health-auth` |
| Python count of `sdk-surface.json` | 182 items: 43 adopted, 10 ignored, 129 needs-human |
| `find`/`wc` on `llm_agent`, `providers`, `mcp`, `plugins`, `llm-sources`, `kb`, `Features/Chat`, `ClaudeLink`, `Library` plugin files | counts as in sections 2a, 2b |
| Not run | `make regression`, `make contract-gates`, `make feature-matrix`, `make chat-gates`, Mac `swift test`, `make token-bench` |
