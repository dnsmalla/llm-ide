import Foundation

/// Feature module for `.mobileSync`: the native WebSocket server + Bonjour.
/// `start()` only launches the server when the user opted into Mobile
/// Control AND auto-start; the manual Start button in Settings keeps calling
/// the manager directly. `stop()` always stops the server.
///
/// `runtimeReady` intentionally inherits the default (`true`) instead of
/// tracking `controlEnabled()`: the registry must consider this module
/// "running" whenever the `.mobileSync` feature flag is on, so that `stop()`
/// always fires when a preset excludes mobileSync (Focused AI, Minimal
/// Editor) — even if the user enabled Mobile Control after launch by calling
/// the manager's start() directly from Settings. The user-level
/// enable/auto-start gates live inside `start()` instead.
@MainActor
final class MobileModule: AppModule {
    let feature: AppFeature = .mobileSync
    private let manager: any FeatureService
    private let controlEnabled: () -> Bool
    private let autoStart: () -> Bool

    init(manager: any FeatureService,
         controlEnabled: @escaping () -> Bool,
         autoStart: @escaping () -> Bool) {
        self.manager = manager
        self.controlEnabled = controlEnabled
        self.autoStart = autoStart
    }

    func start() {
        if controlEnabled() && autoStart() { manager.start() }
    }

    func stop() { manager.stop() }
}
