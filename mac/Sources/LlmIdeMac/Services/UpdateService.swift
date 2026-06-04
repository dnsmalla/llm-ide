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
        // startingUpdater: true means Sparkle launches its background
        // scheduler immediately at construction. Combined with the
        // `automaticallyChecksForUpdates` user preference, this
        // starts the once-a-day poll loop without us writing the
        // timer. updaterDelegate / userDriverDelegate are nil — we
        // accept the standard user-facing behaviour (modal sheet on
        // update found, etc.).
        controller = SPUStandardUpdaterController(
            startingUpdater: true,
            updaterDelegate: nil,
            userDriverDelegate: nil
        )

        // Mirror Sparkle's KVO'd `canCheckForUpdates` into our own
        // Combine publisher so SwiftUI views can observe directly.
        controller.updater.publisher(for: \.canCheckForUpdates)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] value in self?.canCheckForUpdates = value }
            .store(in: &cancellables)

        if controller.updater.feedURL?.absoluteString.isEmpty != false {
            log.info("Sparkle started without SUFeedURL — auto-update inert until the release build wires the appcast.")
        }
    }

    func checkForUpdates() {
        // The Standard user driver presents the modal sheet. There's
        // no async return; the user interacts with the sheet and
        // Sparkle drives the download/install on its own.
        controller.checkForUpdates(nil)
    }
}
