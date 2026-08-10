import XCTest
@testable import LlmIdeMacLib

/// A template is applied to a project the user did not necessarily inspect
/// first, so a malformed built-in or a leaked stage id becomes a broken loop (or
/// a command running unapproved) in someone else's repo.
final class LoopTemplateTests: XCTestCase {
    private var repoRoot: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        repoRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("loop-template-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: repoRoot, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: repoRoot)
        try super.tearDownWithError()
    }

    // MARK: - Built-ins

    func testEveryBuiltInHasANameASummaryAndStages() {
        XCTAssertFalse(LoopTemplate.builtIns.isEmpty)
        for template in LoopTemplate.builtIns {
            XCTAssertFalse(template.name.isEmpty, "\(template.name) has no name")
            XCTAssertFalse(template.summary.isEmpty, "\(template.name) has no summary")
            XCTAssertFalse(template.config.stages.isEmpty, "\(template.name) has no stages")
            XCTAssertTrue(template.isBuiltIn)
        }
    }

    /// Ids are stable constants, not fresh UUIDs — the picker stores a selection by
    /// id, so a regenerated id would silently deselect the user's choice on every
    /// relaunch.
    func testBuiltInIdsAreStableAndUnique() {
        let ids = LoopTemplate.builtIns.map(\.id)
        XCTAssertEqual(Set(ids).count, ids.count)
        XCTAssertEqual(LoopTemplate.testAndFix.id, LoopTemplate.builtIns[0].id)
    }

    func testBuiltInNamesAreUnique() {
        let names = LoopTemplate.builtIns.map { $0.name.lowercased() }
        XCTAssertEqual(Set(names).count, names.count)
    }

    /// A built-in must never hardcode a test command: applied to a Node project,
    /// `swift test` would fail every iteration for a reason the user did not cause.
    func testNoBuiltInHardcodesATestCommand() {
        for template in LoopTemplate.builtIns {
            for stage in template.config.stages where stage.kind == .shellCommand {
                let command = stage.command ?? ""
                XCTAssertFalse(command == "swift test" || command == "npm test" || command == "pytest",
                               "\(template.name)/\(stage.name) hardcodes \(command)")
            }
        }
    }

    /// Every stage that gates must be reachable: a shell stage with an empty
    /// command stops the run in preflight with a config error.
    func testNoBuiltInShipsAnEmptyShellCommand() {
        for template in LoopTemplate.builtIns {
            for stage in template.config.stages where stage.kind == .shellCommand {
                XCTAssertFalse((stage.command ?? "").isEmpty,
                               "\(template.name)/\(stage.name) has no command")
            }
        }
    }

    // MARK: - Apply

    /// Stage ids key `VerifyApprovalStore` approvals. If apply reused the
    /// template's ids, a command approved once in one project would run
    /// unapproved in every project the template was later applied to.
    func testApplyRegeneratesEveryStageId() throws {
        FileManager.default.createFile(atPath: repoRoot.appendingPathComponent("Package.swift").path,
                                       contents: nil)
        let applied = LoopTemplate.testAndFix.applied(to: repoRoot)
        let templateIds = Set(LoopTemplate.testAndFix.config.stages.map(\.id))
        for stage in applied.stages {
            XCTAssertFalse(templateIds.contains(stage.id))
        }
        XCTAssertEqual(Set(applied.stages.map(\.id)).count, applied.stages.count)
    }

    func testApplySubstitutesTheDetectedTestCommand() {
        FileManager.default.createFile(atPath: repoRoot.appendingPathComponent("Package.swift").path,
                                       contents: nil)
        let applied = LoopTemplate.testAndFix.applied(to: repoRoot)
        let test = applied.stages.first { $0.kind == .shellCommand }
        XCTAssertEqual(test?.command, "swift test")
    }

    func testApplyDetectsPerProjectTooling() throws {
        let packageJSON = #"{"scripts":{"test":"node --test"}}"#
        try Data(packageJSON.utf8).write(to: repoRoot.appendingPathComponent("package.json"))
        let applied = LoopTemplate.testAndFix.applied(to: repoRoot)
        XCTAssertEqual(applied.stages.first { $0.kind == .shellCommand }?.command, "npm test")
    }

    /// With no detectable tooling the placeholder stage is DROPPED, not shipped
    /// with the sentinel as its command — a stage that could never run.
    func testApplyDropsTheTestStageWhenNoToolingIsDetected() {
        let applied = LoopTemplate.testAndFix.applied(to: repoRoot)   // empty dir
        XCTAssertTrue(applied.stages.allSatisfy { $0.kind != .shellCommand })
        XCTAssertFalse(applied.stages.isEmpty, "the regression stage must survive")
        for stage in applied.stages {
            XCTAssertNotEqual(stage.command, LoopTemplate.detectedTestCommand)
        }
    }

    func testApplyWithNoGitRootDropsPlaceholderStages() {
        let applied = LoopTemplate.testAndFix.applied(to: nil)
        XCTAssertTrue(applied.stages.allSatisfy { $0.command != LoopTemplate.detectedTestCommand })
    }

    /// `isDefault` is `LoopStageDetector`'s to assign — it re-pins the real
    /// defaults on load. A template that carried the flag in would make a stage
    /// undeletable in a project where it is not actually a default.
    func testApplyClearsIsDefault() {
        var template = LoopTemplate.testAndFix
        template.config.stages = template.config.stages.map {
            var s = $0
            s.isDefault = true
            return s
        }
        for stage in template.applied(to: repoRoot).stages {
            XCTAssertFalse(stage.isDefault)
        }
    }

    /// The template carries a whole `LoopEngineConfig`, so budgets travel with the
    /// recipe. `docsRefresh` sets a non-default repair budget precisely so this is
    /// observable.
    func testApplyCarriesBudgetsAndPolicy() {
        FileManager.default.createFile(atPath: repoRoot.appendingPathComponent("Package.swift").path,
                                       contents: nil)
        let applied = LoopTemplate.docsRefresh.applied(to: repoRoot)
        XCTAssertEqual(applied.maxIterations, 4)
        XCTAssertEqual(applied.maxRepairsPerStage, 2)
        XCTAssertEqual(applied.protectedPathPolicy, .revert)
    }

    func testApplyPreservesSeverityAndTimeout() {
        FileManager.default.createFile(atPath: repoRoot.appendingPathComponent("Package.swift").path,
                                       contents: nil)
        let applied = LoopTemplate.fullVerify.applied(to: repoRoot)
        let lint = applied.stages.first { $0.name == "Lint" }
        XCTAssertEqual(lint?.severity, .advisory)
        XCTAssertEqual(lint?.timeoutSeconds, 120)
    }

    func testApplyPreservesStageOrder() {
        FileManager.default.createFile(atPath: repoRoot.appendingPathComponent("Package.swift").path,
                                       contents: nil)
        let applied = LoopTemplate.fullVerify.applied(to: repoRoot)
        XCTAssertEqual(applied.stages.sorted { $0.order < $1.order }.map(\.name),
                       ["Lint", "Test", "Regression"])
    }

    // MARK: - Codable

    func testTemplateRoundTripsThroughJSON() throws {
        let original = LoopTemplate(
            name: "Mine", summary: "does a thing",
            config: LoopEngineConfig(stages: [
                LoopStage(id: "s", name: "Test", kind: .shellCommand, command: "make test", order: 0)
            ], maxIterations: 7, writeSummaryNote: true))
        let data = try JSONEncoder().encode(original)
        XCTAssertEqual(try JSONDecoder().decode(LoopTemplate.self, from: data), original)
    }
}
