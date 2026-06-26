---
title: macOS app — spec
status: draft
---

The macOS app (`LlmIdeMac`) is the primary IDE client — a single-window SwiftUI application that manages session state, drives a local Node backend, surfaces all workspace sections (Library, Explorer, Live, Code Assistant, etc.), and mediates every API call made to the backend.

---

## §1 Scope + build facts

**Source:** `mac/Package.swift`

| Attribute | Value |
|---|---|
| Swift tools version | 5.9 (line 1) |
| Build system | SwiftPM |
| Minimum platform | `.macOS(.v14)` (line 7) |
| Product | `.executable(name: "LlmIdeMac")` (line 10) |
| System linker dep | `sqlite3` (line 38) |

**Third-party dependencies** (lines 13–16):

| Package | Version |
|---|---|
| Yams | `from: "5.1.0"` |
| Sparkle | `from: "2.6.0"` |
| SwiftTerm | `from: "1.2.0"` |
| graph-kit (`GraphKit`) | `from: "1.5.3"` |

**Bundled resources** (lines 28–35): `note_template.docx`, `generate_meeting_note.py`, vendored highlight.js v11.9.0 (`highlight.min.js`), and two highlight.js themes (`atom-one-dark.min.css`, `atom-one-light.min.css`).

**Governed source areas** under `mac/Sources/LlmIdeMac/`:

- `Services/` — all business logic, networking, and state objects
- `Views/` — SwiftUI views and panels
- `Agent/` — agent dispatch, agent model types, agent-action sheets
- `CodeGraph/` — code graph indexing and query
- `CodeNotes/` — code note model and store
- `Models/` — shared data models
- `ViewModels/` — view-model objects
- `Utilities/` — helpers, path utils, JSON codable utilities
- `Resources/` — bundled assets

---

## §2 App lifecycle

### Entry point and scene shape

**Source:** `mac/Sources/LlmIdeMac/LlmIdeMacApp.swift`

The `@main` struct is `LlmIdeMacApp: App` (line 29). It uses a **`Window`** scene (not `WindowGroup`), declared at line 140:

```swift
Window(L.App.name, id: "main") { … }
```

The comment at lines 129–139 explains the choice: `WindowGroup` allows a second window to open on a deep-link arrival (which would produce two login screens), while `Window` enforces one window per process — the canonical macOS pattern for single-window apps.

An `NSApplicationDelegateAdaptor(AppDelegate.self)` is wired at line 34 to handle reopen and should-quit events that SwiftUI cannot express.

### EnvironmentObject graph

Most objects are constructed once in `init()` and injected at lines 142–156. Two exceptions use a `@State` wrapper instead of the "constructed once in init()" form: `BackendManager` (`@State private var backend`) and `ActivityStore` (`@State private var activityStore`, line 51) — both are `@Observable` rather than `ObservableObject`, so SwiftUI requires `@State` for storage.

| Object | Type | Role |
|---|---|---|
| `theme` | `ThemeStore` | Active colour palette |
| `templateStore` | `DocTemplateStore` | Doc templates (lazy-loaded from disk) |
| `session` | `SessionStore` | Auth state + live access token |
| `config` | `AppConfig` | User settings (singleton) |
| `capture` | `CaptionOrchestrator` | AX scraper / caption state |
| `deepLink` | `DeepLinkRouter` | URL scheme handler |
| `liveMirror` | `LiveSessionMirror` | Cross-client caption polling |
| `autoCodeUpdate` | `AutoCodeUpdateService` | Automated GitLab action processor |
| `updateService` | `UpdateService` | Sparkle updater |
| `projectStore` | `ProjectStore` | Active project management |
| `agentRuns` | `AgentRunsStore` | Agent run history |
| `graphAutoUpdater` | `GraphAutoUpdater` | Auto-maintains the per-project knowledge graph + memory (see §3) |
| `graphSessionStore` | `GraphSessionStore` | Process-lifetime cache of generated Code Graph results, keyed `repo#mode` |
| `activityStore` | `ActivityStore` | Activity feed state: bell badge count, poll loop, mark-seen cursor (see §8). Uses `@State` wrapper — injected via `.environment(activityStore)` at line 156. |

`BackendManager` is held as `@State private var backend` (line 49, using `@Observable`, not `ObservableObject`), injected via `.environment(backend)` at line 155. `LlmIdeAPIClient` and `AutoCaptureService` are stored as plain `let` properties (lines 52–53) and passed directly to views that need them.

### Launch `.task` bootstrap order

The single `.task` block attached to `ContentView` (lines 162–202) runs the following steps in sequence:

1. **ProjectMigrator** (lines 169–176) — one-shot import of legacy `SavedGitLab/HubRepo` entries. Runs first so an imported `activeProject` is visible to every subsequent step.
2. **`templateStore.bootstrap()`** (line 182) — deferred disk read of doc templates.
3. **`autoStartBackend()`** (lines 189–190, conditional on `config.backendAutoStart`) — resolves node/server.mjs paths and calls `backend.start()`.
4. **`awaitBackendReady(timeoutSec: 3)`** (line 196) — polls `/health` for up to 3 seconds so session restore has a live backend to talk to.
5. **`session.bootstrap(api: api)`** (line 199) — attempts to restore a persisted session by calling `/auth/refresh` with the Keychain-stored refresh token.
6. **`autoCapture.start()`** (line 200) — arms the auto-capture service (workspace-activation observer).
7. **`autoCodeUpdate.start()`** (line 201, conditional on `config.autoCodeUpdateEnabled`) — starts the auto-code-update polling loop.

After bootstrap, `liveMirror` is started/stopped in lockstep with `session.isAuthenticated` via `.onChange` (lines 207–209).

### MenuBarExtra

A `MenuBarExtra` is declared at lines 272–285. Its icon (`record.circle.fill` / `record.circle`) reflects `capture.isRunning`. The label turns red while recording. The menu (struct `MenuBarMenu`) shows start/stop recording, open-fault count, last regression run timestamp, and a quit button.

### ContentView and AppShell

**Source:** `mac/Sources/LlmIdeMac/Views/ContentView.swift`

`ContentView` (line 5) switches on `session.bootstrapping` and `session.isAuthenticated`:

- While bootstrapping → `ProgressView("Connecting…")`
- Not authenticated → `LoginView(api: api)`
- Authenticated → `AppShell(api: api)`

