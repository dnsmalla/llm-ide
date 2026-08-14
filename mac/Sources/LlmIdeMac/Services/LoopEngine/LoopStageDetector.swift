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
            LoopStage(name: "Regression", kind: .regressionSweep, command: nil, order: 0,
                      isDefault: true, defaultKey: "regression")
        ]
        guard let gitRoot else { return stages }
        if let testCommand = detectTestCommand(gitRoot: gitRoot) {
            stages.append(LoopStage(name: "Test", kind: .shellCommand, command: testCommand,
                                    order: stages.count, isDefault: true, defaultKey: "test"))
        }
        for check in systemCheckStages(gitRoot: gitRoot) {
            stages.append(LoopStage(name: check.name, kind: .shellCommand, command: check.command,
                                    order: stages.count, isDefault: true, defaultKey: check.key))
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
    private static func systemCheckStages(gitRoot: URL) -> [(key: String, name: String, command: String)] {
        let fm = FileManager.default
        func exists(_ relativePath: String) -> Bool {
            fm.fileExists(atPath: gitRoot.appendingPathComponent(relativePath).path)
        }
        // `key` is the stage's stable identity (`LoopStage.defaultKey`) — it
        // must never change once shipped, or every saved config's pinned stage
        // is orphaned and re-appended. `name` is just the initial display name.
        var checks: [(key: String, name: String, command: String)] = []
        if exists("extension/tests/agent-skills.test.mjs") {
            checks.append(("skills", "Skills", "cd extension && node --test tests/agent-skills.test.mjs "
                + "tests/agent-skill-telemetry.test.mjs tests/skill-library.test.mjs "
                + "tests/install-project-skills.test.mjs tests/task-skill-routing.test.mjs"))
        }
        if exists("extension/tests/plugins-loader.test.mjs") {
            checks.append(("plugins", "Plugins", "cd extension && node --test tests/plugins-loader.test.mjs "
                + "tests/plugins-installer.test.mjs"))
        }
        if exists("extension/tests/box-connector.test.mjs") {
            checks.append(("connectors", "Connectors", "cd extension && node --test tests/box-connector.test.mjs "
                + "tests/box-routes.test.mjs tests/slack-source.test.mjs tests/slack-oauth.test.mjs "
                + "tests/slack-oauth-routes.test.mjs tests/email-source.test.mjs "
                + "tests/scip-connector.test.mjs tests/scip-scanner.test.mjs "
                + "tests/git-connector-chunking.test.mjs"))
        }
        if exists("extension/tests/dispatch-preview.test.mjs") {
            checks.append(("github-dispatch", "GitHub dispatch", "cd extension && node --test tests/dispatch-concurrency.test.mjs "
                + "tests/dispatch-preview.test.mjs tests/github-pr-secrets.test.mjs "
                + "tests/outcome-dispatch-sentinel.test.mjs"))
        }
        if exists("extension/package.json") {
            checks.append(("backend", "Backend", "cd extension && npm test"))
        }
        if let makefile = try? String(contentsOf: gitRoot.appendingPathComponent("Makefile"), encoding: .utf8),
           makefile.range(of: #"(?m)^test-shared-protocol:"#, options: .regularExpression) != nil {
            checks.append(("shared-protocol", "iOS ↔ Mac shared protocol", "make test-shared-protocol"))
        }
        if exists("mac/Package.swift") {
            checks.append(("mac-app", "Mac app", "cd mac && swift test"))
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
            // Primary match: the stable `defaultKey`. This is what makes a
            // pinned default survive a RENAME — matching on the display name
            // meant renaming a (possibly disabled) default orphaned it, and
            // a fresh enabled copy was appended on the next load.
            //
            // Legacy fallback, for stages saved before `defaultKey` existed
            // (restricted to key-less stages so it can never steal a stage
            // that already carries a different default's identity):
            // "Test" predates every other `.shellCommand` default and was
            // always matched by kind alone, so a renamed Test keeps its
            // pinned status; the System Check stages match by exact name.
            // Whichever way a stage matches, its key is stamped, so every
            // config migrates to key-matching on first load.
            let matches: (LoopStage) -> Bool
            if stages.contains(where: { $0.defaultKey == def.defaultKey }) {
                matches = { $0.defaultKey == def.defaultKey }
            } else if def.defaultKey == "test" || def.kind == .regressionSweep {
                // Kind-alone is unambiguous for these two: there is exactly one
                // Test default and one Regression default, so even a legacy
                // stage renamed before keys existed is recovered, not duplicated.
                matches = { $0.kind == def.kind && $0.defaultKey == nil }
            } else {
                matches = { $0.kind == def.kind && $0.name == def.name && $0.defaultKey == nil }
            }
            if let idx = stages.firstIndex(where: matches) {
                stages[idx].isDefault = true
                stages[idx].defaultKey = def.defaultKey
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
