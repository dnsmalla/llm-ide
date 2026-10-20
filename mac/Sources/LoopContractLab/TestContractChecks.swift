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
    expect(prune?.testOp == .prune && prune?.severity == .advisory && prune?.defaultKey == "test-prune",
           "Test Prune is an advisory prune report")
    let bare = LoopStageDetector.defaultStages(forLoop: LoopDefaultLoopKey.test, gitRoot: noRunner)
    expect(!bare.contains { $0.defaultKey == "test-prune" }, "no Test Prune without a runner")

    runSavedTestLoopUpgradeChecks(root: root)
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
