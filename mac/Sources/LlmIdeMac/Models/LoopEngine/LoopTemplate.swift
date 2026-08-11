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
    static let builtIns: [LoopTemplate] = [testAndFix, fullVerify, skillLoop, docsRefresh]

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
}