**Source:** `mac/Sources/LlmIdeMac/Views/AppShell.swift`

`AppShell` is the authenticated shell. It renders `WelcomeView` when `projectStore.activeProject == nil` (lines 39–40), and the full section layout when a project is active. The section layout is driven by `ShellState.section` (an `@Observable` object, `mac/Sources/LlmIdeMac/Services/ShellState.swift`). `ShellState` is created once at the `AppShell` root and injected via `.environment(shell)`, so it has **app-session scope**: it survives section navigation (which tears the section views down and recreates them) and is reset only when the app relaunches. UI state that must outlive a section switch lives here rather than as the section view's `@State` — e.g. `ShellState.exploreChatVisible` keeps the Explorer's chat panel open across navigation (it would otherwise reset to closed every time `ExplorerView` is rebuilt), while still starting closed on a fresh launch.

**Sections** (`ShellState.Section`, `ShellState.swift` line 9):

`library`, `live`, `explorer`, `search`, `plans`, `conflicts`, `sourceControl`, `issues`, `gantt`, `visual`, `docGen`, `autoCode`, `codeGraph`, `regression`, `settings`

The Library section gets a 3-column layout (sidebar | list | detail). All other sections use a 2-column layout (AppShell sidebar rail | content). A `TerminalPanelView` docks at the bottom of the content area for most sections. `ShellState.section` defaults to `.explorer`, so a fresh launch lands on the Explorer. The "tool" sections render as named buttons (`ToolbarToolButton`) in a `ToolbarItemGroup` inside the unified title bar (AppKit collapses overflow into the native `»` menu); `explorer`, `sourceControl`, and `search` are instead a panel-header switcher (`PanelSectionTabs`) shown in those three sections' headers, Cursor-style.

---

## §3 Service taxonomy + key contracts

**Source:** `mac/Sources/LlmIdeMac/Services/` (verified by `ls`)

### Suffix taxonomy

| Suffix | Role | Examples |
|---|---|---|
| `*Store` | Observable state / data store (publish `@Published` properties) | `SessionStore`, `ProjectStore`, `AgentRunsStore`, `DocTemplateStore`, `GitStatusStore`, `VerifyApprovalStore`, `LibraryItemStore`, `AgentCatalogStore` |
| `*Service` | Logic / side-effect handler (may publish state) | `AutoCaptureService`, `AutoCodeUpdateService`, `CodeWorkflowService`, `FaultPackService`, `PermissionsService`, `SourceControlService`, `SearchService`, `UpdateService` |
| `*Client` | Networking — calls external APIs | `LlmIdeAPIClient` (backend), `GitLabClient`, `GitHubClient` |
| `*Manager` | Lifecycle + process/resource management | `BackendManager`, `RepoManager` |
| `*Mirror` | Live-sync / polling from another source | `LiveSessionMirror` |
| `*Router` | Navigation / deep-link dispatch | `DeepLinkRouter` |

### Key service contracts

#### `SessionStore` (`Services/SessionStore.swift`)

Single source of truth for authentication state. Annotated `@MainActor` so all token reads/writes are actor-isolated (line 19).

- `@Published var user: UserInfo?`, `accessToken: String?`, `refreshToken: String?`, `bootstrapping: Bool` (lines 21–24)
- `var isAuthenticated: Bool` — `accessToken != nil && user != nil` (line 32)
- `bootstrap(api:)` (line 38) — loads the refresh token from Keychain via `KeychainStore.loadToken(host:)`, calls `/auth/refresh`, calls `adopt(session:)` on success or `KeychainStore.deleteToken` on failure
- `adopt(session:)` (line 57) — sets `user`, `accessToken`, `refreshToken`, and calls `KeychainStore.saveToken(_:host:)` to persist the new refresh token
- `attemptRefresh(via:)` (line 79) — coalesced refresh: concurrent 401-retry callers share one in-flight network call via a stored `Task<Bool, Never>`; the task is nilled out once the slot completes

**Token storage split:** The access token lives only in memory (`accessToken` property on `SessionStore`). The refresh token is persisted to the Keychain via `KeychainStore.saveToken(_:host:)` (called from `adopt`, line 61); it survives app restarts.

#### `BackendManager` (`Services/BackendManager.swift`)

Supervises the local Node `server.mjs` process (`@MainActor @Observable`, lines 18–20).

- `status: Status` — `.stopped | .starting | .running | .crashed(exitCode:)` (lines 24–29)
- `pid: Int32?`, `log: [BackendLogLine]` (lines 32–33)
- `start(nodePath:workingDirectory:)` (line 156) — checks if port 3456 is in use; if so, probes `/health` within 2 s. If healthy, adopts the external server; if not, kills the listener and spawns a fresh process. If the port is free, spawns immediately.
- `spawn(...)` (line 244) — calls `Process.run()`, stays in `.starting` until `/health` responds, then calls `markRunning(...)` (line 361) which flips to `.running`
- Auto-restart: up to 3 attempts with backoffs of 1 s, 5 s, 30 s (`restartBackoffsSec`, line 47); skipped on user-initiated stop (`userInitiatedStop` flag)
- `probeHealthDetail()` (line 517) — 2 s ephemeral URLSession GET to `http://127.0.0.1:3456/health`; also checks `apiVersion` against `minimumServerApiVersion = 18` (line 505)
- `stop()` (line 425) — SIGTERMs the spawned process; for adopted externals, uses `lsof -ti :<port>` to find and kill the listener

#### `LiveSessionMirror` (`Services/LiveSessionMirror.swift`)

Polls the backend for live caption streams from other clients (e.g., the Chrome extension).

- `@Published var captions: [MirroredCaption]`, `activeSession: LiveSessionInfo?`, `isPolling: Bool` (lines 22–24)
- `start()` / `stop()` (lines 67–80) — controlled by `AppShell` in response to `session.isAuthenticated` changes
- Discovery loop: `GET /kb/live/sessions` every **5 s** (line 60, `discoveryIntervalNs`)
- Caption poll: `GET /kb/live/<sessionId>?since=<seq>` every **1.5 s** while a session is active (line 61, `captionIntervalNs`), slowing to 5 s after finalize (line 62)
- `mergeCaptionInPlace(_:)` (line 159) — deduplicates growing utterances by replacing the most recent same-speaker caption when the new text starts with the old text (within a 10-entry tail window)
- On `finalized == true`: fires `NotificationCenter.default.post(name: .liveSessionFinalized, ...)` (line 244) with a `FinalizedPayload` so `AppShell` can generate a note file automatically

