import Foundation

/// Per-project Loop Engineering contract: the ordered stage list plus
/// stop conditions. Persisted as UserDefaults JSON, one entry per
/// project id — same idiom as `CustomAutoTask`/`CustomProvider`, and
/// local-only (never synced), matching how Repo/Issues/Gantt config
/// already works.
struct LoopEngineConfig: Codable, Equatable {
    var stages: [LoopStage]
    var maxIterations: Int = 5
    var consecutiveFailureStop: Int = 2

    private static func key(for projectId: String) -> String {
        "loopEngineConfig_\(projectId)"
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
