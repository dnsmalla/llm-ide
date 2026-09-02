import Foundation

/// App-wide starting values a project's Loop config inherits the first time it is
/// created.
///
/// `LoopEngineConfig` is per-project and, once saved, is never re-derived — so
/// before this existed, every new project silently started at the struct's own
/// hardcoded 10 iterations / 60 minutes / revert policy, and a user who wanted a
/// tighter budget had to re-set it by hand in every project they opened. These
/// are the values the Settings card edits.
///
/// Stored as a **stage-less `LoopEngineConfig`** rather than a parallel list of
/// budget fields, for the same reason `LoopTemplate` carries a whole config: a
/// field added to the config is then automatically part of the defaults instead
/// of being silently left at its hardcoded value for every new project.
enum LoopEngineDefaults {
    private static let storeKey = "loopEngineDefaults"

    /// The stored defaults, or `LoopEngineConfig`'s own values when nothing has
    /// been saved. `stages` is always empty — see `save`.
    static func load(defaults: UserDefaults = .standard) -> LoopEngineConfig {
        guard let data = defaults.data(forKey: storeKey),
              var config = try? JSONDecoder().decode(LoopEngineConfig.self, from: data)
        else { return LoopEngineConfig(stages: []) }
        config.stages = []
        return config
    }

    /// Persists `config`'s budgets and policy as the defaults.
    ///
    /// The stage list is deliberately dropped: stages are detected per project by
    /// `LoopStageDetector` from the repo's actual test tooling, so an app-wide
    /// default stage list would either be wrong for most projects or silently
    /// override that detection. Reusable stage lists are `LoopTemplate`'s job.
    static func save(_ config: LoopEngineConfig, defaults: UserDefaults = .standard) {
        var stripped = config
        stripped.stages = []
        guard let data = try? JSONEncoder().encode(stripped) else { return }
        defaults.set(data, forKey: storeKey)
    }

    /// A config for a project that has none yet: `stages` from detection, every
    /// other field from the defaults.
    ///
    /// All three sites that can create a fresh config (the Loop page, the chat
    /// command, and the Auto Task sweep) must go through this — the same
    /// single-source-of-truth rule `LoopEngineConfig.shouldPersist` documents, or
    /// the defaults would apply on some paths and not others depending on which
    /// surface the user happened to open the project from first.
    static func newConfig(stages: [LoopStage], defaults: UserDefaults = .standard) -> LoopEngineConfig {
        var config = load(defaults: defaults)
        config.stages = stages
        return config
    }
}
