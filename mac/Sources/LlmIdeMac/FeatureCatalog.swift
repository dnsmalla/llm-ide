import SwiftUI

/// The single seam between the app chrome and build-time-excludable
/// features. Every `#if FEATURE_*` in the app lives in THIS file; the rest
/// of the codebase talks to features through the catalog's factories.
/// When a feature is compiled out, its factory returns an inert value and
/// `compiledFeatures` omits it, so Settings shows "Not installed" and the
/// registry never starts it.
@MainActor
enum FeatureCatalog {

    static var compiledFeatures: Set<AppFeature> {
        var set = Set(AppFeature.allCases)
        #if !FEATURE_GRAPH
        set.remove(.codeGraph3D)
        #endif
        #if !FEATURE_EXPLORER
        set.remove(.fileExplorer)
        #endif
        #if !FEATURE_GANTT
        set.remove(.ganttIssues)
        #endif
        #if !FEATURE_DOCGEN
        set.remove(.docGen)
        #endif
        #if !FEATURE_TERMINAL
        set.remove(.terminal)
        #endif
        #if !FEATURE_AUTOTASK
        set.remove(.autoTasks)
        #endif
        #if !FEATURE_MOBILE
        set.remove(.mobileSync)
        #endif
        return set
    }

    /// True when this build was compiled with the Graph feature — i.e. a
    /// lite build (`FEATURE_GRAPH` off) reports `false`. Callers outside
    /// this file use this instead of naming `#if FEATURE_GRAPH` directly, so
    /// a single seam decides "is Graph in this build" (`compiledFeatures`
    /// already encodes it — no new `#if` needed here).
    static var isGraphCompiled: Bool { compiledFeatures.contains(.codeGraph3D) }

    /// True when this build was compiled with the Mobile Sync feature — i.e.
    /// a build with `FEATURE_MOBILE` off reports `false`. Callers outside
    /// this file use this instead of naming `#if FEATURE_MOBILE` directly, so
    /// a single seam decides "is Mobile in this build" (`compiledFeatures`
    /// already encodes it — no new `#if` needed here).
    static var isMobileCompiled: Bool { compiledFeatures.contains(.mobileSync) }

    // MARK: - Graph

    #if FEATURE_GRAPH
    private static var graphAutoUpdater: GraphAutoUpdater?
    private static var graphSessionStore: GraphSessionStore?
    #endif

    /// Build + wire the graph stack and register its module. No-op when the
    /// feature is compiled out. Mirrors what LlmIdeMacApp.init used to do
    /// inline (construction order and wiring preserved).
    static func bootGraph(projectStore: ProjectStore,
                          config: AppConfig,
                          api: LlmIdeAPIClient,
                          activity: ActivityStore,
                          registry: FeatureRegistry,
                          isAuthenticated: @escaping () -> Bool) {
        #if FEATURE_GRAPH
        let updater = GraphAutoUpdater(projectStore: projectStore,
                                       intervalMinutes: config.graphAutoUpdateMinutes)
        let sessionStore = GraphSessionStore()
        updater.activity = activity
        updater.uploader.api = api
        updater.sessionStore = sessionStore
        graphAutoUpdater = updater
        graphSessionStore = sessionStore
        registry.register(module: GraphModule(
            updater: updater, isAuthenticated: isAuthenticated))
        #endif
    }

    /// Inject the graph environment objects (identity when compiled out).
    static func installGraphEnvironment(_ view: AnyView) -> AnyView {
        #if FEATURE_GRAPH
        guard let updater = graphAutoUpdater, let store = graphSessionStore else {
            // bootGraph() wires graphAutoUpdater/graphSessionStore before any
            // view can call this — reaching here means the environment was
            // installed before boot, not that Graph is absent.
            assertionFailure("installGraphEnvironment called before bootGraph")
            return view
        }
        return AnyView(view.environmentObject(updater).environmentObject(store))
        #else
        return view
        #endif
    }

    static func graphMainPane() -> AnyView {
        #if FEATURE_GRAPH
        return AnyView(UAGraphView())
        #else
        return AnyView(EmptyView())
        #endif
    }

    static func graphSettingsSection() -> AnyView? {
        #if FEATURE_GRAPH
        return AnyView(GraphSettingsSection())
        #else
        return nil
        #endif
    }

