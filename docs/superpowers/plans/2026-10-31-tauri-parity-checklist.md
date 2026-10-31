# Tauri parity checklist against the Mac app

Status: **created 2026-10-31; every Tauri cell is not started (`-`) or deferred; the Phase 0 spike (Monaco, xterm, chat replay) is not counted until a row is verified.** Date: 2026-10-31, at `main`. Parents: [Phase 3 plan](2026-10-31-tauri-phase3-plan.md), [MASTER-PLAN](../MASTER-PLAN.md) S2, [ADR 0018](../../decisions/0018-tauri-desktop-node-core-relay.md).

How to use: one row per behaviour. **Mac** is the reference (Swift source named in the row). **Tauri** is one of `-` (not started), `~` (built, not verified), `x` (verified on macOS), `x+w` (verified on macOS and Windows), `n/a` (decided not to port, with a reason in Evidence), `defer` (planned later). **Evidence** is a test name, a screenshot under `desktop/parity/`, or a commit hash. A row is `x` only with evidence, and visual rows also need the user's side-by-side check. Each slice owner edits only their own section, in the same commit that lands the work. Rows were derived from the Mac source tree, not from memory; an unknown behaviour found later is added as a new row, not skipped.

## 1. Shell, Home and toolbar navigation (slice S-A)

| Row | Mac (source) | Tauri | Evidence |
|---|---|---|---|
| Window opens, restores last section and project | yes (`ShellState, ContentView`) | ~ | last section restored (`ui/screens/shell/sections.ts`, test "navigation: shortcuts, nav keys, launch section"); project is not auto-reopened, it is chosen from the host recent list |
| Section switcher lists the same sections in the same order (Library, Live, Explorer, Search, Review Conflicts, Source Control, Issues, Gantt, Visual, Doc Gen, Auto Tasks, Graph, Loop, Settings, System); sections of out-of-scope phases show disabled with a reason | yes (`ShellSection`) | ~ | partial: Chat, Explorer, Library, Settings enabled, later sections listed as disabled "Soon" (`Shell.tsx`, test "Shell renders landmarks"); full Mac list not mirrored |
| Section hidden when its feature is off (`/health` features, 404 `feature_disabled`) | yes (`ShellSection.backingFeature`) | - |  |
| Home / default section resolution (`resolveHome`) | yes (`ShellState`) | ~ | `launchSection`, `initialNav` (test "navigation: select keeps visited sections") |
| Toolbar: project name, open project, recent projects, status bar, activity bell | yes (`Shell/Chrome`) | ~ | project switcher in status bar via host commands, native Open Folder (`StatusBar.tsx`, `project-store.ts`, test "project store"); activity bell not built |
| Deep links (`llmide://`) route to the right section | yes (`DeepLinkRouter`) | - |  |
| Login, reconnect, welcome, recovery screens | yes (`LoginView, ReconnectView, Welcome, Recovery`) | ~ | sign-in/create-account panel and core-down panel (`Panels.tsx`, tests "LoginPanel", "CoreDownPanel"); welcome and recovery not built; tokens in memory only, sign in on every app start |
| Backend status and restart (sidecar lifecycle equals BackendManager) | yes (`BackendManager`) | ~ | status bar and panel map starting/ready/restarting/failed/fatal and claude missing (`status-view.ts`, test "status view"); no manual restart control (host has no command) |
| Keyboard shortcuts for section switch and command palette | yes (`menus`) | ~ | Ctrl/Cmd+1..4, roving arrows in nav, skip link (`sections.ts`); command palette not built |
| Theme: light, dark, midnight from tokens.json; side-by-side screenshot in `desktop/parity/` | yes (`ColorPalette`) | ~ | Dark/Light/Midnight menu persisted in webview storage (`theme.ts`, test "theme storage"); side-by-side screenshot pending |
| Window state, tray, close-to-tray default off, notifications (2 templates) | yes (`AppDelegate`) | - |  |

## 2. Chat panel (S-B, S-G, S-L)

