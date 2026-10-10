import XCTest
@testable import LlmIdeMacLib

final class LoopStageDetectorRefactorLoopTests: XCTestCase {
    private let pkg = "// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: \"x\", targets: [.testTarget(name: \"XTests\")])\n"

    func testOrderWithRunner() throws {
        let root = try TempRepo.make(files: ["Package.swift": pkg])
        let s = LoopStageDetector.defaultStages(forLoop: LoopDefaultLoopKey.refactor, gitRoot: root)
        XCTAssertEqual(s.map(\.defaultKey), ["refactor-structure", "refactor-setup", "refactor-structure-check", "refactor-graph", "refactor-test-map", "refactor-plan", "refactor-plan-check", "refactor-test-write", "refactor-test-baseline", "refactor-apply", "refactor-test", "refactor-ledger", "refactor-graph-check"])
        XCTAssertEqual(s[1].enabled, false); XCTAssertEqual(s[3].graphOp, .snapshot); XCTAssertEqual(s[12].graphOp, .verify)
        XCTAssertEqual(s[8].allowsRepair, false); XCTAssertTrue(s[10].allowsRepair)
        XCTAssertTrue(s[7].testWriteOnly)
        XCTAssertFalse(s.filter(\.enabled).contains { LoopStage.lacksVerifyAfter($0, in: s) })
    }
    func testPlanOnlyWithoutRunner() throws {
        let root = try TempRepo.make(files: ["README.md": "x"])
        let s = LoopStageDetector.defaultStages(forLoop: LoopDefaultLoopKey.refactor, gitRoot: root)
        XCTAssertEqual(s.map(\.defaultKey), ["refactor-structure", "refactor-setup", "refactor-structure-check", "refactor-graph", "refactor-test-map", "refactor-plan", "refactor-plan-check"])
        XCTAssertEqual(s[1].enabled, true)
        XCTAssertFalse(s.filter(\.enabled).contains { LoopStage.lacksVerifyAfter($0, in: s) })
    }
    func testStillManualOnly() throws {
        let root = try TempRepo.make(files: ["Package.swift": "let p = Package(targets: [.testTarget(name: \"XTests\")])"])
        XCTAssertTrue(LoopStageDetector.defaultLoops(gitRoot: root).first { $0.defaultKey == LoopDefaultLoopKey.refactor }!.isManualOnly)
    }

    func testShippedRevisionsOfTheRefactorStages() {
        let catalog = DefaultRevisionCatalog.shipped
        XCTAssertEqual(catalog.current("refactor-plan"), 3)
        XCTAssertEqual(catalog.current("refactor-apply"), 3)
        XCTAssertEqual(catalog.current("refactor-test"), 2)
        XCTAssertNotNil(catalog.history["refactor-plan"]?[2])
        XCTAssertNotNil(catalog.history["refactor-apply"]?[2])
        XCTAssertNotNil(catalog.history["refactor-test"]?[1])
    }

    /// An unedited revision-2 plan stage upgrades; an edited one is left alone.
    func testUneditedRevisionTwoPlanIsUpgradedAndAnEditedOneIsNot() throws {
        let v2 = try XCTUnwrap(DefaultRevisionCatalog.shipped.history["refactor-plan"]?[2])
        func loop(prompt: String) -> LoopDefinition {
            var stage = v2
            stage.id = "refactor/refactor-plan"
            stage.isDefault = true
            stage.defaultKey = "refactor-plan"
            stage.defaultRevision = 2
            stage.prompt = prompt
            return LoopDefinition(id: "default-refactor", name: "Refactoring",
                                  defaultKey: LoopDefaultLoopKey.refactor,
                                  config: LoopEngineConfig(stages: [stage]))
        }
        let root = try TempRepo.make(files: ["Package.swift": pkg])
        let unedited = LoopStageDetector.upgradingDefaultRevisions(
            in: [loop(prompt: v2.prompt ?? "")], gitRoot: root).loops[0].config.stages[0]
        XCTAssertEqual(unedited.defaultRevision, 3)
        XCTAssertEqual(unedited.prompt, LoopStageDetector.refactorPlanPrompt)
        let edited = LoopStageDetector.upgradingDefaultRevisions(
            in: [loop(prompt: "mine")], gitRoot: root).loops[0].config.stages[0]
        XCTAssertEqual(edited.defaultRevision, 2)
        XCTAssertEqual(edited.prompt, "mine")
    }

    func testRefactorContractIsShipped() {
        let contract = LoopStageDetector.defaultLoopContract(LoopDefaultLoopKey.refactor)
        XCTAssertEqual(contract?.goal, "Move the codebase toward a professional, graph-verified structure one tested, behaviour-preserving batch at a time.")
        XCTAssertEqual(contract?.acceptance, "Every file the batch touches has tests that passed before the change, the suite passes after it, and the fresh code-graph snapshot shows the batch's declared counter lower with no structural counter higher.")
        XCTAssertEqual(LoopStageDetector.legacyLoopContract(LoopDefaultLoopKey.refactor)?.goal,
                       "Move the codebase toward a professional, AI-friendly structure one safe, behaviour-preserving batch at a time.")
    }

    func testPlannerPromptPinsTheBatchHeadingAndEveryRefactorPromptIsPathAgnostic() {
        XCTAssertTrue(LoopStageDetector.refactorPlanPrompt.contains("no other headings may start with `### R`"))
        for prompt in [LoopStageDetector.refactorPlanPrompt, LoopStageDetector.refactorApplyPrompt,
                       LoopStageDetector.refactorTestWritePrompt] {
            XCTAssertFalse(prompt.contains("llm-doc"))
            XCTAssertTrue(prompt.contains("the Input") && prompt.contains("the Output"))
        }
    }
}
