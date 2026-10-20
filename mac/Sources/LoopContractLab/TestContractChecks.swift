import Foundation
import LlmIdeMacLib

#if FEATURE_AUTOTASK

// Asserts the Test loop's Setup/Write prompts follow the company test guideline,
// the loop ends with the advisory Test Prune report, and a Test loop saved by an
// older build is brought forward only where it is provably unedited.

func runTestContractChecks() {
    print("test contract (guideline prompts + revision upgrade)")

    let write = LoopStageDetector.testWritePrompt
    expect(write.contains("Unit-test candidates"), "Test Write reads the Unit-test candidates section")
    expect(write.contains("public calls"), "Test Write asserts through public calls only")
    expect(write.contains("not one test per function"), "Test Write tests behaviours, not one test per function")
    expect(!write.contains("every untested function"), "Test Write no longer pins every untested function")
    let setup = LoopStageDetector.testSetupPrompt
    expect(setup.contains("tests/unit/") && setup.contains("testpaths = tests/unit tests/integration"),
           "Test Setup creates the layered Python layout")
    expect(setup.contains("never create empty folders or files"), "Test Setup never creates empty folders or files")

    for key in ["test-write", "test-setup", "refactor-setup"] {
        expect(LoopStageDetector.shippedRevision(key: key) == 2, "\(key) is shipped at revision 2")
    }
    expect(LoopStageDetector.shippedStage(key: "test-write", revision: 1)?.prompt?
               .contains("every untested function") == true,
           "revision 1 of Test Write keeps the exact text users were shipped")
    expect(LoopStageDetector.shippedStage(key: "test-setup", revision: 1)?.prompt
               == LoopStageDetector.shippedStage(key: "refactor-setup", revision: 1)?.prompt,
           "Test Setup and Refactor Setup share their revision-1 text")

    let root = FileManager.default.temporaryDirectory.appendingPathComponent("test-contract-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    try? "".write(to: root.appendingPathComponent("Package.swift"), atomically: true, encoding: .utf8)
    defer { try? FileManager.default.removeItem(at: root) }
    let noRunner = FileManager.default.temporaryDirectory.appendingPathComponent("test-contract-nr-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: noRunner, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: noRunner) }

    let stages = LoopStageDetector.defaultStages(forLoop: LoopDefaultLoopKey.test, gitRoot: root)
    expect(stages.suffix(2).map(\.name) == ["Test Map Check", "Test Prune"], "the Test loop ends with Test Prune")
    let prune = stages.last
    expect(prune?.kind == .testPrune && prune?.testOp == nil && prune?.severity == .advisory
               && prune?.defaultKey == "test-prune",
           "Test Prune is its own advisory stage kind")
    // An older build decodes `testOp` strictly, so a new op value would make it
    // quarantine the whole loop.json; an unknown KIND it reads as `.unsupported`.
    let pruneJSON = prune.flatMap { try? JSONEncoder().encode($0) }.map { String(decoding: $0, as: UTF8.self) } ?? ""
    expect(pruneJSON.contains("\"kind\":\"testPrune\"") && !pruneJSON.contains("testOp"),
           "Test Prune encodes as kind testPrune with no testOp key")
    expect(TestMapOp(rawValue: "prune") == nil, "TestMapOp has no prune op")
    let bare = LoopStageDetector.defaultStages(forLoop: LoopDefaultLoopKey.test, gitRoot: noRunner)
    expect(!bare.contains { $0.defaultKey == "test-prune" }, "no Test Prune without a runner")

    runSavedTestLoopUpgradeChecks(root: root)
    runTestLoopContractTextChecks(root: root)

    let batch = LoopStageDetector.refactorTestWritePrompt
    expect(!batch.contains("every untested function"), "Refactor Test Write no longer pins every untested function")
    expect(batch.contains("before/after-equality") && batch.contains("public calls"),
           "Refactor Test Write follows the skill's Batch mode")
    expect(LoopStageDetector.shippedRevision(key: "refactor-test-write") == 2, "refactor-test-write is shipped at revision 2")
    expect(LoopStageDetector.shippedStage(key: "refactor-test-write", revision: 1)?.prompt?
               .contains("every untested function") == true,
           "revision 1 of Refactor Test Write keeps the exact text users were shipped")
}

/// The Test loop goal / acceptance text the previous build created loops with.
private let shippedTestGoalRevision2 = "Keep the test suite green and growing: every run adds real tests for the "
    + "most-used untested functions and records every new failure as a fault."
private let shippedTestAcceptanceRevision2 = "The test command exits 0, untestedFunctions in TEST-MAP.md is lower "
    + "than at the start of the run when Test Write ran, and every new failure has a fault with a runnable verify command."

private func runTestLoopContractTextChecks(root: URL) {
    guard let fresh = LoopStageDetector.defaultLoops(gitRoot: root)
        .first(where: { $0.defaultKey == LoopDefaultLoopKey.test }) else {
        expect(false, "a Test loop exists for a Swift package")
        return
    }
    let text = (fresh.goal ?? "") + " " + (fresh.acceptanceCriteria ?? "")
    expect(!text.contains("untestedFunctions") && !text.lowercased().contains("untested functions"),
           "the Test loop's goal and acceptance set no coverage counter as the goal")

    var saved = fresh
    saved.goal = shippedTestGoalRevision2
    saved.acceptanceCriteria = shippedTestAcceptanceRevision2
    let upgraded = LoopStageDetector.ensureDefaultLoops(in: LoopEngineProjectStore(loops: [saved]), gitRoot: root)
        .store.loops.first { $0.defaultKey == LoopDefaultLoopKey.test }
    expect(upgraded?.goal == fresh.goal && upgraded?.acceptanceCriteria == fresh.acceptanceCriteria,
           "an unedited coverage-goal Test loop text is brought to the guideline text")

    var edited = saved
    edited.acceptanceCriteria = "My own acceptance."
    let kept = LoopStageDetector.ensureDefaultLoops(in: LoopEngineProjectStore(loops: [edited]), gitRoot: root)
        .store.loops.first { $0.defaultKey == LoopDefaultLoopKey.test }
    expect(kept?.acceptanceCriteria == "My own acceptance.", "an edited Test loop acceptance text is kept")
}

/// A Test loop as the previous build saved it: no Test Prune, and the
/// revision-1 Setup/Write content.
private func revisionOneTestLoop(root: URL) -> LoopDefinition? {
    guard var loop = LoopStageDetector.defaultLoops(gitRoot: root)
        .first(where: { $0.defaultKey == LoopDefaultLoopKey.test }) else { return nil }
    loop.config.stages = loop.config.stages.filter { $0.defaultKey != "test-prune" }.map { stage in
        var copy = stage
        if let key = stage.defaultKey, ["test-write", "test-setup"].contains(key) {
            copy.prompt = LoopStageDetector.shippedStage(key: key, revision: 1)?.prompt
            copy.defaultRevision = 1
        }
        return copy
    }
    return loop
}

private func runSavedTestLoopUpgradeChecks(root: URL) {
    guard let saved = revisionOneTestLoop(root: root) else {
        expect(false, "a Test loop exists for a Swift package")
        return
    }
    func testStage(_ key: String, _ store: LoopEngineProjectStore) -> LoopStage? {
        store.loops.first { $0.defaultKey == LoopDefaultLoopKey.test }?.config.stages.first { $0.defaultKey == key }
    }

    let upgraded = LoopStageDetector.ensureDefaultLoops(in: LoopEngineProjectStore(loops: [saved]), gitRoot: root).store
    expect(testStage("test-write", upgraded)?.prompt == LoopStageDetector.testWritePrompt
           && testStage("test-write", upgraded)?.defaultRevision == 2,
           "an unedited saved Test Write gains the guideline prompt")
    expect(testStage("test-setup", upgraded)?.prompt == LoopStageDetector.testSetupPrompt,
           "an unedited saved Test Setup gains the guideline prompt")
    let upgradedNames = upgraded.loops.first { $0.defaultKey == LoopDefaultLoopKey.test }?.config.stages
        .sorted { $0.order < $1.order }.map(\.name) ?? []
    expect(upgradedNames.suffix(2) == ["Test Map Check", "Test Prune"], "a saved Test loop gains Test Prune at the end")

    var edited = saved
    let mine = "Write tests my way."
    edited.config.stages = edited.config.stages.map { stage in
        var copy = stage
        if stage.defaultKey == "test-write" { copy.prompt = mine }
        return copy
    }
    let kept = LoopStageDetector.ensureDefaultLoops(in: LoopEngineProjectStore(loops: [edited]), gitRoot: root).store
    expect(testStage("test-write", kept)?.prompt == mine && testStage("test-write", kept)?.defaultRevision == 1,
           "an edited Test Write keeps the user's prompt")
    expect(testStage("test-setup", kept)?.prompt == LoopStageDetector.testSetupPrompt,
           "its unedited Test Setup is still upgraded (the two are not coupled)")
}

#endif
