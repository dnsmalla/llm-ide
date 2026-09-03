import XCTest
@testable import LlmIdeMacLib

/// The phone reports on a loop it does not own, so its view of the config has to
/// be the one the Mac would RUN — not the raw saved file. Both divergences
/// pinned here shipped as bugs that made the iPhone page look empty or wrong:
///
///  • a saved config shown without the same ensure the desktop runs lists
///    different stages than the desktop does for the same project;
///  • no saved config reported as "not configured" disables Start for a loop
///    the Mac would have run happily off detected defaults.
final class MobileLoopStateTests: XCTestCase {
    private var projectRoot: URL!
    private var gitRoot: URL!
    private let projectId = "proj-mobile-loop"

    override func setUpWithError() throws {
        try super.setUpWithError()
        let base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("mobile-loop-\(UUID().uuidString)", isDirectory: true)
        projectRoot = base.appendingPathComponent("project", isDirectory: true)
        gitRoot = base.appendingPathComponent("repo", isDirectory: true)
        for dir in [projectRoot!, gitRoot!] {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: projectRoot.deletingLastPathComponent())
        try super.tearDownWithError()
    }

    // MARK: - No saved config

    func testDetectsDefaultsWhenNothingIsSavedYet() throws {
        // The state the bug produced: a project whose loop had never been saved
        // from the Mac page. The Mac detects stages from the repo and runs;
        // the phone said "not set up".
        let resolved = MobileLoopBridge.resolveLoopConfig(
            projectRoot: projectRoot, projectId: projectId, gitRoot: gitRoot)
        let config = try XCTUnwrap(resolved, "a git root is enough to run a loop — this must not be nil")
        XCTAssertFalse(config.stages.isEmpty)
        // Regression is unconditional in the default set, so it is the one
        // stage that must be present for any repo.
        XCTAssertTrue(config.stages.contains { $0.kind == .regressionSweep })
    }

    func testResolvingDoesNotPersistAnything() throws {
        // A phone asking for a snapshot must never be what writes a project's
        // contract — deciding to persist detected stages is the Mac page's job
        // (LoopEngineConfig.shouldPersist).
        _ = MobileLoopBridge.resolveLoopConfig(
            projectRoot: projectRoot, projectId: projectId, gitRoot: gitRoot)
        let configFile = LoopEngineConfigStore.fileURL(projectRoot: projectRoot)
        XCTAssertFalse(FileManager.default.fileExists(atPath: configFile.path),
                       "a read-only snapshot wrote the project's loop config")
    }

    func testNilWithoutAConfigOrAGitRoot() {
        // Nothing saved and nothing to detect from — the honest answer is "not
        // configured", which is what the phone renders as "set this up on the Mac".
        XCTAssertNil(MobileLoopBridge.resolveLoopConfig(
            projectRoot: projectRoot, projectId: projectId, gitRoot: nil))
    }

    // MARK: - Saved config

    /// The built-in checks are their own loops now, so a saved USER loop keeps
    /// exactly the stages the user gave it — the pinned defaults are no longer
    /// injected into it. What the phone must not do is disagree with the
    /// desktop, and it cannot: both go through `LoopEngineConfigStore.loops`.
    func testSavedUserLoopIsShownWithItsOwnStagesOnly() throws {
        // A config saved with ONLY a custom stage, from before the split.
        let custom = LoopStage(name: "My check", kind: .shellCommand, command: "echo hi", order: 0,
                               severity: .blocking)
        let saved = LoopEngineConfig(stages: [custom], maxIterations: 7)
        LoopEngineConfigStore.save(
            LoopEngineProjectStore(loops: [LoopDefinition(name: "Main Loop", isPrimary: true, config: saved)]),
            projectRoot: projectRoot, projectId: projectId)

        let resolved = try XCTUnwrap(MobileLoopBridge.resolveLoopConfig(
            projectRoot: projectRoot, projectId: projectId, gitRoot: gitRoot))

        XCTAssertEqual(resolved.stages.map(\.name), ["My check"],
                       "a user loop must not grow a copy of the built-in checks")
        // Budgets come from the saved file, not from the defaults.
        XCTAssertEqual(resolved.maxIterations, 7)
    }

    /// …and the Regression check the loop used to carry as a pinned stage is
    /// still there — as its own independent loop, which the scheduled Auto Task
    /// runs separately. Nothing is lost by the migration, it moves.
    func testTheBuiltInChecksBecomeTheirOwnLoops() throws {
        let saved = LoopEngineConfig(stages: [
            LoopStage(name: "My check", kind: .shellCommand, command: "echo hi", order: 0)
        ], maxIterations: 7)
        LoopEngineConfigStore.save(
            LoopEngineProjectStore(loops: [LoopDefinition(name: "Main Loop", isPrimary: true, config: saved)]),
            projectRoot: projectRoot, projectId: projectId)

        let store = LoopEngineConfigStore.loops(projectRoot: projectRoot, projectId: projectId,
                                                gitRoot: gitRoot)
        let regression = try XCTUnwrap(store.loop(defaultKey: LoopDefaultLoopKey.regression))
        XCTAssertTrue(regression.config.stages.contains { $0.kind == .regressionSweep })
        XCTAssertTrue(regression.isDefault, "a built-in loop cannot be deleted")
        XCTAssertEqual(regression.config.maxIterations, 7, "it inherits the project's budgets")
        XCTAssertTrue(store.loops.contains { $0.name == "Main Loop" },
                      "the user's own loop survives the migration")
    }

    func testSavedConfigWinsOverDetection() throws {
        let saved = LoopEngineConfig(stages: [
            LoopStage(name: "Only mine", kind: .shellCommand, command: "true", order: 0,
                      severity: .blocking),
        ], maxIterations: 3)
        LoopEngineConfigStore.save(
            LoopEngineProjectStore(loops: [LoopDefinition(name: "Main Loop", isPrimary: true, config: saved)]),
            projectRoot: projectRoot, projectId: projectId)
        let resolved = try XCTUnwrap(MobileLoopBridge.resolveLoopConfig(
            projectRoot: projectRoot, projectId: projectId, gitRoot: gitRoot))
        XCTAssertEqual(resolved.maxIterations, 3, "the saved budget must not be replaced by a default")
    }
}
