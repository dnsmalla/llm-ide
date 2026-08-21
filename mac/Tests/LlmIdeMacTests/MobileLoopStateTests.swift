import XCTest
@testable import LlmIdeMacLib

/// The phone reports on a loop it does not own, so its view of the config has to
/// be the one the Mac would RUN — not the raw saved file. Both divergences
/// pinned here shipped as bugs that made the iPhone page look empty or wrong:
///
///  • a saved config shown without `ensureDefaultStages` lists fewer stages
///    than the desktop does for the same project;
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
        let resolved = MobileControlManager.resolveLoopConfig(
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
        _ = MobileControlManager.resolveLoopConfig(
            projectRoot: projectRoot, projectId: projectId, gitRoot: gitRoot)
        let configFile = LoopEngineConfigStore.fileURL(projectRoot: projectRoot)
        XCTAssertFalse(FileManager.default.fileExists(atPath: configFile.path),
                       "a read-only snapshot wrote the project's loop config")
    }

    func testNilWithoutAConfigOrAGitRoot() {
        // Nothing saved and nothing to detect from — the honest answer is "not
        // configured", which is what the phone renders as "set this up on the Mac".
        XCTAssertNil(MobileControlManager.resolveLoopConfig(
            projectRoot: projectRoot, projectId: projectId, gitRoot: nil))
    }

    // MARK: - Saved config

    func testSavedConfigIsRunThroughEnsureDefaultStages() throws {
        // A config saved with ONLY a custom stage. The Mac adds the pinned
        // defaults back on load, so the phone must see them too.
        let custom = LoopStage(name: "My check", kind: .shellCommand, command: "echo hi", order: 0,
                               severity: .blocking)
        let saved = LoopEngineConfig(stages: [custom], maxIterations: 7)
        LoopEngineConfigStore.save(saved, projectRoot: projectRoot, projectId: projectId)

        let resolved = try XCTUnwrap(MobileControlManager.resolveLoopConfig(
            projectRoot: projectRoot, projectId: projectId, gitRoot: gitRoot))

        XCTAssertTrue(resolved.stages.contains { $0.name == "My check" }, "the saved stage survives")
        XCTAssertTrue(resolved.stages.contains { $0.kind == .regressionSweep },
                      "the pinned Regression default must be restored, as the Mac page does")
        XCTAssertGreaterThan(resolved.stages.count, saved.stages.count)
        // Budgets come from the saved file, not from the defaults.
        XCTAssertEqual(resolved.maxIterations, 7)
    }

    func testSavedConfigWinsOverDetection() throws {
        let saved = LoopEngineConfig(stages: [
            LoopStage(name: "Only mine", kind: .shellCommand, command: "true", order: 0,
                      severity: .blocking),
        ], maxIterations: 3)
        LoopEngineConfigStore.save(saved, projectRoot: projectRoot, projectId: projectId)
        let resolved = try XCTUnwrap(MobileControlManager.resolveLoopConfig(
            projectRoot: projectRoot, projectId: projectId, gitRoot: gitRoot))
        XCTAssertEqual(resolved.maxIterations, 3, "the saved budget must not be replaced by a default")
    }
}
