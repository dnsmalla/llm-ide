import SwiftUI
import UIKit
import UserNotifications
import SharedProtocol

/// Exists only for APNs: iOS hands the device token, or the failure, to the app delegate.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in PushRegistrar.shared.tokenArrived(deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in PushRegistrar.shared.registrationFailed() }
    }

    /// Show the banner while the app is open too: the desktop already skipped the push when the user was at the desk.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}

/// Push notifications from the paired desktop (Host API v1 capability `push`). On a desktop that serves `push` it asks
/// once for alert permission, registers for remote notifications and sends the device token with `push.register`.
/// Without the Push Notifications capability in the Xcode project (plan user step A) iOS refuses the registration
/// and this only records why.
@MainActor
final class PushRegistrar: ObservableObject {
    static let shared = PushRegistrar()

    enum Status: Equatable { case off, on, denied, failed(String) }
    @Published private(set) var status: Status = .off

    weak var connection: ConnectionService?
    private var token: Data?

    #if DEBUG
    static let isDebug = true
    #else
    static let isDebug = false
    #endif

    /// Called when a connection is up and whenever the host's capabilities change.
    func hostReady() {
        guard let c = connection, c.connectionStatus == .connected, HostApiPush.isOn(capabilities: c.hostCapabilities) else { return }
        Task {
            let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])) ?? false
            guard granted else { status = .denied; return }
            if let token { await register(token) } else { UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    func tokenArrived(_ t: Data) {
        token = t
        Task { await register(t) }
    }

    func registrationFailed() {
        status = .failed("This build of the app cannot receive push notifications.")
    }

    private func register(_ t: Data) async {
        guard let c = connection, c.connectionStatus == .connected, HostApiPush.isOn(capabilities: c.hostCapabilities) else { return }
        do {
            _ = try await c.host.send(.pushRegister, HostApiPush.registerRequest(token: t, isDebug: Self.isDebug),
                                      as: HostApiPushRegisterResult.self)
            status = .on
        } catch {
            let text = (error as? HostApiRejection)?.message ?? ""
            status = .failed(text.isEmpty ? "The desktop did not accept this phone for push notifications." : String(text.prefix(500)))
        }
    }
}