| Row | Mac (source) | Tauri | Evidence |
|---|---|---|---|
| Streaming reply renders incrementally, no dropped events | yes (`ChatMessageList, ChatEngine`) | ~ | sealed-block streaming, only the last message changes, 10k-delta reply micro-batched (`ui/screens/chat/state.ts`, `controller.ts`; tests "10k-token reply reduces fast", "a 10k-delta reply is micro-batched", "every fixture can be applied in a turn"); live run on the real core and the 10k-token main-thread check are not measured |
| Markdown bubble: code blocks with copy, tables, links, no raw HTML (sanitised) | yes (`ChatMarkdownBubble`) | ~ | AST to React, no HTML strings, allowlisted links via host opener, images never loaded, code copy, tables (`markdown.ts`, `MarkdownView.tsx`; tests in `markdown.test.mjs`: script/iframe/img/javascript: links); desktop link opener host command `open_external_url` does not exist yet (clicks are ignored in the app, blocked-by host) |
| Composer: multiline, history recall, send, stop, attachments via host dialog, drag drop | yes (`ChatComposer, HistoryTextEditor`) | ~ | multiline, Enter/Shift+Enter, history recall, send, Stop, queue while streaming, per-chat draft (`Composer.tsx`, tests "Composer: ..."); attachments and drag-drop NOT built (no host file-dialog command; the button is hidden) |
| Slash menu: 7 dynamic surfaces (built-ins, skills, plugins, MCP, commands, modes, models) from the server | yes (`ChatSlashCommands, CompletionMenu`) | - |  |
| @ file mentions / completion | yes (`CompletionController`) | - |  |
| Mode picker incl. plan and assist-plan modes, per-chat mode memory, mode badge | yes (`ModeBadge, ModePolicy`) | ~ | 7 modes, Auto follows the server `mode_set`, hand-picked mode never moves, new chat starts on Auto (`route.ts`, test "mode picker rules"); mode kept per chat for the app run only; mode badge and plan flow not built |
| Plan flow: plan card, edit sheet, save card, execution card, timeline, 'Nothing to execute.' marker | yes (`CodeAssistant+Plan*, PlanEditSheet`) | - |  |
| Model picker with live model list, provider routing control, route history | yes (`CodeAssistantModelState, ChatRouteControl`) | ~ | live Claude list + connected catalog models with tools badge and plain-chat note, pin via `PUT /agent/v2/session/route` (`route.ts`, tests "loadModelGroups", "plain-chat note"); route history and cold-switch confirmation not built |
| Cap chip (per-model usage caps, same thresholds, fallback notice) | yes (`usage ledger, notice events`) | ~ | billable-token SESSION cap chip: presets, k/m input, raise at cap, same 80 percent warn and reached thresholds as the Mac (`Pickers.tsx`, `route.ts`; tests "cap thresholds", "parseLimit", "CapChip"); the per-model usage-cap ledger and fallback notice (`/kb/usage/limits`) are not built |
| Context usage meter (`context_usage`) | yes (`ChatSessionHeader`) | ~ | percent from `context_usage` in the header (`ChatScreen.tsx`, test "fixtures can be applied"); no category breakdown |
| Tool activity list, subagent chip, task list and progress (`tasks`, `tasks_progress`) | yes (`ToolActivityList, SubagentActivityChip`) | ~ | collapsed tool cards with capped args and output, 'show more' in steps, task list from `tasks`/`tasks_progress` (`MessageView.tsx`, tests "tool cards", "tool output preview is capped"); subagent chip not built; full output beyond the core's own truncation needs a core route (blocked-by) |
| Permission mode: Ask / Accept Edits / Bypass chip and Bypass confirmation | yes (`EditAcceptanceMode`) | ~ | Ask / Accept Edits / Bypass select sent as `permissionMode`; Bypass fails closed unless the host supplies a native confirm (`confirmBypass`, not wired yet) (`Pickers.tsx`, `route.ts`; test "Bypass needs one confirmation"); persistent red header state not built |
| Tool approval card (Allow once / always for project / Deny), parked approval survives reload | yes (`ToolApprovalCard, AgentV2ApprovalState`) | - |  |
| Question card (AskUserQuestion) | yes (`AskUserQuestionCard, ApprovalQuestionCard`) | - |  |
| Workspace trust banner, trust by host dialog | yes (`workspace-trust`) | - |  |
| Session header: rename, delete (removes everywhere), new chat | yes (`ChatSessionHeader, SessionRow`) | ~ | rename and delete (with confirm) on list rows, new chat button, title in header (`SessionList.tsx`, tests in `components.test.mjs`); delete 'removes everywhere' relies on `DELETE /kb/chat/sessions/:id` only (archive copy is S-D) |
| Session list: history, background (parked) sessions, switch without losing a running turn | yes (`ChatEngineRegistry`) | ~ | virtualised and grouped list, 2,000 chats render a bounded window, Running flag, switching never kills a turn (`SessionList.tsx`, `controller.ts`; tests "2,000 chats", "switching chats never touches a running turn"); re-attaching to a running turn after a webview reload is blocked-by core (no replay route), the UI only shows that a turn runs on the core |
| Notices: retry, rate limit, permission denied, fallback, refusal | yes (`notice event`) | ~ | retry, rate limit, permission denied, fallback, refusal and `workspace_trust` render as banners (info hidden, repeats collapsed) (`state.ts`, test "notices: info is hidden") |
| Error states and reconnect after core restart | yes (`error event`) | ~ | error event, refusals (402/409/503), dropped stream and unreachable core give a retryable error with Retry; 409 TURN_IN_PROGRESS after Stop is retried; SESSION_UNRESUMABLE retries fresh (`controller.ts`; tests "stream dropped mid-turn", "409 TURN_IN_PROGRESS", "SESSION_UNRESUMABLE"); no automatic reconnect |
| Chat survives quit and reopens (live-then-archive store, plan section 4); recovery sweep after kill | yes (`ChatSessionStore, ChatArchiveService`) | - |  |
| Ended chat opens read-only | yes (`R2b`) | - |  |
| Chat archive settings card | yes (`ChatArchiveSettingsCard`) | - |  |
| menu-bar quick chat | yes (`MenuBarChatView`) | defer |  |
| code-change workflow sheets, quick fix, PR/issue/git sheets | yes (`CodeWorkflowSheet, QuickFixSheet`) | defer |  |
| voice input | yes (`CodeAssistant+Voice`) | defer |  |
| Mobile quick chat host | yes (`ChatMobileHost`) | defer |  |

