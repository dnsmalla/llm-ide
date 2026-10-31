# Tauri parity checklist against the Mac app

Status: **created 2026-10-31; every Tauri cell is not started (`-`) or deferred; the Phase 0 spike (Monaco, xterm, chat replay) is not counted until a row is verified.** Date: 2026-10-31, at `main`. Parents: [Phase 3 plan](2026-10-31-tauri-phase3-plan.md), [MASTER-PLAN](../MASTER-PLAN.md) S2, [ADR 0018](../../decisions/0018-tauri-desktop-node-core-relay.md).

How to use: one row per behaviour. **Mac** is the reference (Swift source named in the row). **Tauri** is one of `-` (not started), `~` (built, not verified), `x` (verified on macOS), `x+w` (verified on macOS and Windows), `n/a` (decided not to port, with a reason in Evidence), `defer` (planned later). **Evidence** is a test name, a screenshot under `desktop/parity/`, or a commit hash. A row is `x` only with evidence, and visual rows also need the user's side-by-side check. Each slice owner edits only their own section, in the same commit that lands the work. Rows were derived from the Mac source tree, not from memory; an unknown behaviour found later is added as a new row, not skipped.

## 1. Shell, Home and toolbar navigation (slice S-A)

| Row | Mac (source) | Tauri | Evidence |
|---|---|---|---|
| Window opens, restores last section and project | yes (`ShellState, ContentView`) | - |  |
| Section switcher lists the same sections in the same order (Library, Live, Explorer, Search, Review Conflicts, Source Control, Issues, Gantt, Visual, Doc Gen, Auto Tasks, Graph, Loop, Settings, System); sections of out-of-scope phases show disabled with a reason | yes (`ShellSection`) | - |  |
| Section hidden when its feature is off (`/health` features, 404 `feature_disabled`) | yes (`ShellSection.backingFeature`) | - |  |
| Home / default section resolution (`resolveHome`) | yes (`ShellState`) | - |  |
| Toolbar: project name, open project, recent projects, status bar, activity bell | yes (`Shell/Chrome`) | - |  |
| Deep links (`llmide://`) route to the right section | yes (`DeepLinkRouter`) | - |  |
| Login, reconnect, welcome, recovery screens | yes (`LoginView, ReconnectView, Welcome, Recovery`) | - |  |
| Backend status and restart (sidecar lifecycle equals BackendManager) | yes (`BackendManager`) | - |  |
| Keyboard shortcuts for section switch and command palette | yes (`menus`) | - |  |
| Theme: light, dark, midnight from tokens.json; side-by-side screenshot in `desktop/parity/` | yes (`ColorPalette`) | - |  |
| Window state, tray, close-to-tray default off, notifications (2 templates) | yes (`AppDelegate`) | - |  |

## 2. Chat panel (S-B, S-G, S-L)

| Row | Mac (source) | Tauri | Evidence |
|---|---|---|---|
| Streaming reply renders incrementally, no dropped events | yes (`ChatMessageList, ChatEngine`) | - |  |
| Markdown bubble: code blocks with copy, tables, links, no raw HTML (sanitised) | yes (`ChatMarkdownBubble`) | - |  |
| Composer: multiline, history recall, send, stop, attachments via host dialog, drag drop | yes (`ChatComposer, HistoryTextEditor`) | - |  |
| Slash menu: 7 dynamic surfaces (built-ins, skills, plugins, MCP, commands, modes, models) from the server | yes (`ChatSlashCommands, CompletionMenu`) | - |  |
| @ file mentions / completion | yes (`CompletionController`) | - |  |
| Mode picker incl. plan and assist-plan modes, per-chat mode memory, mode badge | yes (`ModeBadge, ModePolicy`) | - |  |
| Plan flow: plan card, edit sheet, save card, execution card, timeline, 'Nothing to execute.' marker | yes (`CodeAssistant+Plan*, PlanEditSheet`) | - |  |
| Model picker with live model list, provider routing control, route history | yes (`CodeAssistantModelState, ChatRouteControl`) | - |  |
| Cap chip (per-model usage caps, same thresholds, fallback notice) | yes (`usage ledger, notice events`) | - |  |
| Context usage meter (`context_usage`) | yes (`ChatSessionHeader`) | - |  |
| Tool activity list, subagent chip, task list and progress (`tasks`, `tasks_progress`) | yes (`ToolActivityList, SubagentActivityChip`) | - |  |
| Permission mode: Ask / Accept Edits / Bypass chip and Bypass confirmation | yes (`EditAcceptanceMode`) | - |  |
| Tool approval card (Allow once / always for project / Deny), parked approval survives reload | yes (`ToolApprovalCard, AgentV2ApprovalState`) | - |  |
| Question card (AskUserQuestion) | yes (`AskUserQuestionCard, ApprovalQuestionCard`) | - |  |
| Workspace trust banner, trust by host dialog | yes (`workspace-trust`) | - |  |
| Session header: rename, delete (removes everywhere), new chat | yes (`ChatSessionHeader, SessionRow`) | - |  |
| Session list: history, background (parked) sessions, switch without losing a running turn | yes (`ChatEngineRegistry`) | - |  |
| Notices: retry, rate limit, permission denied, fallback, refusal | yes (`notice event`) | - |  |
| Error states and reconnect after core restart | yes (`error event`) | - |  |
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
| Providers: list, add, verify key, catalog connect and test, write-only keys | yes (`ProvidersSection, ProviderForms`) | - |  |
| Model routing: roles, switches, per-role models | yes (`ModelRoutingSection`) | - |  |
| Backend: status, port, restart | yes (`BackendSettingsSection`) | - |  |
| Preferences | yes (`PreferencesSettingsSection`) | - |  |
| Tool approvals: stored rules, delete | yes (`ToolApprovalsSettingsSection`) | - |  |
| Agent SDK settings | yes (`AgentSdkSettingsSection`) | - |  |
| Token saving | yes (`TokenSavingSettingsSection`) | - |  |
| Agent history card | yes (`AgentHistorySettingsCard`) | - |  |
| Memory | yes (`MemorySettingsSection`) | - |  |
| Paths | yes (`PathsSettingsSection`) | - |  |
| Live-then-archive setting | yes (`LiveThenArchiveSettingModel`) | - |  |
| Terminal toggle (read in Rust) | yes (`Terminal`) | - |  |
| feature profile and Apply & Rebuild (Mac-only mechanism; Tauri feature-off decision open) | yes (`FeatureRebuildService`) | defer |  |
| Help guide, self-heal, updates card (T6), GitHub/GitLab provider cards | yes (`HelpGuideView`) | defer |  |

## 6. Exit summary (updated by the integrator)

| Section | Rows | Verified (x or x+w) | Deferred |
|---|---|---|---|
| fill in when rows start to flip | | | |

Phase 3 exit needs every non-deferred row in sections 1 to 5 at `x+w` (see the plan, section 11).
