import SwiftUI
import os.log

// Uncaught exceptions and signal-triggered crashes are not reported
// by SwiftUI — they die into ~/Library/Logs/DiagnosticReports/ where
// users never look. Wire them through Apple's unified logging so the
// crash text appears in Console.app under the llmide subsystem,
// which we can pull into a fault report.
fileprivate let crashLog = Logger(subsystem: "com.llmide.macapp", category: "Crash")
fileprivate func installCrashHandlers() {
    NSSetUncaughtExceptionHandler { exception in
        crashLog.critical(
            "Uncaught \(exception.name.rawValue, privacy: .public): \(exception.reason ?? "<no reason>", privacy: .public)\nstack: \(exception.callStackSymbols.joined(separator: "\n"), privacy: .public)"
        )
    }
    // POSIX signals — SIGSEGV/SIGABRT/SIGILL/SIGBUS. Re-raise the
    // default after logging so the OS still produces the crash log
    // and exits the process cleanly.
    for sig: Int32 in [SIGSEGV, SIGABRT, SIGILL, SIGBUS, SIGFPE] {
        signal(sig) { sig in
            crashLog.critical("Fatal signal \(sig)")
            signal(sig, SIG_DFL)
            raise(sig)
        }
    }
}

@main
struct LlmIdeMacApp: App {
    // Adopt an NSApplicationDelegate to handle reopen and "should-quit"
    // events SwiftUI alone can't express on macOS.  Without this,
    // closing the main window kills the process AND a second deep
    // link click looks like a fresh launch.
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    @StateObject private var theme: ThemeStore
    @StateObject private var templateStore: DocTemplateStore
    @StateObject private var session: SessionStore
    @StateObject private var config: AppConfig
    @StateObject private var autoTaskSettings = AutoTaskSettings()
    @StateObject private var capture: CaptionOrchestrator
    @StateObject private var deepLink: DeepLinkRouter
    @StateObject private var liveMirror: LiveSessionMirror
    @StateObject private var autoCodeUpdate: AutoCodeUpdateService
    @StateObject private var logStore: TaskLogStore
    @StateObject private var updateService = UpdateService()
    @StateObject private var projectStore: ProjectStore
    @StateObject private var agentRuns: AgentRunsStore
    @StateObject private var graphAutoUpdater: GraphAutoUpdater
    @StateObject private var graphSessionStore = GraphSessionStore()
    @State private var backend = BackendManager()
    @State private var mobileControl = MobileControlManager()
    @State private var quickSwitcherShown = false
    @State private var activityStore: ActivityStore
    private let api: LlmIdeAPIClient
    private let autoCapture: AutoCaptureService

