import Foundation

/// A named, reusable Loop Engineering recipe: a stage list plus the budgets and
/// protected-path policy it expects.
///
/// Why this exists: a `LoopEngineConfig` is per-project and un-named, so the
/// knowledge "this is what a docs-refresh loop looks like" lived only in whoever
/// had already assembled one. A template makes that knowledge portable — pick a
/// recipe, see the pipeline it will run, apply it, then edit per project.
///
/// A template carries a whole `LoopEngineConfig` rather than a parallel list of
/// fields, so a field added to the config is automatically part of every
/// template instead of being silently dropped on apply.
struct LoopTemplate: Identifiable, Codable, Equatable {
    /// Sentinel command for a built-in template's test stage, replaced at apply
    /// time by whatever `LoopStageDetector` finds in the target repo.
    ///
    /// A built-in cannot hardcode `swift test` — applied to a Node project it
    /// would produce a stage that fails on every iteration for a reason the user
    /// did not cause. The alternative (omitting the stage) would make every
    /// built-in useless in the common case, since the test stage is the point.
    static let detectedTestCommand = "<detected-test-command>"

    var id: UUID = UUID()
    var name: String
    /// One line describing what a run of this loop does. Shown in the picker and
    /// the overview, so a user can tell recipes apart without reading stages.
    var summary: String
    var config: LoopEngineConfig
    /// True for the shipped starters. They can be applied and duplicated but not
    /// edited or deleted, so a project always has a known-good starting point.
    var isBuiltIn: Bool = false

    /// This template's config, ready to save for `gitRoot`.
    ///
    /// Regenerates every stage id: ids key `VerifyApprovalStore` approvals, so
    /// reusing a template's ids would let a command approved in one project run
    /// unapproved in another. `isDefault` is cleared for the same reason
    /// `LoopStageDetector` owns that flag — it re-pins the real defaults on load.
    func applied(to gitRoot: URL?) -> LoopEngineConfig {
        let detected = gitRoot.flatMap { LoopStageDetector.detectTestCommand(gitRoot: $0) }
        var result = config
        result.stages = config.stages.compactMap { stage -> LoopStage? in
            var copy = stage
            copy.id = UUID().uuidString
            copy.isDefault = false
            if copy.command == Self.detectedTestCommand {
                // No detectable test tooling ⇒ drop the stage rather than ship a
                // stage whose command is a placeholder that could never run.
                guard let detected else { return nil }
                copy.command = detected
            }
            return copy
        }
        return result
    }

    // MARK: - Built-in starters

    /// Ordered most-general first — the picker shows them in this order, and
    /// `testAndFix` is what a project with no template history should reach for.
    static let builtIns: [LoopTemplate] = [
        testAndFix, fullVerify, regressionOnly, testOnly, skillLoop, docsRefresh,
        operationDiagnosis, systemCheck, planDirector
    ]

    /// The default recipe, and the one that matches what the loop did before
    /// templates existed: verify the known faults, then the test suite.
    static let testAndFix = LoopTemplate(
        id: UUID(uuidString: "1E7B0A00-0000-4000-8000-0000000000A1")!,
        name: "Test & Fix",
        summary: "Re-check known faults, then run the test suite, repairing until both are green.",
        config: LoopEngineConfig(
            stages: [
                LoopStage(name: "Regression", kind: .regressionSweep, order: 0),
                LoopStage(name: "Test", kind: .shellCommand,
                          command: detectedTestCommand, order: 1)
            ],
            maxIterations: 10, consecutiveFailureStop: 2),
        isBuiltIn: true)

    /// Adds an advisory lint stage in front. Advisory so a formatting nit is
    /// reported without consuming the run — the reason `severity` exists.
    static let fullVerify = LoopTemplate(
        id: UUID(uuidString: "1E7B0A00-0000-4000-8000-0000000000A2")!,
        name: "Full Verify",
        summary: "Lint (advisory), then tests, then the fault sweep — the pre-merge gate.",
        config: LoopEngineConfig(
            stages: [
                // No per-stage timeout: `make lint` on a large repo legitimately
                // runs past any figure worth shipping as a default, and a stage
                // killed at 120 s was recorded as a lint FAILURE it never was.
                LoopStage(name: "Lint", kind: .shellCommand, command: "make lint",
                          order: 0, severity: .advisory),
                LoopStage(name: "Test", kind: .shellCommand,
                          command: detectedTestCommand, order: 1),
                LoopStage(name: "Regression", kind: .regressionSweep, order: 2)
            ],
            maxIterations: 10, consecutiveFailureStop: 2),
        isBuiltIn: true)

    /// The generate → verify shape: a chosen skill edits the code each iteration
    /// and the verify stages decide when to stop. The skill is deliberately
    /// unset — it is the one thing the user must choose.
    static let skillLoop = LoopTemplate(
        id: UUID(uuidString: "1E7B0A00-0000-4000-8000-0000000000A3")!,
        name: "Skill Loop",
        summary: "Run a chosen skill as a generate step each iteration, gated by tests and the fault sweep.",
        config: LoopEngineConfig(
            stages: [
                LoopStage(name: "Apply skill", kind: .skill, order: 0),
                LoopStage(name: "Test", kind: .shellCommand,
                          command: detectedTestCommand, order: 1),
                LoopStage(name: "Regression", kind: .regressionSweep, order: 2)
            ],
            maxIterations: 6, consecutiveFailureStop: 2),
        isBuiltIn: true)

