import Foundation

/// Feature module for `.mobileSync`: the native WebSocket server + Bonjour.
/// `start()` only launches the server when the user opted into auto-start;
/// the manual Start button in Settings keeps calling the manager directly.
/// `stop()` always stops the server — a preset that excludes mobileSync
/// (Focused AI, Minimal Editor) must tear the listener down.
@MainActor
final class MobileModule: AppModule {
    let feature: AppFeature = .mobileSync
    private let manager: any FeatureService
    private let controlEnabled: () -> Bool
    private let autoStart: () -> Bool

    var runtimeReady: Bool { controlEnabled() }

    init(manager: any FeatureService,
         controlEnabled: @escaping () -> Bool,
         autoStart: @escaping () -> Bool) {
        self.manager = manager
        self.controlEnabled = controlEnabled
        self.autoStart = autoStart
    }

    func start() {
        if autoStart() { manager.start() }
    }

    func stop() { manager.stop() }
}
