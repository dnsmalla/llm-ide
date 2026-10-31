# Tauri Phase 3: Chat, Explorer, Library, Settings on the shared React UI kit

Status: **plan, nothing built.** Date: 2026-10-31, at `main`. Parents: [ADR 0018](../../decisions/0018-tauri-desktop-node-core-relay.md), [Tauri plan](2026-10-24-tauri-desktop-and-relay.md), [Phase 0 report](2026-10-25-tauri-phase0-report.md), [kit-by-kit migration](2026-10-27-kit-by-kit-migration.md), [live-then-archive](2026-10-29-live-then-archive.md), [data-lifecycle](../../kits/data-lifecycle.md), [parity checklist](2026-10-31-tauri-parity-checklist.md), [MASTER-PLAN](../MASTER-PLAN.md) (S2).

Sizes below are bytes from `wc -c` on `mac/Sources/LlmIdeMac/Features/*` at this commit (Chat 1.30 MB across the folder, Explorer 152 KB, Library 256 KB, Terminal 27 KB, Search 62 KB, SourceControl 117 KB, Extensions 377 KB, Settings 315 KB). Route names come from `schema/http/INVENTORY.md` and `schema/agent-v2/SCHEMA.md`. Nothing was run.

## 0. Decision recorded (user, 2026-10-31)

ADR 0018 is **accepted for the Phase 3 start, conditional.** The open Phase 0 measurements are recorded before Phase 3 **exits**, not before it starts:

1. user-run autobench with the window frontmost (confirms the numbers and the 30 s hidden phase);
2. one Windows run: graph >= 30 fps, sidecar start/quit, installer size;
3. an Accessibility grant to measure caption read cadence.

If the Windows run fails the gate, **work pauses and this plan is revisited.** Honest reading: this is permission to start, not a pass. Until those three are recorded, the Phase 0 GO in the report stands only on the agent-run numbers (graph 59.8 fps at 10k nodes) and no Windows or user-run evidence exists. Phase 3 slices that depend on a Windows-specific fact (terminal shell, path handling, installer) must not be called done on macOS evidence alone.

Sequencing note: the Windows run is the cheapest early signal. Recommendation: run it in the first week of Phase 3, not at the end, so a failure costs little.

## 1. Scope

**In:** Chat, Explorer (tree, editor tabs, Monaco, search, source control, terminal dock), Library (sections including Extensions), Settings, on the shared React kit `ui/kit` (being built by another agent right now; this plan consumes it and does not edit it except through the ownership rules in section 8). Shell navigation (Home, toolbar, section switching), project open, consent sheets.

**Out (later phases, kit-by-kit order):** Issues/Gantt, Doc Gen, Graph screen polish (the spike graph stays), Loop/Auto Tasks, Live capture, Mobile control, relay and phone PWA, signing/auto-update (T6), Linux best-effort polish. Swift retirement (Phase 6).

**Non-goals:** new features. Phase 3 reproduces the Mac behaviour on a second client. Where the Mac app has a known defect, copy the contract, not the bug, and log it in the checklist.

## 2. What already exists to build on

- `desktop/` Tauri spike: React views for chat (`desktop/src/chat/`: `chatModel.ts`, `replay.ts`, `markdown.tsx`), Monaco (`desktop/src/editor/`), xterm.js + PTY (`desktop/src/terminal/`, `src-tauri/src/pty.rs`), graph, bench. These are spike code; Phase 3 moves reusable parts into `ui/kit` and the screens consume them.
- Rust host commands today: `ping`, `read_graph_file`, `pty_spawn/write/ack/resize/kill` (terminal behind a native consent dialog), project open + recent list (`project.rs`, folder dialog by the host, too-broad roots refused), tray + two fixed notification templates, secrets in the OS keychain (`secrets.rs`), sidecar host (`core_host.rs`, per-launch nonce), single instance.
- Core contracts: `schema/agent-v2` (15 event variants), `schema/http` (JSON schema per route group), `schema/design/tokens.json`.
- Not existing: the packaged sidecar (being built by another agent), `ui/kit` (being built), file read/write host commands, a desktop chat archive store (section 4).

## 3. Per-screen specification

