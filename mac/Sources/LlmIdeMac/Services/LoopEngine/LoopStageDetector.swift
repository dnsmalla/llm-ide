import Foundation

/// Sniffs a repo's root for common test-command conventions to propose a
/// default stage list, the first time a project has no saved
/// `LoopEngineConfig`. The user edits/overrides from there — this only
/// ever runs once per project (see `LoopEngineView`).
enum LoopStageDetector {
    static func detectDefaultStages(gitRoot: URL) -> [LoopStage] {
        defaultStages(gitRoot: gitRoot)
    }

    /// The canonical default stage list, each marked `isDefault = true`:
    /// Regression always; a Test (`shellCommand`) only when test tooling is
    /// detected at `gitRoot`. `gitRoot == nil` ⇒ Regression only (no tooling
    /// to detect).
    private static func defaultStages(gitRoot: URL?) -> [LoopStage] {
        var stages: [LoopStage] = [
            LoopStage(name: "Regression", kind: .regressionSweep, command: nil, order: 0, isDefault: true)
        ]
        if let gitRoot, let testCommand = detectTestCommand(gitRoot: gitRoot) {
            stages.append(LoopStage(name: "Test", kind: .shellCommand, command: testCommand, order: 1, isDefault: true))
        }
        return stages
    }

    /// Ensure `config` contains the detector's default stages, each pinned
    /// (`isDefault = true`): Regression always; a Test only when tooling is
    /// detected at `gitRoot`. The first existing stage of each default kind
    /// is pinned IN PLACE (its command/edits preserved); a default is appended
    /// only if no stage of that kind exists. User-added stages and their
    /// commands are never modified. Pure + idempotent. Called by all three
    /// config-load sites so saved and legacy configs honor the pinned-defaults
    /// invariant (one shared helper, mirroring `shouldPersist`'s rationale).
    static func ensureDefaultStages(in config: LoopEngineConfig, gitRoot: URL?) -> LoopEngineConfig {
        var stages = config.stages
        for def in defaultStages(gitRoot: gitRoot) {
            if let idx = stages.firstIndex(where: { $0.kind == def.kind }) {
                stages[idx].isDefault = true
            } else {
                stages.append(def)
            }
        }
        return LoopEngineConfig(stages: stages,
                                maxIterations: config.maxIterations,
                                consecutiveFailureStop: config.consecutiveFailureStop)
    }

    private static func detectTestCommand(gitRoot: URL) -> String? {
        let fm = FileManager.default

        if fm.fileExists(atPath: gitRoot.appendingPathComponent("Package.swift").path) {
            return "swift test"
        }

        if let data = try? Data(contentsOf: gitRoot.appendingPathComponent("package.json")),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let scripts = obj["scripts"] as? [String: Any],
           scripts["test"] != nil {
            return "npm test"
        }

        if let makefile = try? String(
            contentsOf: gitRoot.appendingPathComponent("Makefile"), encoding: .utf8
        ), makefile.range(of: #"(?m)^(test|regression):"#, options: .regularExpression) != nil {
            return "make test"
        }

        let pytestMarkers = ["pytest.ini", "pyproject.toml", "setup.cfg"]
        for marker in pytestMarkers {
            let path = gitRoot.appendingPathComponent(marker)
            if fm.fileExists(atPath: path.path) {
                if marker == "pytest.ini" { return "pytest" }
                if let contents = try? String(contentsOf: path, encoding: .utf8),
                   contents.contains("pytest") {
                    return "pytest"
                }
            }
        }

        return nil
    }
}
