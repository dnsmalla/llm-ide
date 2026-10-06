import Foundation
import Observation

/// Which repos have an environment setup (a `pip install` into the project's
/// venv) running, and the last message each produced.
///
/// Process-wide on purpose: the setup outlives the Loop page. AppShell rebuilds
/// a section's view on every menu switch, so state held in the page's `@State`
/// vanished while the install carried on — the rebuilt page showed an idle
/// "Set up environment…" button and let a run start against a half-installed venv.
@MainActor
@Observable
final class LoopEnvironmentSetupTracker {
    static let shared = LoopEnvironmentSetupTracker()

    /// Symlink-resolved git-root paths with a setup in flight.
    var running: Set<String> = []
    /// The last result message per git-root path.
    var messages: [String: String] = [:]

    private init() {}
}