#### `KeychainStore` (`Services/KeychainStore.swift`)

Namespace enum (no instances) that wraps `SecItem*` calls.

- `saveToken(_:host:)` / `loadToken(host:)` / `deleteToken(host:)` (lines 15–25) — stores the JWT refresh token under account key `"<host>::refresh_token"`, service `"com.llmide.macapp"`
- Also stores GitLab PATs (`"gitlab::<host>::token"`, lines 30–38) and GitHub PATs (`"github::<host>::token"`, lines 47–56)
- `logout()` (line 67) — bulk-deletes all generic-password items under the service ID and clears `gitLabSavedProjects` / `gitHubSavedRepos` from `AppConfig`
- Legacy fallback: `load(account:service:)` tries the old service ID `"com.meetnotes.macapp"` and migrates items forward on first read (lines 104–110)

#### Caption orchestrator (`Services/CaptionScraper/CaptionScraper.swift`)

`CaptionOrchestrator` (line 49) is the `@StateObject` named `capture` in `LlmIdeMacApp`. It manages the AX-scraper-based local caption capture, driving meeting-app scrapers (Zoom, Teams) and the `CaptionScraper` protocol. `AutoCaptureService` (`Services/AutoCaptureService.swift`, line 9) wraps it, observing `NSWorkspace` activation/termination notifications to auto-start and auto-stop capture when known meeting bundle IDs become frontmost (line 23, `meetingBundleIDs` from `PlatformDetector.allScrapers`).

#### Knowledge-graph automation (`CodeGraph/`)

A per-project knowledge graph + agent memory, built from two tracks and kept current automatically. Project-scoped — every artifact lives under the project, nothing global.

- **`KnowledgeGraphService`** (`CodeGraph/KnowledgeGraphService.swift`, `@MainActor`) runs both tracks and publishes `codeGraph`, `docGraph`, `mergedGraph`, `docChunks`, `docCount`, `docFingerprint`:
  - *Code track* — `CodeNoteService` / `StructureScanner` (incremental scan-cache), written to `system/graph/`.
  - *Doc track* — `GraphKit.MemoryGenerator` over the repo's `.md` / `.txt` docs; recomputed only when a stat-only `docSetFingerprint` changes.
  - `merge(code:doc:chunks:)` unifies the two, adding doc→code cross-links for explicit `[[wikilinks]]`. **Markdown is a doc, not code** ("md is doc"): `FileClassifier.strippingDocNodes` removes the scanner's `.docPage` markdown nodes from the code graph so a doc isn't double-counted in the merged graph.
  - **Memory index** — `writeMemoryArtifact(...)` writes `<repo>/graphify-out/memory/`: `repo.md` (code summary), `doc-notes.md` (doc summary), `graph-notes.md` (cross-links). This combined index is what the extension agent reads (`extension/graphkit/memory.mjs`).
