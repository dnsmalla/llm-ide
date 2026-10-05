import Foundation

/// Per-project Loop Engineering contract: the ordered stage list plus
/// stop conditions. Persisted as UserDefaults JSON, one entry per
/// project id — same idiom as `CustomAutoTask`/`CustomProvider`, and
/// local-only (never synced), matching how Repo/Issues/Gantt config
/// already works.
public struct LoopEngineConfig: Codable, Equatable {
    public var stages: [LoopStage]
    public var maxIterations: Int = 10
    public var consecutiveFailureStop: Int = 2

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
    public var wallClockBudgetSeconds: Double?

    /// Maximum repair attempts per stage per run. `maxIterations` bounds how many
    /// times the loop goes round, but a single stubborn stage can consume every
    /// one of them; this bounds the spend on one stage independently of the
    /// iteration count, which is what actually costs LLM calls.
    public var maxRepairsPerStage: Int = 3

    /// Model the repair agent runs on. `nil` (the default) = the app's default
    /// model, the user's full chat model — repair is a multi-file edit. A
    /// cheaper tier can be chosen per loop or as a Settings → Loop default.
    public var repairModel: String?

    /// What to do when a repair edits a protected path. See `RepairScopeGuard`.
    public var protectedPathPolicy: ProtectedPathPolicy = .revert

    /// Write a human-readable run summary into the Library
    /// (`llm-doc/loop/<yyyy>/<MM>/`) at the end of every run. Off by default —
    /// the journal already records every run, and a note per run is only wanted
    /// when a person, not a tool, is the audience. See `LoopRunSummaryWriter`.
    public var writeSummaryNote: Bool = false

    /// Project-specific additions to `GitRepairScopeGuard.defaultProtectedGlobs`.
    /// Additive by design — a project can widen the protected set but not narrow
    /// the built-in one, because the built-ins are what stop the loop certifying
    /// a deleted test as a fix.
    public var extraProtectedGlobs: [String] = []

    /// When another run already holds the main git root, provision an isolated
    /// worktree instead of waiting in `LoopRunQueue`. Off by default — queueing
    /// is safer when disk or git state is tight. Stage approvals still key off
    /// the main repo path, and worktrees with changes are retained for review.
    public var useWorktreesForConcurrentRuns: Bool = false

    /// Always run this loop in an isolated worktree cut from HEAD, even on a
    /// dirty main checkout, and never fall back to editing the main checkout
    /// when a worktree cannot be made. Off by default — most loops still want
    /// to repair the checkout the user is looking at. Self-Heal turns this on
    /// so an uncommitted submodule pointer or in-progress edit never blocks it.
    public var alwaysUseWorktree: Bool = false

    /// After a SUCCESSFUL run that changed files, put the changes on a new branch,
    /// commit them, push it and open a merge request against the default branch
    /// (`ChangeShipping`). On by default; a loop that should only ever edit the
    /// working tree turns it off. The repo allow-list (branch, auto-commit, push,
    /// create MR) still has to permit it, and nothing is ever merged automatically.
    /// The repair stays in the working tree (nothing is checked out or reset), so the
    /// next run starts from a tree that is no longer clean and is skipped until the
    /// user discards the shipped files — in practice one request per clean-up.
    /// An absent key decodes as true, so existing loops pick it up.
    public var openMergeRequest: Bool = true

    /// Any enabled stage belongs to Self-Heal or its SDK Adoption sibling — keyed on the stages, not the
    /// flag, so a hand-edited loop.json, a template or "Run this stage only"
    /// cannot drop the guarantees below.
    public var isSelfHealRun: Bool {
        stages.contains { $0.enabled && ($0.kind == .incidentTriage || $0.kind == .sdkSurfaceDiff
            || $0.defaultKey?.hasPrefix("self-heal-") == true || $0.defaultKey?.hasPrefix("sdk-adopt-") == true) }
    }

    /// Self-Heal must never edit the main checkout, whatever the flag says.
    public var requiresWorktree: Bool { alwaysUseWorktree || isSelfHealRun }