    /// Docs work touches no test, so the verify stage is the docs gate itself and
    /// the run needs no repair budget to speak of.
    static let docsRefresh = LoopTemplate(
        id: UUID(uuidString: "1E7B0A00-0000-4000-8000-0000000000A4")!,
        name: "Docs Refresh",
        summary: "Regenerate documentation with a skill, then hold it to the project's docs checks.",
        config: LoopEngineConfig(
            stages: [
                LoopStage(name: "Write docs", kind: .skill, order: 0),
                // Same reasoning as Lint above — `make docs-check` builds the
                // whole docs site and is routinely slower than 300 s.
                LoopStage(name: "Docs check", kind: .shellCommand, command: "make docs-check",
                          order: 1)
            ],
            maxIterations: 4, consecutiveFailureStop: 2, maxRepairsPerStage: 2),
        isBuiltIn: true)

    /// Isolates the fault sweep alone — for re-checking known regressions
    /// without paying for a full test run every iteration (e.g. after a repair
    /// elsewhere, to confirm nothing already-fixed came back).
    static let regressionOnly = LoopTemplate(
        id: UUID(uuidString: "1E7B0A00-0000-4000-8000-0000000000A6")!,
        name: "Regression",
        summary: "Re-check known faults only, repairing until the sweep is green.",
        config: LoopEngineConfig(
            stages: [
                LoopStage(name: "Regression", kind: .regressionSweep, order: 0)
            ],
            maxIterations: 5, consecutiveFailureStop: 2),
        isBuiltIn: true)

    /// Isolates the test suite alone — for chasing a test failure without the
    /// fault sweep also gating the run.
    static let testOnly = LoopTemplate(
        id: UUID(uuidString: "1E7B0A00-0000-4000-8000-0000000000A7")!,
        name: "Test",
        summary: "Run just the test suite, repairing until it's green.",
        config: LoopEngineConfig(
            stages: [
                LoopStage(name: "Test", kind: .shellCommand,
                          command: detectedTestCommand, order: 0)
            ],
            maxIterations: 10, consecutiveFailureStop: 2),
        isBuiltIn: true)

    /// llm-ide-specific, like `systemCheck`: whether the app itself runs, not
    /// whether its test suites pass. Assumes the local dev server is already
    /// started (`cd extension && node server.mjs`) — the point of this loop is
    /// to diagnose the running app, so a stage failing here because nothing is
    /// listening on :3456 is real signal, not a false alarm.
    static let operationDiagnosis = LoopTemplate(
        id: UUID(uuidString: "1E7B0A00-0000-4000-8000-0000000000A8")!,
        name: "Operation App Diagnosis",
        summary: "Check the local server responds and the extension and Mac app build cleanly, "
            + "then the fault sweep — for diagnosing the running app, not its test suites.",
        config: LoopEngineConfig(
            stages: [
                LoopStage(name: "Server health", kind: .shellCommand,
                          command: "curl -sf http://127.0.0.1:3456/health", order: 0),
                LoopStage(name: "Extension build", kind: .shellCommand,
                          command: "cd extension && npm run build", order: 1),
                LoopStage(name: "Mac app build", kind: .shellCommand,
                          command: "cd mac && swift build", order: 2),
                LoopStage(name: "Regression", kind: .regressionSweep, order: 3)
            ],
            maxIterations: 6, consecutiveFailureStop: 2),
        isBuiltIn: true)

