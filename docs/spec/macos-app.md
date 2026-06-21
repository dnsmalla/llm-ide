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
| graph-kit (`GraphKit`) | `from: "1.2.0"` |

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

The `@main` struct is `LlmIdeMacApp: App` (line 29). It uses a **`Window`** scene (not `WindowGroup`), declared at line 127:

```swift
Window(L.App.name, id: "main") { … }
```

The comment at lines 117–126 explains the choice: `WindowGroup` allows a second window to open on a deep-link arrival (which would produce two login screens), while `Window` enforces one window per process — the canonical macOS pattern for single-window apps.

An `NSApplicationDelegateAdaptor(AppDelegate.self)` is wired at line 34 to handle reopen and should-quit events that SwiftUI cannot express.

### EnvironmentObject graph

All objects are constructed once in `init()` and injected at lines 129–140:

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

`BackendManager` is held as `@State private var backend` (line 47, using `@Observable`, not `ObservableObject`), injected via `.environment(backend)` at line 140. `LlmIdeAPIClient` and `AutoCaptureService` are stored as plain `let` properties (lines 49–50) and passed directly to views that need them.

### Launch `.task` bootstrap order

The single `.task` block attached to `ContentView` (lines 146–186) runs the following steps in sequence:

1. **ProjectMigrator** (lines 153–160) — one-shot import of legacy `SavedGitLab/HubRepo` entries. Runs first so an imported `activeProject` is visible to every subsequent step.
2. **`templateStore.bootstrap()`** (line 166) — deferred disk read of doc templates.
3. **`autoStartBackend()`** (lines 173–175, conditional on `config.backendAutoStart`) — resolves node/server.mjs paths and calls `backend.start()`.
4. **`awaitBackendReady(timeoutSec: 3)`** (lines 177–181) — polls `/health` for up to 3 seconds so session restore has a live backend to talk to.
5. **`session.bootstrap(api: api)`** (line 183) — attempts to restore a persisted session by calling `/auth/refresh` with the Keychain-stored refresh token.
6. **`autoCapture.start()`** (line 184) — arms the auto-capture service (workspace-activation observer).
7. **`autoCodeUpdate.start()`** (line 185, conditional on `config.autoCodeUpdateEnabled`) — starts the auto-code-update polling loop.

After bootstrap, `liveMirror` is started/stopped in lockstep with `session.isAuthenticated` via `.onChange` (lines 191–193).

### MenuBarExtra

A `MenuBarExtra` is declared at lines 256–269. Its icon (`record.circle.fill` / `record.circle`) reflects `capture.isRunning`. The label turns red while recording. The menu (struct `MenuBarMenu`) shows start/stop recording, open-fault count, last regression run timestamp, and a quit button.

### ContentView and AppShell

**Source:** `mac/Sources/LlmIdeMac/Views/ContentView.swift`

`ContentView` (line 6) switches on `session.bootstrapping` and `session.isAuthenticated`:

- While bootstrapping → `ProgressView("Connecting…")`
- Not authenticated → `LoginView(api: api)`
- Authenticated → `AppShell(api: api)`

**Source:** `mac/Sources/LlmIdeMac/Views/AppShell.swift`

`AppShell` is the authenticated shell. It renders `WelcomeView` when `projectStore.activeProject == nil` (lines 37–39), and the full section layout when a project is active. The section layout is driven by `ShellState.section` (an `@Observable` object, `mac/Sources/LlmIdeMac/Services/ShellState.swift`).

**Sections** (`ShellState.Section`, `ShellState.swift` line 9):

`library`, `live`, `explorer`, `search`, `plans`, `conflicts`, `sourceControl`, `issues`, `gantt`, `visual`, `docGen`, `autoCode`, `codeGraph`, `regression`, `settings`

The Library section gets a 3-column layout (sidebar | list | detail). All other sections use a 2-column layout (AppShell sidebar rail | content). A `TerminalPanelView` docks at the bottom of the content area for most sections. The activity bar (section-icon rail) is a `.principal` `ToolbarItem` (`TopActivityBar`) inside the unified title bar.

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
- `spawn(...)` (line 233) — calls `Process.run()`, stays in `.starting` until `/health` responds, then calls `markRunning(...)` (line 338) which flips to `.running`
- Auto-restart: up to 3 attempts with backoffs of 1 s, 5 s, 30 s (`restartBackoffsSec`, line 47); skipped on user-initiated stop (`userInitiatedStop` flag)
- `probeHealthDetail()` (line 477) — 2 s ephemeral URLSession GET to `http://127.0.0.1:3456/health`; also checks `apiVersion` against `minimumServerApiVersion = 18` (line 465)
- `stop()` (line 402) — SIGTERMs the spawned process; for adopted externals, uses `lsof -ti :<port>` to find and kill the listener

#### `LiveSessionMirror` (`Services/LiveSessionMirror.swift`)

Polls the backend for live caption streams from other clients (e.g., the Chrome extension).

- `@Published var captions: [MirroredCaption]`, `activeSession: LiveSessionInfo?`, `isPolling: Bool` (lines 23–25)
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

---

## §4 Server IPC

### Base URL and authentication

**Source:** `Services/LlmIdeAPIClient.swift`

`LlmIdeAPIClient` (line 122) is initialized with `baseURL: String` read from `AppConfig.shared.serverURL` (set in `LlmIdeMacApp.init()`, line 59). Every authenticated request sets `Authorization: Bearer <accessToken>` (line 253):

