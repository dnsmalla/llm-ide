import Foundation

/// One scheduled routine as the System view shows it: a built-in Auto Task or a
/// custom Auto Task with a schedule (or enabled), for the active project.
/// Shell builds these from the Auto Task settings; Core carries only the values.
struct RoutineSummary: Codable, Equatable, Sendable {
    let id: String
    let title: String
    /// The cron expression, present only while the schedule is active.
    let schedule: String?
    let nextRunAt: Date?
    let lastRunAt: Date?
    /// The master switch and the task's own switch and an active schedule.
    let enabled: Bool
}

/// Hands the System view its routines without it naming Auto Task. Shell
/// installs the provider at the end of `FeatureCatalog.bootAutoTask` under
/// `FEATURE_AUTOTASK`; with nothing installed the answer is `[]`, which is the
/// same answer a build without Auto Task gives.
///
/// Contract:
/// - `install(_:)`
///   - Pre: main actor.
///   - Post: replaces any previous provider (last install wins).
/// - `routines(projectId:)`
///   - Post: the provider's routines for that project (nil project means no
///     custom tasks), or `[]` when none is installed. Never throws.
@MainActor
final class RoutinesRegistry {
    static let shared = RoutinesRegistry()

    private var provider: (@MainActor (_ projectId: String?) -> [RoutineSummary])?

    /// Internal (not private) so tests can use an isolated instance.
    init() {}

    var isInstalled: Bool { provider != nil }

    func install(_ provider: @escaping @MainActor (_ projectId: String?) -> [RoutineSummary]) {
        self.provider = provider
    }

    func routines(projectId: String?) -> [RoutineSummary] {
        guard let provider else { return [] }
        return provider(projectId)
    }
}
