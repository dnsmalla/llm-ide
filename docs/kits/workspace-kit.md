# workspace-kit

Status: **K0 Map**, written 2026-10-31. No code was changed. Citations are paths (and `path:line` where one was read); read on 2026-10-31 at `main` (`de8d51e8`). Counts say how they were taken (`wc -l`, `find`). Section 9 lists where the migration plan's premises do not match the code; section 10 lists what was not verified.

## 1. Purpose

workspace-kit is the **editor-side workspace** of the Mac app: the file tree and file operations (Explorer), project-wide text search (Search), git status, staging, diff and commit (Source Control), and the PTY terminal dock (Terminal). It is the part of LLM-IDE that behaves like a small IDE around the user's project folder. It has **no server routes**: it works on local files, local git and local processes.

The plan row (kit 7) names: file tree, search, source control, terminal (PTY in Rust); `Features/Explorer`, `Search`, `SourceControl`, `Terminal`; keys `file_explorer`, `terminal`; contract "(mostly local)"; depends on core, ui-kit. The plan's route is **K0 to K2 to K3** (K1 skipped: "UI state only"). This map finds that skip is mostly right but not entirely (sections 5 and 6).

## 2. Code on every side

### 2a. Server (Node)

**None.** `ALL_ENDPOINTS` (`extension/server.mjs`) has no Explorer, Search, Source Control or Terminal route, and `routes/feature-routes.mjs` has no group for `file_explorer` or `terminal` (the plan's invariant 2 says the same). The only server code the kit touches is indirect: the phone's explorer chat goes through agent-kit (`/agent/v2/*`), and project memory (`/kb/agent/project-memory`) is read by Explorer's memory viewer through the `ProjectMemoryRegistry` seam.

### 2b. Mac app (Swift, `mac/Sources/LlmIdeMac/`)

| Layer | Piece | Path | Lines |
|---|---|---|---|
| Features | Explorer | `Features/Explorer/` (11 files: `ExplorerView` 1 155, `ExplorerTreeStore` 577, `ExplorerFileOps` 378, `ExplorerTreeList` 362, `ProjectMemoryView` 334, clipboard, drag payload, key command, rename name, name prompt sheet, paths sheet) | 3 112 |
| Features | Search | `Features/Search/` (3 files: `SearchView` 697, `SearchEngine` 368, `SearchService` 238) | 1 303 |
| Features | Source Control | `Features/SourceControl/` (4 files: `SourceControlView` 1 248, `GitLabSettingsSection` 660, `GitHubSettingsSection` 531, `RepoSettingsSection` 54) | 2 493 |
| Features | Terminal | `Features/Terminal/Views/` (6 files: `TerminalSession` 162, `TerminalPanelView` 133, `TerminalSessionView` 107, `BottomDockTabBar` 105, `TerminalDockSessions` 101, `TerminalTabBar` 84); PTY through `SwiftTerm` `LocalProcessTerminalView` (`TerminalSession.swift:3,18`) | 692 |
| Features | **Total** | 4 folders, 35 files (`find` + `cat \| wc -l`) | **7 600** |
| Core | Git engine | `Core/Repo/Services/SourceControlService.swift` (762), `RepoManager.swift` (830), `RepoFileWatcher.swift` (165), `SCMParsers.swift` (284), `GitTruthStore.swift`, `GitLog.swift` (25), `SCMModels.swift`, `ChangeShipping*.swift` | part of `Core/Repo/` 5 765 (25 files; shared with Issues, Chat, AutoTask, Loop, MobileControl) |
| Core | File-tree primitives | `Core/Project/FileSystemTree.swift` (44), `ExplorerPaths.swift` (179), `WorkspaceRoot`; `Core/DesignSystem/FileTreePanel.swift` (512), `EditorTabBar`, `FileDetailView`, `PanelSectionTabs` | — |
| Core | Editor | `Core/Editor/Monaco*.swift` (Monaco in a WKWebView), `GitGutter`, `HunkStagingList`, `TextFileWriter`, `EditorDraftStore` | — |
| Core | Shell exec | `Core/Platform/BashService.swift` (622); `TerminalPanelState.swift` (72, always compiled) | — |
| Contracts | Seams | `Core/Contracts/TerminalPanelProviding.swift` (`TerminalPanelRegistry`, `TerminalPanelSlot`), `ProjectMemoryProviding.swift`, `ChatPanelProviding.swift`, `ShellSection.swift` | — |
| Phone | Bridges | `Features/MobileControl/Services/MobileFilesBridge.swift` (53), `PhoneFiles.swift` (83), `MobileWorkspaceSearch.swift` (238), `MobileSourceControlBridge.swift` (72), `PhoneGit.swift` (144), `MobileExploreIndexStore.swift` (453); wire `FilesMessages`, `SourceControlMessages`, `ExploreWorkspaceMessages`, `ExplorerMessages` | — |

### 2c. Extension (Chrome)

**None.** The extension has no file, search, git or terminal surface.

### 2d. Contract and phone wire

No HTTP contract group. The phone wire carries read-only files (`files_list/files_read`), read-only source control (`scm_status_list`, `scm_diff`) and workspace search for the explore chat (`MobileProtocol.swift` message constants).

### 2e. Feature keys

- `file_explorer` (`mac/Package.swift:33`, `explorerIncluded`): when off, `Features/Explorer`, `Features/Search`, `Features/SourceControl` are excluded together (`:71-75`, "option b": Search and Source Control are reached through Explorer's panel-header switcher), plus a list of tests; closure drops `code_graph_3d`, `gantt_issues`, `doc_gen`.
- `terminal` (`:36`, `:119-123`): excludes `Features/Terminal` alone; `Core/Platform/TerminalPanelState.swift` stays in Core by design (`invariants.md`).
- `mac/Scripts/feature-map.txt`: all four folders are `sealed`.
- Server: no route group, so `feature_disabled` does not apply (kit plan invariant 2).

### 2f. Tests and gates

| Side | Files (by name, `ls`) |
|---|---|
| Mac Explorer | `ExplorerClipboardTests`, `ExplorerDragPayloadTests`, `ExplorerFileOpsTests`, `ExplorerKeyCommandTests`, `ExplorerMobileEngineResolverTests`, `ExplorerPathsTests`, `ExplorerTreeStorePersistenceTests`, `ExplorerTreeStoreTests`, `ExplorerTreeStoreWatchTests` (9) |
| Mac Search | `SearchEngineTests`, `SearchReplaceTests`, `SearchStreamTests`, `SearchTruncationTests`, `ShellStatePendingSearchTests` (5) |
| Mac Source Control and git | `SourceControlStageAllTests`, `SCMParsersTests`, `GitTruthStoreTests`, `GitTruthStorePatchTests`, `GitGutterTests`, `GitIgnoreRulesTests`, `PhoneGitTests`, `MemoryStoreGitTests` (8) |
| Mac Terminal and shell | `BashServiceTests`, `BashServiceEnvironmentTests` (no Terminal view test) |
| Mac Editor | `MonacoBridgeTests`, `MonacoEditorMessageHandlerTests`, `MonacoHostHTMLTests`, `MonacoLanguageMapTests`, `MonacoRevealGateTests`, `EditorDraftStoreTests` |
| Gates | `mac/Scripts/feature-boundaries.sh`; `make feature-matrix --key file_explorer` and `--key terminal` (Mac rows need `--mac`) |

## 3. Cross-kit edges

| # | From to | Mechanism | Ok? | Evidence |
|---|---|---|---|---|
| E1 | Explorer to agent-kit | chat panel for scope `explorer` via `ChatPanelView(request:)` | C | `ChatPanelProviding.swift`; agent-kit map 3a |
| E2 | Explorer to Terminal | `TerminalPanelRegistry` / `TerminalPanelSlot`, sharing Shell's dock sessions | C | `Core/Contracts/TerminalPanelProviding.swift` |
| E3 | Explorer to graph-kit / knowledge | project memory viewer through `ProjectMemoryRegistry` | C | `ProjectMemoryProviding.swift` |
| E4 | Source Control to Core/Repo | `SourceControlService`, `RepoManager`, `GitHubClient` | C (Core) | `Core/Repo/` |
| E5 | work-kit (Issues), AutoTask, Loop to `Core/Repo` | same clients | C (Core) | work-kit map E7 |
| E6 | MobileControl to workspace | files, search and scm bridges read the same Core types | C (Mac only) | `MobileFilesBridge.swift` |
| E7 | graph-kit and Library to `FileTreePanel`, `EditorTabBar` | design-system chrome | C (Core) | `Core/DesignSystem/` |
| E8 | Search to Explorer | `ShellState` pending search handoff; Shell routes | C | `ShellStatePendingSearchTests` |

**Cycles:** none found. **Invisible edges:** Source Control's backing code is `Core/Repo`, which five other features use (knowledge-kit CLAUDE.md "known limitation": the gate cannot see edges through `Core/`).

## 4. Delegated vs owned

| Piece | Label | Reason |
|---|---|---|
| File tree, create/rename/move/delete, clipboard, drag | Owned | Local file control; permission (`WorkspaceRoot` confinement). |
| Search engine (walk, match, cap 1 000 matches, 1 MB file limit) | Owned | Deterministic; no model involved. Could use `rg`, but the caps are product behaviour. |
| Git status, stage, diff, commit (`SourceControlService`) | Owned | Shells to `git`; the SDK does not improve it. |
| PR and MR creation (`ChangeShipping`) | Owned | Workflow and permission (what leaves the machine). |
| Terminal PTY | Owned (platform) | OS access. In the target it is Rust `portable-pty` plus xterm.js (ADR 0018 table). |
| Monaco editor | Delegated (third-party) | Already web; reused as is. |
| Explorer chat panel | Delegated | It is agent-kit's engine. |
| Project memory viewer | Owned UI | Knowledge display. |
| Phone files, git, search bridges | Owned | Permission switches (`PhoneAccessSettings`, `PhoneRedaction`). |

## 5. State and data (feeds K1a)

- **Project folder:** the files themselves; Explorer persists no content. Tree expansion and selection: `ExplorerTreeStorePersistenceTests` pins a per-project persisted state (UserDefaults; not re-read for exact keys).
- **Git:** the repo's own `.git`; `GitTruthStore` caches git truth in memory (tests only; no disk store named).
- **Editor drafts:** `EditorDraftStore` (unsaved edits, Application Support).
- **Terminal:** sessions are in-memory processes; no persistence; closing kills the shell.
- **Credentials** for GitHub and GitLab: Keychain (Settings sections live in `Features/SourceControl/Views/`, which is why that folder holds 1 191 lines of provider settings UI).
- **Server:** none. **Relay or sync:** none needed beyond the phone's read-only views.

## 6. What K1 would move (proposal)

Per the plan: **K1 is skipped** for workspace-kit, K0 to K2 to K3. The map's refinement:

1. **K2 (remove)** is already proven by the feature matrix rows `file_explorer` and `terminal`; re-run them with `--mac` at K2.
2. **No Node module for the editor or terminal.** In the Tauri app these are Rust plus web (xterm.js, Monaco, a Rust file watcher). The contract to decide is a small **Tauri command surface** (read dir, read/write file within root, watch, spawn PTY, git), not an HTTP route group.
3. **Git is the one real logic piece** (`SourceControlService` 762, `RepoManager` 830, `SCMParsers` 284). Two options: keep it in Rust (git2 or shelling `git`), or serve it from the Node core as `/kb/repo/git/*` routes (which also feeds the relay snapshot for the phone). Question WS2.
4. **Search** is pure logic (`SearchEngine` 368): port to Node or Rust with `SearchEngineTests`, `SearchReplaceTests`, `SearchTruncationTests` as the golden fixtures.
5. **K3** needs the ui-kit file tree and editor-tab components first; Monaco stays.

## 7. Decisions needed from the user

| # | Question | Options | Recommended |
|---|---|---|---|
| WS1 | Where does file access live in the Tauri app: Rust commands only, or Node core routes too (so the extension and relay can read files)? | Rust only; Node routes; both | Rust commands for the desktop UI; Node routes only for what the phone snapshot and extension already need (read-only listing, search). Never expose write over the relay without the permission re-check (relay design) |
| WS2 | Git engine: Rust, Node core, or keep shelling `git` from whichever host? | Rust; Node; shell `git` from the core | shell `git` from the Node core behind routes: one implementation for desktop, Linux, Windows and the phone; `git` is already required |
| WS3 | Terminal on Windows: ConPTY via `portable-pty`, or Mac and Linux first? | all three; Mac and Linux first | Mac and Linux first, Windows after the Phase 0 Windows run |
| WS4 | Keep Search and Source Control gated by `file_explorer`, or give each its own key? | keep; split | keep ("option b" ruling); revisit only if a build needs Search without a file tree |
| WS5 | Phone workspace access (files, git, search) once the relay exists: snapshot-only (read) or also queue edits? | read only; read plus queued edits | read only; edits stay a desktop action |
| WS6 | Monaco versus a lighter editor in the Tauri app? | keep Monaco; CodeMirror | keep Monaco (already embedded in `Core/Editor/MonacoHost.swift`, Phase 0 measured) |

## 8. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Git behaviour differences across `git` versions and OSes | One implementation; port `SCMParsersTests`, `GitTruthStore*Tests` as fixtures |
| R2 | Path confinement bugs in a new file API (traversal, symlink) | Reuse `ExplorerPaths` rules as tests; confinement tests first |
| R3 | Terminal PTY on Windows and Linux webview rendering | Phase 0 conditions; best-effort Linux (ADR 0018) |
| R4 | `Core/Repo` is shared with five kits, so a git change breaks Issues, AutoTask and Loop | Leave `Core/Repo` in core; contract tests per consumer |
| R5 | Editor draft and tree state are Mac UserDefaults; a Tauri screen starts empty | Small K1a note: no migration needed, or a one-time import |

## 9. Drift, gaps and corrections to the plan's premises

1. The plan says "(mostly local)" for the contract: it is **entirely local**; no route, no schema, no fixture.
2. The plan lists keys `file_explorer`, `terminal`; Search and Source Control have **no key of their own** and ride `file_explorer` (`Package.swift:71-75`).
3. The plan's K1-skip is right for Explorer, Search and Terminal; **Source Control's engine (`Core/Repo`)** is real logic shared with other kits and does need a home decision.
4. `Features/SourceControl` is 1 191 of 2 493 lines GitHub and GitLab **settings** UI (`GitHubSettingsSection`, `GitLabSettingsSection`), which belongs to Settings or work-kit credentials, not to the workspace.

## 10. What I could not verify

- Exact UserDefaults keys for tree and panel state (not grepped).
- Whether `GitTruthStore` persists to disk (tests only were read by name).
- Any behaviour at run time; `make feature-matrix`, `swift test` and `feature-boundaries.sh` were not run.
