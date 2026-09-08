import AppKit
import Foundation
import UserNotifications

/// Posts a macOS user notification when a Loop run reaches a terminal status.
///
/// Loop runs are designed to go unattended for tens of minutes; without this,
/// the only completion signal was a log line on a page the user had usually
/// navigated away from. Notifies only while the app is NOT frontmost — in the
/// foreground the run header and log already show the outcome, and a banner
/// on top of them would be noise.
enum LoopRunNotifier {

    /// A bare `swift build` executable (a dev run outside a `.app` bundle)
    /// has no bundle identifier, and `UNUserNotificationCenter.current()`
    /// raises `NSInternalInconsistencyException` there — notifications are a
    /// bundle-only affordance, so a non-bundle process must never touch the
    /// framework at all.
    private static var isNotificationCapable: Bool {
        Bundle.main.bundleIdentifier != nil
    }

    /// Once per process — the system remembers the answer, so re-asking is a
    /// redundant XPC round trip per call site.
    @MainActor private static var didRequestAuthorization = false

    /// Ask for notification permission NOW, while the user is looking at the
    /// app. Called from foreground moments (opening the Loop page — the only
    /// surface that can schedule a loop — and pressing Run), never from
    /// `notify` — the permission alert is one-shot on macOS, and raising it
    /// from `notify` would guarantee it appears while the app is in the
    /// background, behind whatever the user switched to, where a missed or
    /// reflex-denied prompt silently kills every future banner.
    @MainActor
    static func prepareAuthorization() {
        guard isNotificationCapable, !didRequestAuthorization else { return }
        didRequestAuthorization = true
        UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    /// Convenience for a single loop's terminal status.
    @MainActor
    static func notifyRunFinished(loopName: String, status: LoopEngineStatus,
                                  duration: TimeInterval) {
        let ok = status.code == LoopEngineStatus.success.code
        notify(title: ok ? "Loop finished — \(loopName)" : "Loop needs attention — \(loopName)",
               body: "\(status.summary) · \(formatDuration(duration))")
    }

    /// Posts if (and only if) permission was already granted — authorization
    /// is `prepareAuthorization`'s job. Fail-open everywhere: a notification
    /// must never gate or fail the run it reports on.
    @MainActor
    static func notify(title: String, body: String) {
        guard isNotificationCapable else { return }
        // Optional-bound, never `NSApp.isActive` directly: `NSApp` is an
        // implicitly-unwrapped optional and is nil in any process without an
        // NSApplication (a test bundle host, a bundled helper) — where the
        // bundle-id guard above does NOT cover for it.
        if let app = NSApp, app.isActive { return }
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized
                    || settings.authorizationStatus == .provisional else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            center.add(UNNotificationRequest(identifier: UUID().uuidString,
                                             content: content, trigger: nil))
        }
    }

    private static func formatDuration(_ seconds: TimeInterval) -> String {
        let total = Int(seconds)
        if total < 60 { return "\(total)s" }
        return "\(total / 60)m \(total % 60)s"
    }
}