```swift
req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
```

The access token is read from `SessionStore` via a `MainActor.run` hop on every call (line 251) so background concurrent calls always see the latest rotated token.

### URLSession configurations

Two sessions are created in `init()` (lines 152–161):

| Session | Timeout (request / resource) | Used for |
|---|---|---|
| `authSession` | 10 s / 15 s | Paths starting with `/auth/` |
| `llmSession` | 240 s / 600 s (10 min) | All other paths (LLM-backed endpoints) |

Route selection happens in `session(for: path)` (line 384): paths with prefix `/auth/` use `authSession`; everything else uses `llmSession`.

### On-401 refresh-and-retry flow

Implemented in `send(path:method:body:authenticated:isRetry:)` (lines 239–327). When a response is HTTP 401 and `isRetry == false`:

1. Check `store.refreshToken != nil` on MainActor (line 285).
2. Call `store.attemptRefresh(via: self)` (line 287) — this is coalesced in `SessionStore` so N concurrent 401 callers share one `/auth/refresh` request.
3. If refresh succeeds, recursively call `send(...)` with `isRetry: true` (line 289).
4. If refresh fails or `isRetry == true`, throw `APIError.noSession` (line 306) so the UI can route to the login screen.

The same pattern is applied in `postRawBytes(...)` (lines 215–222).

### GET retry + backoff

Only GET requests are retried (comment at line 259 explains why: re-issuing a POST/PUT/DELETE could double-apply a side effect). Up to `maxAttempts = 3` (line 263). Retried on:

- Network errors classified as transient by `isTransient(_:)` (lines 332–341): `NSURLErrorTimedOut`, `NSURLErrorCannotConnectToHost`, `NSURLErrorNetworkConnectionLost`, `NSURLErrorDNSLookupFailed`
- Server status codes 429, 502, 503, 504 (line 296)

Backoff strategy (`backoffNanos`, lines 345–348): `0.4 × 2^(attempt-1)` seconds, capped at 5 s.

`Retry-After` header honoring (`retryAfterNanos`, lines 351–356): delta-seconds form parsed, capped at 10 s.

### Token storage summary

| Token | Storage location |
|---|---|
| Access token | Memory only (`SessionStore.accessToken`, never written to disk) |
| Refresh token | Keychain via `KeychainStore.saveToken(_:host:)` (account: `"<host>::refresh_token"`) |

### The `pendingTool` → `toolResult` flow (Code Assistant)

**Sources:** `Views/CodeAssistantPanel.swift`, `Services/API/LlmIdeAPIClient+CodeAssist.swift`, `Agent/Models/AgentTypes.swift`

The Code Assistant sends a `POST /code-assist` request and receives a `CodeAssistResponse` (defined in `LlmIdeAPIClient+CodeAssist.swift`, lines 52–61). The response carries an optional `pendingTool: PendingTool?`.

`PendingTool` (`Agent/Models/AgentTypes.swift`, line 40) has:
- `name: String` — the tool name (e.g. `"update-file"`, `"create-gitlab-issue"`, `"comment-issue"`, `"trigger-review-code"`)
- `arguments: AnyArguments` — raw JSON payload stored as `Data`, decoded lazily into typed structs via accessor properties (`updateFileArgs`, `createIssueArgs`, etc.)

**Flow for `update-file` (the file-edit path):**

1. `api.codeAssist(...)` returns a response; `self.pendingTool = resp.pendingTool` is set at `CodeAssistantPanel.swift` line 1534.
2. **Auto mode** (`editMode == .auto`): `confirmUpdateFile(args, finalContent: args.content)` is called immediately (line 1542–1543), bypassing the sheet.
3. **Manual mode**: A `PendingActionCard` is rendered in the chat bubble (line 625). When the user taps the card, `showingUpdateFileSheet = true` is set (line 632), presenting `UpdateFileSheet` as a `.sheet` (lines 304–356).
4. `UpdateFileSheet` shows the original content alongside the proposed content (a diff view). The user can edit the proposed content before confirming.
5. On confirm, `confirmUpdateFile(_:finalContent:)` (line 1625) is called: it validates the path against the `attachments` list (only files the user has attached can be written — defence in depth), writes the file to disk with `String.write(to:atomically:encoding:)`, refreshes the in-memory attachment, appends a synthetic `(applied update to <file>: ±N lines)` user turn to history, and calls `sendFollowup()` (line 1659).
6. `sendFollowup()` (line 1685) POSTs another `POST /code-assist` with `message: "(continue)"` and the updated history so the agent can acknowledge in natural language.
7. `pendingTool` is set to `nil` (line 1645) after write; if the follow-up response contains another `pendingTool`, the cycle repeats.

**Other tool names** follow the same card → sheet → confirm → synthetic-turn → follow-up pattern:
- `"create-gitlab-issue"` / `"create-github-issue"` → `CreateIssueSheet` → calls `GitLabClient` or `GitHubClient` → synthetic `(executed create-issue → #N ...)` turn
- `"comment-issue"` → `CommentIssueSheet` → calls `client.createNote(...)`
- `"trigger-review-code"` → `TriggerReviewCodeSheet`

There is no separate `/code-assist/tool-result` endpoint. The tool result is communicated back to the server by appending a synthetic acknowledgement turn to `history` and making a fresh `POST /code-assist` call. The server sees the outcome in the conversation history.

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
| `GET /health` | Backend health probe (used by `BackendManager`) |