    /// Why a Self-Heal run ends at once (successfully, without a worktree or
    /// an LLM call), or nil when it may proceed.
    public static func selfHealSkipReason(isEnabled: Bool, isAppSourceRoot: Bool) -> String? {
        if !isEnabled { return "Self-Heal is off" }
        if !isAppSourceRoot { return "not the LLM-IDE checkout" }
        return nil
    }

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
        case writeSummaryNote, useWorktreesForConcurrentRuns, repairModel, alwaysUseWorktree
        case openMergeRequest
    }

    public init(stages: [LoopStage], maxIterations: Int = 10, consecutiveFailureStop: Int = 2,
         wallClockBudgetSeconds: Double? = nil, maxRepairsPerStage: Int = 3,
         protectedPathPolicy: ProtectedPathPolicy = .revert, extraProtectedGlobs: [String] = [],
         writeSummaryNote: Bool = false, useWorktreesForConcurrentRuns: Bool = false,
         repairModel: String? = nil, alwaysUseWorktree: Bool = false,
         openMergeRequest: Bool = true) {
        self.stages = stages
        self.maxIterations = maxIterations
        self.consecutiveFailureStop = consecutiveFailureStop
        self.wallClockBudgetSeconds = wallClockBudgetSeconds
        self.maxRepairsPerStage = maxRepairsPerStage
        self.protectedPathPolicy = protectedPathPolicy
        self.extraProtectedGlobs = extraProtectedGlobs
        self.writeSummaryNote = writeSummaryNote
        self.useWorktreesForConcurrentRuns = useWorktreesForConcurrentRuns
        self.repairModel = repairModel
        self.alwaysUseWorktree = alwaysUseWorktree
        self.openMergeRequest = openMergeRequest
    }

    /// Same rule as `LoopStage.init(from:)`: every field added after the first
    /// shipped version is `decodeIfPresent` with a default, or a saved config
    /// from an older build fails to decode and the user silently loses their
    /// stage list (`load` returns nil ⇒ callers re-detect defaults).
    public init(from decoder: Decoder) throws {
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
        useWorktreesForConcurrentRuns = try container.decodeIfPresent(
            Bool.self, forKey: .useWorktreesForConcurrentRuns) ?? false
        repairModel = try container.decodeIfPresent(String.self, forKey: .repairModel)
        alwaysUseWorktree = try container.decodeIfPresent(Bool.self, forKey: .alwaysUseWorktree) ?? false
        openMergeRequest = try container.decodeIfPresent(Bool.self, forKey: .openMergeRequest) ?? true
    }

    /// Hand-written so `wallClockBudgetSeconds` is encoded as an explicit JSON
    /// `null` when nil rather than omitted (the synthesized encoder uses
    /// `encodeIfPresent`). Absent and null now decode identically — both mean "no
    /// limit" — so this is no longer load-bearing for correctness; it stays
    /// because writing the key makes the stored config self-describing, and a
    /// future default other than nil would need the distinction back.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(stages, forKey: .stages)
        try container.encode(maxIterations, forKey: .maxIterations)
        try container.encode(consecutiveFailureStop, forKey: .consecutiveFailureStop)
        try container.encode(wallClockBudgetSeconds, forKey: .wallClockBudgetSeconds)
        try container.encode(maxRepairsPerStage, forKey: .maxRepairsPerStage)
        try container.encode(protectedPathPolicy, forKey: .protectedPathPolicy)
        try container.encode(extraProtectedGlobs, forKey: .extraProtectedGlobs)
        try container.encode(writeSummaryNote, forKey: .writeSummaryNote)
        try container.encode(useWorktreesForConcurrentRuns, forKey: .useWorktreesForConcurrentRuns)
        try container.encodeIfPresent(repairModel, forKey: .repairModel)
        try container.encode(alwaysUseWorktree, forKey: .alwaysUseWorktree)
        try container.encode(openMergeRequest, forKey: .openMergeRequest)
    }

    /// Whether an auto-detected stage list is safe to persist as the
    /// project's permanent config. `LoopStageDetector.defaultStages(gitRoot:)`
    /// always includes the bare Regression stage, so an all-Regression
    /// detection is indistinguishable from "no test tooling found YET"
    /// (e.g. a clone-into-code checkout that hasn't finished populating) —
    /// saving that would silently and irreversibly disable the Test stage
    /// for every future run, since nothing re-detects once a config exists.
    /// Every call site that may auto-detect and save a config must agree on
    /// this condition — hence one shared helper instead of inline copies. Today
    /// that is `LoopEngineConfigStore.loops`, which the Auto Task sweep and the
    /// Loop page both go through; the chat panel used to be a second one before
    /// its "Run Loop" header button was removed.
    /// `LoopEngineView.loadConfig()` used to be a third, but it no longer
    /// persists a detection at all: `LoopEngineHomeView` is the only creator
    /// of loops, so a detection there is for display only.
    static func shouldPersist(_ stages: [LoopStage]) -> Bool {
        // The Plan loop's skill stages are as unconditional as the Regression
        // sweep — the detector emits them for any resolvable git root — so
        // they carry no evidence the tree has finished populating either.
        stages.contains { stage in
            stage.kind != .regressionSweep
                && !LoopStageDetector.unconditionalStageKeys.contains(stage.defaultKey ?? "")
        }
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
