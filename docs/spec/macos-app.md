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
| graph-kit (`GraphKit` + `GraphCore`) | `.package(url: "https://github.com/dnsmalla/graph-kit.git", revision: …)` — a **remote** dependency pinned by commit in `Package.swift`, so SwiftPM fetches and caches it and the build does **not** depend on the submodule at `mac/LocalPackages/graph-kit` being checked out. That submodule still exists (same repo, same commit) as the working tree for editing the engine and running its labs. Two pins to keep in step when bumping the engine: the `revision:` here and the submodule gitlink. The repo is public — a cold resolve needs only network access, no credentials. `make regression`'s `graph-gates` still runs from the submodule (guarded by the `graph-kit-checkout` target) |

**Bundled resources** (lines 28–35): `note_template.docx`, `generate_meeting_note.py`, vendored highlight.js v11.9.0 (`highlight.min.js`), and two highlight.js themes (`atom-one-dark.min.css`, `atom-one-light.min.css`).

**Not bundled — mermaid (on-demand optional component).** mermaid.js (3.4 MB), which draws ```` ```mermaid ```` fences in the markdown previews that opt in (`MarkdownWebView(enableMermaid: true)`: Library/Explorer/Search/Review file preview, plan editor, Doc Gen/Visual), is no longer shipped in the app: `Package.swift` declares no `Resources/mermaid` and `Scripts/build.sh` rsyncs Resources with `--exclude '/mermaid/'`.

- **Install trigger:** user action only — the `MermaidInstallBanner` over a preview whose document contains a mermaid fence, or Settings → Optional components. No automatic download (local-first; works offline). Until installed, fences render as ordinary code blocks (`renderMermaid` guards on `window.mermaid`).
- **Source:** `https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js` — exact version, never a range.
- **Integrity:** the body must hash to the SHA-256 pinned in `Core/Editor/Mermaid.swift` (`581ed7d7…390eb8`, identical to the file previously vendored). A mismatch writes nothing. The loader (`MermaidScriptCache`) re-hashes whatever it reads from disk before handing it to a web view, so a file altered after install is ignored. Download capped at 16 MB.
- **Storage:** `~/Library/Application Support/llm-ide/runtime/mermaid/<version>/mermaid.min.js`, written atomically (temp file + rename); installing a new version prunes the others; Settings → Remove deletes `runtime/mermaid/`.
- **State:** `MermaidRuntime.shared` (`@MainActor`, `notInstalled / downloading / installed / failed`); `MarkdownWebView` observes it and reloads when it flips, so an open preview draws its diagrams right after install.
- **Pin bump:** `Scripts/mermaid-pin.mjs <version>` checks the CDN file against the npm tarball and prints `version` / `sha256` / `byteCount`. `chat-contract-lab` asserts the integrity check, path layout, pinned URL shape, the not-installed fallback, the chunked download reader (every byte kept, progress per 64 KB chunk, 16 MB cap) and that the installed copy is the loader's only candidate (the old in-bundle lookups are gone — a stale dev `.build` bundle used to keep serving mermaid after Remove). The installed path is resolved once per process, so a render with mermaid not installed costs one failed file read.

**Release bundle: stripped executable, dSYM beside it.** `Scripts/build.sh` copies `swift build -c release`'s `LlmIdeMac` into `Contents/MacOS/`, adds the Sparkle rpath, then, still before `sign.sh`:

1. `xcrun dsymutil <scratch>/release/LlmIdeMac -o <APP_DIR>.dSYM` reads the **unstripped** binary in the SwiftPM scratch dir and writes the dSYM beside the bundle (default `mac/LlmIdeMac.app.dSYM`). It is never inside the `.app`, so it is not sealed by the signature, not in the DMG and not installed.
2. `xcrun strip -S -x Contents/MacOS/LlmIdeMac` removes debug stabs and local symbols and keeps exported ones. That is the only binary stripped: Sparkle's framework, `Autoupdate`, `Updater.app` and XPC services are third-party and already signed.

Stripping must come before signing, because `strip` rewrites the Mach-O and so invalidates any signature already on it. `strip` and `install_name_tool` keep `LC_UUID`, so the bundled executable and the dSYM have the same UUID. Nothing at runtime reads local symbol names: Swift reflection uses the `__swift5_*` metadata sections, dyld uses exported symbols, and the app never `dlsym`s into itself. The one cost is that the uncaught-exception crash file (`NSException.callStackSymbols`, `installCrashHandlers` in `Shell/LlmIdeMacApp.swift`) names only the nearest exported symbol for the app's own frames, so that file also records the image's path, arch, `LC_UUID` and load address (`Shell/CrashBinaryImage.swift`, computed once at handler install from `#dsohandle`): enough to pick the matching dSYM and run `atos -o <dSYM>/Contents/Resources/DWARF/LlmIdeMac -arch <arch> -l <load address> <frame address>`. Signal crash files carry no stack in either case. The system `.ips` report plus the dSYM symbolicates fully.

`LLMIDE_SKIP_STRIP=1` leaves the symbol table in; the dSYM is still written. If `dsymutil` fails, the build warns and does not strip. The old `<APP_DIR>.dSYM` is deleted together with the old bundle at the start of a build, so a dSYM that does not match the binary is never left behind.

**Governed source areas** under `mac/Sources/LlmIdeMac/`:

