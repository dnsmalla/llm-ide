import Foundation

/// Per-project Loop Engineering contract: the ordered stage list plus
/// stop conditions. Persisted as UserDefaults JSON, one entry per
/// project id — same idiom as `CustomAutoTask`/`CustomProvider`, and
/// local-only (never synced), matching how Repo/Issues/Gantt config
/// already works.
struct LoopEngineConfig: Codable, Equatable {
    var stages: [LoopStage]
    var maxIterations: Int = 10
    var consecutiveFailureStop: Int = 2

    /// Total wall-clock ceiling for a run, in seconds. `nil` ⇒ unlimited.
    ///
    /// `maxIterations` alone is not a time budget: ten iterations of a
    /// three-minute test suite plus ten LLM repairs is most of an hour, and on
    /// the `.autoTask` trigger nobody is watching it happen. Checked between
    /// stages, so the ceiling is "stop starting new work after this", not a hard
    /// kill of a stage already running.
    var wallClockBudgetSeconds: Double? = 3600

    /// Maximum repair attempts per stage per run. `maxIterations` bounds how many
    /// times the loop goes round, but a single stubborn stage can consume every
    /// one of them; this bounds the spend on one stage independently of the
    /// iteration count, which is what actually costs LLM calls.
    var maxRepairsPerStage: Int = 3

    /// What to do when a repair edits a protected path. See `RepairScopeGuard`.
    var protectedPathPolicy: ProtectedPathPolicy = .revert

    /// Project-specific additions to `GitRepairScopeGuard.defaultProtectedGlobs`.
    /// Additive by design — a project can widen the protected set but not narrow
    /// the built-in one, because the built-ins are what stop the loop certifying
    /// a deleted test as a fix.
    var extraProtectedGlobs: [String] = []

    /// The full protected set this config enforces.
    var protectedGlobs: [String] {
        GitRepairScopeGuard.defaultProtectedGlobs + extraProtectedGlobs
    }

    private static func key(for projectId: String) -> String {
        "loopEngineConfig_\(projectId)"
    }

    // MARK: - Codable backward compatibility

    enum CodingKeys: String, CodingKey {
        case stages, maxIterations, consecutiveFailureStop
        case wallClockBudgetSeconds, maxRepairsPerStage, protectedPathPolicy, extraProtectedGlobs
    }

    init(stages: [LoopStage], maxIterations: Int = 10, consecutiveFailureStop: Int = 2,
         wallClockBudgetSeconds: Double? = 3600, maxRepairsPerStage: Int = 3,
         protectedPathPolicy: ProtectedPathPolicy = .revert, extraProtectedGlobs: [String] = []) {
        self.stages = stages
        self.maxIterations = maxIterations
        self.consecutiveFailureStop = consecutiveFailureStop
        self.wallClockBudgetSeconds = wallClockBudgetSeconds
        self.maxRepairsPerStage = maxRepairsPerStage
        self.protectedPathPolicy = protectedPathPolicy
        self.extraProtectedGlobs = extraProtectedGlobs
    }

    /// Same rule as `LoopStage.init(from:)`: every field added after the first
    /// shipped version is `decodeIfPresent` with a default, or a saved config
    /// from an older build fails to decode and the user silently loses their
    /// stage list (`load` returns nil ⇒ callers re-detect defaults).
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        stages = try container.decode([LoopStage].self, forKey: .stages)
        maxIterations = try container.decodeIfPresent(Int.self, forKey: .maxIterations) ?? 10
        consecutiveFailureStop = try container.decodeIfPresent(Int.self, forKey: .consecutiveFailureStop) ?? 2
        wallClockBudgetSeconds = try container.decodeIfPresent(Double.self, forKey: .wallClockBudgetSeconds) ?? 3600
        maxRepairsPerStage = try container.decodeIfPresent(Int.self, forKey: .maxRepairsPerStage) ?? 3
        protectedPathPolicy = try container.decodeIfPresent(
            ProtectedPathPolicy.self, forKey: .protectedPathPolicy) ?? .revert
        extraProtectedGlobs = try container.decodeIfPresent([String].self, forKey: .extraProtectedGlobs) ?? []
    }

    /// Whether an auto-detected stage list is safe to persist as the
    /// project's permanent config. `LoopStageDetector.detectDefaultStages`
    /// always includes the bare Regression stage, so an all-Regression
    /// detection is indistinguishable from "no test tooling found YET"
    /// (e.g. a clone-into-code checkout that hasn't finished populating) —
    /// saving that would silently and irreversibly disable the Test stage
    /// for every future run, since nothing re-detects once a config exists.
    /// All three call sites that may auto-detect and save a config (the
    /// Auto Task sweep, `LoopEngineView.loadConfig()`, and the chat panel's
    /// `runLoopEngineeringFromChat`) must agree on this condition — hence
    /// one shared helper instead of three inline copies.
    static func shouldPersist(_ stages: [LoopStage]) -> Bool {
        stages.contains { $0.kind != .regressionSweep }
    }

    /// - Parameter projectId: Must be the stable `Project.id`
    ///   (`mac/Sources/LlmIdeMac/Models/Project.swift:6`) — e.g.
    ///   `projectStore.activeProject?.bundle.id` — never a filesystem path
    ///   or a remote-repo id. Mixing identifier kinds silently splits one
    ///   project's config across multiple UserDefaults keys.
    static func load(for projectId: String, defaults: UserDefaults = .standard) -> LoopEngineConfig? {
        guard let data = defaults.data(forKey: key(for: projectId)),
              let config = try? JSONDecoder().decode(LoopEngineConfig.self, from: data)
        else { return nil }
        return config
    }

    /// - Parameter projectId: Must be the stable `Project.id`
    ///   (`mac/Sources/LlmIdeMac/Models/Project.swift:6`) — e.g.
    ///   `projectStore.activeProject?.bundle.id` — never a filesystem path
    ///   or a remote-repo id. Mixing identifier kinds silently splits one
    ///   project's config across multiple UserDefaults keys.
    func save(for projectId: String, defaults: UserDefaults = .standard) {
        guard let data = try? JSONEncoder().encode(self) else { return }
        defaults.set(data, forKey: Self.key(for: projectId))
    }
}