    /// Drop the cached graph-engine resolution (e.g. after a plugin
    /// install/uninstall may have added or removed one). No-op when the
    /// feature is compiled out — callers outside Graph/ (auth/plugin routes)
    /// go through this seam instead of naming `GraphEngines` directly.
    static func invalidateGraphEngineCache() {
        #if FEATURE_GRAPH
        GraphEngines.invalidate()
        #endif
    }

    // MARK: - Explorer

    /// Project file browser. No module-owned services — construction happens
    /// per-render, same as AppShell did before this seam existed.
    static func explorerPane(api: LlmIdeAPIClient) -> AnyView {
        #if FEATURE_EXPLORER
        return AnyView(ExplorerView(api: api))
        #else
        return AnyView(EmptyView())
        #endif
    }

    /// Search over the active project's files. Excluded together with the
    /// Explorer (`file_explorer`) — see Package.swift's `libExcludes`.
    static func searchPane(api: LlmIdeAPIClient) -> AnyView {
        #if FEATURE_EXPLORER
        return AnyView(SearchView(api: api))
        #else
        return AnyView(EmptyView())
        #endif
    }

    /// Git status / staging / diff view. Excluded together with the Explorer
    /// (`file_explorer`) — see Package.swift's `libExcludes`.
    static func sourceControlPane(api: LlmIdeAPIClient) -> AnyView {
        #if FEATURE_EXPLORER
        return AnyView(SourceControlView(api: api))
        #else
        return AnyView(EmptyView())
        #endif
    }

    // MARK: - Gantt / Issues

    static func issuesPane(api: LlmIdeAPIClient) -> AnyView {
        #if FEATURE_GANTT
        return AnyView(RepoIssuesView(api: api))
        #else
        return AnyView(EmptyView())
        #endif
    }

    static func ganttPane(api: LlmIdeAPIClient) -> AnyView {
        #if FEATURE_GANTT
        return AnyView(GanttContainerView(api: api))
        #else
        return AnyView(EmptyView())
        #endif
    }

    // MARK: - Doc Gen

    static func docGenPane(api: LlmIdeAPIClient) -> AnyView {
        #if FEATURE_DOCGEN
        return AnyView(DocGenView(api: api))
        #else
        return AnyView(EmptyView())
        #endif
    }

    // MARK: - Terminal

    #if FEATURE_TERMINAL
    /// Backing store for the Terminal feature's tab sessions — mirrors the
    /// Graph section's `graphAutoUpdater`/`graphSessionStore` pattern
    /// (module-owned state kept in the catalog, not in core). Shared by
    /// `installTerminalHooks(on:)` and `terminalPanel(projectDirectory:)` so
    /// both see the same session list.
    private static let terminalSessions = TerminalDockSessions()
    #endif

    /// Wires `TerminalPanelState.onToggleRequested` to
    /// `TerminalDockSessions.handleToggle(_:projectDirectory:)`. Called once
    /// from AppShell right after constructing its `TerminalPanelState` —
    /// unconditionally; this function (and `terminalPanel` below) are the
    /// ONLY places `#if FEATURE_TERMINAL` appears for this feature. No-op
    /// when the feature is compiled out, leaving `onToggleRequested` nil so
    /// `TerminalPanelState.toggle()` falls back to a plain open/close flip.
    static func installTerminalHooks(on state: TerminalPanelState) {
        #if FEATURE_TERMINAL
        state.onToggleRequested = { state, directory in
            terminalSessions.handleToggle(state, projectDirectory: directory)
        }
        #endif
    }

    /// Used by both AppShell call sites (the shared bottom dock) and
    /// ExplorerView (its embedded editor-column dock).
    static func terminalPanel(projectDirectory: URL) -> AnyView {
        #if FEATURE_TERMINAL
        return AnyView(TerminalPanelView(projectDirectory: projectDirectory)
            .environment(terminalSessions))
        #else
        return AnyView(EmptyView())
        #endif
    }

    // MARK: - Auto Tasks / Loop