- `Shell/` — composition root: app entry (`LlmIdeMacApp.swift`), `AppShell`, `FeatureCatalog`, login/recovery/welcome screens, and `Chrome/` (status bar, toolbar, activity bell)
- `Features/<Name>/` — one folder per build-excludable unit (`Models/`, `Services/`, `Views/`); a unit may hold several sections as sub-folders when one `LLMIDE_FEATURES` key excludes them together and they reference each other (`Generation/` holds `DocGen/` + `Visual/`, `Issues/` holds `Gantt/`); a feature never references another feature, which is what lets the build-excludable ones be compiled out
- `Core/` — leaf infrastructure every layer may use: `Contracts/`, `DesignSystem/` (incl. the section chrome features render: `SectionChromeBar`/`SectionToggle`, `PanelSectionTabs`, `WindowHeightKey`), `Editor/`, `FeatureToggles/` (`AppFeature`, `ProfilePreset`, `FeatureRegistry`, `AppModule`, `FeatureService`), `Generation/`, `Incidents/`, `Memory/`, `Networking/`, `Platform/` (incl. `ShellState`, `TerminalPanelState`), `Project/`, `Repo/` (the Loop's verify/repair machinery — `RegressionRunner`, `ShellFaultVerifier`, `RepairScopeGuard`, `VerifyApprovalStore` — lives in `Features/Loop/`, not Core)
- `ClaudeLink/` — Claude SDK/CLI glue, counted as Core
- `Resources/` — bundled assets

The folder → layer map is `mac/Scripts/feature-map.txt`, and `mac/Scripts/feature-boundaries.sh` checks it (see "Build-time feature selection" below).

Every feature is marked `sealed` in that map (CodeGraph, Search, Issues, ReviewConflicts, Terminal, Explorer, SourceControl, Generation, Settings, Chat, Live, Library, AutoTask, Loop, MobileControl), so the gate fails on any reference from one feature to another. The seal covers feature → feature; feature → Shell is enforced for every feature by the gate's check 8 (no `Features/` file may name a type declared under `Shell/`). What features used to ask `FeatureCatalog` for now arrives through Core seams Shell installs at boot: `FeatureRegistry.shared.compiledFeatures` for "is X in this build", `IssueSeamRegistry` (Issues' existing-issue picker + recent issues), `ProjectMemoryRegistry` (Explorer's memory viewer) and `TerminalPanelRegistry` (the Terminal dock Explorer embeds) — installed by `FeatureCatalog.installFeatureSeams()` only when their owner is compiled in, so a compiled-out owner leaves the `EmptyView` / `[]` fallback — and the `loopRunnerProvider` / `pushStateToMobile` properties Shell sets on `AutoCodeUpdateService`. Features that show the chat beside their content (Explorer, Review Conflicts, Doc Gen, Visual) embed it as `ChatPanelView(request: ChatPanelRequest(…))` and open the Quick Fix / guided code-change sheets as `CodeWorkflowSheetView` — Core seams in `Core/Contracts/ChatPanelProviding.swift` that Shell fills with Chat's `CodeAssistantPanel` / `CodeWorkflowSheet` / `QuickFixSheet` at boot (`FeatureCatalog.installChatSeams()`). Generation's "Save chat output" reads the latest finished reply through `ChatOutputRegistry` (`Core/Contracts/ChatOutputProviding.swift`), never `ChatEngine`. Library's meeting detail wraps its content in `LiveCaptureGate` (`Core/Contracts/LiveCaptureProviding.swift`); Shell installs Live's `LiveCaptureGateView` at boot (`FeatureCatalog.installLiveSeams()`), which shows the recording banner + live transcript while a capture runs or its post-stop banner is up, and the meeting detail otherwise. The meeting file store and summarization pipeline both features use (`MeetingFileStore`, `PartialRecovery`, `MeetingSummarizationService`, …) live in `Core/Notes/Services/`, and the "Add from Library" sheet (`LibraryPicker`) in `Core/DesignSystem/`.

---

## §2 App lifecycle

### Entry point and scene shape

**Source:** `mac/Sources/LlmIdeMac/Shell/LlmIdeMacApp.swift`

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
| `featureRebuild` | `FeatureRebuildService` | Apply & Rebuild orchestration (stage → confirm → swap-and-relaunch); see "Apply & Rebuild" below |

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

**Source:** `mac/Sources/LlmIdeMac/Shell/ContentView.swift`

`ContentView` (line 5) switches on `session.bootstrapping` and `session.isAuthenticated`:

- While bootstrapping → `ProgressView("Connecting…")`
- Not authenticated → `LoginView(api: api)`
- Authenticated → `AppShell(api: api)`

**Source:** `mac/Sources/LlmIdeMac/Shell/AppShell.swift`

`AppShell` is the authenticated shell. It renders `WelcomeView` when `projectStore.activeProject == nil` (lines 39–40), and the full section layout when a project is active. The section layout is driven by `ShellState.section` (an `@Observable` object, `mac/Sources/LlmIdeMac/Core/Platform/ShellState.swift` — Core, so features can read it without naming Shell). `ShellState` is created once at the `AppShell` root and injected via `.environment(shell)`, so it has **app-session scope**: it survives section navigation (which tears the section views down and recreates them) and is reset only when the app relaunches. UI state that must outlive a section switch lives here rather than as the section view's `@State` — e.g. `ShellState.exploreChatVisible` keeps the Explorer's chat panel open across navigation (it would otherwise reset to closed every time `ExplorerView` is rebuilt), while still starting closed on a fresh launch.

**Sections** (`ShellSection`, declared in `Core/Contracts/ShellSection.swift` so Core code can name a section; `ShellState.Section` is kept as a typealias, and the feature-runtime/presentation members `backingFeature`, `resolveHome` and `tint(_:)` live in `Core/Platform/ShellState.swift` so the contract file stays Foundation-only):

`library`, `live`, `explorer`, `search`, `conflicts`, `sourceControl`, `issues`, `gantt`, `visual`, `docGen`, `autoCode`, `codeGraph`, `loopEngine`, `settings`

The Library section gets a 3-column layout (sidebar | list | detail). All other sections use a 2-column layout (AppShell sidebar rail | content). A `TerminalPanelView` docks at the bottom of the content area for most sections. `ShellState.section` defaults to `.explorer`, so a fresh launch lands on the Explorer. The "tool" sections render as named buttons (`ToolbarToolButton`) in a `ToolbarItemGroup` inside the unified title bar (AppKit collapses overflow into the native `»` menu); `explorer`, `sourceControl`, and `search` are instead a panel-header switcher (`PanelSectionTabs`) shown in those three sections' headers, Cursor-style.

### Build-time feature selection

The app's lifecycle can exclude features at compile time via `LLMIDE_FEATURES` environment variable, reducing binary size and startup overhead for non-engineers. `Package.swift` reads `LLMIDE_FEATURES` (comma-separated feature names; unset defaults to all enabled) via `ProcessInfo` and appends excluded features' source folders to the `LlmIdeMacLib` target's `exclude:` list, while defining `.define("FEATURE_<NAME>")` for each included feature. **`#if FEATURE_*` conditionals appear in exactly two always-compiled files: `Shell/FeatureCatalog.swift`**, which registers compiled-in feature modules, exposes their view factories, and registers each compiled-in feature's Settings cards into `Core/Contracts/SettingsSectionRegistry` (`registerSettingsSections`; Settings renders slots and never names a feature, so a compiled-out feature's slot is simply empty), **and `Core/Contracts/LoopRunning.swift`**, whose `run(config:…)` requirement names the Loop-owned `LoopEngineConfig` and is therefore deliberately wrapped in `#if FEATURE_AUTOTASK` (the one flag that excludes `Features/Loop` and `Features/AutoTask` together). All other code accesses features through catalog-provided protocols or notifications, decoupling the main codebase from feature presence. `code_graph_3d`, `gantt_issues` and `doc_gen` require `file_explorer` (`AppFeature.requiredDependencies`); `Package.swift` applies that dependency closure itself, so a hand-typed `LLMIDE_FEATURES` without `file_explorer` drops those three as well instead of compiling in features the app would then refuse to enable. A feature compiled out still gets a row in Settings → Workspace, but shows "Not installed" in place of its toggle.

Seven features are excludable at build time:

- **`codeGraph3D`** — Code graph layout, rendering, memory/Q&A stores (Phase 2a)
- **`fileExplorer`** — File navigator, source control view, search; omits help topics for search and source control (Phase 2b)
- **`ganttIssues`** — Issues board and Gantt timeline (Phase 2b)
- **`docGen`** — Document generator view (Phase 2b)
- **`terminal`** — Terminal panel and **drops the SwiftTerm product dependency** (Phase 2b, independent of Explorer)
- **`autoTasks`** — Automated code generation, Loop Engine verification-and-repair, task scheduling; when excluded, `AutoCaptureService` does not auto-arm on launch (manual capture remains unaffected), and `.loopEngine` is hidden from ShellState sections (Phase 2c). This is no longer only a compile-time exclusion: the RUNTIME toggle (Settings → Workspace, Auto Tasks off while still compiled in) now also hides the Loop page, since `AppShell`'s toolbar filter and `PanelSectionTabs` both check `.loopEngine`'s `backingFeature` (`.autoTasks`) against `FeatureRegistry.isEnabled(_:)`, not just `compiledFeatures` — previously the Loop page stayed reachable with Auto Tasks toggled off at runtime (Phase 2c final-review fix)
- **`mobileSync`** — iPhone companion chat, explorer sessions, auto-tasks control, and Loop engine control via WebSocket on :3006 (Bonjour + PIN pairing). Excludes the single folder `Features/MobileControl/` (manager, WebSocket server, Bonjour, PIN pairing, phone bridges, and its settings section) and gates out the `SharedProtocol` product dependency (used only by the mobile unit). The phone's Auto Task and Loop bridges are not part of that folder: `MobileAutoTaskBridge` lives in `Features/AutoTask/Services/` and `MobileLoopBridge` in `Features/Loop/Services/`, so `auto_tasks`'s own folder exclude removes them, and neither needs a per-file exclude in any feature combination. They reach the manager only through `Core/Contracts/MobileBridgeHosting.swift` (which `MobileControlManager` conforms to in `MobileControlManager+BridgeHost.swift`) and never import `SharedProtocol`: the host decodes inbound frames into the Foundation-only `MobileAutoTaskRequest` / `MobileLoopRequest` and encodes `MobileAutoTaskReply` / `MobileLoopReply` into wire types, so a build with `auto_tasks` on and `mobile_sync` off compiles them with no `SharedProtocol` linked. The Loop bridge drives AutoTask's loop lane through `Core/Contracts/LoopLaneControlling.swift`. Only `Shell/FeatureCatalog.swift`'s `wireMobileFeatureBridges()`, under `#if FEATURE_AUTOTASK && FEATURE_MOBILE`, constructs them. Phone chat (quick chat and Explorer chats, Explorer session list/load/new/rename/delete, and parked-approval relay) reaches Chat the same way, through `Core/Contracts/MobileChatHosting.swift`: Chat's `ChatMobileHost` (`Features/Chat/Services/`) implements it, owns the phone's off-screen Explorer engine pool (`ExplorerMobileEngineResolver`, also in Chat), and makes `ChatEngine` a `MobileChatTurnEngine`; `bootMobile` sets `manager.chatHost`. With no host installed the manager answers chat requests "Chat not installed". The `MobileFeatureBridge` protocol stays core to support dynamic downgrades when AutoTask/LoopEngine are compiled out (Phase 2d)

A "lite" non-engineer build (the `LLMIDE_FEATURES=agent_chat,auto_tasks,mobile_sync` preset used by `make build-mac-lite`) excludes codeGraph3D, fileExplorer, ganttIssues, docGen, and terminal, leaving only Agent Chat, Auto Tasks, Mobile Sync, Live Capture, and Library. A "minimum" build (the `LLMIDE_FEATURES=agent_chat` preset used by `make build-mac-min`) excludes all seven excludable features, leaving only Agent Chat, Live Capture, and Library.

When AutoTask/LoopEngine is compiled out, the `MobileControlManager` invokes a `replyFeatureUnavailable` path to degrade phone requests for auto-tasks and loop operations to an explicit "not installed" acknowledgement (via `MobileFeatureBridge` protocol seam). A lite or minimum install is not durable across dev rebuilds: a later full `swift build` run overwrites it with the all-features default, since nothing records the feature selection outside that one build's Info.plist.

**Mechanism notes:** `WindowHeightKey` (Terminal Panel content height broadcasting, `Core/DesignSystem/WindowHeightKey.swift`) lives in always-compiled Core rather than in `Features/Terminal/` so AppShell can publish window sizing unconditionally — the `.preference(key: WindowHeightKey.self, …)` call in AppShell has no terminal gate. The Terminal Panel itself is *not* always mounted: `TerminalPanelView` renders only while `state.isOpen` or a session is still alive (`dock.sessions` non-empty), and only where AppShell/ExplorerView choose to place it when the Terminal feature is enabled; once mounted it collapses to zero height (rather than unmounting) while `state.isOpen` is false but a session persists, which is what keeps PTYs and scrollback alive across toggle cycles. The terminal session state (`activeDockTab`, `sessions`, `activeIndex`, `nextTabNumber`) moved into a feature-owned store (`Features/Terminal/Views/TerminalDockSessions.swift`), while the core panel state (`TerminalPanelState`, responsible for isOpen/height tracking and a FeatureCatalog-wired onToggleRequested hook) lives in `Core/Platform/TerminalPanelState.swift` — always compiled, and Core so features other than Terminal may name it.

**Gate:** `mac/Scripts/feature-boundaries.sh` (run by `make regression`) fails the build when any always-compiled layer (Shell, Core, ClaudeLink, Chat, Library, Live, Settings, ReviewConflicts) references a symbol owned by an excludable feature without the matching `#if FEATURE_*` guard, when a `libExcludes` or `testExcludes` path does not exist, when (check 6) a test file references an excludable feature's top-level type without being in that feature's `testExcludes`, and when (check 7) a `Core`-layer file (`Core/`, `ClaudeLink/`) names a top-level type declared under `Shell/` or `Features/` (one allowlisted `#if FEATURE_AUTOTASK` seam; stale allowlist rows fail too), and when (check 8) a `Features/` file names a top-level type declared under `Shell/` (empty allowlist, same stale-row rule). The test target is only compiled with every feature in, so check 6 is what keeps `swift build --build-tests` under a reduced `LLMIDE_FEATURES` from breaking unnoticed.

When building with a subset of features, pass `--manifest-cache none` to `swift build` to avoid manifest caching stale includes (this is automatic in `make build-mac-lite` for convenience; a bare `swift build` builds the full app with all features enabled, unless `LLMIDE_FEATURES` is already exported in the shell — in which case it picks up that selection too, so use an unset/empty shell for a guaranteed full build).

### Apply & Rebuild (Settings → Workspace)

`FeatureRebuildService` (`Features/Settings/Services/FeatureRebuildService.swift`) drives an in-place, feature-selected rebuild of the running app from Settings, without a terminal. It is core chrome — never registered with `FeatureRegistry`, always constructed (`@StateObject private var featureRebuild = FeatureRebuildService()` in `LlmIdeMacApp`).

**Eligibility** (`isEligible`): a `sourceRoot` (this bundle's `Info.plist` carries an `LLMIDESourceRoot` key pointing at a directory with `Package.swift`), an `installTarget` (`Bundle.main.bundleURL` ends in `.app`, not a bare `swift run` executable) must be non-nil, AND the published `toolchainAvailable` flag must be `true`. That flag starts `false` and is set from an async `xcrun --find swift` probe kicked off once from `init` (cached for the instance's lifetime) — the card cannot appear until the probe resolves, so a machine without Xcode command line tools never shows a button it can't honor. **Distributed release builds never qualify**: `Scripts/release.sh` exports `LLMIDE_OMIT_SOURCE_ROOT=1` before calling `build.sh`, which omits the `LLMIDESourceRoot` Info.plist key entirely — no local build machine path ever ships in a release bundle. Dev builds (`build_app.sh`) and staged rebuilds (`rebuild-features.sh`) call `build.sh` without that flag, so they carry it.

The UI (`Features/Settings/Views/FeatureProfileSettingsView.swift`, `BuildRebuildSettingsCard`) renders nothing when `isEligible` is false — no dead button on machines that can't use it. When eligible:

1. **Idle** — "Apply & Rebuild (remove disabled code)" → a confirmation dialog (rebuild-from-source, replaces the app, relaunches, previous version kept as `.bak`) → `startRebuild()`.
2. **`startRebuild()`** runs `mac/Scripts/rebuild-features.sh --features <active-features csv> --stage-dir <Application Support>/rebuild-staging` in a detached `Task` (staging is the script's only mode — it never swaps), streaming stdout/stderr into a 200-line internal buffer whose last 20 lines are published as `logTail`. This calls `build.sh` (release, `LLMIDE_SKIP_KILL=1`) then `sign.sh` into the stage dir; the running app is untouched. As in every `build.sh` run, the staged executable is stripped, and its dSYM is written beside it at `<stage-dir>/LlmIdeMac.app.dSYM`. `rebuild-swap.sh` moves only the `.app`, so the dSYM stays in `rebuild-staging/`, still matching the installed binary, until the next `startRebuild()` wipes that directory. It never reaches the install location.
3. **Building / Swapping** — the card shows a `ProgressView` + the log tail; both phases disable the apply affordance (`.swapping` is the instant between spawning the swap helper and the process actually dying, treated identically to `.building`).
4. **Ready to swap** — "Restart & Install" → `swapAndRelaunch()` spawns `mac/Scripts/rebuild-swap.sh <staged_app> <target_app> <pid>` detached (`nohup`), then `NSApp.terminate(nil)`. The swap script waits for the pid to exit, moves the current `.app` to `<name>.app.bak` (one rollback slot), installs the staged bundle, and relaunches it — logging to `<install-target-minus-.app>.rebuild.log` beside the app bundle.
5. **Failed** — the card shows the log tail and a Retry button, which re-confirms before calling `startRebuild()` again (the confirmation dialog gates every path into `startRebuild()`, not just the first attempt). Failure at any step leaves the running/installed app untouched.

---

## §3 Service taxonomy + key contracts

**Source:** `mac/Sources/LlmIdeMac/Core/` (`Platform/`, `Networking/`, `Project/`, `Repo/Services/`, …) and each `mac/Sources/LlmIdeMac/Features/<Name>/Services/`

### Suffix taxonomy

| Suffix | Role | Examples |
|---|---|---|
| `*Store` | Observable state / data store (publish `@Published` properties) | `SessionStore`, `ProjectStore`, `AgentRunsStore`, `DocTemplateStore`, `GitStatusStore`, `VerifyApprovalStore`, `LibraryItemStore` |
| `*Service` | Logic / side-effect handler (may publish state) | `AutoCaptureService`, `AutoCodeUpdateService`, `CodeWorkflowService`, `FaultPackService`, `PermissionsService`, `SourceControlService`, `SearchService`, `UpdateService` |
| `*Client` | Networking — calls external APIs | `LlmIdeAPIClient` (backend), `GitLabClient`, `GitHubClient` |
| `*Manager` | Lifecycle + process/resource management | `BackendManager`, `RepoManager` |
| `*Mirror` | Live-sync / polling from another source | `LiveSessionMirror` |
| `*Router` | Navigation / deep-link dispatch | `DeepLinkRouter` |

### Feature toggles and lifecycle (`FeatureRegistry`)

The feature runtime (`AppFeature`, `ProfilePreset`, `FeatureRegistry`, the
`AppModule` / `FeatureService` protocols) lives in `Core/FeatureToggles/`, so
features may read it; Shell's `FeatureCatalog` assigns
`FeatureRegistry.compiledFeatures` (from its `#if FEATURE_*` list) and
registers the modules at boot. Until that boot runs, `compiledFeatures`
reads as every feature — Core cannot know the real set — so tests and labs
that care pass it in: `FeatureRegistry(defaults:compiledFeatures:)`. Feature toggles are wired to
`FeatureRegistry.refresh()`: each feature has
an `AppModule` (`AutoTaskModule`, `GraphModule`, `ChatModule`,
`MobileModule`, `PassiveModule` for the view-only four) owning its
services' `start()`/`stop()`. Disabling a feature stops its timers,
watchers, and listeners; presets do the same in bulk. Rule: init is free,
`start()` does the work, `stop()` undoes it, both idempotent. Auth changes
call `refresh()`, so auth-scoped modules (graph, chat mirror) stop on
logout via `runtimeReady`.

**Server side of the feature set.** The runtime feature set (active ∩
compiled, plus `agent_chat` always) also reaches the Node backend: Shell
installs `BackendManager.featureKeysProvider` at boot, and every spawn
(start, restart, auto-restart) writes it into the child's environment as
`LLMIDE_FEATURES` — sorted, comma-separated `AppFeature` raw values, the
same keys and semantics as `mac/Package.swift` (unset/empty → all). An
`LLMIDE_FEATURES` inherited from the app's own environment is always
dropped first, never passed through (`BackendManager.childEnvironment`).
The server does not load a disabled feature's route groups and answers
them with 404 `feature_disabled`. A toggle applies on the **next backend
start** — the app deliberately does not restart the backend when the set
changes, because that would kill in-flight Loop/agent work; Settings →
Workspace says so in its hint. An adopted external server (one already
listening on :3456) keeps whatever environment it was launched with.

### Key service contracts

#### `SessionStore` (`Core/Platform/SessionStore.swift`)

Single source of truth for authentication state. Annotated `@MainActor` so all token reads/writes are actor-isolated (line 19).

- `@Published var user: UserInfo?`, `accessToken: String?`, `refreshToken: String?`, `bootstrapping: Bool` (lines 21–24)
- `var isAuthenticated: Bool` — `accessToken != nil && user != nil` (line 32)
- `bootstrap(api:)` (line 38) — loads the refresh token from Keychain via `KeychainStore.loadToken(host:)`, calls `/auth/refresh`, calls `adopt(session:)` on success or `KeychainStore.deleteToken` on failure
- `adopt(session:)` (line 57) — sets `user`, `accessToken`, `refreshToken`, and calls `KeychainStore.saveToken(_:host:)` to persist the new refresh token
- `attemptRefresh(via:)` (line 79) — coalesced refresh: concurrent 401-retry callers share one in-flight network call via a stored `Task<Bool, Never>`; the task is nilled out once the slot completes

**Token storage split:** The access token lives only in memory (`accessToken` property on `SessionStore`). The refresh token is persisted to the Keychain via `KeychainStore.saveToken(_:host:)` (called from `adopt`, line 61); it survives app restarts.

#### `BackendManager` (`Core/Networking/BackendManager.swift`)

Supervises the local Node `server.mjs` process (`@MainActor @Observable`, lines 18–20).

- `status: Status` — `.stopped | .starting | .running | .crashed(exitCode:)` (lines 24–29)
- `pid: Int32?`, `log: [BackendLogLine]` (lines 32–33)
- `start(nodePath:workingDirectory:)` (line 156) — checks if port 3456 is in use; if so, probes `/health` within 2 s. If healthy, adopts the external server; if not, kills the listener and spawns a fresh process. If the port is free, spawns immediately.
- `spawn(...)` (line 244) — calls `Process.run()`, stays in `.starting` until `/health` responds, then calls `markRunning(...)` (line 361) which flips to `.running`
- Auto-restart: up to 3 attempts with backoffs of 1 s, 5 s, 30 s (`restartBackoffsSec`, line 47); skipped on user-initiated stop (`userInitiatedStop` flag)
- `probeHealthDetail()` (line 517) — 2 s ephemeral URLSession GET to `http://127.0.0.1:3456/health`; also checks `apiVersion` against `minimumServerApiVersion = 43` (line 607). This app-wide floor is deliberately NOT raised for the server's v47 `ask` mode — `Chat/QuickChatContext.swift`'s `serverSupportsAsk`/`requiredServerApiVersion = 47` gates that at the three surfaces that actually send `ask` (`MenuBarChatView`, `LlmChatSheet`, `MobileControlManager`'s `llmide_chat` handler) instead, because `serverVersionTooOld` (below) only ever renders in `LoginView`/`ReconnectView`/`BackendSettingsSection` and never blocks an already-authenticated session from sending one.
- `stop()` (line 425) — SIGTERMs the spawned process; for adopted externals, uses `lsof -ti :<port>` to find and kill the listener

#### `LiveSessionMirror` (`Features/Live/Services/LiveSessionMirror.swift`)

Polls the backend for live caption streams from other clients (e.g., the Chrome extension).

- `@Published var captions: [MirroredCaption]`, `activeSession: LiveSessionInfo?`, `isPolling: Bool` (lines 22–24)
- `start()` / `stop()` (lines 67–80) — controlled by `AppShell` in response to `session.isAuthenticated` changes
- Discovery loop: `GET /kb/live/sessions` every **5 s** (line 60, `discoveryIntervalNs`)
- Caption poll: `GET /kb/live/<sessionId>?since=<seq>` every **1.5 s** while a session is active (line 61, `captionIntervalNs`), slowing to 5 s after finalize (line 62)
- `mergeCaptionInPlace(_:)` (line 159) — deduplicates growing utterances by replacing the most recent same-speaker caption when the new text starts with the old text (within a 10-entry tail window)
- On `finalized == true`: fires `NotificationCenter.default.post(name: .liveSessionFinalized, ...)` (line 244) with a `FinalizedPayload` so `AppShell` can generate a note file automatically

#### `KeychainStore` (`Core/Platform/KeychainStore.swift`)

Namespace enum (no instances) that wraps `SecItem*` calls.

- `saveToken(_:host:)` / `loadToken(host:)` / `deleteToken(host:)` (lines 15–25) — stores the JWT refresh token under account key `"<host>::refresh_token"`, service `"com.llmide.macapp"`
- Also stores GitLab PATs (`"gitlab::<host>::token"`, lines 30–38) and GitHub PATs (`"github::<host>::token"`, lines 47–56)
- `logout()` (line 67) — bulk-deletes all generic-password items under the service ID and clears `gitLabSavedProjects` / `gitHubSavedRepos` from `AppConfig`
- Legacy fallback: `load(account:service:)` tries the old service ID `"com.meetnotes.macapp"` and migrates items forward on first read (lines 104–110)

#### Caption orchestrator (`Features/Live/Services/CaptionScraper.swift`)

`CaptionOrchestrator` (line 49) is the `@StateObject` named `capture` in `LlmIdeMacApp`. It manages the AX-scraper-based local caption capture, driving meeting-app scrapers (Zoom, Teams) and the `CaptionScraper` protocol. `AutoCaptureService` (`Features/Live/Services/AutoCaptureService.swift`, line 9) wraps it, observing `NSWorkspace` activation/termination notifications to auto-start and auto-stop capture when known meeting bundle IDs become frontmost (line 23, `meetingBundleIDs` from `PlatformDetector.allScrapers`).

#### Knowledge-graph automation (`CodeGraph/`)

A per-project knowledge graph + agent memory, built from two tracks and kept current automatically. Project-scoped — every artifact lives under the project, nothing global.

- **`KnowledgeGraphService`** (`CodeGraph/KnowledgeGraphService.swift`, `@MainActor`) runs both tracks and publishes `codeGraph`, `docGraph`, `mergedGraph`, `docChunks`, `docCount`, `docFingerprint`:
  - *Code track* — `CodeNoteService` / `StructureScanner` (incremental scan-cache), written to `system/graph/`.
  - *Doc track* — `GraphKit.MemoryGenerator` over the repo's `.md` / `.txt` docs; recomputed only when a stat-only `docSetFingerprint` changes.
  - `merge(code:doc:chunks:)` unifies the two, adding doc→code cross-links for explicit `[[wikilinks]]`. **Markdown is a doc, not code** ("md is doc"): `FileClassifier.strippingDocNodes` removes the scanner's `.docPage` markdown nodes from the code graph so a doc isn't double-counted in the merged graph. The doc→code citation `references` edges that stripping deletes are kept separately as a citation overlay (`FileClassifier.citationOverlay`, returned by `GraphEngine.scanCodeWithCitations`): the doc FILE nodes that cite code plus their edges into surviving code nodes. Only the backend upload merges it back in (`KnowledgeGraphService.codeGraphForUpload` → `CodeGraphUploadService`, whose fingerprint therefore moves on a doc-only change); every graph view renders the stripped graph, and headings stay stripped everywhere.
  - **Memory index** — `writeMemoryArtifact(...)` writes `<repo>/graphify-out/memory/`: `repo.md` (code summary), `doc-notes.md` (doc summary), `graph-notes.md` (cross-links). This combined index is what the extension agent reads (`extension/graphkit/memory.mjs`).
- **`GraphAutoUpdater`** (`CodeGraph/GraphAutoUpdater.swift`, `@MainActor`) drives the service automatically on three triggers: project open/switch (`.activeProjectChanged`), a 15-minute timer, and a **file watcher** (below) that fires within seconds of an edit. All three funnel through `runIfEligible`, which resolves the repo to graph via **`repoToGraph(projectRoot:)`** — a `code/<repo>` **child git repo** whenever `code/` has children (preferring one already graphed for incremental stability, else the first child alphabetically). It **never graphs the project workspace root when `code/` has children**, even if the root carries a stale graph: the root isn't a git repo and holds the tool's own `system/` output, so scanning it would ingest ~20k generated files. Only a project with no `code/` children falls back to the **root itself** when it directly holds source. **First generation is automatic too** — opening a project with no graph yet generates one (the product's purpose is autonomous knowledge the user only reviews, never hand-triggers); `runIfEligible` is a no-op only for an empty project with nothing to graph. After each run it publishes the graphs into `GraphSessionStore` so the Code Graph view shows the auto-maintained result without re-scanning. Started from `AppShell` via `.task`.
- **`RepoFileWatcher`** (`CodeGraph/RepoFileWatcher.swift`) is a recursive `FSEventStream` on the active graphed repo that fires a **debounced (2 s) incremental regen** via the same `runIfEligible` path — so memory tracks code/docs in seconds rather than waiting for the timer. Events under regen-output dirs (`system/`, `graphify-out/`, `.code-notes/`, `.understand-anything/`) and VCS/build noise (`.git/`, `.build/`, `node_modules/`) are ignored, so a regenerated file can't retrigger the watcher (no feedback loop). Lifecycle is driven from `runIfEligible` (`ensureWatcher`, idempotent), not just `start()`/the project-switch notification — so a project **restored on launch** (which posts no `.activeProjectChanged`) still engages the watcher, since `runIfEligible` reads the live `activeProject` on start and every tick.
- **`FileClassifier`** (`CodeGraph/FileClassifier.swift`) routes files to code vs doc by extension — `MemoryGenerator.supportedExtensions` are docs, and the code-extension set subtracts them so `.md` classifies as a doc.
- **`GraphSessionStore`** (`Features/CodeGraph/Views/GraphSessionStore.swift`, `@MainActor`) caches generated results keyed `repo#mode` (`code` / `data` / `all`) for the view's process lifetime, with a `laidOut` flag (the auto-updater stores raw graphs; the view lays them out on hydrate) and a `docFingerprint` (lets a manual InfiniteBrain re-generate reuse an unchanged doc index).

##### Graph rendering view (2D + 3D)

`UAGraphView` (`Features/CodeGraph/Views/UAGraphView.swift`) is the interactive graph view that hydrates from `GraphSessionStore` and renders the selected `Mode` (`code` / `data` / `all`). It supports two renderers, toggled by a `Picker` bound to `@State private var render3D` (line 135):

- **2D** — `CodeGraphCanvas` over a 2D force layout (`CodeGraph/CGSimulation.swift`, with `QuadTree` Barnes-Hut approximation and `CodeGraphLayout`). Large graphs are pruned by `GraphPrune` (`CodeGraph/GraphPrune.swift`, e.g. `capDegree` at line 24) before layout.
- **3D** — `Graph3DView` (`Features/CodeGraph/Views/Graph3DView.swift`), a SceneKit `NSViewRepresentable`, over the 3D force layout `CGSimulation3D` (GraphCore product, `LocalPackages/graph-kit/Sources/GraphCore/Layout/CGSimulation3D.swift`: `settle` / `positions`). 3D positions are cached per mode in `@State private var positions3DByMode: [Mode: SIMD3<Float>…]` (line 136); the cache is invalidated (`positions3DByMode[mode] = nil`) when the mode changes or the Symbols filter toggles (lines 390, 395), and re-settled lazily via `settle3DIfNeeded()` only while `render3D` is on.
- **Colour legend** — a kind-keyed colour legend (one pill per doc kind, sourced from `CGPalette.swift`) is rendered inline so InfiniteBrain / All / 3D views share a consistent node-colour key.

#### Model usage limits (`AutoCodeUpdateService` + Model & Limits panel)

The Auto Tasks page has a **Model & Limits** item (`AutoTask/Views/AutoCodeView.swift`) whose right pane is `AutoTask/Views/ModelLimitsPanel.swift` — a Claude-Settings-style surface: a per-model usage dashboard (progress bar + `% used` / reset), an inline cap editor (limit, runs/tokens, daily/monthly, switch-at %, enable, reorder) behind a per-row disclosure, an auto-switch status banner, and a provider-scoped API rate-limit card. It auto-refreshes every 30 s while visible (paused during edits) and reads/writes the `/kb/usage/*` routes via `Core/Networking/API/LlmIdeAPIClient+Usage.swift`.

`AutoCodeUpdateService` (`AutoTask/Services/AutoCodeUpdateService.swift`) participates in the global ledger so subscription-CLI usage is counted: before each Auto Task run it calls `GET /kb/usage/resolve` (seeded with the user's default model as `prefer`) and skips the run with a banner when the chain is `paused`; it pins the resolved model on the CLI via `--model` for `claude`/`codex`/`gemini`; and after each run it calls `POST /kb/usage/record`. The `model_fallback` activity kind (`Core/Platform/ActivityStore.swift`, mirrored from the backend `ACTIVITY_KINDS`) surfaces auto-switches in the activity bell.

#### Loop Engine (`LoopEngine/Services/`, `LoopEngine/Models/`)

The agentic verify-and-repair loop. Design rationale + the four-level model: [Loop Engineering](../explanation/loop-engineering.md); do-not-regress rules: [invariants](../explanation/invariants.md).

A project holds SEVERAL independent loops (`Features/Loop/Models/LoopDefinition.swift`), persisted together as a `LoopEngineProjectStore` in `<projectRoot>/system/loop.json`. `LoopStageDetector.defaultLoops` seeds six built-ins, each gated on what applies: **Regression** (fault sweep + a test verify stage), **Test** (the detected test command), **System Check** (llm-ide's per-subsystem checks), **Plan** (structure-index + plan-director skill stages reading `llm-doc/plans/` and writing `llm-doc/loop/plan/`), **Refactoring** (graph-verified; fourteen stages with a runner (sixteen when a lint/typecheck command is detected), planning-only without one, see the Refactoring paragraph below; reads the project's own rules from a generated `RULES.md` before planning/applying/conforming; a batch that cannot be made green is rolled back and marked `blocked` in the plan rather than left in the tree; one run advances several batches, bounded by a configurable **Batches per run** (default 3, 1–10); manual-only via `LoopDefaultLoopKey.manualOnly`, so `scheduledLoops` never includes it; its code-applying stage sees `.revert`/`.stop` as `.warn` (`LoopEngineRunner.effectivePolicy`) and runs at most once per batch) and **Doc Optimization** (doc-structure-index → `llm-doc/loop/docs/INDEX.md`, then doc-writer for the generated, code-cited pages under `llm-doc/loop/docs/`, resolved against the repo root only so the code graph scans and links them; `ProjectScaffolder` does not create `llm-doc/loop/docs` at the project level; it creates `llm-doc/plans` and `llm-doc/loop`). `LoopDefinition.defaultKey` marks a built-in — it cannot be deleted (`ensureDefaultLoops` recreates it) but is fully editable; `runsOnSchedule` opts it in or out of the scheduled Auto Task, and is OPT-IN: every newly created loop starts `false`, and `LoopEngineConfigStore.normalizeScheduleOptIn` switches it off once per project for loops saved under the old default-on behavior (tracked by a per-project UserDefaults flag, so a later opt-in is never reverted). `LoopEngineConfigStore.loops(projectRoot:projectId:gitRoot:)` is the ONE entry point every surface (Loop page, scheduler, phone) resolves a project's loops through, so none of them can disagree about what exists; it also performs the one-shot migration that splits a pre-split project's single aggregate loop into the built-ins, carrying the user's edited commands, `enabled` flags and budgets across. `LoopStageDetector.ensureDefaultStages(in:gitRoot:)` is LOOP-SCOPED — a loop only ever receives the default stages its own `defaultKey` owns, and a user-created loop receives none; the pre-split aggregate overload survives only for the migration's legacy key-stamping pass. `ensureDefaultLoops` also guarantees one EDITABLE loop ("Main Loop") — seeded when the incoming list is empty and preserved when the split empties it, but never re-added afterwards, so deleting your own loop sticks — and never leaves `isPrimary` on a stage-less loop. `AutoCodeUpdateService.runLoopEngineeringSweep` asks Loop's `LoopSweepPlanner` (through `Core/Contracts/LoopSweepPlanning.swift`, injected by `FeatureCatalog.bootAutoTask`) which loops to run, and runs each as its OWN run (own budgets, own journal record, own outcome), one at a time because of the per-git-root guard below — not chained into one pipeline; `onlyLoopId` (the phone's `loop_start` via `runSingleLoop`) and `onlyStageId` (`loop_start_stage`) narrow it to one loop or one stage, both fail-closed on an id that no longer resolves. The phone deliberately starts only the Primary loop, since `buildLoopState` reports on that one alone.

`LoopEngineRunner` (`Features/Loop/Services/LoopEngineRunner.swift`, `@MainActor`) repeats an ordered `[LoopStage]` until every stage passes or a budget stops it. Each iteration re-runs every stage from the top. A process-wide `activeRoots` set, keyed on the symlink-resolved git root, rejects a concurrent run against the same working tree whichever trigger started it (`run` returns `nil`).

Stage kinds (`Features/Loop/Models/LoopStage.swift`) — `artifactCheck` (native, no shell or agent; `check`), `testMap` (native, Test loop only; `testOp` `structure` | `map` | `ledger`, label "Test Map"; see below), `codeGraph` (native, Refactoring loop only; `graphOp` `snapshot` | `verify`; see the Refactoring paragraph), `regressionSweep` (via `RegressionSweepRunning` → `RegressionRunner`), `shellCommand` (via `FaultVerifier`, gated by `VerifyApprovalStore` in a preflight pass before any iteration), and `skill` (a generate step via `LoopSkillExecuting`; preflight also rejects a skill stage with no `skillId` chosen). Per stage: `enabled` (default `true`; a disabled stage is skipped entirely — not run, not preflighted, never gating — the escape hatch for pinned default stages, which cannot be deleted), `severity` (`blocking` | `advisory` — an advisory failure is logged and journalled but never repairs, stalls, or fails the run) and `timeoutSeconds` (override of the runner's 600 s default).

Test loop (`LoopStageDetector`). With a runner the stages are `test-structure` (structure) → `test-setup` (skill `skills/test-structure-setup`, disabled by detection) → `test-structure-check` (structure; fails if Setup ran this run and detection still reports missing) → `test-map` (map) → `test-write` (skill `skills/test-gap-writer`, `testWriteOnly`) → `test` (shell, detected command) → `test-ledger` (ledger) → `test-map-check` (map; fails if Test Write reported changes and `untestedFunctions` did not fall). Without a runner only the first five exist, Setup is enabled, Test Write disabled and the loop is manual-only; `testWriteOnly` exempts the writer from `isManualOnly`, so with a runner the loop is schedulable. Detection also recognises `go.mod` (`go test ./...`) and `Cargo.toml` (`cargo test`); the `test` stage family is at revision 2, a "Test Growth" built-in template mirrors the loop (the older "Test" template is unchanged), and `legacyLoopContract` upgrades saved Test loops' goal and acceptance. Outputs live under `llm-doc/loop/test/` (`TEST-STRUCTURE.{md,json}`, `TEST-MAP.{md,json}`, `ledger.json`), written to the main checkout root in worktree runs. The map reads `<repo>/system/graph/graph.json` and falls back to `source: files`. The ledger stage raises `FaultReport`s tagged `test:<id>` with a `VerifyCommandBuilder` single-test `verify` command, pre-approves only those commands in `VerifyApprovalStore`, and marks a fault `fixed` when its test passes again. The write guards (Test Write creates only under test roots; Test Setup touches only package manifests, test files, `__init__.py` under a tests dir, `pytest.ini`, `pyproject.toml`) revert violations and fail the stage, leaving pre-dirty user edits alone. Journal fields: `LoopStageAttempt.testMapDelta` (`[String: Double]?`) and `newFaults` (`[String]?`). Builds older than this read `.testMap` stages as `.unsupported` and leave them untouched.

Refactoring loop (`LoopStageDetector`, `LoopDefaultLoopKey.refactor`). With a runner the stages are `refactor-structure` (testMap structure) → `refactor-setup` (skill `skills/test-structure-setup`, disabled by detection) → `refactor-structure-check` → `refactor-graph` (codeGraph snapshot; also writes `RULES.md`, a digest of the project's own `CLAUDE.md`/`AGENTS.md`, rule files and linked convention docs, quoted as data, via `RefactorRulesCollector` — written first so it exists even when the graph itself is unavailable) → `refactor-test-map` (map) → `refactor-plan` (skill `skills/refactor-planner`, reads `RULES.md`; every batch states `- Rules:`; a folder/repo-scale plan adds `- Area:` per batch) → `refactor-plan-check` (artifact check: `Files`, `Expect`, `Tests` and `Rules` per `### R<n>` section — every batch, whatever its status, so the planner may backfill `- Rules: none found` on an older `done`/`skipped`/`blocked` batch, the one edit it may make to a non-`todo` batch — and no other heading starting with `### R`) → `refactor-test-write` (skill `skills/test-gap-writer` in batch mode, reading `llm-doc/loop/refactor/NEXT-BATCH.md`, which the runner writes from the first `todo` batch; passes as skipped when no batch is `todo`) → `refactor-test-baseline` (test command, `allowsRepair` false) → `refactor-check-baseline` (detected lint/typecheck command, `allowsRepair` false; only when one is detected — a red baseline ends the run rather than repairing pre-existing breakage) → `refactor-apply` (skill `skills/refactor-apply`, reads `RULES.md`, at most once per batch) → `refactor-conform` (skill `skills/refactor-conform`, optional — skipped with a warning when the central skill is not installed; fixes non-mechanical `RULES.md` violations in the batch's own files, writing `RULE-REVIEW.md`) → `refactor-check` (detected lint/typecheck command, repairable; only when one is detected) → `refactor-test` → `refactor-ledger` (ledger) → `refactor-graph-check` (codeGraph verify). Without a runner only the first seven planning stages exist, Setup is enabled and the loop is manual-only. Plan rows are `### R<n> <title>  (status: todo|done|skipped|blocked)` with `- Files:`, `- Symbols:`, `- Tests:`, `- Intent:`, `- Risk:`, `- Rules:`, `- Expect: <counter> <before> → <after>`, an optional `- Note:`, and, on a rolled-back batch, `- Blocked: <stage> — <reason>`. Saved Refactoring loops upgrade in place: missing stages are inserted in run order, a user's edited test command survives, the stage revisions are 4 for plan and apply and 2 for test, and the goal and acceptance are replaced unless the user edited them. The graph snapshot and verify reach CodeGraph through the `GraphRescanning` protocol in `Core/Contracts/` (optional; without a rescanner the snapshot reads the existing `graph.json`, and logs and passes only when none loads; with a busy or unavailable rescan it uses the existing file with a warning). Outputs live under `llm-doc/loop/refactor/`: `REFACTOR.md`, `REFACTOR-DONE.md` (done/skipped/blocked batches archived once the plan nears 250 lines), `RULES.md`, `RULE-REVIEW.md`, `NEXT-BATCH.md`, `GRAPH.md`, `graph/before.json` (snapshot), `graph/after.json` and `GRAPH-DELTA.md` (verify); they are written to the main checkout root in worktree runs. The graph is `graph.json` version 1.1, which adds file-level `calls` (`{from, to, symbol}`), `summary.totalCalls` and `files[].role`; it is a strict superset of 1.0. Journal fields: `LoopStageAttempt.batchId` and `graphDelta`.

A batch that ends unsuccessfully once it has STARTED — from `refactor-test-write` on, before `refactor-apply` has run as well as after: a repairable stage gives up, `refactor-graph-check` fails, a baseline is red, or the run otherwise terminates, but not a user Stop or a pending approval — is rolled back: every path that batch's own stages touched (never the whole tree; a move counts as both its old and its new path) is restored to its pre-batch content, worktree only. The restore fails closed — nothing touched, the tree left for review — when a probe fails or the batch changed a `.gitignore` (a file it un-ignored would otherwise be deleted for good), and it never deletes through a symlinked directory. The batch's header is then rewritten `(status: blocked)` with a `- Blocked:` line, unless the ending says nothing about the batch — a red non-repairable baseline (`refactor-test-baseline`/`refactor-check-baseline`) or a plain agent/transport/command `.error` — in which case a restored batch goes back to `(status: todo)` and is retried as-is next run (a give-up, a scope violation and a Graph Check failure stay `blocked`, as does any batch whose tree could not be restored). A `blocked` batch is never retried as-is; the planner appends a smaller batch that removes the blocker first (`- Replaces: R<n>`). When a repaired stage passes mid-batch, the batch restarts at `refactor-test-write`, and the baselines before `refactor-apply` are not re-run once it has applied (they measured the tree before the batch). **Batches per run** (a stepper beside the loop's other budgets, default 3, range 1–10) lets one run advance several `todo` batches: after a batch's graph check passes, the runner resets the per-batch iteration/repair state and jumps straight to that batch's `refactor-test-write` (the planning stages do not re-run); the run succeeds once at least one batch is verified, even if a later batch in the same run rolled back.

Progress + repair:

- `StageOutputParser` (`Features/Loop/Services/StageOutputParser.swift`) extracts a failing-test count from XCTest, swift-testing, `node --test`, pytest, jest, and `go test`; `nil` for unrecognised output.
- `ProgressWatch` (`Features/Loop/Models/ProgressWatch.swift`) is the single per-stage stall detector: a strictly decreasing score resets the streak, equal-or-worse increments it, and a missing score falls back to normalised output-hash equality (the pre-scoring behaviour).
- `AgentLoopStageRepairer` (`Features/Loop/Services/LoopStageRepairer.swift`) receives that delta as `RepairEvidence` and quotes it back to the agent, over the `api.codeAssist` transport with the full chat model.

`RepairScopeGuard` (`Features/Loop/Services/Verification/RepairScopeGuard.swift`) snapshots `git status --porcelain --untracked-files=all` around every repair and skill stage and compares newly-dirty paths against `GitRepairScopeGuard.defaultProtectedGlobs` (tests, build/verify config, `system/`) plus `LoopEngineConfig.extraProtectedGlobs`. `ProtectedPathPolicy` is `revert` (default) | `stop` | `warn` | `off`; under `revert`/`stop` the run terminates as `.blocked(.repairOutOfScope)` and the stage is never re-verified. The Auto Task regression sweep's fault repairs run inside `ProtectedPathRepairGuard` (`Features/Loop/Services/Verification/`, default globs, `revert`); `RegressionRunner` never repairs without a guard (`.repairSkipped`).

Budgets (`Features/Loop/Models/LoopEngineConfig.swift`, persisted per loop inside `system/loop.json`): `maxIterations` (10), `consecutiveFailureStop` (2), `maxRepairsPerStage` (3), and `wallClockBudgetSeconds` (**default `nil` = no limit**; when the user sets one in Settings → Loop it is checked between iterations and skipped on the first). The time budget defaulted to 3600 and was removed as a default because spending an hour is not itself a failure — the run was progressing, and abandoning it at the hour mark discarded the work and reported `.wallClockExceeded`, which reads like a fault when nothing faulted. The remaining budgets bound the loop by **progress**, which is the property worth bounding. A paused run keeps the per-git-root `LoopRunQueue` lock, so `pauseTimeoutSeconds` (default 1800, `0` = unlimited; non-optional with a decode fallback) auto-aborts a pause not resumed in time — `waitWhilePaused` returns `.timedOut` at the next stage boundary hold, the run ends `.aborted` with a "Pause timed out" log line, and the `defer` releases the lock and clears `pausedRootKeys`. Per-stage `timeoutSeconds` is likewise `nil` by default (the runner's fallback `stageTimeout` is `0` = unlimited, and `ShellFaultVerifier` treats `<= 0` as unbounded), and the built-in templates ship no stage timeouts. Terminal statuses are enumerated by `Core/Contracts/LoopEngineStatus.swift`, whose `summary` (human) and `code` (stable, for journal grouping) are the single source of truth for every caller.

Visibility: `.loopEngine` is in `ShellState.Section.userHideable`, so its top-bar button is toggleable from Settings → Menu Bar (`Views/Settings/SidebarVisibilitySection.swift`). Hiding removes the button only — the `.openSection` handler in `AppShell` sets the section directly and does not consult `config.hiddenSidebarSections`, which is what keeps Settings → Loop's Open Loop button, the menu-bar status rows and the chat command working. `redirectIfSectionHidden` still bounces to `.library` if the *current* section becomes hidden.

Naming: the section's `label` is **"Loop"**; the `Section.loopEngine` rawValue and `AutoTask.loopEngineering` rawValue are unchanged because both are persisted (deep links, activity rows, `taskErrors`, Auto Task toggles).

Persistence: the contract is `<projectRoot>/system/loop.json` via `LoopEngineConfigStore` (`Features/Loop/Models/LoopEngineConfigStore.swift`) — committed, pretty-printed + sorted keys, file-first with a one-time migration from the legacy `loopEngineConfig_<projectId>` UserDefaults entry (which `save` no longer writes). `system/loop-runs/` is in `ProjectScaffolder`'s managed `.gitignore` block plus its `managedGitignoreUpgrades` retro-fit list. Approvals (`VerifyApprovalStore`) and `LoopEngineDefaults` stay per-machine in UserDefaults.

Defaults: `LoopEngineDefaults` (`Features/Loop/Models/LoopEngineDefaults.swift`) stores a stage-less `LoopEngineConfig` under one app-wide UserDefaults key as the values a project inherits the first time its config is created; edited by `Views/Settings/LoopSettingsSection.swift`. All three fresh-config sites call `newConfig(stages:)`.

Templates: `LoopTemplate` (`Features/Loop/Models/LoopTemplate.swift`) is a named `LoopEngineConfig` — four built-in starters (Test & Fix, Full Verify, Skill Loop, Docs Refresh) with stable UUIDs, whose test stage carries the `detectedTestCommand` sentinel that `applied(to:)` resolves via `LoopStageDetector.detectTestCommand` (dropping the stage when nothing is detected). `applied(to:)` regenerates every stage id, since ids key `VerifyApprovalStore`. `LoopTemplateStore` (`Features/Loop/Services/LoopTemplateStore.swift`, `@MainActor @Published`) holds built-ins plus the user's saved recipes under one app-wide UserDefaults key — not per-project, unlike `LoopEngineConfig`.

Journal: `FileLoopRunJournal` (`Features/Loop/Services/LoopRunJournal.swift`) writes `<projectRoot>/system/loop-runs/<yyyy-MM>/<runId>.json` plus an append-only `index.jsonl`, alongside the `system/faults/` tree `RegressionRunner` already owns. Writes are fail-open; every exit from `run` journals. Surfaced as "Past runs" in `Features/Loop/Views/LoopEngineView.swift`.

Summary note (opt-in, `LoopEngineConfig.writeSummaryNote`): `NoteLoopRunSummaryWriter` (`Features/Loop/Services/LoopRunSummaryWriter.swift`) renders a markdown run summary — outcome, pipeline, per-stage table, files changed, protected-path violations — and saves it through `NoteService` under the `loop` note type, i.e. `llm-doc/loop/<yyyy>/<MM>/`. Returns `LoopSummaryNoteResult`; fail-open, and written after the journal.

UI: `Features/Loop/Views/LoopEngineView.swift` owns the three-pane shell and all `@State`; the detail pane's sections (Overview, Template, Selected stage, Settings, Output) live in `Features/Loop/Views/LoopEngineView+DetailPane.swift` as computed views, which is why the shared state members are internal rather than private — the same split as `CodeAssistantPanel` / `CodeAssistantPanel+Session.swift`.

Triggers, all sharing one config per project: `manual` (`Features/Loop/Views/LoopEngineView.swift`) and `autoTask` (`AutoTask/Services/AutoCodeUpdateService+PipelineTasks.swift`). `LoopRunTrigger.chat` is historical — the Code Assistant chat header used to carry a Run Loop button; it was removed, and the enum case survives only so journal records written by earlier builds still decode.

---

## §4 Server IPC

### Base URL and authentication

**Source:** `Core/Networking/LlmIdeAPIClient.swift`

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

The `llmSession` has **no wall clock**: both `timeoutIntervalForRequest` and `timeoutIntervalForResource` are set to 30 days (`LlmIdeAPIClient.swift`), which is indistinguishable from "none" for any real session while remaining a value URLSession handles normally. They were 620 s / 15 min, sized against server deadlines that no longer exist (see [agent-runtime](agent-runtime.md)); with the server now running a turn to completion, a client-side clock would only cut the socket while the work continued, turning a slow answer into a connection error. Cancellation is the control (the chat Stop button cancels the `URLSessionTask`), and `ResourceGuardService` stops work when the machine is at risk. `authSession` keeps its short 10 s / 15 s timeouts — those are liveness probes for `/auth/*`, not work.

**`ResourceGuardService`** (`Core/Platform/ResourceGuard.swift`) is what stops long-running local work now that no deadline does. It subscribes to `DispatchSource.makeMemoryPressureSource` and stops registered jobs only when macOS reports **`.critical` pressure continuously for 30 s** (`MemoryPressureTracker`, a pure state machine so the sustained rule is unit-testable; a drop below critical clears the episode). It takes **one victim per episode, newest first** — the most recently started job is the likeliest culprit and stopping one may be enough to recover — then re-arms. **CPU load is deliberately not a trigger**: a healthy `swift build` or `npm test` pegs every core, so acting on CPU would kill exactly the work the app exists to run. Registered by `BashService`, `CodeWorkflowService`, `AutoCodeUpdateService+CLI`, `ShellFaultVerifier`, `RepoManager`'s git runner, `PluginGitInstaller`, and `MeetingNoteGenerator`; monitoring starts with the first registration and stops with the last, so an idle app pays nothing.

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

**Sources:** `Chat/Views/Panel/CodeAssistantPanel.swift`, `Core/Networking/API/LlmIdeAPIClient+CodeAssist.swift`, `Core/Platform/AgentTypes.swift`

The Code Assistant sends a `POST /code-assist` request and receives a `CodeAssistResponse` (defined in `LlmIdeAPIClient+CodeAssist.swift`, lines 52–61). The response carries an optional `pendingTool: PendingTool?`.

`PendingTool` (`Core/Platform/AgentTypes.swift`, line 40) has:

- `name: String` — the tool name (e.g. `"update-file"`, `"create-gitlab-issue"`, `"comment-gitlab-issue"`, `"trigger-review-code"`)
- `arguments: AnyArguments` — raw JSON payload stored as `Data`, decoded lazily into typed structs via accessor properties (`updateFileArgs`, `createIssueArgs`, etc.)

**Flow for `update-file` (the file-edit path):**

`update-file` carries **two mutually exclusive edit shapes** (the server's `validateEditShape` guarantees exactly one arrives):

- `content` — a whole-file rewrite. Only emitted when the agent could see the entire file, i.e. the user attached it.
- `old_text` + `new_text` — an anchored replacement of one region that must occur **exactly once** in the file. This is what lets the agent edit a file it located itself (via `find-code`) and read only part of, without the unseen remainder being at risk.

`ProposedEditResolver` (`Features/Chat/Models/ProposedEdit.swift`) is the single place that turns either shape plus a path into a concrete `ProposedEdit { absolutePath, displayPath, original, proposed, source }`. All three consumers — the card's diff preview, the review sheet, and the write — resolve through it, so the change the user is shown is by construction the change that gets written. It refuses: a path that is neither attached nor inside the open project, a path escaping the project root (checked after canonicalisation, so `..` and symlinks can't slip past), an anchor that matches zero times, and an anchor that matches more than once.

1. `api.codeAssist(...)` returns a response; `self.pendingTool = resp.pendingTool` is set in `finishStreamingTurn`.
2. **Auto mode** (`editMode == .auto`): `autoChainPendingAction` resolves the edit and calls `confirmUpdateFile(args, finalContent: edit.proposed)` immediately, bypassing the sheet. A whole-file rewrite of a file the server had to TRUNCATE is exempted (auto-applying it would drop the tail the agent never saw) and falls back to the card; anchored edits are not, since they only touch the matched region.
3. **Review mode**: A `PendingActionCard` is rendered in the chat bubble with an inline **Apply** / **Review diff** / **Skip** row (`PendingActionCard.EditActions`). Apply writes immediately (`applyPendingEdit`); Review diff sets `showingUpdateFileSheet = true`, presenting `UpdateFileSheet`; Skip (`skipPendingEdit`) drops the card AND appends a synthetic "skipped" turn, so the agent learns the write was declined instead of re-proposing it. Apply is disabled when the proposal resolves to no change or doesn't resolve at all — Review still opens and shows why.
4. `UpdateFileSheet` shows the original content alongside the resolved proposed content (a diff view). The user can edit the proposed content before confirming.
5. On confirm, `confirmUpdateFile(_:finalContent:)` re-resolves the target, writes to the **resolved** `absolutePath` (never the LLM-emitted path — a relative path or a basename-fallback match makes them diverge) with `String.write(to:atomically:encoding:)`, retires the attachment chip if the target was an attachment, appends a synthetic `(applied update to <file>: ±N lines)` user turn to history, and calls `sendFollowup()`.
6. `sendFollowup()` (line 1901) POSTs another `POST /code-assist` with `message: "(continue)"` and the updated history so the agent can acknowledge in natural language.
7. `pendingTool` is set to `nil` (line 1810) after write; if the follow-up response contains another `pendingTool`, the cycle repeats.

**Other tool names** follow the same card → sheet → confirm → synthetic-turn → follow-up pattern:

- `"create-gitlab-issue"` / `"create-github-issue"` → `CreateIssueSheet` → calls `GitLabClient` or `GitHubClient` → synthetic `(executed create-issue → #N ...)` turn
- `"comment-gitlab-issue"` → `CommentIssueSheet` → calls `client.createNote(...)`
- `"trigger-review-code"` → `TriggerReviewCodeSheet`
- `"git-op"` → see **git-op capability** subsection below.

#### git-op capability

**Sources:** `Core/Platform/AgentTypes.swift`, `Core/Repo/Services/RepoManager.swift`, `Chat/Views/Panel/CodeAssistantPanel.swift`, `Features/Chat/Views/Panel/GitOpSheet.swift`

The `git-op` tool gives the Code Assistant agent the ability to run git operations on the active repository.

**Model** (`Core/Platform/AgentTypes.swift`):

- `GitOp` — a 16-op `enum`: `status`, `log`, `diff`, `branch` (read tier); `add`, `commit`, `create_branch`, `checkout`, `pull_ff`, `push` (safe-write tier); `merge`, `revert`, `reset`, `stash`, `clean`, `merge_to_main` (destructive tier).
- `GitOpTier` — `case read, write, destructive`.
- `GitOpArgs: Codable` — `{ op: GitOp, message?, branch?, ref?, mode?, slug? }`.
- `PendingTool.gitOpArgs` — accessor on `PendingTool` that decodes `GitOpArgs` when `name == "git-op"`.

**Confirmation tier** (`Chat/Views/Panel/CodeAssistantPanel.swift`):

- **Read-tier ops** (`status`, `log`, `diff`, `branch`) — auto-run without any confirmation sheet.
- **Safe-write and destructive ops** — surface `GitOpSheet` before execution. Destructive ops additionally show a red warning banner inside the sheet so the user understands the operation is irreversible.

**Branch-first / protected-main policy** (`Core/Repo/Services/RepoManager.runGitOp`):

- **commit on the default branch or a detached HEAD** — `runGitOp` auto-creates an `agent/<slug>` branch first (BRANCH-FIRST rule), so agent commits never land directly on `main`/`master`.
- **`push`** — refused when not on a named non-default branch (`"Refusing to push: not on a feature branch"`).
- **direct `merge` into the default branch or a detached HEAD** — refused (`"Refusing to merge into the default branch (or a detached HEAD) directly. Use merge_to_main for that explicit step."`).
- **`merge_to_main`** — the only operation that pushes `origin <default-branch>`; it performs a fast-forward merge from a feature branch and rolls back to the original branch if the ff-merge fails.
- **`safeRef()`** (`RepoManager.safeRef`, line 164) — rejects flag-like strings (starting with `-`) and strings containing whitespace, preventing shell-injection via ref names.

**Skill file:** `extension/llm_agent/global/git-op.md`  
**Confirmation tag:** `confirmation: gitop-sheet`

There is no separate `/code-assist/tool-result` endpoint. The tool result is communicated back to the server by appending a synthetic acknowledgement turn to `history` and making a fresh `POST /code-assist` call. The server sees the outcome in the conversation history.

#### Chat Stop, message queue, and reply collapse

**Source:** `Chat/Views/Panel/CodeAssistantPanel.swift`

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
| `GET /kb/usage/limits` / `PUT /kb/usage/limits` | Read/write per-model usage caps (Model & Limits panel) |
| `GET /kb/usage/summary?provider=` | Live per-model usage + active model for the dashboard |
| `GET /kb/usage/resolve?provider=&prefer=` | Resolve the model an Auto Task run should use (skip when `paused`) |
| `POST /kb/usage/record` | Record an Auto Task CLI run into the usage ledger |
| `GET /kb/usage/ratelimits?provider=` | Latest provider API rate-limit snapshot for the gauge |
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
| Accessibility tree walk | `AXUIElementCreateApplication`, `AXUIElementCopyAttributeValue`, `AXIsProcessTrusted`, `kAXChildrenAttribute`, `kAXStaticTextRole`, `kAXWindowsAttribute`, `kAXTitleAttribute`, `kAXRoleAttribute`, `kAXValueAttribute`, `kAXDescriptionAttribute` | `Features/Live/Services/AXCaptionReader.swift:AXCaptionReader` | LOCKED |
| Accessibility trust gate | `AXIsProcessTrusted()`, `AXIsProcessTrustedWithOptions` | `Features/Live/Services/PermissionsService.swift:PermissionsService.refreshAccessibility()` (line 26), `promptAccessibility()` (line 75) | LOCKED |
| Keychain storage | `SecItemAdd`, `SecItemCopyMatching`, `SecItemDelete`, `kSecClassGenericPassword`, `kSecAttrService`, `kSecAttrAccount`, `kSecAttrAccessible` (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`) | `Core/Platform/KeychainStore.swift:KeychainStore` | REPLACE |
| File dialogs | `NSOpenPanel` (7 files) + `NSSavePanel` (2 files) | **Open** panels: `Features/Library/Views/LibraryView.swift`, `Features/Settings/Views/BackendSettingsSection.swift`, `Core/DesignSystem/FileTreePanel.swift`, `Shell/Chrome/ProjectSwitcher.swift`, `Shell/Welcome/WelcomeView.swift`, `Features/CodeGraph/Views/UAGraphView.swift`, `Core/Notes/Services/NotesFolderConfig.swift`. **Save** panels (`NSSavePanel`): `Features/Library/Views/MeetingDetailView.swift`, `Shell/Welcome/WelcomeView.swift` | REPLACE |
| Global local key monitor | `NSEvent.addLocalMonitorForEvents(matching: .keyDown)` | `Shell/AppShell.swift:AppShell.body` (monitor line 96) — matches the backtick **character** (`event.charactersIgnoringModifiers == "\`"` + `.control`, line 99) rather than keyCode 50, so the Ctrl+backtick terminal-panel toggle works on all keyboard layouts | REPLACE |
| Process / PTY | `Foundation.Process`, `SIGTERM`, `SIGKILL` (`kill(pid, ...)`) | `Core/Networking/BackendManager.swift:BackendManager.spawn()` (line 244), `killExternalListener()` (line 457) | REPLACE |
| Port listener lookup | `/usr/sbin/lsof -ti :<port> -sTCP:LISTEN` launched via `Process` | `Core/Networking/BackendManager.swift:BackendManager.killExternalListener()` (line 457) | REPLACE |
| Terminal emulator | SwiftTerm `LocalProcessTerminalView` | `Features/Terminal/Views/TerminalSessionView.swift:TerminalSessionView` (line 8) | REPLACE |
| Auto-update | Sparkle (`SPUStandardUpdaterController`, `SUFeedURL`, `SUPublicEDKey`) | `Features/Settings/Services/UpdateService.swift:UpdateService` | REPLACE |
| App-support paths | `FileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)` | `Core/Notes/Services/LibraryItemStore.swift` (line 32) — `LLM-IDE/library_items.json`; `Chat/Session/ChatSessionStore.swift` (line 17) — `LLM-IDE/sessions/<uuid>.json`; `Core/Platform/Config.swift` (line 19) — corrupt-config stash under `LLM-IDE/` | ABSTRACT |
| Screen recording probe | `CGPreflightScreenCaptureAccess()` | `Features/Live/Services/PermissionsService.swift:PermissionsService.refreshScreenRecording()` (line 33) | REPLACE |
| System Settings deep links | `x-apple.systempreferences:…` URL scheme via `NSWorkspace.shared.open` | `Features/Live/Services/PermissionsService.swift:PermissionsService.openSystemSettings(pane:)` (line 89) | REPLACE |

**Porting strategy (one line):** Keep the Node server and agent runtime verbatim; re-implement the SwiftUI shell in the target UI toolkit; abstract the six service boundaries — caption capture (AX), credential storage (Keychain), file dialogs, key monitoring, process/PTY management, and app-support paths — behind protocol interfaces so the rest of the codebase compiles unchanged.

---

## §6 Capture pipeline (Accessibility)

**Sources:** `Features/Live/Services/AXCaptionReader.swift`, `Features/Live/Services/ZoomCaptionScraper.swift`, `Features/Live/Services/TeamsCaptionScraper.swift`, `Features/Live/Services/CaptionScraper.swift`, `Features/Live/Services/PlatformDetector.swift`, `Features/Live/Services/PermissionsService.swift`

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

Captions captured locally by the AX scraper are **not pushed to the server in real time**. They accumulate in `CaptionOrchestrator.captions: [Caption]` (line 50) and in the on-disk partial `.md` file. When the user stops recording, `stopAndIngest(api:meetingTitle:)` (line 162) POSTs the full transcript to **`POST /kb/ingest`** (implemented in `Core/Networking/API/LlmIdeAPIClient+KB.swift:ingestMeeting`, line 76). See [`api-server.md`](api-server.md) for the `/kb/ingest` route contract.

The `LiveSessionMirror` service (`Features/Live/Services/LiveSessionMirror.swift`) works in the opposite direction: it polls `GET /kb/live/sessions` and `GET /kb/live/<id>?since=<seq>` to receive captions produced by *other* clients (e.g. the Chrome extension). The Mac AX scraper does not write to the `/kb/live/*` namespace.

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

`mac/build_app.sh` is a backward-compat shim (line 3) that delegates to three sub-scripts in order: `Scripts/build.sh` → `Scripts/sign.sh` → `Scripts/dmg.sh`. For a full notarized release, `Scripts/release.sh` adds a `Scripts/notarize.sh` phase between sign and DMG. Dev DMGs built via `build_app.sh` carry `LLMIDESourceRoot` in their Info.plist; only `release.sh` sets `LLMIDE_OMIT_SOURCE_ROOT=1` to omit it.

**`Scripts/build.sh`:**

1. Reads the version string from `mac/VERSION` (line 19) — single source of truth for both the Info.plist `CFBundleShortVersionString` and the DMG filename.
2. Assembles the `.app` bundle skeleton (`Contents/MacOS/`, `Contents/Resources/`).
3. Generates `AppIcon.icns` from `app_logo.png` using `sips` + `iconutil` (line 41).
4. Writes `Contents/Info.plist` (lines 77–150) including Sparkle keys (`SUFeedURL`, `SUPublicEDKey`) from environment variables `LLMIDE_SU_FEED_URL` / `LLMIDE_SU_PUBLIC_KEY` (absent for dev builds — Sparkle starts inert), and the URL schemes `llmide` + `meetnotes` for deep linking.
5. Runs `swift build -c release --product LlmIdeMac` (line 158).
6. Copies the Sparkle framework from the SPM build cache into `Contents/Frameworks/` and patches `@rpath` with `install_name_tool` (line 181) — without this the app crashes on launch with "Library not loaded: @rpath/Sparkle.framework".

**`Scripts/sign.sh`:** calls `codesign -s "$IDENTITY" --force --deep --options runtime --entitlements LlmIdeMac.entitlements` (line 30). `LLMIDE_SIGN_IDENTITY` defaults to `"-"` (ad-hoc) for dev builds; set to a Developer ID for distribution.

**`Scripts/dmg.sh`:** creates a UDZO-compressed DMG (`hdiutil create -format UDZO`, line 37) named `LlmIdeMac_v<VERSION>.dmg` with a symlink to `/Applications` for drag-install.

**`Scripts/rebuild-features.sh`** and **`Scripts/rebuild-swap.sh`** are not part of this pipeline — they back the in-app "Apply & Rebuild" flow (`FeatureRebuildService`, see "Apply & Rebuild" above) and are invoked by the running app itself, not by a developer.

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

```text
-F /Library/Developer/CommandLineTools/Library/Developer/Frameworks
-Xfrontend -disable-cross-import-overlays
```

Linker flags add `-framework Testing` with an `-rpath` pointing at the same CommandLineTools path. This setup is needed because Swift Testing is not yet part of the standard Xcode toolchain search path under SwiftPM on macOS 14.

---

## §8 Activity feed

The activity feed surfaces backend events in the Mac status bar without requiring the user to navigate to a specific section.

### ActivityStore (`mac/Sources/LlmIdeMac/Core/Platform/ActivityStore.swift`)

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

### ActivityBell + ActivityPanel (`mac/Sources/LlmIdeMac/Shell/Chrome/ActivityBell.swift`)

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