    init() {
        installCrashHandlers()
        // Chat sessions persist across launches (server + local JSON).
        // CodeAssistantPanel loads the last session on appear.
        // Build the dependency graph once, on the main actor where
        // SwiftUI requires it.  The API client needs SessionStore
        // so it can mint authorization headers from the live token.
        let cfg = AppConfig.shared
        let store = SessionStore(server: cfg.serverURL)
        let client = LlmIdeAPIClient(baseURL: cfg.serverURL, sessionStore: store)
        // Honour the user's Capture → poll-interval setting (stored in ms).
        let orchestrator = CaptionOrchestrator(
            pollInterval: max(0.05, TimeInterval(cfg.pollIntervalMs) / 1000.0))
        let themeStore = ThemeStore(initial: Theme.find(id: cfg.themeID))
        let router = DeepLinkRouter()
        let mirror = LiveSessionMirror(api: client)
        let appSupportBase = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first ?? URL(fileURLWithPath: NSHomeDirectory())
                .appendingPathComponent("Library/Application Support")
        let registryURL = appSupportBase.appendingPathComponent("LLM IDE/processed-actions.json")
        let registry = ProcessedActionsRegistry(storeURL: registryURL)
        let projectStoreStateDir = appSupportBase.appendingPathComponent("LLM IDE")
        let projectStoreInstance = ProjectStore(stateDirectory: projectStoreStateDir,
                                                 defaults: cfg.defaultProjectSettings)
        // Wire ProjectStore into the API client so write endpoints
        // (currently /kb/ingest) can stamp `projectId` onto payloads
        // without every caller having to thread it through.
        client._projectStore = projectStoreInstance
        // Wire the API client back into ProjectStore so it can call
        // /kb/project/:id/export on close without threading the client
        // through every call site.
        projectStoreInstance._apiClient = client
        let autoTaskSettingsInstance = AutoTaskSettings()
        let taskLogStore = TaskLogStore()
        // `backend: nil` ⇒ auto-resolve from the active project's `linkedRepo`,
        // which supports BOTH GitLab and GitHub (set by syncLinkedRepoFromConfig).
        // Passing a GitLabClient here used to set `backendOverride` to a GitLab
        // backend, which made resolveBackendAndProject() short-circuit into
        // resolveWithBackend() — a path that ONLY checks GitLab saved projects.
        // GitHub repos were silently ignored → "No linked repo". Leave the
        // override for tests only.
        let autoCode = AutoCodeUpdateService(
            config: cfg,
            autoTaskSettings: autoTaskSettingsInstance,
            backend: nil,
            registry: registry,
            projectStore: projectStoreInstance,
            api: client,
            logStore: taskLogStore)

        // The registry's `bootstrap()` (the disk-read path) is invoked
        // from the AppShell's first `.task` tick — see `autoCode.start()`
        // which performs it lazily before any registry query.  Errors are
        // surfaced after bootstrap inside AutoCodeUpdateService.
        registry.onSaveError = { [weak autoCode] error in
            Task { @MainActor in
                autoCode?.setError("Action history failed to save: \(error.localizedDescription)")
            }
        }

        self._config = StateObject(wrappedValue: cfg)
        self._templateStore = StateObject(wrappedValue: DocTemplateStore())
        self._session = StateObject(wrappedValue: store)
        self._capture = StateObject(wrappedValue: orchestrator)
        self._theme = StateObject(wrappedValue: themeStore)
        self._deepLink = StateObject(wrappedValue: router)
        self._liveMirror = StateObject(wrappedValue: mirror)
        self._autoCodeUpdate = StateObject(wrappedValue: autoCode)
        self._logStore = StateObject(wrappedValue: taskLogStore)
        self._projectStore = StateObject(wrappedValue: projectStoreInstance)
        let runs = AgentRunsStore(api: client)
        self._agentRuns = StateObject(wrappedValue: runs)
        let autoUpdater = GraphAutoUpdater(projectStore: projectStoreInstance,
                                           intervalMinutes: cfg.graphAutoUpdateMinutes)
        self._graphAutoUpdater = StateObject(wrappedValue: autoUpdater)
        let activity = ActivityStore(api: client)
        activity.start()
        self._activityStore = State(wrappedValue: activity)
        // Wire activity store weak refs on app-level services so they can
        // report events without a global singleton. Mirrors weak var config
        // on RegressionRunner.
        autoUpdater.activity = activity
        autoCode.activity = activity
        self._autoTaskSettings = StateObject(wrappedValue: autoTaskSettingsInstance)
        self.api = client
        self.autoCapture = AutoCaptureService(capture: orchestrator, config: cfg)
    }

