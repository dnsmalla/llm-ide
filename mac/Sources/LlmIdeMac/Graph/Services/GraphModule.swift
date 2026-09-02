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