## 3. Explorer (S-C, S-H, S-K)

| Row | Mac (source) | Tauri | Evidence |
|---|---|---|---|
| File tree, virtualised, expand/collapse, icons, drag and drop, clipboard | yes (`ExplorerTreeList, ExplorerTreeStore`) | - |  |
| Create, rename, delete (to trash), duplicate, reveal in OS | yes (`ExplorerFileOps`) | - |  |
| Keyboard commands (rename, delete, copy/paste) | yes (`ExplorerKeyCommand`) | - |  |
| Editor tabs: open, close, reorder, dirty marker, restore on start | yes (`EditorTabBar`) | - |  |
| Monaco editor: highlight, find/replace, theme, large file guard, binary refusal | yes (`FileDetailView`) | - |  |
| Save atomic, external-change detection and conflict prompt | yes (`(new rule)`) | - |  |
| Hunk staging list and diff view | yes (`HunkStagingList`) | - |  |
| Project open, recent, broad-root refusal, project paths sheet | yes (`ProjectPathsSheet`) | - |  |
| Project memory viewer | yes (`ProjectMemoryView`) | - |  |
| Terminal dock: tabs, resize, consent dialog, flow control, per-OS shell (Windows run) | yes (`Terminal/*`) | - |  |
| Search: text and file search, scopes, excludes, result open at line | yes (`SearchView, SearchEngine`) | - |  |
| Source Control: status, diff, stage, commit (local git) | yes (`SourceControlView`) | - |  |
| hosted repo actions (PR, issues, push via GitHub/GitLab), no core route yet | yes (`Core/Repo`) | defer |  |

## 4. Library (S-E, S-I, S-J)

| Row | Mac (source) | Tauri | Evidence |
|---|---|---|---|
| Sidebar sections and counts match for the same data | yes (`LibraryView`) | - |  |
| Notes list, row, filter, search (`/kb/search`) | yes (`LibraryRow, LibraryViewModel`) | - |  |
| Note viewer and editor, frontmatter byte-stable round trip with shared fixtures | yes (`MeetingFrontmatter`) | - |  |
| Meeting detail with summary, actions, decisions, blockers | yes (`MeetingDetailView, SummarySections`) | - |  |
| Source sheets: Box, Slack, Email (secrets in keychain only) | yes (`BoxSourceSheet, SlackSourceSheet, EmailSourceSheet`) | - |  |
| Connector catalog: add, detail, selection-gated settings, MCP connectors, OAuth | yes (`ConnectorAddSheet, ConnectorDetailView`) | - |  |
| Source removal (`LibraryRemoval`) and legacy export | yes (`LibraryRemoval, LegacyExporter`) | - |  |
| Extensions: catalog view, installed, active set, toggle | yes (`ExtensionsCatalogView`) | - |  |
| Plugins: detail, git install, marketplace, Claude and Codex import sheets | yes (`PluginDetailView, PluginGitInstaller, ClaudePluginImportSheet`) | - |  |
| Plugin updates: check, preview, confirm, rollback, repair | yes (`PluginUpdateCenter, PluginUpdateConfirmSheet`) | - |  |
| MCP plugins: add, detail, consent prompt, update | yes (`McpPluginDetailView, McpConsentPrompt`) | - |  |
| LLM sources: list, items, add, update, discovery | yes (`LlmSourceDetailView`) | - |  |
| Trust cards and hook consent gate (not bypassable from the page) | yes (`ExtensionTrustSettingsCards`) | - |  |
| live-capture take-over of meeting detail | yes (`LiveCaptureGate`) | defer |  |