    var body: some Scene {
        // Use `Window` (singular) instead of `WindowGroup` so SwiftUI
        // enforces one main window per process.  `WindowGroup` lets a
        // deep-link arrival spawn a second window of the same scene
        // (we'd see two login screens stacked when clicking the
        // extension's ↗ button while the app was already running);
        // `Window` is the canonical macOS pattern for a single-window
        // app like Mail or Slack and never multi-instances.
        //
        // The id "main" is used by EnvironmentValues.openWindow when
        // we need to programmatically reopen the window after the
        // user closes it via Cmd-W.
        Window(L.App.name, id: "main") {
            ContentView(api: api)
                .environmentObject(theme)
                .environmentObject(templateStore)
                .environmentObject(session)
                .environmentObject(config)
                .environmentObject(autoTaskSettings)
                .environmentObject(capture)
                .environmentObject(deepLink)
                .environmentObject(liveMirror)
                .environmentObject(autoCodeUpdate)
                .environmentObject(logStore)
                .environmentObject(updateService)
                .environmentObject(projectStore)
                .environmentObject(agentRuns)
                .environmentObject(graphAutoUpdater)
                .environmentObject(graphSessionStore)
                .environment(backend)
                .environment(mobileControl)
                .environment(activityStore)
                // 1000 gives the 3-pane Review layout breathing room
                // (sidebar ~240 + code ~380 + assistant ~280 = 900,
                // plus toolbar + dividers + comfort).  Users can still
                // shrink the sidebar to icon-only mode for more space.
                .frame(minWidth: 1000, minHeight: 600)
                .task {
                    // Repair saved GitHub/GitLab repos whose localPath is nil
                    // even though a matching clone already exists on disk —
                    // e.g. cloned manually outside the app, or the app quit
                    // between `git clone` finishing and the config write
                    // persisting. Without this, `isCloned` stays false
                    // forever and ReviewView/CodeWorkflowTarget report no
                    // linked repo despite the code being right there. Runs
                    // BEFORE the migrator below so a healed localPath is
                    // visible to it in the same launch.
                    await Self.reconcileSavedRepoPaths(config: config, projectStore: projectStore)
                    // One-shot import of legacy SavedGitLab/HubRepo entries
                    // with localPath. No-op on every launch after the first
                    // successful run (ProjectMigrator records completion in
                    // a sidecar marker). Runs FIRST so the migrator's
                    // imported activeProject (if any) is visible to every
                    // other bootstrap step below.
                    let migrator = ProjectMigrator(store: projectStore)
                    let result = migrator.runOnce(
                        gitLab: config.gitLabSavedProjects,
                        gitHub: config.gitHubSavedRepos)
                    if result.imported > 0 {
                        Logger(subsystem: "com.llmide.macapp", category: "Migration")
                            .info("Imported \(result.imported, privacy: .public) legacy projects")
                    }
                    // Self-heal the active project's `linkedRepo` from the
                    // currently-active saved repo. Setups that predate the
                    // writer (saved repo configured when nothing populated
                    // linkedRepo) get linked automatically on launch instead
                    // of requiring the user to re-toggle the active radio.
                    // Idempotent — a no-op once the link matches.
                    projectStore.syncLinkedRepoFromConfig(config)
                    // Lazy bootstrap: DocTemplateStore's disk read is
                    // deferred from init() to here so LlmIdeMacApp.init
                    // stays cheap.  Run first so any UI that reads
                    // customTemplates on first frame still gets the
                    // hydrated list within the same .task tick.
                    templateStore.bootstrap()
                    // Start the backend FIRST. Session restore below calls
                    // the backend (api.refresh), so it must already be coming
                    // up — and, more importantly, a slow or blocked restore
                    // (e.g. a keychain-access prompt after an ad-hoc re-sign)
                    // must never gate the backend from starting at all, which
                    // is what happened when this ran after bootstrap.
                    if config.backendAutoStart {
                        autoStartBackend()
                        // Give a freshly-spawned backend a brief, bounded
                        // window to answer so session restore has a fair shot
                        // on a cold launch. Returns immediately once healthy
                        // (e.g. an adopted server); bounded so a genuinely
                        // down backend can't stall the first frame.
                        //
                        // ONLY wait when there's a stored session to restore.
                        // A logged-out / first-run user has nothing to restore,
                        // so skip the wait and paint login immediately — it
                        // auto-retries when the backend reports `.running`.
                        if session.hasStoredSession {
                            await Self.awaitBackendReady(timeoutSec: 3)
                        }
                    }
                    if config.mobileControlEnabled, config.mobileControlAutoStart {
                        autoStartMobileControl()
                    }
                    // Restore persisted session on launch, if any.
                    await session.bootstrap(api: api)
                    autoCapture.start()
                    if autoTaskSettings.enabled { autoCodeUpdate.start() }
                }
                // Start / stop the live caption mirror in lockstep
                // with authentication.  When signed out, polling
                // would just 401 in a loop; when signed in, we want
                // immediate visibility of any active extension session.
                .onChange(of: session.isAuthenticated) { _, authed in
                    if authed { liveMirror.start() } else { liveMirror.stop() }
                }
                // Keep the active project's `linkedRepo` bound to the
                // currently-active saved repo whenever the active project
                // changes. The one-shot launch sync in `.task` above only
                // covers a project restored at launch; this covers projects
                // opened or switched to afterward (and re-runs if the saved
                // repo config changed since). Idempotent — setLinkedRepo
                // no-ops once the link already matches, so the reassignment
                // it causes here can't loop.
                .onChange(of: projectStore.activeProject) { _, _ in
                    projectStore.syncLinkedRepoFromConfig(config)
                }
                // Stop the supervised backend on Cmd-Q so we don't
                // leak an orphan node process every time the user
                // quits the app.
                .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in
                    backend.stop()
                    mobileControl.stop()
                }
                .task {
                    if session.isAuthenticated { liveMirror.start() }
                }
                // Custom URL scheme handler.  Fired by macOS when any
                // app (the Chrome extension, Spotlight, `open
                // llmide://transcript`, etc.) opens a URL with our
                // scheme.  Routing decisions live in the router so this
                // hook stays trivial.
                .onOpenURL { url in
                    deepLink.handle(url)
                }
                .sheet(isPresented: $quickSwitcherShown) {
                    QuickSwitcherSheet(isPresented: $quickSwitcherShown)
                        .environmentObject(theme)
                        .environmentObject(projectStore)
                }
        }
        // `.contentSize` was making the window resize whenever the
        // selected section's content had a different intrinsic width
        // (Library three-pane vs. single-pane Plans/Review/Settings),
        // which pulled the sidebar in/out on every click.  Default
        // resizability keeps the window stable on section switch.
        .defaultSize(width: 1280, height: 760)
        .windowResizability(.contentMinSize)
        // Titlebar blends with the sidebar / toolbar (no separator
        // line) — matches Mail.app, Notes.app, Reminders.app.
        .windowToolbarStyle(.unified)
        // Replace SwiftUI's default "LLM IDE" → "About" group so we
        // can slot the Sparkle "Check for updates…" item beside it.
        // .appInfo lives under the app menu's first divider — exactly
        // where every macOS app puts its update entry.
        .commands {
            CommandGroup(after: .appInfo) {
                Button("Check for Updates…") {
                    updateService.checkForUpdates()
                }
                .disabled(!updateService.canCheckForUpdates)
            }
            CommandGroup(after: .windowList) {
                Button("Quick Switch Project…") { quickSwitcherShown = true }
                    .keyboardShortcut("p", modifiers: .command)
                // Global "Ask the Agent" — opens the AskAgentSheet
                // owned by AppShell, regardless of which section is
                // active. Posts a notification rather than mutating
                // state directly because the App scene has no direct
                // handle on AppShell's @State.
                Button("Ask the Agent…") {
                    NotificationCenter.default.post(name: .openAskAgentSheet, object: nil)
                }
                .keyboardShortcut("a", modifiers: [.command, .shift])
            }
        }