    /// llm-ide-specific: one stage per subsystem (skills, plugins, connectors,
    /// dispatch, backend, iOS↔Mac shared protocol, Mac app, known faults) instead
    /// of one monolithic `npm test`. A single suite would tell the repair agent
    /// only "something broke" and hand it the whole repo as scope; a stage per
    /// subsystem tells it which one, which is what `RepairScopeGuard` needs to
    /// keep a fix's blast radius to the failing area. Unlike the other built-ins,
    /// this one is not meant to be portable to other projects — every command
    /// names an llm-ide test file or Makefile target directly, mirroring how
    /// `make lint`/`make docs-check` above already assume this repo's layout.
    static let systemCheck = LoopTemplate(
        id: UUID(uuidString: "1E7B0A00-0000-4000-8000-0000000000A5")!,
        name: "System Check",
        summary: "Verify skills, plugins (with their MCP servers and hooks), connectors, GitHub "
            + "dispatch, backend, the iOS↔Mac shared protocol, and the Mac app itself, repairing "
            + "whichever subsystem breaks.",
        config: LoopEngineConfig(
            stages: [
                LoopStage(name: "Skills", kind: .shellCommand,
                          command: "cd extension && node --test tests/agent-skills.test.mjs "
                              + "tests/agent-skill-telemetry.test.mjs tests/skill-library.test.mjs "
                              + "tests/install-project-skills.test.mjs tests/task-skill-routing.test.mjs",
                          order: 0),
                LoopStage(name: "Plugins", kind: .shellCommand,
                          command: "cd extension && node --test tests/plugins-loader.test.mjs "
                              + "tests/plugins-installer.test.mjs",
                          order: 1),
                LoopStage(name: "Plugins + MCP", kind: .shellCommand,
                          command: "cd extension && node --test tests/mcp-config.test.mjs "
                              + "tests/mcp-state.test.mjs tests/mcp-plugin-servers.test.mjs "
                              + "tests/plugin-mcp-wiring.test.mjs tests/agent-v2-user-mcp.test.mjs "
                              + "tests/plugin-hook-trust.test.mjs tests/plugin-hook-runner.test.mjs "
                              + "tests/plugin-hook-trust-route.test.mjs tests/agent-v2-plugin-hooks.test.mjs "
                              + "tests/mcp-cli-args.test.mjs tests/route-mcp-mode.test.mjs",
                          order: 2),
                LoopStage(name: "Connectors", kind: .shellCommand,
                          command: "cd extension && node --test tests/box-connector.test.mjs "
                              + "tests/box-routes.test.mjs tests/slack-source.test.mjs "
                              + "tests/slack-oauth.test.mjs tests/slack-oauth-routes.test.mjs "
                              + "tests/email-source.test.mjs tests/scip-connector.test.mjs "
                              + "tests/scip-scanner.test.mjs tests/git-connector-chunking.test.mjs",
                          order: 3),
                LoopStage(name: "GitHub dispatch", kind: .shellCommand,
                          command: "cd extension && node --test tests/dispatch-concurrency.test.mjs "
                              + "tests/dispatch-preview.test.mjs tests/github-pr-secrets.test.mjs "
                              + "tests/outcome-dispatch-sentinel.test.mjs",
                          order: 4),
                // No per-stage timeout on the three below: same reasoning as
                // Lint/Docs check — a full backend suite, the shared-protocol
                // package, and the Mac app's XCTest suite routinely run past any
                // figure worth shipping as a default.
                LoopStage(name: "Backend", kind: .shellCommand,
                          command: "cd extension && npm test", order: 5),
                LoopStage(name: "iOS ↔ Mac shared protocol", kind: .shellCommand,
                          command: "make test-shared-protocol", order: 6),
                LoopStage(name: "Mac app", kind: .shellCommand,
                          command: "cd mac && swift test", order: 7),
                LoopStage(name: "Regression", kind: .regressionSweep, order: 8)
            ],
            maxIterations: 8, consecutiveFailureStop: 2),
        isBuiltIn: true)

    /// The Plan default loop's recipe (`LoopDefaultLoopKey.plan`), offered as a
    /// template too — same hand-kept-in-sync relationship `systemCheck` has
    /// with its default loop. Two generate stages, no verify: refresh the
    /// structure indexes, then consolidate every plan in `llm-doc/plans/` into
    /// one hierarchical, line-limited master plan. Skill stages always
    /// complete, so a run ends after one pass — `maxIterations` is a backstop,
    /// not a budget.
    static let planDirector = LoopTemplate(
        id: UUID(uuidString: "1E7B0A00-0000-4000-8000-0000000000A9")!,
        name: "Plan Director",
        summary: "Rebuild the plan structure indexes, then consolidate every collected plan in "
            + "llm-doc/plans/ into one hierarchical, line-limited master plan.",
        config: LoopEngineConfig(
            stages: [
                // Prompts name no concrete path: they defer to the editable
                // Input/Output fields (same reasoning as
                // `LoopStageDetector.planStages`), so redirecting the loop is
                // an Input/Output edit, not a prompt rewrite.
                LoopStage(name: "Structure Index", kind: .skill, order: 0,
                          skillId: "skills/plan-structure-index",
                          targetPath: "llm-doc/plans",
                          outputPath: "llm-doc/plans/INDEX.md",
                          prompt: "Refresh the plan structure index: read every plan in the Input directory and "
                              + "rewrite only the drifted sections of the Output index file, creating it if "
                              + "missing. Paths are relative to the project root — the directory containing "
                              + "system/project.json: the repo root itself, or two levels up when the repo is "
                              + "checked out under code/. The index holds: a folder-structure index of the "
                              + "codebase, a file index and a function index for the areas the collected plans "
                              + "touch, and a registry of every plan file in the Input directory."),
                LoopStage(name: "Plan Director", kind: .skill, order: 1,
                          skillId: "skills/plan-director",
                          targetPath: "llm-doc/plans",
                          outputPath: "llm-doc/plans/PLAN.md",
                          prompt: "Consolidate every plan in the Input directory into the master plan at the "
                              + "Output path: a hierarchy of areas → file plans → function plans, each entry with "
                              + "a stable task ID, a status, and links back to its source plan and its "
                              + "structure-index rows. Keep every generated plan file within the 250-line limit, "
                              + "splitting oversized areas into an areas/ folder beside the Output file. Preserve "
                              + "existing task IDs and completed ticks; never delete or rewrite the source plans.")
            ],
            maxIterations: 2, consecutiveFailureStop: 2),
        isBuiltIn: true)
}
