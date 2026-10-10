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

    // MARK: - Fix round 1: saved loops upgrade in run order; Setup/writer follow detection

    private static let refactorKeysInRunOrder = ["refactor-structure", "refactor-setup", "refactor-structure-check",
        "refactor-graph", "refactor-test-map", "refactor-plan", "refactor-plan-check", "refactor-test-write",
        "refactor-test-baseline", "refactor-apply", "refactor-test", "refactor-ledger", "refactor-graph-check"]

    /// A project saved with the three-stage Refactoring loop (revision 2, the user's
    /// `make test` on the test stage) upgrades into the full pipeline IN RUN ORDER:
    /// the baseline runs before the apply, the snapshot before any change.
    func testSavedThreeStageLoopUpgradesIntoRunOrderAndKeepsTheUsersCommand() throws {
        let root = try TempRepo.make(files: ["Package.swift": pkg])
        var plan = try XCTUnwrap(LoopStageDetector.shippedStage(key: "refactor-plan", revision: 2))
        plan.id = "refactor/refactor-plan"; plan.isDefault = true; plan.defaultKey = "refactor-plan"
        plan.defaultRevision = 2; plan.order = 0
        var apply = try XCTUnwrap(LoopStageDetector.shippedStage(key: "refactor-apply", revision: 2))
        apply.id = "refactor/refactor-apply"; apply.isDefault = true; apply.defaultKey = "refactor-apply"
        apply.defaultRevision = 2; apply.order = 1
        var test = LoopStage(id: "refactor/refactor-test", name: "Test", kind: .shellCommand,
                             command: "make test", order: 2, isDefault: true, defaultKey: "refactor-test",
                             detectedCommand: "swift test")
        test.defaultRevision = 2
        let saved = LoopEngineProjectStore(loops: [
            LoopDefinition(id: "default-refactor", name: "Refactoring", defaultKey: LoopDefaultLoopKey.refactor,
                           config: LoopEngineConfig(stages: [plan, apply, test])),
        ])
        let ensured = LoopStageDetector.ensureDefaultLoops(in: saved, gitRoot: root).store
        let stages = LoopStage.runOrder(try XCTUnwrap(ensured.loops.first {
            $0.defaultKey == LoopDefaultLoopKey.refactor }).config.stages)
        XCTAssertEqual(stages.compactMap(\.defaultKey), Self.refactorKeysInRunOrder)
        XCTAssertEqual(stages.map(\.order), Array(0..<13))
        let byKey = Dictionary(uniqueKeysWithValues: stages.map { ($0.defaultKey ?? "", $0) })
        XCTAssertEqual(byKey["refactor-test"]?.command, "make test")
        XCTAssertEqual(byKey["refactor-test-baseline"]?.command, "swift test")
        XCTAssertEqual(byKey["refactor-test-baseline"]?.detectedCommand, "swift test")
        XCTAssertEqual(byKey["refactor-test-baseline"]?.allowsRepair, false)
        XCTAssertEqual(byKey["refactor-graph"]?.graphOp, .snapshot)
        XCTAssertEqual(byKey["refactor-graph-check"]?.graphOp, .verify)
    }

    /// Runner LOST: Setup comes back only because it carries the mark, and the
    /// writer goes off with its own mark so the plan-only shape writes no tests.
    func testRunnerLostReEnablesMarkedSetupAndDisablesTheWriter() throws {
        let withRunner = try TempRepo.make(files: ["Package.swift": pkg])
        let planOnly = try TempRepo.make(files: ["README.md": "x"])
        let stages = LoopStageDetector.defaultStages(forLoop: LoopDefaultLoopKey.refactor, gitRoot: withRunner)
        let loops = [LoopDefinition(id: "default-refactor", name: "Refactoring",
                                    defaultKey: LoopDefaultLoopKey.refactor,
                                    config: LoopEngineConfig(stages: stages))]
        let (out, _) = LoopStageDetector.revalidatingTestStages(in: loops, gitRoot: planOnly, eligibleStageIDs: [])
        let result = out[0].config.stages
        let setup = try XCTUnwrap(result.first { $0.defaultKey == "refactor-setup" })
        XCTAssertTrue(setup.enabled)
        XCTAssertNil(setup.disabledByDetection)
        let writer = try XCTUnwrap(result.first { $0.defaultKey == "refactor-test-write" })
        XCTAssertFalse(writer.enabled)
        XCTAssertEqual(writer.disabledByDetection, true)
    }

    /// Runner APPEARED: a plan-only loop gains the writer, Setup goes off with its
    /// own mark, and a writer disabled by an earlier loss comes back on.
    func testRunnerAppearedDisablesSetupAndReEnablesTheMarkedWriter() throws {
        let withRunner = try TempRepo.make(files: ["Package.swift": pkg])
        let planOnly = try TempRepo.make(files: ["README.md": "x"])
        var stages = LoopStageDetector.defaultStages(forLoop: LoopDefaultLoopKey.refactor, gitRoot: planOnly)
        var writer = try XCTUnwrap(LoopStageDetector.defaultStages(forLoop: LoopDefaultLoopKey.refactor,
                                                                   gitRoot: withRunner)
            .first { $0.defaultKey == "refactor-test-write" })
        writer.enabled = false
        writer.disabledByDetection = true
        stages.append(writer)
        let loops = [LoopDefinition(id: "default-refactor", name: "Refactoring",
                                    defaultKey: LoopDefaultLoopKey.refactor,
                                    config: LoopEngineConfig(stages: stages))]
        let (out, _) = LoopStageDetector.revalidatingTestStages(in: loops, gitRoot: withRunner, eligibleStageIDs: [])
        let result = out[0].config.stages
        let setup = try XCTUnwrap(result.first { $0.defaultKey == "refactor-setup" })
        XCTAssertFalse(setup.enabled)
        XCTAssertEqual(setup.disabledByDetection, true)
        let back = try XCTUnwrap(result.first { $0.defaultKey == "refactor-test-write" })
        XCTAssertTrue(back.enabled)
        XCTAssertNil(back.disabledByDetection)
    }
}