- **`GraphAutoUpdater`** (`CodeGraph/GraphAutoUpdater.swift`, `@MainActor`) drives the service automatically on three triggers: project open/switch (`.activeProjectChanged`), a 15-minute timer, and a **file watcher** (below) that fires within seconds of an edit. All three funnel through `runIfEligible`, which resolves the repo to graph via **`repoToGraph(projectRoot:)`** — an already-graphed repo if one exists (keeps incremental refresh stable), else the **first-gen target**: the first `code/<repo>` child, else the project root itself when it directly holds source. **First generation is automatic too** — opening a project with no graph yet generates one (the product's purpose is autonomous knowledge the user only reviews, never hand-triggers); `runIfEligible` is a no-op only for an empty project with nothing to graph. After each run it publishes the graphs into `GraphSessionStore` so the Code Graph view shows the auto-maintained result without re-scanning. Started from `AppShell` via `.task`.
- **`RepoFileWatcher`** (`CodeGraph/RepoFileWatcher.swift`) is a recursive `FSEventStream` on the active graphed repo that fires a **debounced (2 s) incremental regen** via the same `runIfEligible` path — so memory tracks code/docs in seconds rather than waiting for the timer. Events under regen-output dirs (`system/`, `graphify-out/`, `.code-notes/`, `.understand-anything/`) and VCS/build noise (`.git/`, `.build/`, `node_modules/`) are ignored, so a regenerated file can't retrigger the watcher (no feedback loop). Lifecycle is driven from `runIfEligible` (`ensureWatcher`, idempotent), not just `start()`/the project-switch notification — so a project **restored on launch** (which posts no `.activeProjectChanged`) still engages the watcher, since `runIfEligible` reads the live `activeProject` on start and every tick.
- **`FileClassifier`** (`CodeGraph/FileClassifier.swift`) routes files to code vs doc by extension — `MemoryGenerator.supportedExtensions` are docs, and the code-extension set subtracts them so `.md` classifies as a doc.
- **`GraphSessionStore`** (`Views/CodeGraph/GraphSessionStore.swift`, `@MainActor`) caches generated results keyed `repo#mode` (`code` / `data` / `all`) for the view's process lifetime, with a `laidOut` flag (the auto-updater stores raw graphs; the view lays them out on hydrate) and a `docFingerprint` (lets a manual InfiniteBrain re-generate reuse an unchanged doc index).

##### Graph rendering view (2D + 3D)

`UAGraphView` (`Views/CodeGraph/UAGraphView.swift`) is the interactive graph view that hydrates from `GraphSessionStore` and renders the selected `Mode` (`code` / `data` / `all`). It supports two renderers, toggled by a `Picker` bound to `@State private var render3D` (line 135):

- **2D** — `CodeGraphCanvas` over a 2D force layout (`CodeGraph/CGSimulation.swift`, with `QuadTree` Barnes-Hut approximation and `CodeGraphLayout`). Large graphs are pruned by `GraphPrune` (`CodeGraph/GraphPrune.swift`, e.g. `capDegree` at line 24) before layout.
- **3D** — `Graph3DView` (`Views/CodeGraph/Graph3DView.swift`), a SceneKit `NSViewRepresentable`, over the 3D force layout `CGSimulation3D` (`CodeGraph/CGSimulation3D.swift`: `settle` / `positions`). 3D positions are cached per mode in `@State private var positions3DByMode: [Mode: SIMD3<Float>…]` (line 136); the cache is invalidated (`positions3DByMode[mode] = nil`) when the mode changes or the Symbols filter toggles (lines 390, 395), and re-settled lazily via `settle3DIfNeeded()` only while `render3D` is on.
- **Colour legend** — a kind-keyed colour legend (one pill per doc kind, sourced from `CGPalette.swift`) is rendered inline so InfiniteBrain / All / 3D views share a consistent node-colour key.

---

## §4 Server IPC

### Base URL and authentication

**Source:** `Services/LlmIdeAPIClient.swift`

`LlmIdeAPIClient` (line 122) is initialized with `baseURL: String` read from `AppConfig.shared.serverURL` (set in `LlmIdeMacApp.init()`, line 62). Every authenticated request sets `Authorization: Bearer <accessToken>` (line 261):

```swift
req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
```

The access token is read from `SessionStore` via a `MainActor.run` hop on every call (line 259) so background concurrent calls always see the latest rotated token.

### URLSession configurations

Two sessions are created in `init()` (lines 153–169):

| Session | Timeout (request / resource) | Used for |
|---|---|---|
| `authSession` | 10 s / 15 s | Paths starting with `/auth/` |
| `llmSession` | 330 s / 600 s (10 min) | All other paths (LLM-backed endpoints) |

The `llmSession` request timeout is 330 s (source: `LlmIdeAPIClient.swift` line 167: `llmCfg.timeoutIntervalForRequest = 330`). 330 s covers the server worst case — the global agent loop (180 s) plus a single internal delegation's own up-to-120 s sub-loop, whose deadlines are independent — with margin. The resource timeout stays at 600 s / 10 min.

Route selection happens in `session(for: path)` (line 392): paths with prefix `/auth/` use `authSession`; everything else uses `llmSession`.

### On-401 refresh-and-retry flow

Implemented in `send(path:method:body:authenticated:isRetry:)` (lines 247–335). When a response is HTTP 401 and `isRetry == false`:

1. Check `store.refreshToken != nil` on MainActor (line 293).
2. Call `store.attemptRefresh(via: self)` (line 295) — this is coalesced in `SessionStore` so N concurrent 401 callers share one `/auth/refresh` request.
3. If refresh succeeds, recursively call `send(...)` with `isRetry: true` (line 297).
4. If refresh fails or `isRetry == true`, throw `APIError.noSession` (line 314) so the UI can route to the login screen.

The same pattern is applied in `postRawBytes(...)` (lines 223–231).

### GET retry + backoff

Only GET requests are retried (comment at line 267 explains why: re-issuing a POST/PUT/DELETE could double-apply a side effect). Up to `maxAttempts = 3` (line 271). Retried on:

- Network errors classified as transient by `isTransient(_:)` (lines 340–350): `NSURLErrorTimedOut`, `NSURLErrorCannotConnectToHost`, `NSURLErrorNetworkConnectionLost`, `NSURLErrorDNSLookupFailed`
- Server status codes 429, 502, 503, 504 (line 304)

Backoff strategy (`backoffNanos`, lines 353–356): `0.4 × 2^(attempt-1)` seconds, capped at 5 s.

`Retry-After` header honoring (`retryAfterNanos`, lines 359–364): delta-seconds form parsed, capped at 10 s.

### Token storage summary

| Token | Storage location |
|---|---|
| Access token | Memory only (`SessionStore.accessToken`, never written to disk) |
| Refresh token | Keychain via `KeychainStore.saveToken(_:host:)` (account: `"<host>::refresh_token"`) |

### The `pendingTool` → `toolResult` flow (Code Assistant)

**Sources:** `Views/CodeAssistantPanel.swift`, `Services/API/LlmIdeAPIClient+CodeAssist.swift`, `Agent/Models/AgentTypes.swift`

The Code Assistant sends a `POST /code-assist` request and receives a `CodeAssistResponse` (defined in `LlmIdeAPIClient+CodeAssist.swift`, lines 52–61). The response carries an optional `pendingTool: PendingTool?`.

`PendingTool` (`Agent/Models/AgentTypes.swift`, line 40) has:
- `name: String` — the tool name (e.g. `"update-file"`, `"create-gitlab-issue"`, `"comment-gitlab-issue"`, `"trigger-review-code"`)
- `arguments: AnyArguments` — raw JSON payload stored as `Data`, decoded lazily into typed structs via accessor properties (`updateFileArgs`, `createIssueArgs`, etc.)

**Flow for `update-file` (the file-edit path):**

1. `api.codeAssist(...)` returns a response; `self.pendingTool = resp.pendingTool` is set at `CodeAssistantPanel.swift` line 1669.
2. **Auto mode** (`editMode == .auto`): `confirmUpdateFile(args, finalContent: args.content)` is called immediately (line 1677–1678), bypassing the sheet.
3. **Manual mode**: A `PendingActionCard` is rendered in the chat bubble (line 669). When the user taps the card, `showingUpdateFileSheet = true` is set (line 676), presenting `UpdateFileSheet` as a `.sheet` (lines 302–361).
4. `UpdateFileSheet` shows the original content alongside the proposed content (a diff view). The user can edit the proposed content before confirming.
5. On confirm, `confirmUpdateFile(_:finalContent:)` (line 1781) is called: it validates the path against the `attachments` list (only files the user has attached can be written — defence in depth), writes the file to disk with `String.write(to:atomically:encoding:)`, refreshes the in-memory attachment, appends a synthetic `(applied update to <file>: ±N lines)` user turn to history, and calls `sendFollowup()` (line 1832).
6. `sendFollowup()` (line 1901) POSTs another `POST /code-assist` with `message: "(continue)"` and the updated history so the agent can acknowledge in natural language.
7. `pendingTool` is set to `nil` (line 1810) after write; if the follow-up response contains another `pendingTool`, the cycle repeats.

**Other tool names** follow the same card → sheet → confirm → synthetic-turn → follow-up pattern:
- `"create-gitlab-issue"` / `"create-github-issue"` → `CreateIssueSheet` → calls `GitLabClient` or `GitHubClient` → synthetic `(executed create-issue → #N ...)` turn
- `"comment-gitlab-issue"` → `CommentIssueSheet` → calls `client.createNote(...)`
- `"trigger-review-code"` → `TriggerReviewCodeSheet`
- `"git-op"` → see **git-op capability** subsection below.

#### git-op capability

**Sources:** `Agent/Models/AgentTypes.swift`, `Services/RepoManager.swift`, `Views/CodeAssistantPanel.swift`, `Views/GitOpSheet.swift`

The `git-op` tool gives the Code Assistant agent the ability to run git operations on the active repository.

**Model** (`Agent/Models/AgentTypes.swift`):

- `GitOp` — a 16-op `enum`: `status`, `log`, `diff`, `branch` (read tier); `add`, `commit`, `create_branch`, `checkout`, `pull_ff`, `push` (safe-write tier); `merge`, `revert`, `reset`, `stash`, `clean`, `merge_to_main` (destructive tier).
- `GitOpTier` — `case read, write, destructive`.
- `GitOpArgs: Codable` — `{ op: GitOp, message?, branch?, ref?, mode?, slug? }`.
- `PendingTool.gitOpArgs` — accessor on `PendingTool` that decodes `GitOpArgs` when `name == "git-op"`.

**Confirmation tier** (`Views/CodeAssistantPanel.swift`):

- **Read-tier ops** (`status`, `log`, `diff`, `branch`) — auto-run without any confirmation sheet.
- **Safe-write and destructive ops** — surface `GitOpSheet` before execution. Destructive ops additionally show a red warning banner inside the sheet so the user understands the operation is irreversible.

**Branch-first / protected-main policy** (`Services/RepoManager.runGitOp`):

- **commit on the default branch or a detached HEAD** — `runGitOp` auto-creates an `agent/<slug>` branch first (BRANCH-FIRST rule), so agent commits never land directly on `main`/`master`.
- **`push`** — refused when not on a named non-default branch (`"Refusing to push: not on a feature branch"`).
- **direct `merge` into the default branch or a detached HEAD** — refused (`"Refusing to merge into the default branch (or a detached HEAD) directly. Use merge_to_main for that explicit step."`).
- **`merge_to_main`** — the only operation that pushes `origin <default-branch>`; it performs a fast-forward merge from a feature branch and rolls back to the original branch if the ff-merge fails.
- **`safeRef()`** (`RepoManager.safeRef`, line 164) — rejects flag-like strings (starting with `-`) and strings containing whitespace, preventing shell-injection via ref names.

**Skill file:** `extension/llm_agent/global/git-op.md`  
**Confirmation tag:** `confirmation: gitop-sheet`

There is no separate `/code-assist/tool-result` endpoint. The tool result is communicated back to the server by appending a synthetic acknowledgement turn to `history` and making a fresh `POST /code-assist` call. The server sees the outcome in the conversation history.

#### Chat Stop, message queue, and reply collapse

**Source:** `Views/CodeAssistantPanel.swift`

**Stop control:** while a turn is running, a Stop button (also triggered by Esc, line 1224) is visible in the chat input area. Tapping it cancels the in-flight `Task` handle stored at line 56 (`@State private var runTask: Task<Void, Never>?`, cancel sites lines 1636 / 1961). Cancellation is a clean stop — no error bubble — after which the queue is drained (line 1634–1641).

**Message queue:** messages submitted while a turn is already running are appended to `@State private var queued: [String]` (line 59) — a FIFO list. When the current turn finishes or is stopped, `startTurn(queued.removeFirst())` is called (line 1694) so queued messages auto-send oldest-first without user intervention. The queue UI renders below the input field (lines 1077–1102); each pending item shows a cancel (×) button.

**Session reset:** switching to a different session or creating a new one calls `resetActiveTurnState()` (line 1960), which cancels the running turn, clears the `busy` flag (line 54), and calls `queued.removeAll()` so busy/queued state never bleeds across sessions (line 1964–1969).

**Collapse-old-replies:** only the latest assistant reply renders a full `SelfSizingMarkdownView` (the expensive web-view-backed renderer). Older assistant turns collapse to a lightweight text preview via `markdownPreview(_:)` (line 787), which strips markdown to plain text. A collapsed reply expands on tap: tapping inserts the turn's `id` into `expandedTurns: Set<UUID>` (line 97); `isAssistantExpanded(_:)` (line 781) returns true when `turn.id == lastAssistantTurnId || expandedTurns.contains(turn.id)`. An expanded old reply shows a "Collapse" button (line 832) that removes it from `expandedTurns`.

### Central routes called by the app

For the full route list see [`api-server.md`](api-server.md) and [`../reference/api/openapi.yaml`](../reference/api/openapi.yaml). The central routes the Mac app calls are:

| Route | Purpose |
|---|---|
| `POST /auth/login` | Login |
| `POST /auth/refresh` | Token refresh |
| `GET /auth/well-known` | Server config (issuer, registration open, token TTL) |
| `GET /auth/me/prefs` / `PUT /auth/me/prefs` | Per-user UI preferences |
| `GET /kb/search` | Knowledge base search |
| `POST /kb/ingest` | Ingest a meeting into the knowledge base |
| `POST /code-assist` | Code assistant round-trip (may return `pendingTool`) |
| `GET /kb/live/sessions` | Discover active live sessions |
| `GET /kb/live/<id>` | Poll captions for an active live session |
| `GET /kb/plans` / `GET /kb/plan/<id>` | Plan list and detail |
| `GET /kb/activity?since=&limit=` | Activity feed poll (incremental, since cursor) |
| `POST /kb/activity` | Report an activity event (knowledge graph update, regression run, issue create/comment) |
| `POST /kb/activity/seen` | Advance the unread-badge watermark |
| `GET /health` | Backend health probe (used by `BackendManager`) |

---

## §5 Platform-coupling boundary (the porting story)

The table below maps every Apple-only dependency to its source location and a portability tag:

- **LOCKED** — deep OS coupling; no cross-platform alternative without a full re-implementation
- **REPLACE** — well-isolated behind a service; swap the implementation, keep the interface
- **ABSTRACT** — already behind a thin wrapper; the wrapper is what needs a new body
- **PORTABLE** — no Apple dependency; builds on any platform today

| Dependency | Apple API / framework | File : symbol | Tag |
|---|---|---|---|
| Accessibility tree walk | `AXUIElementCreateApplication`, `AXUIElementCopyAttributeValue`, `AXIsProcessTrusted`, `kAXChildrenAttribute`, `kAXStaticTextRole`, `kAXWindowsAttribute`, `kAXTitleAttribute`, `kAXRoleAttribute`, `kAXValueAttribute`, `kAXDescriptionAttribute` | `Services/CaptionScraper/AXCaptionReader.swift:AXCaptionReader` | LOCKED |
| Accessibility trust gate | `AXIsProcessTrusted()`, `AXIsProcessTrustedWithOptions` | `Services/PermissionsService.swift:PermissionsService.refreshAccessibility()` (line 26), `promptAccessibility()` (line 75) | LOCKED |
| Keychain storage | `SecItemAdd`, `SecItemCopyMatching`, `SecItemDelete`, `kSecClassGenericPassword`, `kSecAttrService`, `kSecAttrAccount`, `kSecAttrAccessible` (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`) | `Services/KeychainStore.swift:KeychainStore` | REPLACE |
| File dialogs | `NSOpenPanel` (8 files) + `NSSavePanel` (3 files) | **Open** panels: `Views/Library/LibraryView.swift`, `Views/Regression/RegressionView.swift`, `Views/Settings/BackendSettingsSection.swift`, `Views/Shared/FileTreePanel.swift`, `Views/Shell/ProjectSwitcher.swift`, `Views/Welcome/WelcomeView.swift`, `Views/CodeGraph/UAGraphView.swift`, `Services/NotesFolder/NotesFolderConfig.swift`. **Save** panels (`NSSavePanel`): `Views/Library/MeetingDetailView.swift`, `Views/Welcome/WelcomeView.swift`, `Views/Regression/RegressionView.swift` | REPLACE |
| Global local key monitor | `NSEvent.addLocalMonitorForEvents(matching: .keyDown)` | `Views/AppShell.swift:AppShell.body` (monitor line 96) — matches the backtick **character** (`event.charactersIgnoringModifiers == "\`"` + `.control`, line 99) rather than keyCode 50, so the Ctrl+backtick terminal-panel toggle works on all keyboard layouts | REPLACE |
| Process / PTY | `Foundation.Process`, `SIGTERM`, `SIGKILL` (`kill(pid, ...)`) | `Services/BackendManager.swift:BackendManager.spawn()` (line 244), `killExternalListener()` (line 457) | REPLACE |
| Port listener lookup | `/usr/sbin/lsof -ti :<port> -sTCP:LISTEN` launched via `Process` | `Services/BackendManager.swift:BackendManager.killExternalListener()` (line 457) | REPLACE |
| Terminal emulator | SwiftTerm `LocalProcessTerminalView` | `Views/Terminal/TerminalSessionView.swift:TerminalSessionView` (line 8) | REPLACE |
| Auto-update | Sparkle (`SPUStandardUpdaterController`, `SUFeedURL`, `SUPublicEDKey`) | `Services/UpdateService.swift:UpdateService` | REPLACE |
| App-support paths | `FileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)` | `Services/LibraryItemStore.swift` (line 32) — `LLM IDE/library_items.json`; `Services/ChatSessionStore.swift` (line 17) — `LLM IDE/sessions/<uuid>.json`; `Models/Config.swift` (line 19) — corrupt-config stash under `LLM IDE/` | ABSTRACT |
| Screen recording probe | `CGPreflightScreenCaptureAccess()` | `Services/PermissionsService.swift:PermissionsService.refreshScreenRecording()` (line 33) | REPLACE |
| System Settings deep links | `x-apple.systempreferences:…` URL scheme via `NSWorkspace.shared.open` | `Services/PermissionsService.swift:PermissionsService.openSystemSettings(pane:)` (line 89) | REPLACE |

**Porting strategy (one line):** Keep the Node server and agent runtime verbatim; re-implement the SwiftUI shell in the target UI toolkit; abstract the six service boundaries — caption capture (AX), credential storage (Keychain), file dialogs, key monitoring, process/PTY management, and app-support paths — behind protocol interfaces so the rest of the codebase compiles unchanged.

---

## §6 Capture pipeline (Accessibility)

**Sources:** `Services/CaptionScraper/AXCaptionReader.swift`, `Services/CaptionScraper/ZoomCaptionScraper.swift`, `Services/CaptionScraper/TeamsCaptionScraper.swift`, `Services/CaptionScraper/CaptionScraper.swift`, `Services/CaptionScraper/PlatformDetector.swift`, `Services/PermissionsService.swift`

### AX trust gate

Before any scraper can read another process's UI, macOS requires that the app hold the Accessibility permission. `AXCaptionReader.canRead` (line 81) calls `AXIsProcessTrusted()` — a silent probe that returns a boolean without presenting the system dialog. It is called on every poll tick (`CaptionScraper.swift` line 265).

Permission is requested explicitly via `PermissionsService.promptAccessibility()` (line 75), which calls `AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt: true])` to surface the OS dialog. **The permission change only takes effect after the app relaunches** — there is no notification, so `PermissionsService.startPolling()` (line 55) polls `AXIsProcessTrusted()` every 1 second while the Permissions view is on screen, allowing the UI to update its badge once the user grants access in System Settings.

Mid-session revocation is handled in `CaptionOrchestrator.tick()` (`CaptionScraper.swift` line 265): if `AXCaptionReader.canRead` returns false during an active capture, the orchestrator sets `permissionLost = true`, stops the timer, and surfaces a banner so the user can re-grant without losing the recorded captions.

### AX tree walk mechanics

`AXCaptionReader` (`AXCaptionReader.swift`) provides four primitives used by all scrapers:

- `axElement(forBundleID:)` (line 15) — looks up the process ID of the target app via `NSWorkspace.shared.runningApplications`, then calls `AXUIElementCreateApplication(pid)` to obtain its root AX element.
- `children(_:attribute:)` (line 33) — reads a child array via `AXUIElementCopyAttributeValue(element, kAXChildrenAttribute)`.
- `descendants(of:matching:maxDepth:)` (line 42) — depth-bounded recursive walk (default `maxDepth: 12`) collecting all elements whose `kAXRoleAttribute` matches a given role string.
- `window(in:titleContains:)` (line 65) — finds an `AXWindow` by case-insensitive title substring via `kAXWindowsAttribute`.

### Per-platform scraper logic

**Zoom** (`ZoomCaptionScraper.swift`): locates the "Captions and Subtitles" window by matching `kAXWindowsAttribute` titles containing `"Caption"` (English) or `"字幕"` (Japanese). Descends to all `kAXStaticTextRole` children and splits each text node on the first newline to extract `speaker\nbody` pairs. Falls back to `("Unknown", text)` when no speaker prefix is found. Bundle ID: `us.zoom.xos`.

**Teams** (`TeamsCaptionScraper.swift`): Teams is Electron-based, so captions appear inside the main meeting window rather than a separate window. Walks all windows up to `maxDepth: 16` looking for an `kAXGroupRole` element whose `kAXDescriptionAttribute` contains `"live caption"`. Then reads alternating `kAXStaticTextRole` children as speaker/body pairs. Bundle ID: `com.microsoft.teams2`.

Both scrapers conform to the `CaptionScraper` protocol (`CaptionScraper.swift` line 8), which requires `source: CaptureSource`, `bundleID: String`, and `snapshot() -> [(speaker: String, text: String)]`. The default `isAvailable()` implementation (line 35) calls `AXCaptionReader.canRead` then checks whether `axElement(forBundleID:)` returns non-nil.

`PlatformDetector.allScrapers` (`PlatformDetector.swift` line 7) registers `[ZoomCaptionScraper(), TeamsCaptionScraper()]` — the ordered list the orchestrator iterates.

### Poll cadence

`CaptionOrchestrator` (`CaptionScraper.swift`) uses an **adaptive two-speed timer**:

| State | Interval | Condition |
|---|---|---|
| Active (captions arriving) | **250 ms** (4 Hz) | Default; snaps back on any new caption |
| Idle (no new captions for 5 s) | **500 ms** (2 Hz) | After `idleAfter: TimeInterval = 5.0` (line 86) elapses with no new lines |

The timer is a `Foundation.Timer` added to `RunLoop.main` with `.common` mode (line 137). Changing cadence requires invalidating and re-creating the timer because `Foundation.Timer.timeInterval` is read-only after scheduling (comment at line 310).

On each tick, the orchestrator calls `scrapers.first(where: { $0.isAvailable() })` (line 271), picks the first available platform, calls `snapshot()`, and deduplicates new lines against a 2-second rolling window (`dedupWindow: TimeInterval = 2.0`, line 73) using an O(1) `Set<String>` keyed on `"speaker::text"` (line 292).

### How captured captions reach the server

Captions captured locally by the AX scraper are **not pushed to the server in real time**. They accumulate in `CaptionOrchestrator.captions: [Caption]` (line 50) and in the on-disk partial `.md` file. When the user stops recording, `stopAndIngest(api:meetingTitle:)` (line 162) POSTs the full transcript to **`POST /kb/ingest`** (implemented in `Services/API/LlmIdeAPIClient+KB.swift:ingestMeeting`, line 76). See [`api-server.md`](api-server.md) for the `/kb/ingest` route contract.

The `LiveSessionMirror` service (`Services/LiveSessionMirror.swift`) works in the opposite direction: it polls `GET /kb/live/sessions` and `GET /kb/live/<id>?since=<seq>` to receive captions produced by *other* clients (e.g. the Chrome extension). The Mac AX scraper does not write to the `/kb/live/*` namespace.

**Cross-reference:** This is the macOS analogue of the Chrome extension's DOM-based caption scraper ([`chrome-extension.md`](chrome-extension.md) §3). Both implement the same goal — intercept in-app captions from Zoom/Teams — using OS-specific mechanisms: the extension reads the DOM via a content script injected into the meeting tab; the Mac app walks the AX tree via `ApplicationServices`. The Chrome extension pushes captions to `/kb/live/<sessionId>` in real time; the Mac app batches them and pushes to `/kb/ingest` on session end.

---

## §7 Build & packaging

**Sources:** `mac/Package.swift`, `mac/build_app.sh`, `mac/Scripts/build.sh`, `mac/Scripts/sign.sh`, `mac/Scripts/dmg.sh`, `mac/LlmIdeMac.entitlements`

### SwiftPM target resources

The single executable target in `Package.swift` (lines 28–35) copies the following resources into the app bundle at build time:

| Resource file | Declared at | Purpose |
|---|---|---|
| `Resources/note_template.docx` | line 29 | Base template for meeting-note DOCX generation |
| `Resources/generate_meeting_note.py` | line 30 | Python helper invoked during DOCX generation |
| `Resources/highlight.min.js` | line 33 | Vendored highlight.js v11.9.0 (BSD-3) — syntax highlighting without a CDN |
| `Resources/atom-one-dark.min.css` | line 34 | highlight.js dark theme |
| `Resources/atom-one-light.min.css` | line 35 | highlight.js light theme |

All five are declared `.copy(...)` so SwiftPM copies them verbatim into `Contents/Resources/` without processing.

### Build pipeline (`build_app.sh` / `Scripts/`)

`mac/build_app.sh` is a backward-compat shim (line 3) that delegates to three sub-scripts in order: `Scripts/build.sh` → `Scripts/sign.sh` → `Scripts/dmg.sh`. For a full notarized release, `Scripts/release.sh` adds a `Scripts/notarize.sh` phase between sign and DMG.

**`Scripts/build.sh`:**
1. Reads the version string from `mac/VERSION` (line 19) — single source of truth for both the Info.plist `CFBundleShortVersionString` and the DMG filename.
2. Assembles the `.app` bundle skeleton (`Contents/MacOS/`, `Contents/Resources/`).
3. Generates `AppIcon.icns` from `app_logo.png` using `sips` + `iconutil` (line 41).
4. Writes `Contents/Info.plist` (lines 77–150) including Sparkle keys (`SUFeedURL`, `SUPublicEDKey`) from environment variables `LLMIDE_SU_FEED_URL` / `LLMIDE_SU_PUBLIC_KEY` (absent for dev builds — Sparkle starts inert), and the URL schemes `llmide` + `meetnotes` for deep linking.
5. Runs `swift build -c release --product LlmIdeMac` (line 158).
6. Copies the Sparkle framework from the SPM build cache into `Contents/Frameworks/` and patches `@rpath` with `install_name_tool` (line 181) — without this the app crashes on launch with "Library not loaded: @rpath/Sparkle.framework".

**`Scripts/sign.sh`:** calls `codesign -s "$IDENTITY" --force --deep --options runtime --entitlements LlmIdeMac.entitlements` (line 30). `LLMIDE_SIGN_IDENTITY` defaults to `"-"` (ad-hoc) for dev builds; set to a Developer ID for distribution.

**`Scripts/dmg.sh`:** creates a UDZO-compressed DMG (`hdiutil create -format UDZO`, line 37) named `LlmIdeMac_v<VERSION>.dmg` with a symlink to `/Applications` for drag-install.

### Entitlements (`mac/LlmIdeMac.entitlements`)

| Entitlement key | Value | Reason |
|---|---|---|
| `com.apple.security.app-sandbox` | `false` | Sandbox disabled; required to spawn child processes (`node`, `claude` CLI) and walk AX trees of other apps |
| `com.apple.security.network.client` | `true` | Outbound HTTPS to GitLab, Anthropic, and `127.0.0.1` backend |
| `com.apple.security.cs.disable-library-validation` | `true` | Allows loading Sparkle's binary framework |
| `com.apple.security.device.microphone` | `true` | Microphone fallback when AX captions are unavailable |
| `com.apple.security.device.audio-input` | `true` | Audio-input for meeting capture |
| `com.apple.security.files.user-selected.read-write` | `true` | Read/write access to files the user selects via file dialogs |
| `com.apple.security.cs.allow-jit` | `false` | Not required (Node runs as a separate process) |
| `com.apple.security.cs.allow-unsigned-executable-memory` | `false` | Not required |

### Test target (`LlmIdeMacTests`)

Declared in `Package.swift` lines 41–60. Depends on the main `LlmIdeMac` target. The `Tests/LlmIdeMacTests/` path is excluded from the `README-skipped-tests.md` file. The target requires unsafe Swift flags pointing at `/Library/Developer/CommandLineTools/Library/Developer/Frameworks` to link the Swift Testing framework:

```
-F /Library/Developer/CommandLineTools/Library/Developer/Frameworks
-Xfrontend -disable-cross-import-overlays
```

Linker flags add `-framework Testing` with an `-rpath` pointing at the same CommandLineTools path. This setup is needed because Swift Testing is not yet part of the standard Xcode toolchain search path under SwiftPM on macOS 14.

---

## §8 Activity feed

The activity feed surfaces backend events in the Mac status bar without requiring the user to navigate to a specific section.

### ActivityStore (`mac/Sources/LlmIdeMac/Services/ActivityStore.swift`)

`@MainActor @Observable final class ActivityStore` owns the live activity state:

| Symbol | Behaviour |
|---|---|
| `items: [ActivityItem]` | All fetched activity rows, newest-first. |
| `unreadCount: Int` | Count of items newer than the last `markSeen()` call, as reported by the server. |
| `lastId: Int` | Highest item `id` seen; used as the `since` cursor for incremental polling. |
| `start()` | Begins a poll loop (`GET /kb/activity?since=<lastId>&limit=50`) every ~25 s.  Idempotent. |
| `refresh()` | Single-shot fetch; called by the poll loop and on focus. |
| `report(kind:title:detail:link:)` | Fire-and-forget `POST /kb/activity`; used by the four Mac call sites (knowledge graph update, regression run, issue create, issue comment) to write their own events. |
| `markSeen()` | Optimistically clears `unreadCount` and sends `POST /kb/activity/seen` to persist the watermark. Called when the `ActivityPanel` popover opens. |

`ActivityStore` is constructed in `LlmIdeMacApp.init` and injected via `.environment(activityStore)` on the root scene so all sheets and popovers can read it with `@Environment(ActivityStore.self)`.

`ActivityItem` fields: `id: Int`, `kind: ActivityKind?`, `title: String`, `detail: [String: Any]?`, `link: String?`, `createdAt: Date`.

The nine `ActivityKind` cases (with matching backend string raw values): `knowledgeUpdated`, `regressionDone`, `issueCreated`, `commentAdded`, `dispatchIssueCreated`, `outcomeChanged`, `meetingAdded`, `emailFetched`, `slackFetched`.

### ActivityBell + ActivityPanel (`mac/Sources/LlmIdeMac/Views/Shell/ActivityBell.swift`)

`ActivityBell` sits in `StatusBar` alongside `AgentStatusBadge` (added inside the trailing `HStack(spacing: 12)`).  It renders:

- A plain `bell` SF Symbol when `unreadCount == 0`.
- A `bell.badge` symbol with a red count badge (capped at 99) when there are unread items.
- A `popover` containing `ActivityPanel` on tap; `markSeen()` is called on open.

`ActivityPanel` is a 360 × 420 pt `ScrollView` wrapping a `LazyVStack`.  Items are grouped into day buckets ("Today", "Yesterday", or an abbreviated date) and each row is an `ActivityRow`.

`ActivityRow` shows an SF Symbol icon keyed on `ActivityKind?` (all 9 kinds + `nil` covered), the item title (2-line limit), and a relative timestamp via `Text(item.createdAt, format: .relative(presentation: .named))`.  Tapping a row posts `NotificationCenter.default.post(name: .openSection, object: item.link)` when `item.link` is non-nil — `AppShell` handles `.openSection` by casting the object to `String` and mapping it to a `ShellState.Section` rawValue, so the deep-link navigates to the matching section.  Links that do not match a known Section rawValue are a silent no-op (AppShell ignores the cast failure).

This feature pairs with the backend `activity` table and module documented in [`knowledge-base.md`](knowledge-base.md).

---

## §9 See also

- [`../explanation/macos-app.md`](../explanation/macos-app.md) — narrative explanation of design decisions and tradeoffs for the macOS app (forward link; created in the next documentation task)
- [`../explanation/architecture.md`](../explanation/architecture.md) — system-wide architecture explanation covering the relationship between the Node server, the Mac shell, and the Chrome extension
- [`chrome-extension.md`](chrome-extension.md) — the Chrome-side caption-scraper: same goal (intercept Zoom/Teams captions), different mechanism (DOM content script vs. AX tree), different transport (real-time `POST /kb/live/<id>` vs. batch `POST /kb/ingest`)

---

## §10 Regeneration checklist
- [x] Every governed contract (service interfaces, IPC, platform-coupling points, capture pipeline) is present with verified `file:symbol` citations.
- [x] Every coupling point names its Apple-only API and a portability tag.
- [x] Spot-check: the app lifecycle, the API client auth/refresh flow, and the AX capture path were rebuilt from this page and match source.
- [x] Cited source files are guarded by `docs/_scripts/check_spec_citations.py` (run in `make docs-check`); note it checks file *existence*, not line numbers or symbols — re-verify those against source when the app changes.
