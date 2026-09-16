import Foundation

/// Feature module for `.codeGraph3D`: owns the GraphAutoUpdater lifecycle.
/// Auth-scoped — the updater talks to the backend, so it only runs while
/// signed in; login/logout call sites trigger `FeatureRegistry.refresh()`.
@MainActor
final class GraphModule: AppModule {
    let feature: AppFeature = .codeGraph3D
    private let updater: any FeatureService
    private let isAuthenticated: () -> Bool

    var runtimeReady: Bool { isAuthenticated() }

    init(updater: any FeatureService, isAuthenticated: @escaping () -> Bool) {
        self.updater = updater
        self.isAuthenticated = isAuthenticated
    }

    func start() { updater.start() }
    func stop() { updater.stop() }
}

// FeatureService conformance — the methods already exist on GraphAutoUpdater;
// this declaration lets it be held behind FeatureService by FeatureCatalog
// without the rest of the app needing to know the concrete type. Moved here
// (out of LlmIdeMacApp.swift) so it lives beside the module it backs.
extension GraphAutoUpdater: FeatureService {}
