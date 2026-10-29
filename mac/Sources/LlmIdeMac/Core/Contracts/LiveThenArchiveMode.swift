import Foundation

/// The live-then-archive rollout switch (docs/superpowers/plans/2026-10-29-live-then-archive.md,
/// section 6). Read once when the notes environment starts, so a change applies
/// on the next start (the same rule as the feature toggles).
///
/// - `off` (default): nothing new runs; behaviour is unchanged.
/// - `shadow`: the derived note index is fed IN ADDITION to the legacy path. The
///   new work never changes what the legacy path reads or writes.
/// - `on`: reserved for the read-path switch (Phase 3). Until then it behaves as `shadow`.
enum LiveThenArchiveMode: String, Sendable {
    case off
    case shadow
    case on

    static let defaultsKey = "lta.mode"

    /// The mode this launch runs with, read once on first use (boot). Services read THIS, never `current()`,
    /// so a change made in Settings applies at the next launch and cannot half-switch a running app.
    static let launchValue: LiveThenArchiveMode = current()

    /// Unknown or missing values mean `off`: a typo must never turn new work on.
    static func current(_ defaults: UserDefaults = .standard) -> LiveThenArchiveMode {
        LiveThenArchiveMode(rawValue: defaults.string(forKey: defaultsKey) ?? "") ?? .off
    }
}