        // Menu-bar item — visible status of the recording state and a
        // one-click Start/Stop.  Lets capture continue when the main
        // window is closed.
        MenuBarExtra {
            MenuBarMenu(api: api)
                .environmentObject(theme)
                .environmentObject(session)
                .environmentObject(capture)
                .environmentObject(config)
                .environmentObject(projectStore)
        } label: {
            Image(systemName: capture.isRunning ? "record.circle.fill" : "record.circle")
                .symbolRenderingMode(.palette)
                .foregroundStyle(capture.isRunning ? .red : .secondary)
                .accessibilityLabel(capture.isRunning ? "LLM IDE — recording" : "LLM IDE")
        }
        .menuBarExtraStyle(.menu)

        // Auto Tasks — manual Run Now / Stop without opening the main window.
        MenuBarExtra {
            MenuBarAutoTaskView()
                .environmentObject(theme)
                .environmentObject(autoTaskSettings)
                .environmentObject(autoCodeUpdate)
                .environmentObject(logStore)
        } label: {
            Image(systemName: autoCodeUpdate.isRunning
                  ? "arrow.triangle.2.circlepath.circle.fill"
                  : "arrow.triangle.2.circlepath.circle")
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(autoTaskSettings.enabled ? .primary : .secondary)
                .accessibilityLabel("Auto Tasks")
        }
        .menuBarExtraStyle(.window)
    }

    /// Always tries to start the backend on app launch:
    ///   1. Validate-and-repair the configured paths (stale paths from a
    ///      moved/renamed repo are re-detected, not just empty ones).
    ///   2. If both paths resolve to a real server.mjs + node binary,
    ///      call backend.start(). BackendManager handles the adopt-vs-
    ///      spawn decision via its /health probe.
    /// Failures are surfaced in Settings → Backend, not as alerts.
    @MainActor
    private func autoStartBackend() {
        BackendManager.resolveLaunchPaths(config: config)
        guard !config.backendNodePath.isEmpty, !config.backendWorkingDir.isEmpty else { return }
        backend.start(nodePath: config.backendNodePath, workingDirectory: config.backendWorkingDir)
    }

    /// Start the native mobile control server when Mobile Control is enabled.
    /// (The caller additionally gates on `mobileControlAutoStart`.)
    @MainActor
    private func autoStartMobileControl() {
        if config.mobileControlEnabled {
            mobileControl.start()
        }
    }

    /// Poll `/health` briefly so session restore — which talks to the
    /// backend — has a chance to succeed on a cold launch. Best-effort:
    /// returns the moment the backend answers, or when the timeout elapses.
    private static func awaitBackendReady(timeoutSec: Double) async {
        let deadline = Date().addingTimeInterval(timeoutSec)
        while Date() < deadline {
            if await BackendManager.probeHealth() { return }
            try? await Task.sleep(nanoseconds: 200_000_000)
        }
    }

    /// See `SavedRepoPathReconciler` — repairs `localPath` for any saved
    /// GitHub/GitLab repo whose expected clone location (active project's
    /// code/ dir, then the global Clones dir) already contains a checkout
    /// with a matching origin remote. Best-effort and silent on no match —
    /// a repo that's genuinely never been cloned is untouched.
    private static func reconcileSavedRepoPaths(config: AppConfig, projectStore: ProjectStore) async {
        let repoManager = RepoManager()
        let candidateDirs = [projectStore.activeProjectCodeDir, config.effectiveClonesURL].compactMap { $0 }
        let log = Logger(subsystem: "com.llmide.macapp", category: "SavedRepoPathReconciler")
        let remoteURL: (URL) async throws -> String = { try await repoManager.runGit(["remote", "get-url", "origin"], at: $0) }

        for i in config.gitHubSavedRepos.indices where config.gitHubSavedRepos[i].localPath == nil {
            let repo = config.gitHubSavedRepos[i]
            guard let name = GitHubClient.ownerAndName(from: repo.url)?.1 else { continue }
            if let found = await SavedRepoPathReconciler.findExistingClone(
                name: name, url: repo.url, candidateDirs: candidateDirs, remoteURL: remoteURL
            ) {
                config.gitHubSavedRepos[i].localPath = found
                log.info("healed GitHub repo localPath: \(repo.displayName, privacy: .public)")
            }
        }
        for i in config.gitLabSavedProjects.indices where config.gitLabSavedProjects[i].localPath == nil {
            let proj = config.gitLabSavedProjects[i]
            let name = proj.url
                .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                .components(separatedBy: "/")
                .last?
                .replacingOccurrences(of: ".git", with: "") ?? ""
            guard !name.isEmpty else { continue }
            if let found = await SavedRepoPathReconciler.findExistingClone(
                name: name, url: proj.url, candidateDirs: candidateDirs, remoteURL: remoteURL
            ) {
                config.gitLabSavedProjects[i].localPath = found
                log.info("healed GitLab project localPath: \(proj.displayName, privacy: .public)")
            }
        }
    }
}

