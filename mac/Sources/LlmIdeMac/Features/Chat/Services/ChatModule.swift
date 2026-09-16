import Foundation

/// Feature module for `.agentChat`: owns the LiveSessionMirror polling
/// lifecycle. Auth-scoped — unauthenticated polling just 401s in a loop.
@MainActor
final class ChatModule: AppModule {
    let feature: AppFeature = .agentChat
    private let mirror: any FeatureService
    private let isAuthenticated: () -> Bool

    var runtimeReady: Bool { isAuthenticated() }

    init(mirror: any FeatureService, isAuthenticated: @escaping () -> Bool) {
        self.mirror = mirror
        self.isAuthenticated = isAuthenticated
    }

    func start() { mirror.start() }
    func stop() { mirror.stop() }
}