    #if FEATURE_AUTOTASK
    private static var autoTaskSettings: AutoTaskSettings?
    private static var autoCodeService: AutoCodeUpdateService?
    private static var autoTaskTemplates: AutoTaskTemplateStore?
    private static var autoTaskSkills: AutoTaskSkillCatalog?
    private static var autoTaskLogStore: TaskLogStore?
    #endif

    /// Build + wire the ENTIRE Auto Task / Loop stack (scheduler + settings +
    /// templates + skills + log store + on-disk run/action history) and
    /// register `AutoTaskModule`. No-op when the feature is compiled out.
    /// Mirrors what LlmIdeMacApp.init used to do inline — construction order
    /// and every wiring line preserved. The mobile-bridge wiring that used to
    /// happen inline here now goes through `wireMobileFeatureBridges()` (see
    /// the Mobile section below), so this function no longer needs a
    /// `MobileControlManager` passed in.
    static func bootAutoTask(config: AppConfig,
                             projectStore: ProjectStore,
                             api: LlmIdeAPIClient,
                             activity: ActivityStore,
                             capture: AutoCaptureService,
                             registry: FeatureRegistry,
                             appSupportDir: URL) {
        #if FEATURE_AUTOTASK
        let registryURL = appSupportDir.appendingPathComponent("processed-actions.json")
        let processedActions = ProcessedActionsRegistry(storeURL: registryURL)
        let runHistoryURL = appSupportDir.appendingPathComponent("auto-task-runs.json")
        let runHistory = AutoTaskRunHistory(storeURL: runHistoryURL)
        let settings = AutoTaskSettings()
        let taskLog = TaskLogStore()
        // `backend: nil` ⇒ auto-resolve from the active project's `linkedRepo`,
        // which supports BOTH GitLab and GitHub (set by syncLinkedRepoFromConfig).
        // Passing a GitLabClient here used to set `backendOverride` to a GitLab
        // backend, which made resolveBackendAndProject() short-circuit into
        // resolveWithBackend() — a path that ONLY checks GitLab saved projects.
        // GitHub repos were silently ignored → "No linked repo". Leave the
        // override for tests only.
        let service = AutoCodeUpdateService(
            config: config,
            autoTaskSettings: settings,
            backend: nil,
            registry: processedActions,
            runHistory: runHistory,
            projectStore: projectStore,
            api: api,
            logStore: taskLog)

        // The registry's `bootstrap()` (the disk-read path) is invoked
        // from the AppShell's first `.task` tick — see `autoCode.start()`
        // which performs it lazily before any registry query.  Errors are
        // surfaced after bootstrap inside AutoCodeUpdateService.
        processedActions.onSaveError = { [weak service] error in
            Task { @MainActor in
                service?.setError("Action history failed to save: \(error.localizedDescription)")
            }
        }
        runHistory.onSaveError = { [weak service] error in
            Task { @MainActor in
                service?.setError("Run history failed to save: \(error.localizedDescription)")
            }
        }

        // The runner resolves a task's selected template at run time, and the
        // store repoints task configs when a template is renamed or deleted —
        // otherwise a rename would silently drop every task back to its own
        // prompt.
        let templates = AutoTaskTemplateStore()
        templates.onTemplateIdChanged = { [weak service] oldId, newId in
            service?.taskConfigs.retargetTemplate(from: oldId, to: newId)
        }
        service.autoTaskTemplates = templates
        let skills = AutoTaskSkillCatalog()

        // Wire activity store weak refs on app-level services so they can
        // report events without a global singleton. Mirrors weak var config
        // on RegressionRunner.
        service.activity = activity

        autoTaskSettings = settings
        autoCodeService = service
        autoTaskTemplates = templates
        autoTaskSkills = skills
        autoTaskLogStore = taskLog

        // Wire the Auto Task + Loop feature bridges onto the mobile manager
        // so the phone can query scheduler state (`auto_task_list`), toggle
        // master / per-task enables (`auto_task_toggle`), and control the
        // active project's Loop (`loop_*`). `wireMobileFeatureBridges()` is
        // idempotent and also called from `bootMobile` — whichever of the
        // two boot functions runs second is the one that actually wires it,
        // since each needs the OTHER feature's stored static to exist.
        wireMobileFeatureBridges()

        registry.register(module: AutoTaskModule(
            scheduler: service,
            capture: capture,
            schedulerEnabled: { settings.enabled }))
        #endif
    }

