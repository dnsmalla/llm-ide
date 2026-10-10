import XCTest
@testable import LlmIdeMacLib

final class LoopStageTestMapKindTests: XCTestCase {
    func testRoundTripAndNotAVerifier() throws {
        let s = LoopStage(name: "Test Map", kind: .testMap, order: 0, isDefault: true, defaultKey: "test-map", testOp: .map)
        let back = try JSONDecoder().decode(LoopStage.self, from: JSONEncoder().encode(s))
        XCTAssertEqual(back.kind, .testMap); XCTAssertEqual(back.testOp, .map); XCTAssertFalse(back.verifies)
    }
    func testOldStageWithoutOpDecodesAndOmitsKey() throws {
        let s = LoopStage(name: "x", kind: .shellCommand, command: "true", order: 0)
        let data = try JSONEncoder().encode(s)
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("testOp"))
        XCTAssertNil(try JSONDecoder().decode(LoopStage.self, from: data).testOp)
    }
    func testWriterIsCodeApplyButNotManualOnly() {
        let writer = LoopStage(name: "Test Write", kind: .skill, order: 1, skillId: "skills/test-gap-writer", targetPath: "x", outputPath: "y", isDefault: true, defaultKey: "test-write")
        XCTAssertTrue(writer.appliesCode); XCTAssertTrue(writer.testWriteOnly)
        let test = LoopStage(name: "Test", kind: .shellCommand, command: "swift test", order: 2, isDefault: true, defaultKey: "test")
        let loop = LoopDefinition(name: "Test", defaultKey: LoopDefaultLoopKey.test,
                                  config: LoopEngineDefaults.newConfig(stages: [writer, test], defaults: UserDefaults(suiteName: UUID().uuidString)!))
        XCTAssertFalse(loop.isManualOnly)
        let setup = LoopStage(name: "Test Setup", kind: .skill, order: 0, skillId: "skills/test-structure-setup", targetPath: "x", outputPath: ".", isDefault: true, defaultKey: "test-setup")
        XCTAssertFalse(setup.testWriteOnly); XCTAssertTrue(setup.appliesCode)
        let setupLoop = LoopDefinition(name: "T", defaultKey: LoopDefaultLoopKey.test,
                                       config: LoopEngineDefaults.newConfig(stages: [setup, test], defaults: UserDefaults(suiteName: UUID().uuidString)!))
        XCTAssertTrue(setupLoop.isManualOnly)
    }
    func testWriterGetsWarnPolicyLikeCodeApply() {
        var config = LoopEngineDefaults.newConfig(stages: [], defaults: UserDefaults(suiteName: UUID().uuidString)!); config.protectedPathPolicy = .revert
        let writer = LoopStage(name: "Test Write", kind: .skill, order: 1, skillId: "skills/test-gap-writer")
        XCTAssertEqual(LoopEngineRunner.effectivePolicy(for: writer, config: config), .warn)
    }
    func testAttemptFields() throws {
        var a = LoopStageAttempt(stageId: "x", stageName: "Ledger", kind: .testMap, severity: .blocking, startedAt: Date(), durationSeconds: 0, exitCode: nil, passed: true, outputTail: "", outputHash: nil, score: nil)
        a.testMapDelta = ["untestedFunctions": -3]; a.newFaults = ["T.A/testB"]
        let back = try JSONDecoder().decode(LoopStageAttempt.self, from: JSONEncoder().encode(a))
        XCTAssertEqual(back.testMapDelta?["untestedFunctions"], -3); XCTAssertEqual(back.newFaults, ["T.A/testB"])
    }
    func testWriteGuardClassification() {
        let roots = ["mac/Tests/LlmIdeMacTests"]
        let bad = LoopEngineRunner.testWriteViolations(
            changed: ["mac/Tests/LlmIdeMacTests/NewTests.swift", "mac/Tests/LlmIdeMacTests/Old.swift", "mac/Sources/A.swift"],
            created: ["mac/Tests/LlmIdeMacTests/NewTests.swift", "mac/Sources/A.swift"], allowedDirs: roots)
        XCTAssertEqual(bad.modified, ["mac/Tests/LlmIdeMacTests/Old.swift"])
        XCTAssertEqual(bad.created, ["mac/Sources/A.swift"])
        XCTAssertTrue(LoopEngineRunner.testWriteViolations(changed: ["mac/Tests/LlmIdeMacTests/N.swift"], created: ["mac/Tests/LlmIdeMacTests/N.swift"], allowedDirs: roots).modified.isEmpty)
    }
    func testPassingIdsFromXCTestOutput() {
        let out = "Test Case '-[LlmIdeMacTests.FooTests testA]' passed (0.001 seconds).\nTest Case '-[LlmIdeMacTests.FooTests testB]' failed (0.1 seconds)."
        XCTAssertEqual(LoopEngineRunner.passingTestIds(out), ["LlmIdeMacTests.FooTests/testA"])
    }
}
