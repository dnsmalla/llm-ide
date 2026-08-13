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
    /// detected at `gitRoot`; then the System Check stages (Skills, Plugins,
    /// Connectors, GitHub dispatch, Backend, iOS↔Mac shared protocol, Mac
    /// app), each only when ITS marker is found — see `systemCheckStages`.
    /// `gitRoot == nil` ⇒ Regression only (no tooling to detect).
    private static func defaultStages(gitRoot: URL?) -> [LoopStage] {
        var stages: [LoopStage] = [
            LoopStage(name: "Regression", kind: .regressionSweep, command: nil, order: 0, isDefault: true)
        ]
        guard let gitRoot else { return stages }
        if let testCommand = detectTestCommand(gitRoot: gitRoot) {
            stages.append(LoopStage(name: "Test", kind: .shellCommand, command: testCommand,
                                    order: stages.count, isDefault: true))
        }
        for check in systemCheckStages(gitRoot: gitRoot) {
            stages.append(LoopStage(name: check.name, kind: .shellCommand, command: check.command,
                                    order: stages.count, isDefault: true))
        }
        return stages
    }

    /// The System Check stages (see `LoopTemplate.systemCheck`), each gated on
    /// its own marker so this stays safe to run in the GLOBAL detector — used
    /// for every project the app opens, not just llm-ide. Every marker below
    /// is llm-ide's own directory layout, so on a repo that isn't llm-ide none
    /// of them match and the defaults stay exactly what they were before this
    /// existed (Regression, plus Test if detected) — the same "only add what's
    /// actually there" rule `detectTestCommand` already follows for Test.
    private static func systemCheckStages(gitRoot: URL) -> [(name: String, command: String)] {
        let fm = FileManager.default
        func exists(_ relativePath: String) -> Bool {
            fm.fileExists(atPath: gitRoot.appendingPathComponent(relativePath).path)
        }
        var checks: [(name: String, command: String)] = []
        if exists("extension/tests/agent-skills.test.mjs") {
            checks.append(("Skills", "cd extension && node --test tests/agent-skills.test.mjs "
                + "tests/agent-skill-telemetry.test.mjs tests/skill-library.test.mjs "
                + "tests/install-project-skills.test.mjs tests/task-skill-routing.test.mjs"))
        }
        if exists("extension/tests/plugins-loader.test.mjs") {
            checks.append(("Plugins", "cd extension && node --test tests/plugins-loader.test.mjs "
                + "tests/plugins-installer.test.mjs"))
        }
        if exists("extension/tests/box-connector.test.mjs") {
            checks.append(("Connectors", "cd extension && node --test tests/box-connector.test.mjs "
                + "tests/box-routes.test.mjs tests/slack-source.test.mjs tests/slack-oauth.test.mjs "
                + "tests/slack-oauth-routes.test.mjs tests/email-source.test.mjs "
                + "tests/scip-connector.test.mjs tests/scip-scanner.test.mjs "
                + "tests/git-connector-chunking.test.mjs"))
        }
        if exists("extension/tests/dispatch-preview.test.mjs") {
            checks.append(("GitHub dispatch", "cd extension && node --test tests/dispatch-concurrency.test.mjs "
                + "tests/dispatch-preview.test.mjs tests/github-pr-secrets.test.mjs "
                + "tests/outcome-dispatch-sentinel.test.mjs"))
        }
        if exists("extension/package.json") {
            checks.append(("Backend", "cd extension && npm test"))
        }
        if let makefile = try? String(contentsOf: gitRoot.appendingPathComponent("Makefile"), encoding: .utf8),
           makefile.range(of: #"(?m)^test-shared-protocol:"#, options: .regularExpression) != nil {
            checks.append(("iOS ↔ Mac shared protocol", "make test-shared-protocol"))
        }
        if exists("mac/Package.swift") {
            checks.append(("Mac app", "cd mac && swift test"))
        }
        return checks
    }

    /// Ensure `config` contains the detector's default stages, each pinned
    /// (`isDefault = true`): Regression always; Test and the System Check
    /// stages only when their tooling/markers are detected at `gitRoot`. The
    /// first existing stage matching each default is pinned IN PLACE (its
    /// command/edits preserved); a default is appended only if no match
    /// exists. User-added stages and their commands are never modified. Pure
    /// + idempotent. Called by all three config-load sites so saved and
    /// legacy configs honor the pinned-defaults invariant (one shared helper,
    /// mirroring `shouldPersist`'s rationale).
    static func ensureDefaultStages(in config: LoopEngineConfig, gitRoot: URL?) -> LoopEngineConfig {
        var stages = config.stages
        for def in defaultStages(gitRoot: gitRoot) {
            // "Test" predates every other `.shellCommand` default and has
            // always been matched by kind alone, so a project that renamed
            // it (e.g. to "My Tests") keeps its pinned status and its custom
            // command. Every check added since (Skills, Plugins, Connectors,
            // …) has no such history to preserve, and kind alone can no
            // longer disambiguate once there is more than one `.shellCommand`
            // default — so those match by exact name instead.
            let matches: (LoopStage) -> Bool = def.name == "Test"
                ? { $0.kind == def.kind }
                : { $0.kind == def.kind && $0.name == def.name }
            if let idx = stages.firstIndex(where: matches) {
                stages[idx].isDefault = true
            } else {
                stages.append(def)
            }
        }
        // Rebuild via `stages` assignment rather than the memberwise initializer:
        // an initializer call here has to restate every field, so each new
        // `LoopEngineConfig` field would silently reset to its default every time
        // a config is loaded (this helper runs on all three load paths). Copying
        // and mutating cannot drift that way.
        var updated = config
        updated.stages = stages
        return updated
    }

    /// The project's test command, or `nil` when no tooling is recognised.
    /// Internal (not private) because `LoopTemplate.applied(to:)` needs the same
    /// answer to resolve its `detectedTestCommand` placeholder — a built-in
    /// template must not hardcode `swift test`.
    static func detectTestCommand(gitRoot: URL) -> String? {
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
