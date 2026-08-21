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
    var config: LoopEngineConfig

    init(id: String = UUID().uuidString, name: String, isPrimary: Bool = false,
         goal: String? = nil, acceptanceCriteria: String? = nil,
         scopeGlobs: [String] = [], config: LoopEngineConfig) {
        self.id = id
        self.name = name
        self.isPrimary = isPrimary
        self.goal = goal
        self.acceptanceCriteria = acceptanceCriteria
        self.scopeGlobs = scopeGlobs
        self.config = config
    }

    // MARK: - Codable backward compatibility

    enum CodingKeys: String, CodingKey {
        case id, name, isPrimary, goal, acceptanceCriteria, scopeGlobs, config
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
        config = try container.decode(LoopEngineConfig.self, forKey: .config)
    }
}

/// A project's full set of Loops — the schema `system/loop.json` holds. See
/// `LoopEngineConfigStore` for the load/save/migration contract.
struct LoopEngineProjectStore: Codable, Equatable {
    var loops: [LoopDefinition]
}