    /// Inject the five Auto Task / Loop environment objects (identity when
    /// compiled out).
    static func installAutoTaskEnvironment(_ view: AnyView) -> AnyView {
        #if FEATURE_AUTOTASK
        guard let settings = autoTaskSettings, let service = autoCodeService,
              let templates = autoTaskTemplates, let skills = autoTaskSkills,
              let logStore = autoTaskLogStore else {
            // bootAutoTask() wires these statics before any view can call
            // this — reaching here means the environment was installed
            // before boot, not that Auto Tasks is absent.
            assertionFailure("installAutoTaskEnvironment called before bootAutoTask")
            return view
        }
        return AnyView(view
            .environmentObject(settings)
            .environmentObject(service)
            .environmentObject(templates)
            .environmentObject(skills)
            .environmentObject(logStore))
        #else
        return view
        #endif
    }

    static func autoTasksPane(api: LlmIdeAPIClient) -> AnyView {
        #if FEATURE_AUTOTASK
        return AnyView(AutoCodeView(api: api))
        #else
        return AnyView(EmptyView())
        #endif
    }

    static func loopEnginePane(api: LlmIdeAPIClient) -> AnyView {
        #if FEATURE_AUTOTASK
        return AnyView(LoopEngineHomeView(api: api))
        #else
        return AnyView(EmptyView())
        #endif
    }

    /// Rebind Auto Task templates/skills/per-task configs to the active
    /// project. Called from AppShell's `reloadDocTemplatesForActiveProject`
    /// on project open/close/switch (the three auto-task lines of that
    /// function). No-op when compiled out.
    static func rebindAutoTaskProject(root: URL?, projectId: String?) {
        #if FEATURE_AUTOTASK
        autoTaskTemplates?.bindProject(root: root)
        autoTaskSkills?.reload(projectRoot: root, force: true)
        autoCodeService?.taskConfigs.bindProject(id: projectId)
        #endif
    }

    /// Point the Auto Task scheduler at the active project's AppEnvironment
    /// (nil on close/rebuild). Called from AppShell's initEnv()/rebuildEnv().
    /// No-op when compiled out.
    static func setAutoCodeEnvironment(_ environment: AppEnvironment?) {
        #if FEATURE_AUTOTASK
        autoCodeService?.environment = environment
        #endif
    }

    // MARK: - Mobile

    #if FEATURE_MOBILE
    private static var mobileControlManager: MobileControlManager?
    #endif

    /// Build + wire the Mobile Control stack (native WebSocket server +
    /// Bonjour advertiser + PIN pairing) and register `MobileModule`. No-op
    /// when the feature is compiled out. Mirrors what LlmIdeMacApp.init used
    /// to do inline (construction order and wiring preserved). Must run
    /// BEFORE `bootAutoTask` in the app root — `wireMobileFeatureBridges()`
    /// (called at the tail of both) is idempotent either way, but this keeps
    /// the same order the inline code used.
    static func bootMobile(config: AppConfig,
                           api: LlmIdeAPIClient,
                           projectStore: ProjectStore,
                           backend: BackendManager,
                           registry: FeatureRegistry) {
        #if FEATURE_MOBILE
        let manager = MobileControlManager()
        // Hand the API client to the mobile control manager so inbound
        // llm-ide chat turns from the iPhone can be proxied to the backend.
        manager.api = api
        manager.config = config
        manager.projectStore = projectStore
        manager.backendManager = backend
        mobileControlManager = manager

        registry.register(module: MobileModule(
            manager: manager,
            controlEnabled: { config.mobileControlEnabled },
            autoStart: { config.mobileControlAutoStart }))

        wireMobileFeatureBridges()
        #endif
    }

    /// Inject the mobile control environment object (identity when compiled
    /// out). Replaces the app root's `.environment(mobileControl)`.
    static func installMobileEnvironment(_ view: AnyView) -> AnyView {
        #if FEATURE_MOBILE
        guard let manager = mobileControlManager else {
            // bootMobile() wires mobileControlManager before any view can
            // call this — reaching here means the environment was installed
            // before boot, not that Mobile Control is absent.
            assertionFailure("installMobileEnvironment called before bootMobile")
            return view
        }
        return AnyView(view.environment(manager))
        #else
        return view
        #endif
    }

