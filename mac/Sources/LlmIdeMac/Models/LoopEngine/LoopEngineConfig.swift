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

    /// Optional wall-clock ceiling for a run, in seconds. `nil` ⇒ unlimited,
    /// which is now the DEFAULT.
    ///
    /// It used to default to 3600. The argument for it was that `maxIterations`
    /// is not a time budget — ten iterations of a three-minute suite plus ten
    /// repairs is most of an hour on an unwatched `.autoTask` run. True, but
    /// spending an hour is not itself a failure: the run was progressing, and
    /// giving up at the hour mark threw away the work and reported
    /// `.wallClockExceeded`, which reads like a fault when nothing had faulted.
    /// `maxIterations`, `consecutiveFailureStop`, and `maxRepairsPerStage` bound
    /// the loop by PROGRESS, which is the property worth bounding.
    ///
    /// Still honoured when the user sets it deliberately in Settings → Loop, and
    /// still checked only between stages: "stop starting new work after this",
    /// never a hard kill of a stage already running.
    var wallClockBudgetSeconds: Double?

    /// Maximum repair attempts per stage per run. `maxIterations` bounds how many
    /// times the loop goes round, but a single stubborn stage can consume every
    /// one of them; this bounds the spend on one stage independently of the
    /// iteration count, which is what actually costs LLM calls.
    var maxRepairsPerStage: Int = 3

    /// What to do when a repair edits a protected path. See `RepairScopeGuard`.
    var protectedPathPolicy: ProtectedPathPolicy = .revert

    /// Write a human-readable run summary into the Library
    /// (`llm-doc/loop/<yyyy>/<MM>/`) at the end of every run. Off by default —
    /// the journal already records every run, and a note per run is only wanted
    /// when a person, not a tool, is the audience. See `LoopRunSummaryWriter`.
    var writeSummaryNote: Bool = false

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
        case writeSummaryNote
    }

    init(stages: [LoopStage], maxIterations: Int = 10, consecutiveFailureStop: Int = 2,
         wallClockBudgetSeconds: Double? = nil, maxRepairsPerStage: Int = 3,
         protectedPathPolicy: ProtectedPathPolicy = .revert, extraProtectedGlobs: [String] = [],
         writeSummaryNote: Bool = false) {
        self.stages = stages
        self.maxIterations = maxIterations
        self.consecutiveFailureStop = consecutiveFailureStop
        self.wallClockBudgetSeconds = wallClockBudgetSeconds
        self.maxRepairsPerStage = maxRepairsPerStage
        self.protectedPathPolicy = protectedPathPolicy
        self.extraProtectedGlobs = extraProtectedGlobs
        self.writeSummaryNote = writeSummaryNote
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
        // `nil` means "no time limit" and is now BOTH the default and what an
        // absent key decodes to, so absent and present-null no longer need to be
        // told apart: a config written before this field existed used to inherit
        // the 3600 default, and that default is gone. A user who deliberately set
        // a budget has the key present with a number, which decodes as itself.
        wallClockBudgetSeconds = try container.decodeIfPresent(
            Double.self, forKey: .wallClockBudgetSeconds)
        maxRepairsPerStage = try container.decodeIfPresent(Int.self, forKey: .maxRepairsPerStage) ?? 3
        protectedPathPolicy = try container.decodeIfPresent(
            ProtectedPathPolicy.self, forKey: .protectedPathPolicy) ?? .revert
        extraProtectedGlobs = try container.decodeIfPresent([String].self, forKey: .extraProtectedGlobs) ?? []
        writeSummaryNote = try container.decodeIfPresent(Bool.self, forKey: .writeSummaryNote) ?? false
    }

    /// Hand-written so `wallClockBudgetSeconds` is encoded as an explicit JSON
    /// `null` when nil rather than omitted (the synthesized encoder uses
    /// `encodeIfPresent`). Absent and null now decode identically — both mean "no
    /// limit" — so this is no longer load-bearing for correctness; it stays
    /// because writing the key makes the stored config self-describing, and a
    /// future default other than nil would need the distinction back.
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(stages, forKey: .stages)
        try container.encode(maxIterations, forKey: .maxIterations)
        try container.encode(consecutiveFailureStop, forKey: .consecutiveFailureStop)
        try container.encode(wallClockBudgetSeconds, forKey: .wallClockBudgetSeconds)
        try container.encode(maxRepairsPerStage, forKey: .maxRepairsPerStage)
        try container.encode(protectedPathPolicy, forKey: .protectedPathPolicy)
        try container.encode(extraProtectedGlobs, forKey: .extraProtectedGlobs)
        try container.encode(writeSummaryNote, forKey: .writeSummaryNote)
    }

    /// Whether an auto-detected stage list is safe to persist as the
    /// project's permanent config. `LoopStageDetector.detectDefaultStages`
    /// always includes the bare Regression stage, so an all-Regression
    /// detection is indistinguishable from "no test tooling found YET"
    /// (e.g. a clone-into-code checkout that hasn't finished populating) —
    /// saving that would silently and irreversibly disable the Test stage
    /// for every future run, since nothing re-detects once a config exists.
    /// Both call sites that may auto-detect and save a config (the Auto Task
    /// sweep and the chat panel's `runLoopEngineeringFromChat`) must agree on
    /// this condition — hence one shared helper instead of two inline copies.
    /// `LoopEngineView.loadConfig()` used to be a third, but it no longer
    /// persists a detection at all: `LoopEngineHomeView` is the only creator
    /// of loops, so a detection there is for display only.
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