## 5. Settings (S-F)

| Row | Mac (source) | Tauri | Evidence |
|---|---|---|---|
| Providers: list, add, verify key, catalog connect and test, write-only keys | yes (`ProvidersSection, ProviderForms`) | ~ | `ui/screens/settings/sections/ProvidersSection.tsx`, `providers-model.ts`; tests "connect flow: the key goes in the POST body once", "remove needs the connection's name typed", "1,000+ connections", "ProvidersSection with a loaded catalog". Catalog connections only; the Claude-compatible add is listed but disabled (no core list/save route, see blocked-by in the Phase 3 report); the Mac's legacy built-in key rows are not ported |
| Model routing: roles, switches, per-role models | yes (`ModelRoutingSection`) | ~ | `RoutingSection.tsx`, `routing-model.ts`; tests "routing: draft starts from the loaded table", "removing a tier resets roles". Server tiers and roles (strong/standard/cheap, subagents/internal/loop) only; Mac-local chat-mode roles are not ported. Router/token-cap switches need host prefs (placeholder until S-A) |
| Backend: status, port, restart | yes (`BackendSettingsSection`) | - |  |
| Preferences | yes (`PreferencesSettingsSection`) | - |  |
| Tool approvals: stored rules, delete | yes (`ToolApprovalsSettingsSection`) | - |  |
| Agent SDK settings | yes (`AgentSdkSettingsSection`) | - |  |
| Token saving | yes (`TokenSavingSettingsSection`) | - |  |
| Agent history card | yes (`AgentHistorySettingsCard`) | ~ | `AgentHistorySection.tsx`, `agent-history-model.ts`; tests "Clear = dry run, then the real clear with the signed preview id", "a stale preview is counted again", "Agent history ClearSheet" (typed DELETE gate) |
| Memory | yes (`MemorySettingsSection`) | - |  |
| Paths | yes (`PathsSettingsSection`) | - |  |
| Live-then-archive setting | yes (`LiveThenArchiveSettingModel`) | ~ | `LtaControl` in `AgentHistorySection.tsx`, rules in `misc-model.ts` (test "live-then-archive: off-confirm rule"); the mode is a host pref, placeholder until the host exposes `getLtaMode/setLtaMode` |
| Terminal toggle (read in Rust) | yes (`Terminal`) | - |  |
| Extensions trust: folder trust list with consent, install allowlist (operator, ceiling, additions, ignored, effective) | yes (`ExtensionTrustSettingsCards`) | ~ | `ExtensionsTrustSection.tsx`, `trust-model.ts`; tests "trust list: trusting goes through the consent", "a load that started before an apply cannot overwrite it", "allowlist: edits are refused until the list has loaded", "normalizeSource" |
| Appearance: theme Dark, Light, Midnight | yes (`PreferencesSettingsSection`) | ~ | `SimpleSections.tsx` `AppearanceSection`; host `getTheme/setTheme` placeholder until S-A prefs land |
| Workspace: active project, notes folder | yes (`PathsSettingsSection`) | ~ | `WorkspaceSection`; read-only placeholders until the host commands land |
| Features: enabled set from /health (read-only) | yes (`FeatureProfileSettingsView`) | ~ | `FeaturesSection`; test "features: null means all on" |
| Account: sign in, sign out (keeps data) | yes (`LoginView`) | ~ | `AccountSection.tsx`; sign-in/out go through the shell host (placeholder until S-A) |
| About and diagnostics: versions, core trust state, copy diagnostics without secrets | yes (`UpdatesSettingsSection`) | ~ | `AboutSection.tsx`, `buildDiagnostics`; tests "diagnostics carry versions and states but no secrets", "core trust states are told apart" |
| feature profile and Apply & Rebuild (Mac-only mechanism; Tauri feature-off decision open) | yes (`FeatureRebuildService`) | defer |  |
| Help guide, self-heal, updates card (T6), GitHub/GitLab provider cards | yes (`HelpGuideView`) | defer |  |

## 6. Exit summary (updated by the integrator)

| Section | Rows | Verified (x or x+w) | Deferred |
|---|---|---|---|
| fill in when rows start to flip | | | |

Phase 3 exit needs every non-deferred row in sections 1 to 5 at `x+w` (see the plan, section 11).
