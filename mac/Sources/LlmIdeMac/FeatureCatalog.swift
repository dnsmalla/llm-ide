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
        return set
    }

    /// True when this build was compiled with the Graph feature — i.e. a
    /// lite build (`FEATURE_GRAPH` off) reports `false`. Callers outside
    /// this file use this instead of naming `#if FEATURE_GRAPH` directly, so
    /// a single seam decides "is Graph in this build" (`compiledFeatures`
    /// already encodes it — no new `#if` needed here).
    static var isGraphCompiled: Bool { compiledFeatures.contains(.codeGraph3D) }

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
}