Common rules for every screen: the screen is a client of the Node core on loopback (bearer token held by the host, never by the webview storage); every request carries an `AbortController` and cancels on unmount; response validation is strict (the kit's client validates against `schema/http` fixtures in tests); a route group that answers 404 `feature_disabled` renders the feature-off state, not an error.

### 3.1 Chat

**Replaces (Mac, `Features/Chat/`, 1.30 MB total):** `Engine/ChatEngine.swift` 92.8 KB, `Session/ChatEngine+Session.swift` 44.8 KB, `Engine/ChatEngine+ExternalTurn.swift` 20.2 KB, `Views/Panel/CodeAssistantPanel.swift` 54.7 KB (+ `+Session` 28.9, `+Agent` 12.0), `Views/Panel/ChatMessageList.swift` 54.0 KB, `Views/Panel/ChatComposer.swift` 54.0 KB, `Views/Panel/CodeAssistant+Plan.swift` 34.1 KB, `+PlanExecution` 21.9, `PlanEditSheet` 21.7, `PlanExecutionCard` 17.1, `PlanSavedCard` 11.8, `PendingActionCard` 17.5, `ToolActivityList` 11.9, `Views/Shared/ToolApprovalCard` 11.6, `ApprovalQuestionCard` 10.6, `AgentV2ApprovalState` 14.8, `Models/ChatMessage` 31.7, `Models/ProposedEdit` 12.6, `Services/ChatEngineRegistry` 25.6, `Session/ChatSessionStore` 26.4, `Transport/AgentV2Selection` 15.9, `Views/Quick/MenuBarChatView` 40.1 (menu-bar quick chat: Phase 3 later slice, see 3.1.3), `Services/CodeWorkflowService` 38.4 and `Views/CodeWorkflowSheet` 26.7 (code-change workflow sheets: after the core panel), `Services/Archive/ChatArchiveService` 34.0. Also `ClaudeLink/AgentV2Transport` for the wire client. About 750 KB of Swift is on the direct path; the rest (Quick, mobile host `ChatMobileHost` 13.2, `ExplorerMobileEngineResolver` 12.0) is not Phase 3.

**Server surface:**
- `POST /agent/v2/stream` (SSE), `POST /agent/v2/decision`, `POST /agent/v2/cancel`, `DELETE /agent/v2/session`, `GET|PUT /agent/v2/session/route`, `GET /agent/v2/session/route/history`, `POST /agent/v2/sessions/purge`.
- Stream events (`schema/agent-v2`): `init`, `delta`, `tool_use_start`, `tool_args_delta`, `tool_result`, `usage`, `result`, `sdk`, `notice`, `approval_request` (tool and question kinds), `approval_resolved`, `mode_set`, `tasks`, `tasks_progress`, `context_usage`, `error`. The kit decodes by `schema/agent-v2/agent-v2.schema.json`; unknown types are ignored, as the older Mac does.
- Models and routing: `POST /kb/providers/models`, `/kb/providers/catalog*`, `GET|PUT /kb/usage/limits`, `GET /kb/usage/summary` (cap chip), `GET /kb/agent/tool-approvals` (+ DELETE: stored Always Allow rules), `/kb/agent/skill-library` (slash menu), `/auth/me/workspace-trust`.
- Chat sessions: `GET|POST /kb/chat/sessions`, `GET|PATCH|DELETE /kb/chat/sessions/:id`, `POST|DELETE .../messages`, `POST .../archive/begin`, `POST .../archive/commit` (fenced, paged, hash-verified, built for live-then-archive).

**Host commands needed (Rust):** none new for the stream (the webview talks to loopback through the host-injected token path already used by the spike). New: `chat_archive_write` / `chat_archive_read` / `chat_archive_list` / `chat_archive_delete` (section 4), bounded and per-user; `attach_file` read through a host dialog (the page never supplies a path), same pattern as project open.

**State and persistence:** section 4.

**Permissions UI:** section 5.

**Acceptance criteria:**
1. A turn streams incrementally with no dropped events (Phase 0 condition 3 re-asserted with the real kit: the `replay.ts` fixtures pass).
2. Slash menu lists the same seven surfaces the Mac menu lists (built-ins, skills, plugins, MCP, commands, modes, models) from the server, not a static list.
3. Mode picker (including plan modes and the "**Nothing to execute.**" marker), model picker with the live model list, cap chip with the same thresholds as the Mac, per-chat mode and route memory.
4. Tool approval and question cards resolve through `/agent/v2/decision`; a parked approval survives a webview reload (the server holds it).
5. Stop works: cancel kills the turn and the UI returns to idle within 2 s on the fake model.
6. A chat survives app quit and reopens (section 4).
7. Streaming a 10k-token reply keeps the main thread responsive (the spike bench threshold, recorded in the report).

#### 3.1.3 Not in the Phase 3 exit

Menu-bar quick chat, code-change workflow sheets (`CodeWorkflowSheet`, `QuickFixSheet`), mobile engine pool. They are listed in the checklist as deferred rows so the gap is visible.

### 3.2 Explorer (tree, editor tabs, Monaco, terminal dock, search, source control)

**Replaces:** `Features/Explorer/` 152 KB: `Views/ExplorerView.swift` 58.0 KB, `Services/ExplorerTreeStore.swift` 29.0, `Services/ExplorerFileOps.swift` 20.4, `Views/ExplorerTreeList.swift` 17.6, `Views/ProjectMemoryView.swift` 14.2, small helpers (drag payload, key command, rename, clipboard, prompt sheets, about 12 KB). Core pieces: `Core/DesignSystem` `FileTreePanel`, `EditorTabBar`, `FileDetailView`; `Core/Editor` completion and hunk staging. `Features/Terminal/` 26.5 KB (`TerminalSession` 5.9, `TerminalPanelView` 5.9, `TerminalSessionView` 4.5, `BottomDockTabBar` 3.8, `TerminalDockSessions` 3.5, `TerminalTabBar` 2.9). `Features/Search/` 62.4 KB (`SearchView` 30.0, `SearchEngine` 19.4, `SearchService` 13.1). `Features/SourceControl/` 117 KB (`SourceControlView` 60.4; the GitHub/GitLab settings sections 24.6 + 30.4 belong to Settings, 3.4).

**Server surface:** Explorer is mostly local filesystem on the Mac; the server has little for it. Used: `GET /kb/search` (note search), `POST /kb/projects/register`, `/kb/connect-git`, repo routes behind the `RepoBackend` Mac code (GitHub/GitLab clients live in Swift `Core/Repo/`; the HTTP forwarding for PRs/issues is **not** in the core yet, so Source Control in Phase 3 is local git only plus read-only status; hosted-repo actions are a deferred checklist row, flagged as a gap).

**Host commands needed (Rust, new):** the page never gets an fs scope. Add bounded, root-confined commands in the style of `graph_file.rs`/`project.rs`: `fs_list_dir`, `fs_read_text` (size cap, binary refusal, O_NOFOLLOW), `fs_write_text` (atomic temp + rename, only inside the open project root), `fs_create`, `fs_rename`, `fs_delete` (to OS trash), `fs_watch` (notify crate, event channel, debounced), `git_status` / `git_diff` / `git_stage` / `git_commit` via a scrubbed-env `git` spawn (reuse `core/child-env.mjs` rules), `project_search` (ripgrep-style, in Rust or the core, decision in 8.2). Terminal: existing `pty_*` and the native consent dialog stay; add per-OS default shell (PowerShell or the user's `%COMSPEC%` on Windows) and a Windows run of the flow-control test. Project open and recent list exist; add "project paths" sheet parity.

**State:** open tabs, tree expansion, panel widths in webview `localStorage` per project hash (per-viewer conveniences only, never durable state); the file on disk is the only copy of its content; Monaco models are views, not stores. Unsaved buffers are held in memory and offered back on crash through a host-written recovery file under the app data dir, deleted when saved (one copy, short lived).

**Permissions UI:** the open-project folder dialog (host-run), the terminal consent dialog (host-run, exists), destructive file operations confirm in the page and run through the host root check. Writes outside the project root are impossible by construction.

**Acceptance criteria:**
1. Open a 20k-file project; the tree is usable (virtualised) and expands a 5k-entry folder in under 300 ms on the reference Mac.
2. Edit, save, external change detected, conflict prompt; save is atomic.
3. Monaco: syntax highlighting for the Mac app's language set, find/replace, diff for staged hunks, theme from `tokens.json`.
4. Terminal dock: multiple tabs, resize, the credit-based flow control test passes on macOS **and** Windows.
5. Search returns results for text and files with the same scoping as the Mac `SearchEngine` (per project, excludes honoured).
6. Source Control shows status/diff, stages, commits; push/pull behind a clear "not in Phase 3" row if deferred.
7. Project memory viewer (`ProjectMemoryView`) renders the same artifacts.

### 3.3 Library

**Replaces:** `Features/Library/` 256 KB: `Views/LibraryView.swift` 42.9 KB, `ConnectionsSettingsSection` 24.6, `EmailSourceSheet` 23.7, `SlackSourceSheet` 17.3, `MeetingDetailView` 12.2, `BoxSourceSheet` 8.9, `SummarySections` 8.0, `ConnectorDetailView` 6.2, `ConnectorAddSheet` 4.6, `LibraryRow` 4.7, `InboxStore` 4.7, rows and small views; services `SourceConnector` 12.4, `SourceConnectorManifest` 8.5, `EmailSource` 7.6, `SlackSource` 6.7, `SourceConnectorNoteWriter` 6.5, `SourceIngestService` 5.4 (the ingest itself is already the Node core: Mac Library calls it through `SourceIngesting`). Plus `Core/Notes/` (on-disk notes store: `LibraryItemStore`, `NoteService`, `FolderIndexer`, `MeetingIndex`, markdown/frontmatter). **Extensions screen** (Library sections Plugins, LLM Sources, MCP Plugins) from `Features/Extensions/` 377 KB: `ExtensionsCatalogView` 35.0, `PluginGitInstaller` 27.8, `ExtensionsLibrarySections` 27.7, `PluginUpdateCenter` 24.8, `LlmSourceDetailView` 23.2, `ExtensionsLibraryModel` 21.5, `PluginDetailView` 18.4, `ExtensionsCatalogModel` 15.7, `PluginUpdatePresentation` 14.9, `ClaudePluginImportSheet` 14.1, `McpPluginDetailView` 13.5, `CodexPluginImportSheet` 13.2, trust models/cards (about 23 KB), `McpConsentPrompt` 2.9. Much of the install/update logic is Swift today; the catalog work (`2026-10-31-extensions-catalog.md`) already moved the item model, importer and active set into the core, so the screen can be a thin client for the catalog routes.

**Server surface:** `GET /kb/search`, `/kb/index/notes` (rebuildable index), `/kb/connect-git`, `/kb/connect-github-issues`, `/kb/mcp-connector/{test,fetch,seen,classify}`, `/auth/mcp-connector/*` (OAuth), `/auth/me/connectors*`, `/auth/me/extensions/*` (allowlist, installed, updates, catalog, active, install, catalog/refresh, updates/check, update/preview, update, rollback, repair, toggle, uninstall), `/auth/me/llm-sources*` (list, updates, toggle, items, add, update, :id, :id/discovery), `/auth/me/mcp-plugins/{claude-sources,codex-sources,consent}`, `POST /auth/me/plugins/hook-trust`, `/auth/me/workspace-trust`.

**The notes store is the open point.** Mac Library reads notes from the user's notes folder on disk (`Core/Notes`). The Tauri app has no such code, and the core has only the rebuildable index plus ingest. Phase 3 rule: the desktop reads and writes notes **as files in the same folder** (the "one copy" is the file) through the same bounded host fs commands as Explorer, with the frontmatter contract (`Markdown/MeetingFrontmatter`) re-implemented once in the kit as a pure TypeScript module with fixtures shared with the Swift tests. No new notes API on the server in Phase 3.

**Host commands needed:** the fs commands of 3.2 (notes root = a second allowed root, set by a host dialog and stored like the project root), `open_external_url` for OAuth (fixed allow-list of schemes), the existing notifications.

**Permissions UI:** the Extensions consent flows are the reference (section 5.3).

**Acceptance criteria:**
1. Sidebar sections and counts match the Mac for the same data directory.
2. Open a note, edit, save; frontmatter round-trips byte-stable against shared fixtures.
3. Add and remove a source (Box, Slack, Email sheets) and a connector from the catalog with selection-gated settings; secrets never reach the page (host keychain, as `secrets.rs`).
4. Extensions: install, update with preview, rollback, repair, toggle, uninstall, with the Mac's trust and consent prompts; the hook consent gate is not bypassable from the page.
5. Meeting detail renders summary sections; live-capture take-over is Phase 3 out of scope (row deferred).

### 3.4 Settings

**Replaces:** `Features/Settings/` 315 KB, in priority order for daily use: `ProvidersSection` 18.5 + `ProviderForms` 14.1 + `ProvidersModel` 20.2 + `ProviderRows` 15.2 + `ProviderCatalogModel` 9.4, `ModelRoutingSection` 26.1 (+ Roles 11.1, Switches 7.5), `BackendSettingsSection` 17.1, `PreferencesSettingsSection` 9.4, `ToolApprovalsSettingsSection` 9.3, `AgentSdkSettingsSection` 9.0, `TokenSavingSettingsSection` 4.2, `AgentHistorySettingsCard` 15.8 + model 14.8, `MemorySettingsSection` 4.0, `PathsSettingsSection`, `LiveThenArchiveSettingModel` 3.2. Not Phase 3: `FeatureRebuildService` 25.6 and its card (Mac-only mechanism; the Tauri feature-off decision is a separate open item), `HelpGuideView` 34.4 (static help: port last), `SelfHeal*`, `UpdateService` (T6). Source Control provider cards (`GitHubSettingsSection` 24.6, `GitLabSettingsSection` 30.4) are a deferred row until the repo HTTP surface exists in the core.

**Server surface:** `/kb/providers/*`, `/kb/usage/*`, `/kb/agent/tool-approvals`, `/agent/v2/session/route*`, `/kb/agent/working-state`, `/health` (features), `/auth/me/*` settings routes already used by the Mac client (`LlmIdeAPIClient+*.swift`).

**Host commands:** secret entry goes through a host-run secure input (keychain write), never `localStorage`. Autostart is not granted.

**Acceptance:** each card listed has the same fields, validation and verify-key action as the Mac card; keys are write-only in the page.

## 4. State and persistence: the desktop storage rule

Constraints from the user (data-lifecycle): **one stored copy**; live in the server DB, **archived to the Mac app's store at quit**; meeting-attached chats deleted at meeting end; a normal chat kept until the user deletes it; delete removes it everywhere; per-user (every row carries `user_id`).

Today the "Mac app" in that rule is the Swift app writing `~/Library/Application Support/llm-ide/sessions/<uuid>.json` (`ChatSessionStore.swift`). Reading the live-then-archive plan, the Mac JSON file is the live transcript on the Mac app today, and archive/begin + archive/commit are the core halves of the future flow. The Tauri app is not the Mac app, so the rule needs one more sentence. Proposal (mine, needs the user, see Q1):

1. **The archive target is "the desktop client's chat store", defined per client by one contract:** an on-disk, per-user, one-file-per-chat store the client owns. On Mac Swift it is `sessions/<uuid>.json`; on the Tauri app it is the **same file format in the same schema**, in `<app data dir>/chats/<userId>/<uuid>.json`, written by Rust host commands (`chat_archive_write` etc.), 0700, atomic temp + rename, hash-verified by `archive/commit` before the server rows are deleted. The format is already specified by the Swift `ChatMessage`/`ChatSessionStore` (500-message cap per `ChatEngine+Session.swift`); a shared JSON fixture set pins it.
2. **While live, the Tauri chat uses the server DB** (`/kb/chat/sessions/*`), not a webview store. The webview keeps only the current view state. This is also what gives the phone and the extension the same live data later.
3. **Quit hook:** the host runs archive-for-all-live-sessions on quit (begin, write, read back, commit), with the next-start recovery sweep of the lifecycle plan. A failed archive keeps the server rows (never delete before verify).
4. **Overlap on macOS (both apps installed):** only one client may own the store for a given user. Proposal: during the overlap the Tauri app on macOS **uses the Mac app's `sessions/` directory in place** (same path, same format, no copy), and holds an advisory lock file so the two apps never write at once. On Windows and Linux the path above is the home. This keeps "one copy" literally true. If the user prefers separate stores per app, that makes two copies of the same chat and breaks the rule, so I recommend against it.
5. **Per user:** the directory is keyed by `userId` from the core's auth, the server enforces `user_id` on every row, the host refuses a path outside the user's directory.
6. **Not stored by the webview:** transcripts, tokens, API keys. `localStorage` holds per-viewer conveniences only (last mode, panel width), wrapped in try/catch as the kit contract requires.
7. **Ended chats:** open read-only in the first release; continuation is the unresolved decision R2b of data-lifecycle and follows the Mac app's answer.
8. **Notes and meetings:** files in the notes folder (3.3), one copy, no server copy beyond the rebuildable index.

Flag: the quit hook on Windows (no `willTerminate` equivalent beyond window close/exit events and OS shutdown) is weaker than on macOS; the recovery sweep carries it, which is why the sweep is a Phase 3 acceptance item, not a polish item.

### 4.1 The rule as built (S-D, 2026-10-31; supersedes the proposal above where they differ)

User decision: **one copy of a chat, the Mac app's file format, live then archive.** Implemented in
`desktop/src-tauri/src/chat_store.rs` / `chat_archive.rs` / `chat_cmds.rs`; full detail in
[desktop-chat-store](../../how-to/desktop-chat-store.md).

1. The chat file is the live and final transcript (the Mac's option B). The Tauri app reads and writes the
   Mac app's `sessions/` folder in place on macOS, `<data dir>/chats/<userId>/sessions/` on Windows and Linux,
   same JSON schema (Swift `ChatSession`), so `chat_archive_write/read/list/delete` became
   `chat_save/load/list/delete`. The server holds working state only; the live-in-server-DB rows of item 2
   above are not used by the desktop chat.
2. Quit: verify the file, record a receipt (SHA-256 identical to `archiveHash`), then purge the working state;
   6 s cap; a journal before the first call; the start-up sweep (after the webview binds its session) repeats it.
   Never purge before a receipt; a failed step leaves the working state.
3. Delete: tombstone in `pending-deletes.json` (the Mac's format) before the file goes, then
   `POST /kb/session-purges`; both apps honour and replay each other's entries.
4. Overlap on macOS: against the Mac app the protection is a revision compare-and-swap (the Mac does not take
   the advisory lock file). A small Mac change to take `chat-store.lock` around `saveOrThrow` would close the
   remaining microsecond window; it is not made here (Swift is out of this slice).
5. Windows and Linux: no reliable quit hook for OS shutdown or a kill; the sweep is the guarantee. The
   extension's server-side chat rows are not archived by the desktop app yet.

## 5. Permissions UI

Reference: Mac Chat `EditAcceptanceMode`, `ToolApprovalCard`, `ApprovalQuestionCard`, `AgentV2ApprovalState`, `ToolApprovalsSettingsSection`, and the Extensions consent flows (`McpConsentPrompt`, `PluginTrustPresentation`, `ExtensionTrustSettingsCards`, `PluginUpdateConfirmSheet`). Source of truth is the server (`approval_request`/`decision`, tool-approvals store, workspace-trust, mcp consent, hook-trust): the page renders and returns decisions only.

1. **Modes:** Ask, Accept Edits, Bypass (project-scoped prefix rules, as PR #65). The mode chip in the composer shows the mode; Bypass needs a one-time explicit confirmation per app run and a persistent red state in the header while on. Mode is also surfaced by the `mode_set` event, so a server-side change is reflected.
2. **Tool approval card:** tool name, arguments (collapsed, expandable, redacted by the server), Allow once, Allow always for this project (writes a prefix rule), Deny. **Always Allow** shows the exact rule that will be stored and lists under Settings, where it can be deleted (`DELETE /kb/agent/tool-approvals`).
3. **Trust banner:** shown when the open project is not trusted (`/auth/me/workspace-trust`), blocking tool use and hooks until the user trusts it; trust is granted by a host-run native dialog, not by a page button alone (consistent with the terminal consent design).
4. **Consent sheets (Extensions reference):** MCP server consent (`/auth/me/mcp-plugins/consent`), plugin hook trust (`/auth/me/plugins/hook-trust`), update confirm with the diff preview (`/auth/me/extensions/update/preview`), uninstall confirm. Each lists what will run, from where, with which permissions, and records the decision server-side.
5. **Terminal consent:** exists (native dialog); the Terminal toggle in Settings is read in Rust.
6. **Fail closed:** if the core cannot be reached, no approval can be granted and the card shows "cannot confirm", never auto-allows. Notification text uses the two fixed templates only.

## 6. Test strategy

No paid model calls anywhere.

1. **Component tests** with the ui-kit's test setup (Vitest + Testing Library, whatever `ui/kit` settles on; this plan follows it): each kit component and screen gets rendering, keyboard and state tests; the event reducer is tested against every `schema/agent-v2/fixtures/*` variant.
2. **Contract tests against the core:** the kit's HTTP client is validated against `schema/http` fixtures and the real core started on a temp data dir (`LLMIDE_DATA_DIR`, `NODE_TEST_CONTEXT` temp DB per the test-DB-isolation rule). The stream decoder runs the same `scripts/conformance-agent-v2.mjs` fixtures as the Mac side.
3. **End to end via the fake model path:** the core's fake provider (no paid call) drives full turns: stream, tool call, approval, cancel, quit-archive-reopen. Driven through the packaged sidecar when that exists, through `npm run server` until then. Windows runs use the same scripts.
4. **Rust:** cargo unit tests for every new host command (root confinement, symlink refusal, size caps, atomic write, archive hash), extending the 58 existing tests; `check-capabilities` must stay green with no new webview permission.
5. **Parity checklist:** [the checklist](2026-10-31-tauri-parity-checklist.md) is updated by the slice owner in the same commit that lands a row; the Tauri column and the evidence column (test name, screenshot path under `desktop/parity/`, or commit) are required, and "verified" needs the user's side-by-side check for the visual rows.
6. **Gates:** `make docs-check`, the desktop CI (`desktop-ci.yml`, to be run on GitHub), schema conformance, and a perf bench (stream render, tree expand, terminal flood) with recorded numbers.

## 7. Ordering and parallel slices

Order by dependency; slices inside a wave run in parallel.

- **Wave 0 (prerequisite, other agents now):** `ui/kit` skeleton (tokens, primitives, API client, stream decoder) and the packaged sidecar. Phase 3 slice work starts when the kit exposes its package entry and the client; until then slices can build against the spike code without editing `ui/kit`.
- **Wave 1:** S-A Shell and navigation; S-B Chat core (stream, list, composer, modes, models); S-C host fs + Explorer tree/tabs/Monaco; S-D host archive store + quit hook (Rust + core wiring, no UI); S-E Library read side (sections, notes viewer); S-F Settings providers and routing.
- **Wave 2:** S-G approvals and trust UI (after S-B); S-H terminal dock and Search (after S-C); S-I Library write side and source sheets (after S-E and S-C); S-J Extensions screen (after S-E); S-K Source Control local (after S-C); S-L slash menu, plan cards, cap chip (after S-B).
- **Wave 3:** Windows pass on every screen, parity checklist review with the user, perf benches, daily-use trial.

### 8. File ownership boundaries (no collisions)

Each slice owns exactly these paths; edits elsewhere go through the owner or a one-line coordination note in the commit body. All file lists are new paths to be created; none exists yet unless stated.

- 8.1 **Shared, single owner at a time:** `ui/kit/**` belongs to the kit agent; screens import it and add components only under their own `ui/screens/<name>/` (new). A needed kit change is requested, not made. `desktop/src-tauri/src/lib.rs` (command registry), `desktop/src-tauri/capabilities/*` and `tauri.conf.json` are touched only by S-D (serially, one small commit per command group, rebase before each); other Rust slices add a new module file and hand S-D a two-line registration diff.
- 8.2 Rust modules: S-C owns `src-tauri/src/fs_ops.rs`, `fs_watch.rs`, `git.rs` (and search if done in Rust, `project_search.rs`; decide Rust vs core with a spike, recommendation Rust for speed and sandboxing); S-D owns `src-tauri/src/chat_store.rs`; terminal changes (Windows shell) belong to S-H in `pty.rs` and `src/terminal/`.
- 8.3 Screens: S-A `ui/screens/shell/` + `desktop/src/App.tsx`; S-B `ui/screens/chat/`; S-C `ui/screens/explorer/`; S-E+S-I `ui/screens/library/`; S-F `ui/screens/settings/`; S-G `ui/screens/chat/approvals/` (subfolder agreed with S-B); S-J `ui/screens/library/extensions/` (subfolder); S-K `ui/screens/explorer/source-control/`.
- 8.4 Docs: the parity checklist rows are per-section; each slice edits only its own section (rows are appended or flipped in place, small commits). MASTER-PLAN lines: one owner (the integrator), via `scripts/plan-status.mjs --fix`.
- 8.5 Tests live beside the slice's code; shared fixtures under `schema/**/fixtures` are append-only.
- 8.6 Rule: `git add <explicit paths>` for your slice only, no `git stash`, no `--no-verify`, commit on `main`, no push without the user.

## 9. Risks

1. **Windows gate fails** (graph fps, sidecar, installer size): pause and revisit, as decided. Mitigation: run it early (section 0).
2. **Chat is 750 KB of Swift with years of edge cases** (plan cards, parked approvals, background sessions, mode stickiness): the checklist rows must be exhaustive; use the invariants and memory notes as the source of rows, not memory.
3. **Two copies of a chat** if the Mac app and Tauri keep separate stores (section 4.4).
4. **Source Control and repo actions have no core HTTP surface**; Swift `RepoBackend` is the only implementation. Scope risk; deferred rows are explicit.
5. **Notes folder semantics** live in Swift (`Core/Notes`); a TypeScript port can drift. Shared fixtures are the guard.
6. **Quit-time archive on Windows/Linux** is weaker than macOS (4, flag).
7. **Monaco and WebKitGTK/WebView2 differences**; Linux is best effort and not in the exit gate.
8. **ui/kit churn** while it is being built: pin a kit version per wave.
9. **Mac invariants must not regress during the overlap**; the freeze rules (10) are meant to keep Mac stable.
10. **Parity measured by feel**: counter with the checklist and side-by-side screenshots in `desktop/parity/`.

## 10. Feature freeze, defined

Consequence of accepting ADR 0018 for Phase 3: the Swift app stops growing. **The user should confirm this**, because it changes how Mac work is prioritised; I inferred it from the Tauri plan's decision 4 and the acceptance, and the MASTER-PLAN line says "user to confirm".

**Frozen (does not land on `mac/` or on server routes only the Mac uses):** new Mac features, new Mac screens, new Mac settings, visual redesign, new Mac-only server routes, new `AppFeature` keys.

**Allowed exceptions:**
1. Bug fixes with a failing test or a reproduced defect.
2. Security fixes and dependency security bumps.
3. Work needed for parity or for the shared contract (for example a core route the Tauri screen needs, an additive field, a schema fixture, a Swift decode-allowlist change that keeps the Mac working against a changed core).
4. Build, release, signing, CI and Sparkle upkeep.
5. Kit work whose core half is shared by both clients (live-then-archive Mac side, extensions catalog consumers), until its Tauri half exists.
6. Data-loss and crash fixes (the invariants list).
7. Anything the user explicitly approves, recorded in the commit body.

**Not frozen:** the Node core, the schema, the extension, `desktop/`, `ui/`, docs. A new feature is built core-first so both clients can use it; only the Tauri screen is new UI.

**Ends** when Phase 6 starts (one release with both apps) or the user revokes it, or immediately if the Windows gate fails and the plan is revisited (the freeze would then be reconsidered).

## 11. Exit gate

Phase 3 exits when all hold:

1. The three open Phase 0 measurements are recorded in the Phase 0 report (autobench frontmost, Windows run incl. graph >= 30 fps, Accessibility cadence), and the Windows run passed.
2. Chat, Explorer, Library and Settings checklist rows in scope are **verified** (not just built) on macOS and Windows; deferred rows are listed with a reason.
3. The user uses the Tauri app for daily work on **Mac and Windows** for at least one working week, with no data loss, and reports blockers recorded as checklist rows.
4. The end-to-end fake-model suite, the cargo tests, the component and contract tests, `make docs-check`, `check-capabilities` and desktop CI are green on both OSes.
5. The chat archive/recovery sweep passed a kill-during-quit test on both OSes.
6. Success criterion S1 (MASTER-PLAN) is **partially met**: one desktop codebase serves Mac and Windows for these four screens. S1 is not claimed in full until the remaining screens and Linux land.

## 12. Open questions for the user

1. **Desktop chat store (section 4).** Recommend: same file format; on macOS the Tauri app uses the Mac app's `sessions/` directory in place with a lock file; elsewhere `<app data>/chats/<userId>/`. Alternative of separate stores creates two copies.
2. **Confirm the Swift freeze and its exceptions (section 10).**
3. **Run the Windows measurement in week 1 of Phase 3.** Recommend yes; a late failure wastes the most work.
4. **Source Control hosted actions** (PRs, issues) need a core HTTP surface that does not exist. Recommend a deferred row now and a core route plan later.
