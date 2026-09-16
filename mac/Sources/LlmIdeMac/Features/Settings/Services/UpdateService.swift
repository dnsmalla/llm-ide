// Sparkle wrapper.
//
// We expose three things to the rest of the app:
//
//   1. `checkForUpdates()` — manual check, invoked from the menu bar
//      "Check for updates…" item. Always shows UI feedback ("you're
//      up to date" vs "update available"), even when no update is
//      pending. Distinct from the background check.
//
//   2. `automaticChecksEnabled` — bound to a Settings toggle so the
//      user can opt out of background polling. Persisted by Sparkle
//      itself (UserDefaults key `SUEnableAutomaticChecks`).
//
//   3. `canCheckForUpdates` — @Published flag the menu disables when
//      a check is already in flight. Prevents double-clicks from
//      stacking modal sheets.
//
// We don't expose Sparkle's full surface. Beta channels, automatic
// downloads, scheduled-checks override, etc. are all defaults today.
// Add them when there's a concrete need.
//
// Sparkle is gated entirely behind the Info.plist `SUFeedURL` key —
// when that key is missing or empty (the default for dev builds via
// `swift run` without the build.sh wrapper), Sparkle won't poll.
// The "Check for updates" menu item still works, just produces "no
// updates available" because the feed is empty.

import AppKit
import Combine
import Foundation
import os.log
import Sparkle

@MainActor
final class UpdateService: ObservableObject {

    // Sparkle's recommended "controller" entry point. It owns the
    // SPUUpdater + SPUStandardUserDriver internally and wires up the
    // menu validation + view-binding plumbing.
    private let controller: SPUStandardUpdaterController

    /// Release builds set `SUFeedURL` in Info.plist (via `Scripts/build.sh`).
    /// Dev launches (`swift run`, `Scripts/run.sh`) omit it — Sparkle's helper
    /// cannot start in that bundle layout and shows "Unable to Check For Updates".
    private(set) var isUpdateFeedConfigured: Bool

    /// True when manual checkForUpdates() is currently safe (no
    /// in-flight check). Bound to the menu item's `.disabled(...)`.
    @Published private(set) var canCheckForUpdates = true

    /// Bound to Settings → Updates → "Check automatically". Reading
    /// + writing Sparkle's setting keeps the user's preference in
    /// sync with the framework.
    var automaticChecksEnabled: Bool {
        get { controller.updater.automaticallyChecksForUpdates }
        set { controller.updater.automaticallyChecksForUpdates = newValue }
    }

    private let log = Logger(subsystem: "com.llmide.macapp", category: "Update")
    private var cancellables = Set<AnyCancellable>()

    init() {
        let feed = Bundle.main.infoDictionary?["SUFeedURL"] as? String
        isUpdateFeedConfigured = !(feed ?? "").isEmpty

        // Only start Sparkle's background scheduler when a release appcast is
        // wired. Dev bundles lack both SUFeedURL and the Autoupdate helper
        // layout Sparkle expects — starting the updater there produces a scary
        // modal on every manual/automatic check.
        controller = SPUStandardUpdaterController(
            startingUpdater: isUpdateFeedConfigured,
            updaterDelegate: nil,
            userDriverDelegate: nil
        )

        // Mirror Sparkle's KVO'd `canCheckForUpdates` into our own
        // Combine publisher so SwiftUI views can observe directly.
        controller.updater.publisher(for: \.canCheckForUpdates)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] value in
                guard let self else { return }
                self.canCheckForUpdates = self.isUpdateFeedConfigured && value
            }
            .store(in: &cancellables)

        if !isUpdateFeedConfigured {
            log.info("Sparkle inactive — no SUFeedURL (expected for dev builds).")
        }
    }

    func checkForUpdates() {
        guard isUpdateFeedConfigured else {
            let alert = NSAlert()
            alert.messageText = "Updates Not Available in This Build"
            alert.informativeText = """
            You're running a development build of LLM-IDE. Auto-update only works in release builds installed from the DMG.

            To get the latest code, pull from git and rebuild:
            cd mac && ./Scripts/run.sh
            """
            alert.alertStyle = .informational
            alert.runModal()
            return
        }
        // The Standard user driver presents the modal sheet. There's
        // no async return; the user interacts with the sheet and
        // Sparkle drives the download/install on its own.
        controller.checkForUpdates(nil)
    }
}
