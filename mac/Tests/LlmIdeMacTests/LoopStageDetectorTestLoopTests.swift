import XCTest
@testable import LlmIdeMacLib

final class LoopStageDetectorTestLoopTests: XCTestCase {
    private let pkg = "// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: \"x\", targets: [.testTarget(name: \"XTests\")])\n"

    func testOrderWithRunner() throws {
        let root = try TempRepo.make(files: ["Package.swift": pkg])
        let stages = LoopStageDetector.defaultStages(forLoop: LoopDefaultLoopKey.test, gitRoot: root)
        XCTAssertEqual(stages.map(\.defaultKey), ["test-structure", "test-setup", "test-map", "test-write", "test", "test-ledger", "test-map-check"])
        XCTAssertEqual(stages[1].enabled, false)
        XCTAssertEqual(stages[3].enabled, true)
        XCTAssertEqual(stages[5].testOp, .ledger)
    }

    func testOrderWithoutRunner() throws {
        let root = try TempRepo.make(files: ["src/a.py": "def f(): return 1\n"])
        let stages = LoopStageDetector.defaultStages(forLoop: LoopDefaultLoopKey.test, gitRoot: root)
        XCTAssertEqual(stages.map(\.defaultKey), ["test-structure", "test-setup", "test-map", "test-write"])
        XCTAssertEqual(stages[1].enabled, true)
        XCTAssertEqual(stages[3].enabled, false)
        XCTAssertEqual(stages[3].disabledByDetection, true)
    }

    func testDetectsGoAndCargo() throws {
        XCTAssertEqual(LoopStageDetector.detectTestCommand(gitRoot: try TempRepo.make(files: ["go.mod": "module x\n"])), "go test ./...")
        XCTAssertEqual(LoopStageDetector.detectTestCommand(gitRoot: try TempRepo.make(files: ["Cargo.toml": "[package]\n"])), "cargo test")
    }

    func testScheduledLoopKeepsWriterButNotSetup() throws {
        let root = try TempRepo.make(files: ["Package.swift": pkg])
        let loop = try XCTUnwrap(LoopStageDetector.defaultLoops(gitRoot: root).first { $0.defaultKey == LoopDefaultLoopKey.test })
        XCTAssertFalse(loop.isManualOnly)
    }

    func testLoopExistsWithoutRunner() throws {
        let root = try TempRepo.make(files: ["src/a.py": "def f(): return 1\n"])
        XCTAssertNotNil(LoopStageDetector.defaultLoops(gitRoot: root).first { $0.defaultKey == LoopDefaultLoopKey.test })
    }

    func testStageKeysRouteToTestLoop() {
        for key in ["test-structure", "test-setup", "test-map", "test-write", "test", "test-ledger", "test-map-check"] {
            XCTAssertEqual(LoopStageDetector.stageKeyOwner[key], LoopDefaultLoopKey.test, key)
        }
    }

    func testRevalidationFlipsSetupAndWriterBothWays() throws {
        let noRunner = try TempRepo.make(files: ["src/a.py": "x = 1\n"])
        let runner = try TempRepo.make(files: ["Package.swift": pkg])
        let loop = try XCTUnwrap(LoopStageDetector.defaultLoops(gitRoot: noRunner).first { $0.defaultKey == LoopDefaultLoopKey.test })
        // runner appears
        let r1 = LoopStageDetector.revalidatingTestStages(in: [loop], gitRoot: runner, eligibleStageIDs: [])
        let s1 = r1.loops[0].config.stages
        XCTAssertEqual(s1.first { $0.defaultKey == "test-setup" }?.enabled, false)
        XCTAssertEqual(s1.first { $0.defaultKey == "test-write" }?.enabled, true)
        XCTAssertNil(s1.first { $0.defaultKey == "test-write" }?.disabledByDetection)
        // runner disappears
        let r2 = LoopStageDetector.revalidatingTestStages(in: r1.loops, gitRoot: noRunner, eligibleStageIDs: [])
        let s2 = r2.loops[0].config.stages
        XCTAssertEqual(s2.first { $0.defaultKey == "test-setup" }?.enabled, true)
        XCTAssertEqual(s2.first { $0.defaultKey == "test-write" }?.enabled, false)
        XCTAssertEqual(s2.first { $0.defaultKey == "test-write" }?.disabledByDetection, true)
        // idempotent
        let r3 = LoopStageDetector.revalidatingTestStages(in: r2.loops, gitRoot: noRunner, eligibleStageIDs: [])
        XCTAssertTrue(r3.changes.isEmpty)
    }

    func testContractMentionsLedgerAndMap() throws {
        let c = try XCTUnwrap(LoopStageDetector.defaultLoopContract(LoopDefaultLoopKey.test))
        XCTAssertTrue(c.goal.hasPrefix("Keep the test suite green and growing"))
        XCTAssertTrue(c.acceptance.contains("untestedFunctions in TEST-MAP.md"))
    }

    func testTemplateMatchesLoop() throws {
        let root = try TempRepo.make(files: ["Package.swift": pkg])
        let keys = LoopStageDetector.defaultStages(forLoop: LoopDefaultLoopKey.test, gitRoot: root).map(\.name)
        let tpl = try XCTUnwrap(LoopTemplate.builtIns.first { $0.id == LoopTemplate.testGrowth.id })
        XCTAssertEqual(tpl.config.stages.map(\.name), keys)
    }

    func testRevisionBumped() {
        XCTAssertEqual(DefaultRevisionCatalog.shipped.current("test"), 2)
    }
}

final class StageOutputParserCargoTests: XCTestCase {
    func testCargoFailedCount() {
        let out = "test result: FAILED. 3 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out"
        XCTAssertEqual(StageOutputParser.parseFailureCount(out), 2)
    }
}
