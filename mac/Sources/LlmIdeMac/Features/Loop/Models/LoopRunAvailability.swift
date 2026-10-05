import Foundation

/// Why the Loop page's Run button cannot be pressed, in one place.
///
/// The button's `.disabled` and its tooltip used to be two separate
/// expressions, and the tooltip only ever explained one of the reasons (a
/// phone/schedule run in flight). A loop with no enabled stage — the seeded
/// "Main Loop" starts empty — therefore showed a dead button with no hint.
/// Deriving both from `disabledReason` keeps them from drifting apart.
enum LoopRunAvailability {
    /// The user-facing reason Run is unavailable, or nil when it can start.
    ///
    /// - Parameters:
    ///   - isRunning: this loop's runner is running.
    ///   - isWaitingInQueue: this loop's run is queued behind another.
    ///   - isStartPending: the service admitted a run the runner has not
    ///     reflected yet.
    ///   - laneRunLabel: label of a phone/schedule run of this loop in flight.
    ///   - isSettingUpEnvironment: a pip install into the project venv runs.
    ///   - hasEnabledStage: at least one stage is enabled.
    ///   - hasGitRoot: a git working tree is resolved for the project.
    /// - Returns: a short sentence, most actionable reason first.
    static func disabledReason(isRunning: Bool,
                               isWaitingInQueue: Bool,
                               isStartPending: Bool,
                               laneRunLabel: String?,
                               isSettingUpEnvironment: Bool,
                               hasEnabledStage: Bool,
                               hasGitRoot: Bool) -> String? {
        if let laneRunLabel { return "\(laneRunLabel) — stop it before running from here." }
        if isRunning || isStartPending { return "This loop is already running." }
        if isWaitingInQueue { return "This loop is queued behind another run." }
        if isSettingUpEnvironment { return "The project environment is being set up — wait for it to finish." }
        if !hasEnabledStage { return "No enabled stage. Add or enable at least one stage to run this loop." }
        if !hasGitRoot { return "No git working tree. Open a project that is a git repo, or activate a cloned repo in Settings → GitLab / GitHub." }
        return nil
    }
}
