import XCTest
@testable import LlmIdeMacLib

final class LoopStageDetectorTestLoopTests: XCTestCase {
    private let pkg = "// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: \"x\", targets: [.testTarget(name: \"XTests\")])\n"

    func testOrderWithRunner() throws {
        let root = try TempRepo.make(files: ["Package.swift": pkg])
        let stages = LoopStageDetector.defaultStages(forLoop: LoopDefaultLoopKey.test, gitRoot: root)
        XCTAssertEqual(stages.map(\.defaultKey), ["test-structure", "test-setup", "test-structure-check", "test-map", "test-write", "test", "test-ledger", "test-map-check", "test-prune"])
        XCTAssertEqual(stages.suffix(2).map(\.name), ["Test Map Check", "Test Prune"])
        XCTAssertEqual(stages.last?.kind, .testPrune)
        XCTAssertNil(stages.last?.testOp)
        XCTAssertEqual(stages.last?.severity, .advisory)
        XCTAssertEqual(stages[1].enabled, false)
        XCTAssertEqual(stages[4].enabled, true)
        XCTAssertEqual(stages[6].testOp, .ledger)
    }

    func testOrderWithoutRunner() throws {
        let root = try TempRepo.make(files: ["src/a.py": "def f(): return 1\n"])
        let stages = LoopStageDetector.defaultStages(forLoop: LoopDefaultLoopKey.test, gitRoot: root)
        XCTAssertEqual(stages.map(\.defaultKey), ["test-structure", "test-setup", "test-structure-check", "test-map", "test-write"])
        XCTAssertEqual(stages[1].enabled, true)
        XCTAssertEqual(stages[4].enabled, false)
        XCTAssertEqual(stages[4].disabledByDetection, true)
        XCTAssertFalse(stages.contains { $0.name == "Test Prune" })
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
        for key in ["test-structure", "test-setup", "test-structure-check", "test-map", "test-write", "test", "test-ledger", "test-map-check", "test-prune"] {
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
        XCTAssertTrue(c.goal.contains("Unit-test candidates"))
        XCTAssertTrue(c.acceptance.contains("public calls") && c.acceptance.contains("Covered:"))
        XCTAssertTrue(c.acceptance.contains("fault"))
        for text in [c.goal, c.acceptance] {
            XCTAssertFalse(text.contains("untestedFunctions"))
            XCTAssertFalse(text.lowercased().contains("untested functions"))
        }
    }

    func testTemplateMatchesLoop() throws {
        let root = try TempRepo.make(files: ["Package.swift": pkg])
        let keys = LoopStageDetector.defaultStages(forLoop: LoopDefaultLoopKey.test, gitRoot: root).map(\.name)
        let tpl = try XCTUnwrap(LoopTemplate.builtIns.first { $0.id == LoopTemplate.testGrowth.id })
        XCTAssertEqual(tpl.config.stages.map(\.name), keys)
        XCTAssertEqual(tpl.config.stages.last?.kind, .testPrune)
        XCTAssertNil(tpl.config.stages.last?.testOp)
        XCTAssertEqual(tpl.config.stages.last?.severity, .advisory)
    }

    /// An older build decodes `testOp` strictly, so a new op value would make it
    /// quarantine the whole loop.json; an unknown kind it reads as `.unsupported`.
    func testTestPruneEncodesAsItsOwnKindWithoutTestOp() throws {
        let root = try TempRepo.make(files: ["Package.swift": pkg])
        let prune = try XCTUnwrap(LoopStageDetector.defaultStages(forLoop: LoopDefaultLoopKey.test, gitRoot: root)
            .first { $0.defaultKey == "test-prune" })
        let json = String(decoding: try JSONEncoder().encode(prune), as: UTF8.self)
        XCTAssertTrue(json.contains("\"kind\":\"testPrune\""), json)
        XCTAssertFalse(json.contains("testOp"), json)
        XCTAssertNil(TestMapOp(rawValue: "prune"))
        let decoded = try JSONDecoder().decode(LoopStage.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.kind, .testPrune)
    }

    func testNoRunnerLoopHasNoUnverifiedCodeApply() throws {
        let root = try TempRepo.make(files: ["src/a.py": "x = 1\n"])
        let stages = LoopStageDetector.defaultStages(forLoop: LoopDefaultLoopKey.test, gitRoot: root)
        for stage in stages where stage.enabled {
            XCTAssertFalse(LoopStage.lacksVerifyAfter(stage, in: stages), stage.name)
        }
        var noCheck = stages
        noCheck.removeAll { $0.defaultKey == "test-structure-check" }
        let setup = noCheck.first { $0.isTestSetup }!
        XCTAssertTrue(LoopStage.lacksVerifyAfter(setup, in: noCheck))
        // Setup alone must not make the loop scheduled-capable: still manual-only.
        let loop = try XCTUnwrap(LoopStageDetector.defaultLoops(gitRoot: root).first { $0.defaultKey == LoopDefaultLoopKey.test })
        XCTAssertTrue(loop.isManualOnly)
    }

    func testSetupViolationClassification() {
        let v = LoopEngineRunner.testSetupViolations(
            changed: ["Package.swift", "Sources/App/main.swift", "tests/test_a.py", "tests/__init__.py", "pytest.ini", "src/__init__.py", "src/new.py"],
            created: ["tests/test_a.py", "tests/__init__.py", "pytest.ini", "src/__init__.py", "src/new.py"])
        let m = LoopEngineRunner.testSetupViolations(changed: ["Package.swift", "go.mod"],
                                                     created: ["Package.swift", "go.mod", "package.json", "pytest.ini"])
        XCTAssertEqual(m.created, ["Package.swift", "go.mod", "package.json"])
        XCTAssertEqual(v.modified, ["Sources/App/main.swift"])
        XCTAssertEqual(v.created, ["src/__init__.py", "src/new.py"])
    }

    func testUpgradedSavedTestLoopGetsNewContract() throws {
        let root = try TempRepo.make(files: ["Package.swift": pkg])
        var loop = try XCTUnwrap(LoopStageDetector.defaultLoops(gitRoot: root).first { $0.defaultKey == LoopDefaultLoopKey.test })
        loop.goal = "Keep this project's own test suite green."
        loop.acceptanceCriteria = "The test command exits 0 with no failures."
        let r = LoopStageDetector.upgradingDefaultRevisions(in: [loop], gitRoot: root)
        XCTAssertEqual(r.loops[0].goal, LoopStageDetector.defaultLoopContract(LoopDefaultLoopKey.test)?.goal)
    }

    /// The coverage-goal text the previous build created Test loops with.
    private let coverageGoal = "Keep the test suite green and growing: every run adds real tests for the most-used untested functions and records every new failure as a fault."
    private let coverageAcceptance = "The test command exits 0, untestedFunctions in TEST-MAP.md is lower than at the start of the run when Test Write ran, and every new failure has a fault with a runnable verify command."

    func testUneditedCoverageGoalTextIsUpgraded() throws {
        let root = try TempRepo.make(files: ["Package.swift": pkg])
        var loop = try XCTUnwrap(LoopStageDetector.defaultLoops(gitRoot: root).first { $0.defaultKey == LoopDefaultLoopKey.test })
        loop.goal = coverageGoal
        loop.acceptanceCriteria = coverageAcceptance
        let r = LoopStageDetector.upgradingDefaultRevisions(in: [loop], gitRoot: root)
        let current = try XCTUnwrap(LoopStageDetector.defaultLoopContract(LoopDefaultLoopKey.test))
        XCTAssertEqual(r.loops[0].goal, current.goal)
        XCTAssertEqual(r.loops[0].acceptanceCriteria, current.acceptance)
        XCTAssertTrue(r.changes.contains { $0.stageName == "Goal and acceptance criteria" })
    }

    func testEditedCoverageGoalTextIsKept() throws {
        let root = try TempRepo.make(files: ["Package.swift": pkg])
        var loop = try XCTUnwrap(LoopStageDetector.defaultLoops(gitRoot: root).first { $0.defaultKey == LoopDefaultLoopKey.test })
        loop.goal = "My own goal."
        loop.acceptanceCriteria = coverageAcceptance + " Plus a human review."
        let r = LoopStageDetector.upgradingDefaultRevisions(in: [loop], gitRoot: root)
        XCTAssertEqual(r.loops[0].goal, "My own goal.")
        XCTAssertEqual(r.loops[0].acceptanceCriteria, coverageAcceptance + " Plus a human review.")
    }

    func testUpgradedSavedTestLoopGainsGuidelinePromptsAndPrune() throws {
        let root = try TempRepo.make(files: ["Package.swift": pkg])
        let saved = try revisionOneTestLoop(root: root)
        let store = LoopStageDetector.ensureDefaultLoops(in: LoopEngineProjectStore(loops: [saved]), gitRoot: root).store
        let stages = try XCTUnwrap(store.loop(defaultKey: LoopDefaultLoopKey.test)).config.stages
        let writer = try XCTUnwrap(stages.first { $0.defaultKey == "test-write" })
        XCTAssertEqual(writer.prompt, LoopStageDetector.testWritePrompt)
        XCTAssertEqual(writer.defaultRevision, 2)
        XCTAssertEqual(stages.first { $0.defaultKey == "test-setup" }?.prompt, LoopStageDetector.testSetupPrompt)
        XCTAssertEqual(stages.sorted { $0.order < $1.order }.suffix(2).map(\.name), ["Test Map Check", "Test Prune"])
    }

    func testEditedWritePromptIsNotUpgraded() throws {
        let root = try TempRepo.make(files: ["Package.swift": pkg])
        var saved = try revisionOneTestLoop(root: root)
        let index = try XCTUnwrap(saved.config.stages.firstIndex { $0.defaultKey == "test-write" })
        saved.config.stages[index].prompt = "Write tests my way."
        let result = LoopStageDetector.upgradingDefaultRevisions(in: [saved], gitRoot: root)
        let writer = try XCTUnwrap(result.loops[0].config.stages.first { $0.defaultKey == "test-write" })
        XCTAssertEqual(writer.prompt, "Write tests my way.")
        XCTAssertEqual(writer.defaultRevision, 1)
        XCTAssertTrue(LoopStageDetector.updateAvailable(for: writer))
    }

    func testWritePromptFollowsGuideline() {
        let prompt = LoopStageDetector.testWritePrompt
        XCTAssertTrue(prompt.contains("Unit-test candidates"))
        XCTAssertTrue(prompt.contains("public calls"))
        XCTAssertTrue(prompt.contains("not one test per function"))
        XCTAssertFalse(prompt.contains("every untested function"))
        XCTAssertTrue(LoopStageDetector.testSetupPrompt.contains("never create empty folders or files"))
    }

    /// The Test loop's revision lives on its per-stage keys: the upgrade reads
    /// `current(stage.defaultKey)`, so `test` (the shell Test stage) stays at 2.
    func testRevisionBumped() {
        XCTAssertEqual(DefaultRevisionCatalog.shipped.current("test"), 2)
        XCTAssertEqual(DefaultRevisionCatalog.shipped.current("test-write"), 2)
        XCTAssertEqual(DefaultRevisionCatalog.shipped.current("test-setup"), 2)
        XCTAssertEqual(DefaultRevisionCatalog.shipped.current("refactor-setup"), 2)
        XCTAssertEqual(DefaultRevisionCatalog.shipped.history["test-write"]?[1]?.prompt?.contains("every untested function"), true)
        XCTAssertNotEqual(DefaultRevisionCatalog.shipped.history["test-setup"]?[1]?.prompt, LoopStageDetector.testSetupPrompt)
    }

    /// A Test loop as the previous build saved it: no Test Prune and the
    /// revision-1 Setup/Write content.
    private func revisionOneTestLoop(root: URL) throws -> LoopDefinition {
        var loop = try XCTUnwrap(LoopStageDetector.defaultLoops(gitRoot: root).first { $0.defaultKey == LoopDefaultLoopKey.test })
        loop.config.stages = loop.config.stages.filter { $0.defaultKey != "test-prune" }.map { stage in
            var copy = stage
            if let key = stage.defaultKey, key == "test-write" || key == "test-setup" {
                copy.prompt = DefaultRevisionCatalog.shipped.history[key]?[1]?.prompt
                copy.defaultRevision = 1
            }
            return copy
        }
        return loop
    }
}

final class StageOutputParserCargoTests: XCTestCase {
    func testCargoSumsEveryBinary() {
        let out = "test result: ok. 4 passed; 0 failed; 0 ignored\ntest result: FAILED. 1 passed; 2 failed; 0 ignored"
        XCTAssertEqual(StageOutputParser.parseFailureCount(out), 2)
    }

    func testCargoFailedCount() {
        let out = "test result: FAILED. 3 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out"
        XCTAssertEqual(StageOutputParser.parseFailureCount(out), 2)
    }

    func testDetectTestCommandExcludesPerformance() throws {
        let root = try TempRepo.make(files: ["pytest.ini": "[pytest]", "tests/unit/test_a.py": "def test_a(): pass",
                                             "tests/integration/test_p.py": "def test_p(): pass",
                                             "tests/performance/test_perf.py": "def test_perf(): pass"])
        XCTAssertEqual(LoopStageDetector.detectTestCommand(gitRoot: root), "pytest --ignore=tests/performance")
    }
}
