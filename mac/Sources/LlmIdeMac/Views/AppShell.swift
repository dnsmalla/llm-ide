import SwiftUI
import RepoKit

private struct RecoveryTimeoutError: Error {}

struct AppShell: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var deepLink: DeepLinkRouter
    @EnvironmentObject var capture: CaptionOrchestrator
    @EnvironmentObject var liveMirror: LiveSessionMirror
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @EnvironmentObject var projectStore: ProjectStore
    @EnvironmentObject var graphAutoUpdater: GraphAutoUpdater
    @EnvironmentObject var graphSessionStore: GraphSessionStore
    @State private var shell = ShellState()
    @State private var itemStore = LibraryItemStore()
    @State private var catalogStore = AgentCatalogStore()
    @State private var appEnv: AppEnvironment?
    @State private var envInitError: String?
    @State private var pendingOrphan: PartialRecovery.Orphan?
    @State private var recoveryError: String?
    @State private var showLegacyPrompt = false
    /// Library list visibility — toggled from the inline SectionChromeBar so
    /// the Library header matches every other section (no title-bar toggle).
    @State private var libraryTreeVisible = true
    @AppStorage("MEETNOTES_LEGACY_PROMPT_SUPPRESSED") private var legacyPromptSuppressed = false
    @State private var showAskAgentSheet = false
    /// Cached "auto-dispatch when capture starts" flag from the user's
    /// persona. Refreshed on login, on settings save, and lazily on
    /// the capture-started transition if we've never loaded it.
    /// Nil = "not loaded yet" so the observer knows to fetch once.
    @State private var autoDispatchEnabled: Bool?
    @State private var terminalPanelState = TerminalPanelState()
    @State private var keyMonitor: Any?

    var body: some View {
        VStack(spacing: 0) {
            Group {
                if projectStore.activeProject == nil {
                    WelcomeView()
                } else {
                    existingShellContent
                }
            }
            .background(GeometryReader { geo in
                // Broadcast the window content height to TerminalPanelView
                // via preference key so it can clamp resize to 60% correctly.
                // We probe inside the main content area (not the VStack itself)
                // to avoid the measurement being 0 when collapsed.
                Color.clear.preference(key: WindowHeightKey.self, value: geo.size.height)
            })
            // NOTE: the terminal dock lives INSIDE the editor (detail) column —
            // see splitContent() — so it spans only the editor area and not the
            // activity rail / file-tree, VS Code style.
            StatusBar(api: api)
        }
        // ShellState lives at the AppShell root so siblings of the
        // active-project body (Welcome, StatusBar, the Ask sheet)
        // can all see it. Previously this lived only on
        // existingShellContent — StatusBar's AgentStatusBadge then
        // crashed post-login because it reads @Environment(ShellState).
        .environment(shell)
        .environment(terminalPanelState)
        .sheet(isPresented: $showAskAgentSheet) {
            AskAgentSheet(api: api)
        }
        .onReceive(NotificationCenter.default.publisher(for: .openAskAgentSheet)) { _ in
            showAskAgentSheet = true
        }
        // When the Chrome extension finalizes a live session, auto-generate
        // a note file — same as CaptionScraper does for AX-captured sessions.
        .onReceive(NotificationCenter.default.publisher(for: .liveSessionFinalized)) { note in
            guard let payload = note.object as? LiveSessionMirror.FinalizedPayload else { return }
            Task { await generateNoteForLiveSession(payload) }
        }
        // Re-summarize triggered from the Meetings file-tree context menu.
        .onReceive(NotificationCenter.default.publisher(for: .resummarizeMeetingFile)) { note in
            guard let fileURL = note.object as? URL else { return }
            Task { await resummarizeMeetingFile(at: fileURL) }
        }
        // Auto-dispatch: when capture transitions from off → on and
        // the user enabled the persona flag, fire dispatchAgent once.
        // First time it runs we lazily load the flag; afterwards we
        // trust the cache (refreshed via .agentPersonaChanged below).
        .onChange(of: capture.isRunning) { wasRunning, nowRunning in
            guard !wasRunning, nowRunning else { return }
            Task { await maybeAutoDispatch() }
        }
        .onReceive(NotificationCenter.default.publisher(for: .agentPersonaChanged)) { _ in
            Task { await refreshAutoDispatchFlag() }
        }
        .onAppear {
            // Guard against re-registration if onAppear fires more than once
            // (e.g., during SwiftUI re-renders) without a matching onDisappear.
            guard keyMonitor == nil else { return }
            keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [terminalPanelState, projectDirectory] event in
                // Compare by character rather than keyCode so the shortcut works
                // on all keyboard layouts (keyCode 50 is layout-specific to US).
                if event.charactersIgnoringModifiers == "`" && event.modifierFlags.contains(.control) {
                    Task { @MainActor in
                        terminalPanelState.toggle(projectDirectory: projectDirectory)
                    }
                    return nil // consume the event
                }
                return event
            }
        }
        .onDisappear {
            if let monitor = keyMonitor {
                NSEvent.removeMonitor(monitor)
                keyMonitor = nil
            }
        }
    }

    /// Working directory for new terminal tabs.
    private var projectDirectory: URL {
        // Prefer the active Source Control repo so the terminal's git matches
        // the SCM panel; fall back to the active project folder, then home.
        WorkspaceRoot.resolveOrHome(config: config, projectStore: projectStore)
    }

    /// Lazy persona-flag load. We avoid the network on every render —
    /// only when capture actually starts (rare) or the user just
    /// saved a new value (also rare).
    private func refreshAutoDispatchFlag() async {
        // `getAgentPersona` returns `AgentPersona?`; `try?` wraps that
        // in another optional, so we end up with `Optional<Optional<…>>`
        // which flattens via the inner ?? to a non-optional Bool.
        let p = (try? await api.getAgentPersona()) ?? nil
        autoDispatchEnabled = p?.autoDispatch ?? false
    }

    /// Fired on every capture-start. If autoDispatch is on and no
    /// agent is already attached to this session, kick one off.
    /// Failures are silent — auto-dispatch is a convenience, not a
    /// guarantee. The status badge surfaces success state regardless.
    private func maybeAutoDispatch() async {
        if autoDispatchEnabled == nil { await refreshAutoDispatchFlag() }
        guard autoDispatchEnabled == true else { return }
        _ = try? await api.dispatchAgent()
    }

    @ViewBuilder
    private var existingShellContent: some View {
        Group {
            if let appEnv = appEnv {
                splitContent()
                    .environment(appEnv)
            } else if let err = envInitError {
                ContentUnavailableView {
                    Label("Couldn't Open Notes Folder", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(err)
                } actions: {
                    Button("Retry") {
                        envInitError = nil
                        initEnv()
                    }
                    .buttonStyle(.borderedProminent)
                }
            } else {
                ProgressView().task { initEnv() }
            }
        }
        // Lifecycle modifiers live on the stable Group so they don't
        // restart each time splitContent() swaps between 2- and 3-column
        // layouts.
        .environment(shell)
        .environment(itemStore)
        .environment(catalogStore)
        .task {
            guard let env = appEnv else { return }
            env.startWatching {
                // startWatching already ran fullScan() to update the SQLite index
                // (don't scan again here — that was a double scan per fs event).
                // Just post the notification on the main thread so SwiftUI observers
                // (LibraryView etc.) receive it on the right queue.
                DispatchQueue.main.async {
                    NotificationCenter.default.post(name: .meetingIndexChanged, object: nil)
                }
            }
        }
        // Sync the NOTES section from AppShell so every view that reads
        // LibraryItemStore (LibraryView, FileTreePanel in ReviewView, etc.)
        // always reflects the current notes/ folder — not just the tab
        // that happens to contain LibraryView.
        .onReceive(NotificationCenter.default.publisher(for: .meetingIndexChanged)) { _ in
            // Authoritative refresh of the bound project's meetings/ and notes/
            // folders. Off-main (rescanAsync) so a notification storm during a
            // sync/import doesn't hitch the UI with the directory walk.
            Task { await itemStore.rescanAsync() }
        }
        .onAppear {
            bindLibraryStore()
            seedLocalCodeFolders()
            redirectIfSectionHidden()
        }
        .onChange(of: config.localCodeFolders)        { _, _ in seedLocalCodeFolders() }
        .onChange(of: config.hiddenSidebarSections)   { _, _ in redirectIfSectionHidden() }
        .task { await checkRecovery() }
        .task { await checkLegacyPrompt() }
        // Auto-maintain the knowledge graph + memory for any project that
        // already has a generated graph (first generation stays manual).
        // Idempotent; re-runs on project open/switch + a periodic timer.
        .task {
            // Wire the session store so background runs surface in the Code
            // Graph view, then begin auto-maintaining the graph.
            graphAutoUpdater.sessionStore = graphSessionStore
            graphAutoUpdater.start()
        }
        // Tie the auto-updater to the auth/session lifecycle: AppShell is only
        // mounted while signed in (ContentView swaps in LoginView on logout), so
        // its teardown is the logout signal. Without this the 15-min timer keeps
        // scanning the last project after logout, since GraphAutoUpdater is an
        // app-level object that outlives this view.
        .onDisappear { graphAutoUpdater.stop() }
        .task {
            // Phase D — arm the regression-run button when the app
            // version changes between launches. We record the new
            // version here; the user fires the actual run from the
            // Regression view's "Run now" button. (Fully automatic
            // background runs are deferred — they'd kick off N CLI
            // calls without user intent.)
            let current = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
            if current != config.lastSeenAppVersion {
                config.lastSeenAppVersion = current
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .notesFolderChanged)) { _ in
            rebuildEnv()
        }
        // When the active project changes (open → close, or A → B),
        // wipe the stale AppEnvironment.  For a project-switch the
        // .notesFolderChanged posted by ProjectStore will trigger
        // rebuildEnv() almost simultaneously (both notifications arrive
        // synchronously in the same run-loop pass, so this fires first
        // and rebuildEnv gets a nil env to overwrite — benign double call).
        // For a close (activeProject → nil) existingShellContent is about
        // to disappear: nil out now so the *next* open's ProgressView
        // task always calls initEnv() against a fresh state instead of
        // the old project's AppEnvironment.
        .onReceive(NotificationCenter.default.publisher(for: .activeProjectChanged)) { _ in
            appEnv?.indexer.stopWatching()
            appEnv = nil
            envInitError = nil
            // Re-point the Library store at the new project root (or nil on
            // close). bindProject runs the one-time legacy migration and a
            // fresh scan, so the index follows the active project.
            bindLibraryStore()
        }
        // Ingest the open project's code into the KB so the agent can SEARCH it
        // (search-kb / findContext), not just read files. Keyed on the active
        // project's path so it fires on BOTH launch-restore (which sets
        // activeProject WITHOUT posting .activeProjectChanged — see ProjectStore
        // rehydrate) AND explicit open/switch. .onReceive alone missed restore.
        .task(id: projectStore.activeProject?.localPath) {
            indexActiveProjectCode()
        }
        .onReceive(NotificationCenter.default.publisher(for: .openSettings)) { _ in
            shell.section = .settings
        }
        .onReceive(NotificationCenter.default.publisher(for: .openSection)) { note in
            // Posted from MenuBarMenu with the target section's
            // rawValue as the object. Activates the app so the
            // user lands inside the right tab from one click.
            if let raw = note.object as? String,
               let target = ShellState.Section(rawValue: raw) {
                shell.section = target
                NSApp.activate(ignoringOtherApps: true)
            }
        }
        .onAppear { applyDeepLink(deepLink.pendingEvent?.tab) }
        // Observe the full Event so identical successive deep links
        // (same `tab`) still trigger the handler — `Event.id` differs
        // per click. The previous `pendingTab` observation only fired
        // when the tab string changed, missing repeats.
        .onChange(of: deepLink.pendingEvent) { _, new in applyDeepLink(new?.tab) }
        // Auto-jump to Live when EITHER source goes from idle to active.
        .onChange(of: capture.isRunning) { old, new in
            handleLiveEdge(wasActive: old, isActive: new)
        }
        .onChange(of: liveMirror.activeSession != nil) { old, new in
            handleLiveEdge(wasActive: old, isActive: new)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if let err = recoveryError {
                HStack(spacing: 8) {
                    Text(err)
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.danger)
                    Spacer()
                    Button("Dismiss") { recoveryError = nil }
                        .buttonStyle(.borderless)
                        .controlSize(.small)
                        .foregroundStyle(theme.current.textMuted)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(theme.current.surface)
            }
        }
        .sheet(item: $pendingOrphan) { o in
            RecoveryPromptView(
                orphan: o,
                onRecover: { recover(o) },
                onDismiss: { dismissOrphan(o) })
        }
        .sheet(isPresented: $showLegacyPrompt) {
            LegacyExportPromptView(
                onExport: { showLegacyPrompt = false; runLegacyExport() },
                onSkip:   { showLegacyPrompt = false },
                onDontAsk: { showLegacyPrompt = false; legacyPromptSuppressed = true })
        }
    }

    /// Library gets a true 3-column layout (sidebar | list | detail).
    /// Every other section is a clean 2-column layout (sidebar | content)
    /// with no wasted middle column.
    /// The "tool" sections shown as named buttons in the title bar. `.search`
    /// is the field; `.explorer`/`.sourceControl` are the panel-header switcher;
    /// `.settings` is in the account menu; `.live` only while a session runs.
    private static let toolOrder: [ShellState.Section] = [
        .codeGraph, .autoCode, .plans, .conflicts, .issues,
        .gantt, .regression, .docGen, .visual, .library, .live,
    ]
    private var liveActive: Bool { capture.isRunning || liveMirror.activeSession != nil }
    private var toolSections: [ShellState.Section] {
        Self.toolOrder.filter { section in
            if section == .live { return liveActive }
            return !config.hiddenSidebarSections.contains(section.rawValue)
        }
    }

    @ViewBuilder
    private func splitContent() -> some View {
        // Title bar holds the named tool buttons (trailing) and the account
        // menu. AppKit collapses whichever tools don't fit into the native `»`
        // overflow menu. Explorer · Source Control · Search are NOT here —
        // they're the panel-header switcher (`PanelSectionTabs`), Cursor-style.
        sectionLayout()
            .toolbar(content: shellToolbar)
    }

    @ToolbarContentBuilder
    private func shellToolbar() -> some ToolbarContent {
        // Leading "Home" button — always returns to Explorer (the default
        // home). Explorer/Source Control/Search live only in the panel-header
        // switcher, so from a tool section (Issues, Gantt, …) this is the way
        // back without hunting for the switcher.
        ToolbarItem(placement: .navigation) {
            Button { shell.section = .explorer } label: {
                Label("Home", systemImage: "house")
            }
            .help("Home — Explorer")
            .accessibilityLabel("Home — Explorer")
        }
        // One group of named tool buttons. AppKit moves whichever don't fit
        // into the native `»` overflow menu. (ForEach can't emit individual
        // ToolbarItems — its closure is a ViewBuilder — but a group of views is
        // fine and still overflows.)
        ToolbarItemGroup(placement: .primaryAction) {
            ForEach(toolSections, id: \.self) { section in
                ToolbarToolButton(section: section)
            }
        }
        ToolbarItem(placement: .primaryAction) {
            HeaderAccountMenu()
        }
    }

    @ViewBuilder
    private func sectionLayout() -> some View {
        if shell.section == .library {
            // Library list | detail split — same VStack + inline SectionChromeBar
            // pattern as every other section, so its window header is identical
            // (no NavigationSplitView title-bar toggle).
            VStack(spacing: 0) {
                SectionChromeBar(toggles: [
                    SectionToggle(icon: "sidebar.left", isOn: libraryTreeVisible,
                                  helpOn: "Hide Library", helpOff: "Show Library") {
                        withAnimation(.easeInOut(duration: 0.2)) { libraryTreeVisible.toggle() }
                    }
                ])
                Divider()
                // Fixed-width list column (HSplitView doesn't reliably cap a
                // leading child's width); the detail fills the rest.
                HStack(spacing: 0) {
                    if libraryTreeVisible {
                        LibraryView(api: api)
                            .background(theme.current.surface)
                            .frame(width: 260)
                            .frame(maxHeight: .infinity)
                            .transition(.move(edge: .leading))
                        Divider()
                    }
                    LibraryDetailView(api: api)
                        .background(theme.current.body)
                        .frame(minWidth: 360, maxWidth: .infinity, maxHeight: .infinity)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                TerminalPanelView(projectDirectory: projectDirectory)
            }
        } else {
            VStack(spacing: 0) {
                detailColumn(shell.section)
                    .background(theme.current.body)
                // Explorer embeds the terminal INSIDE its editor column (right
                // of the file tree), so skip the shared full-width dock there.
                // Every other section gets the dock here, spanning the section.
                if shell.section != .explorer {
                    TerminalPanelView(projectDirectory: projectDirectory)
                }
            }
        }
    }

    @ViewBuilder
    private func detailColumn(_ section: ShellState.Section) -> some View {
        // Render only the active section. A previous version mounted
        // every visited section in a ZStack to preserve their @State,
        // but each section's `.toolbar { … }` modifier accumulates in
        // the host window toolbar simultaneously — producing duplicate
        // "New Change…" buttons and a stack of sidebar toggle icons.
        //
        // The state we most cared about preserving (Code Assistant
        // chat) is now persisted to disk via ChatSessionStore, so
        // single-section rendering is the right tradeoff: clean
        // toolbar, chat survives quit/relaunch, other view-local state
        // resets on menu switch (acceptable for filter selections etc).
        sectionView(for: section)
    }

    @ViewBuilder
    private func sectionView(for section: ShellState.Section) -> some View {
        switch section {
        case .library:   LibraryDetailView(api: api)
        case .live:      TranscriptView(api: api)
        case .explorer:  ExplorerView(api: api)
        case .search:    SearchView(api: api)
        case .plans:     ReviewView(api: api, config: .docs)
        case .conflicts: ReviewView(api: api, config: .conflicts)
        case .sourceControl: SourceControlView(api: api)
        case .issues:    issuesRoute
        case .gantt:     ganttRoute
        case .visual:    VisualView(api: api)
        case .docGen:    DocGenView(api: api)
        case .autoCode:  AutoCodeView(api: api)
        case .codeGraph: UAGraphView()
        case .regression: RegressionView(api: api)
        case .settings:  SettingsView(api: api)
        }
    }

    // ── Issues / Gantt routes ───────────────────────────────────
    // Both surfaces are backend-agnostic and serve GitHub + GitLab through the
    // RepoBackend abstraction. Each view owns its own provider picker (shown
    // only when both are configured), so AppShell just mounts them directly.
    /// Issues — unified RepoIssuesView for both providers (GitHub + GitLab).
    /// The view owns its own provider picker (shown when both are configured),
    /// so no separate top-level switch is needed here.
    @ViewBuilder
    private var issuesRoute: some View {
        RepoIssuesView(api: api)
    }

    /// Gantt. Unified RepoBackend-typed GanttContainerView serves both
    /// providers: GitLab uses native dates, GitHub uses the scheduling overlay
    /// (LlmIdeAPIClient issue-schedule). Like Issues, the view owns its own
    /// provider picker, so no separate top-level switch is needed.
    @ViewBuilder
    private var ganttRoute: some View {
        GanttContainerView(api: api)
    }

    private func initEnv() {
        do {
            // When a project is open, put the SQLite index in the project's
            // canonical system/ directory (alongside project.json and
            // sync.json), not inside meetings/.llmide/ where it would be
            // unscaffolded and harder to gitignore.
            let indexRoot = projectStore.activeProject
                .map { URL(fileURLWithPath: $0.localPath) }
            self.appEnv = try AppEnvironment(indexRootURL: indexRoot)
            // Populate the NOTES and MEETINGS sections from the bound project's
            // meetings/ and notes/ folders. Run OFF the main thread
            // (rescanAsync) so a large project's directory walk doesn't freeze
            // first paint — the Library fills in a beat later instead of the
            // window hanging on open.
            Task { await itemStore.rescanAsync() }
        } catch {
            self.envInitError = error.localizedDescription
        }
    }

    private func rebuildEnv() {
        // Drop the old env so its FolderIndexer kqueue source releases
        // its fd; the new env opens a fresh sqlite handle against the
        // new path on init.
        appEnv?.indexer.stopWatching()
        appEnv = nil
        envInitError = nil
        initEnv()
        NotificationCenter.default.post(name: .meetingIndexChanged, object: nil)
    }

    private func applyDeepLink(_ raw: String?) {
        guard let raw = raw,
              let section = ShellState.Section(deepLinkTabName: raw) else { return }
        shell.section = section
    }

    /// Honor edge transitions in the live-capture state without
    /// stomping the user's manual navigation.  Idle→active: jump to
    /// Live so the user sees captions.  Active→idle while still on
    /// Live: drop to Library so the newly-saved meeting is selectable.
    private func handleLiveEdge(wasActive: Bool, isActive: Bool) {
        // Reduce both sources to one bool — only the combined state
        // matters here.  Without this, ending session A while session
        // B is still live would bounce the user to Library.
        let combined = capture.isRunning || liveMirror.activeSession != nil
        if !wasActive && combined && shell.section != .live {
            shell.section = .live
        } else if wasActive && !combined && shell.section == .live {
            shell.section = .library
        }
    }

    private func checkRecovery() async {
        guard let env = appEnv else { return }
        let rec = PartialRecovery(notesFolder: env.notesConfig.currentFolder)
        do {
            if let o = try rec.scanOrphans().first {
                pendingOrphan = o
            }
        } catch {
            recoveryError = "Could not scan for partial recordings: \(error.localizedDescription)"
        }
    }

    private func checkLegacyPrompt() async {
        guard !legacyPromptSuppressed, appEnv != nil else { return }
        let count = await api.legacyMeetingCount()
        if count > 0 {
            await MainActor.run { showLegacyPrompt = true }
        }
    }

    private func dismissOrphan(_ o: PartialRecovery.Orphan) {
        if let env = appEnv {
            try? PartialRecovery(notesFolder: env.notesConfig.currentFolder).cleanup(id: o.id)
        }
        pendingOrphan = nil
    }

    private func recover(_ o: PartialRecovery.Orphan) {
        recoveryError = nil
        pendingOrphan = nil
        guard let env = appEnv else { return }
        let url = URL(fileURLWithPath: o.path)
        let root = env.notesConfig.currentFolder
        Task.detached(priority: .background) {
            do {
                try await withThrowingTaskGroup(of: Void.self) { group in
                    group.addTask {
                        let recovery = PartialRecovery(notesFolder: root)
                        guard FileManager.default.fileExists(atPath: url.path) else {
                            try? recovery.cleanup(id: o.id)
                            return
                        }
                        let store = MeetingFileStore(root: root)
                        _ = try store.finalize(
                            partialAt: url,
                            title: "Recovered",
                            endedAt: Date(),
                            participants: [])
                        try recovery.cleanup(id: o.id)
                        await rescanIndex()
                        NotificationCenter.default.post(name: .meetingIndexChanged, object: nil)
                    }
                    group.addTask {
                        try await Task.sleep(for: .seconds(30))
                        throw RecoveryTimeoutError()
                    }
                    _ = try await group.next()
                    // remaining task is cancelled automatically on scope exit
                }
            } catch is RecoveryTimeoutError {
                await MainActor.run { recoveryError = "Recovery timed out after 30 seconds." }
            } catch {
                let msg = error.localizedDescription
                await MainActor.run { recoveryError = msg }
            }
        }
    }

    private func runLegacyExport() {
        guard let env = appEnv else { return }
        let root = env.notesConfig.currentFolder
        let index = env.index
        let api = self.api
        Task.detached(priority: .background) {
            let exporter = LegacyExporter(
                store: MeetingFileStore(root: root),
                index: index)
            do {
                _ = try await exporter.export(records: api.exportAll())
            } catch APIError.noSession {
                // Auth missing — surface a banner rather than silently
                // failing. Was: try? swallowed every error including
                // noSession, so a signed-out user clicking Export saw
                // nothing happen at all.
                await MainActor.run { recoveryError = "Sign in to export legacy meetings." }
            } catch {
                await MainActor.run { recoveryError = "Legacy export failed: \(error.localizedDescription)" }
            }
            await rescanIndex()
            NotificationCenter.default.post(name: .meetingIndexChanged, object: nil)
        }
    }

    @MainActor
    // Mirror the Library's CODE section to the Settings lists (GitLab + GitHub).
    // Code repos appear only when a matching project exists in either Settings panel.
    /// If the user just hid the currently-displayed section (or launched
    /// with a stale-pinned hidden section), fall back to Library so the
    /// detail column doesn't show a view whose sidebar entry has
    /// disappeared.
    private func redirectIfSectionHidden() {
        if config.hiddenSidebarSections.contains(shell.section.rawValue) {
            shell.section = .library
        }
    }

    /// Bind the Library store to the active project root (single source of
    /// truth) and seed its external code-folder references from
    /// `config.localCodeFolders`.  Also installs the write-back so any
    /// folder the store adds (legacy migration, future "+ folder") persists
    /// back into config.  Idempotent — safe to call on every appear and
    /// project change.
    /// Ingest the open project's code into the KB `sources` corpus so the agent
    /// can SEARCH it (search-kb / findContext) — `read-file`/`list-files` only
    /// navigate by path. Fire-and-forget + best-effort: registers the workspace
    /// root on the allow-list, then runs the local FTS indexer (connect-git,
    /// ~local, no network/LLM, fast). Skips on project close (no root). If it
    /// fails, code search just stays empty — never blocks the UI.
    private func indexActiveProjectCode() {
        guard let root = WorkspaceRoot.resolve(config: config, projectStore: projectStore) else { return }
        let path = root.path
        let api = self.api
        Task.detached(priority: .utility) {
            do {
                try await api.addUserRepo(path: path)   // allow-list (idempotent)
                _ = try await api.connectGit(path: path) // ingest → KB sources
            } catch {
                // best-effort — leave code search empty rather than surfacing
            }
        }
    }

    private func bindLibraryStore() {
        // Persist store-originated external-folder mutations back into the
        // durable config list.  AppShell mediates config ↔ store so the
        // store stays free of an AppConfig dependency.
        itemStore.onExternalCodeFoldersChanged = { [weak config] paths in
            config?.localCodeFolders = paths
        }
        let root = projectStore.activeProject
            .map { URL(fileURLWithPath: $0.localPath) }
        itemStore.bindProject(root: root)
        itemStore.setExternalCodeFolders(config.localCodeFolders)
    }

    /// Ensures every path in `config.localCodeFolders` is referenced by the
    /// Library store as an external `.code` folder. Called on appear and
    /// whenever the list changes so new additions take effect without
    /// relaunch.  The store references folders in place (no copy) and
    /// rescans when the set changes.
    private func seedLocalCodeFolders() {
        itemStore.setExternalCodeFolders(config.localCodeFolders)
    }

    private func rescanIndex() async {
        do {
            try appEnv?.indexer.fullScan()
        } catch {
            recoveryError = "Index scan failed: \(error.localizedDescription)"
        }
    }

    // ── Re-summarize from Meetings file-tree context menu ─────────────
    // Reads the .md file, extracts the raw transcript, and runs the same
    // summarise → .docx pipeline CaptionScraper uses.  Non-fatal: failures
    // set recoveryError so the user sees a banner without losing anything.
    private func resummarizeMeetingFile(at fileURL: URL) async {
        guard let rawContent = try? String(contentsOf: fileURL, encoding: .utf8) else {
            recoveryError = "Could not read transcript: \(fileURL.lastPathComponent)"
            return
        }

        // Parse frontmatter + body using the shared FrontmatterCoder.
        // Prefer the live AppEnvironment so we always use the active project's
        // folder; fall back to UserDefaults if the env hasn't initialised yet.
        let root = appEnv?.notesConfig.currentFolder ?? NotesFolderConfig().currentFolder
        guard let split = FrontmatterCoder.split(file: rawContent),
              let fm = try? FrontmatterCoder.decode(split.yaml) else {
            recoveryError = "Could not parse meeting frontmatter: \(fileURL.lastPathComponent)"
            return
        }

        // Everything after the frontmatter block is the meeting body
        // (summary section + Transcript heading + caption lines).
        let transcript = String(rawContent[split.bodyStart...])

        let title = fm.title.isEmpty
            ? fileURL.deletingPathExtension().lastPathComponent
            : fm.title
        let indexer = appEnv?.indexer
        let notesOutputFolder = appEnv?.notesOutputFolder

        Task.detached(priority: .background) { [api] in
            // Build .docx path before entering the shared service.
            let dateSlug = AppDateFormatter.dateHourMinuteLocal(fm.startedAt)
            let stem     = fileURL.deletingPathExtension().lastPathComponent.prefix(8)
            let docxURL  = notesOutputFolder?.appendingPathComponent(
                "\(dateSlug)-\(stem)-meeting-notes.docx")

            // 1. AI summary + write summary + generate .docx (shared pipeline).
            await MeetingSummarizationService.run(
                api: api,
                transcript: transcript,
                title: title,
                language: fm.language,
                startedAt: fm.startedAt,
                durationSeconds: fm.durationSeconds,
                participants: fm.participants,
                transcriptFileURL: fileURL,
                docxOutputURL: docxURL,
                root: root)

            // 2. Re-scan so the library row updates with the new gist.
            try? indexer?.fullScan()

            await MainActor.run {
                NotificationCenter.default.post(name: .meetingIndexChanged, object: nil)
            }
        }
    }

    // ── Live-session auto-note generation ─────────────────────────────
    // When the Chrome extension finalizes a session, LiveSessionMirror
    // fires .liveSessionFinalized.  We mirror the CaptionScraper flow:
    //   1. Create a new .md file via MeetingFileStore
    //   2. Write the raw transcript into it
    //   3. Call api.summarize() to generate summary / action items
    //   4. Overwrite the summary section via writeSummary()
    //   5. Post .meetingIndexChanged so the Library refreshes
    //
    // Runs detached (background priority) so it doesn't block the UI.
    // Failures surface via recoveryError — the file still exists with
    // the raw transcript, so the user loses nothing on error.
    private func generateNoteForLiveSession(_ payload: LiveSessionMirror.FinalizedPayload) async {
        // Prefer the live AppEnvironment folder so a project switch is
        // immediately reflected; fall back to UserDefaults if env is nil.
        let root = appEnv?.notesConfig.currentFolder ?? NotesFolderConfig().currentFolder
        let store = MeetingFileStore(root: root)
        let startedAt = payload.startedAt ?? Date()
        let title = payload.meetingTitle.isEmpty
            ? "Meeting · \(AppDateFormatter.dateHourMinuteLocal(startedAt))"
            : payload.meetingTitle
        // Capture appEnv on main actor before jumping to background.
        let indexer = appEnv?.indexer
        let notesOutputFolder = appEnv?.notesOutputFolder

        Task.detached(priority: .background) { [api] in
            do {
                // 1. Create the partial .md file.
                let handle = try store.createPartial(
                    id: payload.sessionId,
                    startedAt: startedAt,
                    platform: "chrome-extension",
                    language: "")

                // 2. Write each caption using the proper appendCaption() method
                //    so the file gets the "[HH:MM:SS] **Speaker**: text" format
                //    that the Library markdown viewer renders correctly.
                for c in payload.captions {
                    try handle.appendCaption(
                        timestamp: c.timestamp,
                        speaker: c.speaker,
                        text: c.text)
                }
                try handle.flush()

                // 3. Rename .partial.md → dated .md file.
                let url = try store.finalize(
                    handle: handle,
                    title: title,
                    endedAt: Date(),
                    participants: payload.participants)

                try? PartialRecovery(notesFolder: root).cleanup(id: payload.sessionId)

                // 4. Force the Library index to pick up the new file immediately
                //    rather than waiting for the kqueue watcher's next tick.
                //    fullScan() is thread-safe (serialised via scanLock).
                try? indexer?.fullScan()

                // 5+7. AI summary + .docx note (non-fatal, 5-minute hard cap).
                //      Include a short session-id suffix to prevent overwriting
                //      when two meetings start within the same minute.
                let dateSlug = AppDateFormatter.dateHourMinuteLocal(startedAt)
                let idSuffix = payload.sessionId.prefix(8)
                let docxURL  = notesOutputFolder?.appendingPathComponent(
                    "\(dateSlug)-\(idSuffix)-meeting-notes.docx")
                await MeetingSummarizationService.run(
                    api: api,
                    transcript: payload.transcript,
                    title: title,
                    language: "",
                    startedAt: startedAt,
                    durationSeconds: nil,
                    participants: payload.participants,
                    transcriptFileURL: url,
                    docxOutputURL: docxURL,
                    root: root)

                // 6. Re-scan so the index picks up any frontmatter changes.
                try? indexer?.fullScan()

                // Keep the raw .md transcript in meetings/ so it
                // appears in the MEETINGS section of the Library.
                // The .docx note lives in notes/ for the NOTES section —
                // both are useful: transcript for full verbatim text,
                // .docx for the AI-summarised version.

                // 8. Notify the Library to refresh — must be on main thread.
                //    LibraryView's handler calls syncMeetingNotes(from: notesOutputFolder)
                //    which picks up the new note file written in step 7.
                await MainActor.run {
                    NotificationCenter.default.post(name: .meetingIndexChanged, object: nil)
                }
            } catch {
                await MainActor.run {
                    self.recoveryError = "Could not save live-session note: \(error.localizedDescription)"
                }
            }
        }
    }
}

// Notification.Name extensions moved to Services/NotificationNames.swift

