import Foundation

/// One independently configured, run, and tracked Loop within a project.
///
/// `LoopEngineConfig` (stages, budgets, protected-path policy) keeps meaning
/// exactly what it means today — this only gives it identity and a richer
/// per-loop contract, so a project can hold several unrelated loops (e.g.
/// "fix flaky tests" and "refactor auth") instead of being forced to share
/// one pipeline.
struct LoopDefinition: Codable, Equatable, Identifiable {
    var id: String
    var name: String
    /// Exactly one loop per project is Primary — the loop the scheduled
    /// `.loopEngineering` Auto Task and the phone target. Not enforced at
    /// the type level; `LoopEngineConfigStore` and the Loop page's "Set as
    /// Primary" action are what keep the invariant.
    var isPrimary: Bool
    /// Free text: what this loop is trying to achieve. When set, appended to
    /// the repair/skill prompts `LoopEngineRunner` builds, so a loop's "done"
    /// signal is more than "the stages passed".
    var goal: String?
    /// Free text: the observable condition that means done. Same treatment
    /// as `goal`.
    var acceptanceCriteria: String?
    /// Optional path allowlist. Empty (the default) means unrestricted —
    /// today's behavior for every existing and migrated loop. When non-empty,
    /// `LoopEngineRunner.withScopeGuard` treats a changed path outside every
    /// glob here the same way it treats a protected-path violation.
    var scopeGlobs: [String]
    /// Stable identity of the built-in default loop this IS
    /// (`LoopDefaultLoopKey`), or `nil` for a loop the user created.
    ///
    /// This is the loop-level twin of `LoopStage.defaultKey`, and it exists for
    /// the same reason: a default must survive a RENAME. It is also what makes
    /// the pinned defaults *independent loops* rather than pinned stages inside
    /// one loop — `LoopStageDetector.ensureDefaultStages(in:gitRoot:)` injects
    /// only the stages this key owns, so a user loop gets nothing injected and
    /// the Regression/Test/System Check checks no longer share one pipeline.
    ///
    /// Non-nil ⇒ the loop cannot be deleted (`LoopEngineHomeView` hides Delete)
    /// and is re-created by `ensureDefaultLoops` if it goes missing. The escape
    /// hatch is per-stage `enabled` plus `runsOnSchedule`, exactly as it was
    /// for pinned stages.
    var defaultKey: String?
    /// Whether the scheduled `.loopEngineering` Auto Task includes this loop.
    ///
    /// **Opt-in.** A newly created loop — a built-in default included — starts
    /// `false`: creating a loop describes work, it does not consent to that
    /// work running unattended on a cron. The user opts in per loop from the
    /// Loop page (⋯ → "Run on schedule"). Note the decode default below is
    /// still `true`, which is the opposite on purpose: an absent key means the
    /// loop predates this field, back when the single loop WAS the scheduled
    /// one, and silently unscheduling it on upgrade would be a regression.
    ///
    /// Each scheduled loop is run as its own INDEPENDENT run — its own
    /// iteration budget, its own journal record, its own goal — not chained
    /// into one long pipeline. They are run one after another only because a
    /// single working tree runs one at a time; extra callers wait in
    /// `LoopRunQueue` (`LoopEngineRunner`'s FIFO per git root).
    var runsOnSchedule: Bool

    var config: LoopEngineConfig

    /// Whether this is one of the built-in default loops.
    var isDefault: Bool { defaultKey != nil }

    init(id: String = UUID().uuidString, name: String, isPrimary: Bool = false,
         goal: String? = nil, acceptanceCriteria: String? = nil,
         scopeGlobs: [String] = [], defaultKey: String? = nil,
         runsOnSchedule: Bool = false, config: LoopEngineConfig) {
        self.id = id
        self.name = name
        self.isPrimary = isPrimary
        self.goal = goal
        self.acceptanceCriteria = acceptanceCriteria
        self.scopeGlobs = scopeGlobs
        self.defaultKey = defaultKey
        self.runsOnSchedule = runsOnSchedule
        self.config = config
    }

    // MARK: - Codable backward compatibility

    enum CodingKeys: String, CodingKey {
        case id, name, isPrimary, goal, acceptanceCriteria, scopeGlobs, config
        case defaultKey, runsOnSchedule
    }

    /// Every field beyond `name`/`config` is `decodeIfPresent` + a default —
    /// same rule `LoopStage.init(from:)` documents, so a future field added
    /// here can't turn an existing `LoopDefinition` into a decode failure.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
        name = try container.decode(String.self, forKey: .name)
        isPrimary = try container.decodeIfPresent(Bool.self, forKey: .isPrimary) ?? false
        goal = try container.decodeIfPresent(String.self, forKey: .goal)
        acceptanceCriteria = try container.decodeIfPresent(String.self, forKey: .acceptanceCriteria)
        scopeGlobs = try container.decodeIfPresent([String].self, forKey: .scopeGlobs) ?? []
        defaultKey = try container.decodeIfPresent(String.self, forKey: .defaultKey)
        // Absent ⇒ true: every loop written before this field existed was the
        // one loop the scheduled Auto Task ran, so defaulting to false would
        // silently turn a project's scheduled loop off on upgrade.
        runsOnSchedule = try container.decodeIfPresent(Bool.self, forKey: .runsOnSchedule) ?? true
        config = try container.decode(LoopEngineConfig.self, forKey: .config)
    }
}

/// Stable identities of the built-in default loops. Every project gets these
/// (marker-gated — see `LoopStageDetector.defaultLoops`), they cannot be
/// deleted, and each is an independent loop with its own process.
///
/// These strings are persisted in `system/loop.json` and MUST NOT change once
/// shipped: a changed key orphans the loop it named and a fresh empty copy is
/// created beside it on the next load.
enum LoopDefaultLoopKey {
    /// Find the code, check the known faults, repair, re-verify — the loop the
    /// `.regressionSweep` stage drives.
    static let regression = "regression"
    /// The project's own test suite, on its own budget.
    static let test = "test"
    /// llm-ide's per-subsystem checks (Skills, Plugins, Connectors, …), each a
    /// marker-gated stage inside this one loop.
    static let systemCheck = "system-check"
    /// The plan-generation loop: refresh the structure indexes, then
    /// consolidate every plan collected in `llm-doc/plans/` into one
    /// hierarchical master plan (the "plan director").
    static let plan = "plan"

    /// Creation/display order.
    static let all = [regression, test, systemCheck, plan]
}

/// A project's full set of Loops — the schema `system/loop.json` holds. See
/// `LoopEngineConfigStore` for the load/save/migration contract.
struct LoopEngineProjectStore: Codable, Equatable {
    var loops: [LoopDefinition]

    /// The loops the scheduled `.loopEngineering` Auto Task should run, in list
    /// order — those opted in AND with at least one enabled stage. A loop whose
    /// every stage is switched off is PARKED, not broken (the reasoning
    /// `runLoopEngineeringSweep` already documented for the single-loop case),
    /// so it is skipped here rather than reported as an error.
    var scheduledLoops: [LoopDefinition] {
        loops.filter { $0.runsOnSchedule && $0.config.stages.contains(where: \.enabled) }
    }

    /// The loop containing the stage `stageId`, for "run just this stage" —
    /// searched across EVERY loop, not just the Primary one, since the stages
    /// a surface offers now come from several independent loops.
    func loopContaining(stageId: String) -> LoopDefinition? {
        loops.first { $0.config.stages.contains { $0.id == stageId } }
    }
}
