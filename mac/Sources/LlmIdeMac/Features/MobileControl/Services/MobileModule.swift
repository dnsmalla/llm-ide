import Foundation

// The method already exists on the manager; this declaration lets
// `MobileModule` hold it behind the shared `FeatureService` protocol.
// Mirrors GraphAutoUpdater's conformance in Graph/Services/GraphModule.swift
// and AutoCodeUpdateService's in AutoTask/Services/AutoTaskModule.swift.
extension MobileControlManager: FeatureService {}

/// Feature module for `.mobileSync`: the native WebSocket server + Bonjour.
/// `start()` only launches the server when the user opted into Mobile
/// Control AND auto-start; the manual Start button in Settings keeps calling
/// the manager directly. `stop()` always stops the server.
///
/// `runtimeReady` intentionally does NOT track `controlEnabled()`: the
/// registry must consider this module "running" whenever the `.mobileSync`
/// feature flag is on, so that `stop()` always fires when a preset excludes
/// mobileSync (Focused AI, Minimal Editor) — even if the user enabled Mobile
/// Control after launch by calling the manager's start() directly from
/// Settings. The user-level enable/auto-start gates live inside `start()`.
///
/// It DOES track sign-in: the paired phone belongs to the signed-in account,
/// so signing out stops the listener (dropping the connection) and signing
/// back in restarts it, like the other auth-scoped modules (Chat, Graph).
@MainActor
final class MobileModule: AppModule {
    let feature: AppFeature = .mobileSync
    private let manager: any FeatureService
    private let controlEnabled: () -> Bool
    private let autoStart: () -> Bool
    private let isAuthenticated: () -> Bool

    init(manager: any FeatureService,
         controlEnabled: @escaping () -> Bool,
         autoStart: @escaping () -> Bool,
         isAuthenticated: @escaping () -> Bool = { true }) {
        self.manager = manager
        self.controlEnabled = controlEnabled
        self.autoStart = autoStart
        self.isAuthenticated = isAuthenticated
    }

    var runtimeReady: Bool { isAuthenticated() }

    func start() {
        if controlEnabled() && autoStart() { manager.start() }
    }

    func stop() { manager.stop() }
}
