import AppKit
import SwiftUI
import os.log

/// Handles classic AppKit lifecycle events that SwiftUI doesn't fully
/// cover on its own:
///
///   - Dock-icon click while no window is visible → reopen the main
///     window instead of leaving the user staring at a no-op bounce.
///   - Last window closed → keep the process alive so the menu-bar
///     item stays usable and subsequent deep links don't have to
///     pay the cold-start cost.
///   - Termination on Cmd-Q → tear down the capture orchestrator
///     cleanly via the standard SwiftUI shutdown path (no extra work
///     here; documented for posterity).
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let log = Logger(subsystem: "com.llmide.macapp", category: "AppDelegate")
    private var didActivateOnce = false

    /// `applicationDidFinishLaunching` fires before SwiftUI creates the
    /// window, so activate here instead — by this point SwiftUI has
    /// laid out and the window exists.  The flag prevents the steal-focus
    /// behaviour from repeating every time the user Cmd-Tabs back.
    func applicationDidBecomeActive(_ notification: Notification) {
        guard !didActivateOnce else { return }
        didActivateOnce = true
        DispatchQueue.main.async {
            NSApp.activate(ignoringOtherApps: true)
            NSApp.windows.first(where: { $0.canBecomeMain })?.makeKeyAndOrderFront(nil)
        }
    }

    /// Called when the user clicks the dock icon AND there are no
    /// visible windows.  Returning `true` tells AppKit to ask the
    /// SwiftUI scene to recreate the main window — which is exactly
    /// what we want.
    func applicationShouldHandleReopen(
        _ sender: NSApplication,
        hasVisibleWindows: Bool
    ) -> Bool {
        log.info("reopen request — visible windows: \(hasVisibleWindows ? "yes" : "no", privacy: .public)")
        if !hasVisibleWindows {
            // Try to bring back any window that exists but is hidden /
            // closed-but-cached before asking SwiftUI to mint a new
            // one.  Cheaper, and avoids a "new window" flicker.
            for window in sender.windows where window.canBecomeMain {
                window.makeKeyAndOrderFront(nil)
                if window.isMiniaturized { window.deminiaturize(nil) }
            }
        }
        return true
    }

    /// Don't auto-quit when the user closes the window.  The app
    /// stays running via the menu-bar item; the next deep link or
    /// dock click brings the window back without a relaunch.  This
    /// matches the behaviour of "real" macOS apps like Mail, Slack,
    /// and Discord.
    func applicationShouldTerminateAfterLastWindowClosed(
        _ sender: NSApplication
    ) -> Bool {
        return false
    }
}