    /// Must run AFTER both `bootMobile` and `bootAutoTask` — it installs push
    /// observers on the Auto Task / Loop mobile bridges those boot functions
    /// construct. No-op when compiled out.
    static func installMobilePushObservers() {
        #if FEATURE_MOBILE
        mobileControlManager?.installMobilePushObservers()
        #endif
    }

    /// Stop the mobile server on app termination. No-op when compiled out.
    static func stopMobile() {
        #if FEATURE_MOBILE
        mobileControlManager?.stop()
        #endif
    }

    /// Forward: the active project changed. No-op when compiled out.
    static func notifyMobileWorkspaceChanged() {
        #if FEATURE_MOBILE
        mobileControlManager?.onWorkspaceChanged()
        #endif
    }

    /// Forward: the Mac-side environment changed (project/backend state).
    /// No-op when compiled out.
    static func notifyMobileMacEnvironmentChanged() {
        #if FEATURE_MOBILE
        mobileControlManager?.onMacEnvironmentChanged()
        #endif
    }

    /// Forward: the local backend became ready. No-op when compiled out.
    static func notifyMobileBackendReady() {
        #if FEATURE_MOBILE
        mobileControlManager?.onBackendReady()
        #endif
    }

    static func mobileControlSettingsSection() -> AnyView? {
        #if FEATURE_MOBILE
        return AnyView(MobileControlSettingsSection())
        #else
        return nil
        #endif
    }

    /// Refresh Auto Task state for the phone (scheduler list + logs).
    /// AutoCodeView calls this instead of holding its own
    /// `@Environment(MobileControlManager.self)`. No-op when compiled out.
    static func refreshAutoTaskStateForMobile() {
        #if FEATURE_MOBILE
        mobileControlManager?.refreshAutoTaskStateForMobile()
        #endif
    }

    /// KeychainStore calls these instead of naming `MobilePin` directly
    /// (precedent: `invalidateGraphEngineCache` above). No-op when compiled
    /// out. `nonisolated` — unlike the manager-forwarding seams above, these
    /// wrap `MobilePin`'s own static cache (not the MainActor-isolated
    /// `mobileControlManager`), and KeychainStore's callers (session warm-up
    /// at app launch, wipe-on-logout) are synchronous, non-MainActor-
    /// isolated call sites, same as `MobilePin.warmCache()`/
    /// `clearSessionCache()` were before this seam existed.
    nonisolated static func warmMobilePinCache() {
        #if FEATURE_MOBILE
        MobilePin.warmCache()
        #endif
    }

    nonisolated static func clearMobilePinSessionCache() {
        #if FEATURE_MOBILE
        MobilePin.clearSessionCache()
        #endif
    }

    /// Wire the Auto Task + Loop feature bridges onto the stored mobile
    /// manager so the phone can query scheduler state (`auto_task_list`),
    /// toggle master / per-task enables (`auto_task_toggle`), and control
    /// the active project's Loop (`loop_*`). Both bridges share the same
    /// instances the UI observes — mutating through them keeps Settings, the
    /// Menu bar, and the scheduler in sync.
    ///
    /// Called unconditionally from the tail of both `bootMobile` and
    /// `bootAutoTask` — a true no-op unless BOTH features are compiled in,
    /// and idempotent (guarded on `autoTaskBridge == nil`) so it's safe for
    /// whichever of the two boot functions runs second to be the one that
    /// actually wires it, regardless of app-root call order.
    private static func wireMobileFeatureBridges() {
        #if FEATURE_AUTOTASK && FEATURE_MOBILE
        guard let mobile = mobileControlManager,
              let service = autoCodeService,
              let settings = autoTaskSettings,
              let taskLog = autoTaskLogStore,
              mobile.autoTaskBridge == nil else { return }
        mobile.autoTaskBridge = MobileAutoTaskBridge(
            manager: mobile, autoCode: service,
            settings: settings, logStore: taskLog)
        mobile.loopBridge = MobileLoopBridge(
            manager: mobile, autoCode: service)
        #endif
    }
}