/// Compact menu-bar menu — tiny on purpose so it doesn't compete with
/// the main window.  All real interaction happens in the window; the
/// menu is just the persistent status surface.
struct MenuBarMenu: View {
    @EnvironmentObject var capture: CaptionOrchestrator
    @EnvironmentObject var session: SessionStore
    @EnvironmentObject var config: AppConfig
    @EnvironmentObject var projectStore: ProjectStore
    let api: LlmIdeAPIClient

    /// Open-fault count cached on appear + every 30s. Counting faults is
    /// disk-bound (decode every frontmatter); recomputing on every
    /// menu render would flicker and stutter.
    @State private var openFaultCount: Int = 0
    @State private var refreshTimer: Timer?

    var body: some View {
        if capture.isRunning {
            Button("Stop recording") { capture.stop() }
        } else {
            Button("Start recording") {
                if AXCaptionReader.canRead { capture.start() }
            }
            .disabled(!AXCaptionReader.canRead)
        }

        // Status pill — only the rows that have non-zero signal.
        // Each row opens the relevant tab and brings the window
        // forward via .openSection.
        if openFaultCount > 0 || config.lastRegressionRunAt != nil {
            Divider()
        }
        if openFaultCount > 0 {
            Button {
                NotificationCenter.default.post(
                    name: .openSection,
                    object: ShellState.Section.codeGraph.rawValue
                )
            } label: {
                Text("🐜 \(openFaultCount) open fault report\(openFaultCount == 1 ? "" : "s")")
            }
        }
        if let last = config.lastRegressionRunAt {
            Button {
                NotificationCenter.default.post(
                    name: .openSection,
                    object: ShellState.Section.regression.rawValue
                )
            } label: {
                let n = config.lastRegressionRegressedCount
                let when = MenuBarMenu.relativeFormatter.localizedString(for: last, relativeTo: Date())
                if n > 0 {
                    Text("⚠ \(n) regression\(n == 1 ? "" : "s") · \(when)")
                } else {
                    Text("✓ No regressions · \(when)")
                }
            }
        }

        Divider()
        if let user = session.user {
            Text("Signed in as \(user.email)")
        } else {
            Text("Not signed in")
        }
        Divider()
        Button("Quit LLM IDE") { NSApplication.shared.terminate(nil) }
            .keyboardShortcut("q")
        // The MenuBarExtra menu re-renders on each open, but
        // @State doesn't get a fresh init on each render — so
        // onAppear fires once. We still want a periodic refresh
        // in case bugs are added/closed elsewhere while the menu
        // sits open, hence the timer.
        EmptyView()
            .onAppear {
                refreshOpenFaultCount()
                if refreshTimer == nil {
                    // Timer.scheduledTimer retains its target via the run
                    // loop, so we MUST invalidate on disappear. Without
                    // this the timer (and the closure it owns) lives for
                    // the entire app process, performing disk I/O every
                    // 30s for the lifetime of the app.
                    refreshTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { _ in
                        Task { @MainActor in refreshOpenFaultCount() }
                    }
                }
            }
            .onDisappear {
                refreshTimer?.invalidate()
                refreshTimer = nil
            }
    }

    private func refreshOpenFaultCount() {
        // Count faults at the active PROJECT root (`<root>/system/faults`) —
        // the same place CodeAssistantPanel writes them and RegressionView
        // reads them. `config.activeRepoLocalURL` pointed at the clone
        // (`code/<repo>`), so the menu under-counted (usually showed 0).
        guard let repo = WorkspaceRoot.resolve(config: config, projectStore: projectStore) else {
            openFaultCount = 0
            return
        }
        let store = config.memoryStore
        // Counting faults decodes every frontmatter — keep it off the main
        // actor so the periodic (30s) refresh never stutters the menu.
        Task {
            let count = await Task.detached(priority: .utility) {
                store.faultStatusSnapshot(at: repo).openCount
            }.value
            openFaultCount = count
        }
    }

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f
    }()
}
