import XCTest
@testable import LlmIdeMacLib

final class LoopArtifactCheckTests: XCTestCase {
    private var root: URL!
    private var project: URL!

    override func setUpWithError() throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("artifact-check-\(UUID().uuidString)").resolvingSymlinksInPath()
        root = base.appendingPathComponent("repo")
        project = base.appendingPathComponent("project")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
    }

    override func tearDown() {
        if let root { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
    }

    private func write(_ rel: String, lines: Int = 1, text: String? = nil, under base: URL? = nil) throws {
        let url = (base ?? root).appendingPathComponent(rel)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try (text ?? (0..<lines).map { "line \($0)" }.joined(separator: "\n") + "\n")
            .write(to: url, atomically: true, encoding: .utf8)
    }

    private func eval(_ spec: ArtifactCheckSpec) -> ArtifactCheckEvaluator.Result {
        ArtifactCheckEvaluator.evaluate(spec, roots: .init(repo: root, project: project))
    }

    // MARK: evaluator

    func testMissingRequiredPathFails() throws {
        try write("a.md")
        let r = eval(.init(requiredPaths: ["a.md", "b.md"]))
        XCTAssertEqual(r.failures, ["missing: b.md"])
    }

    func testLineLimitCountsEveryMatchingFileAndHonoursExcludes() throws {
        try write("docs/INDEX.md", lines: 280)
        try write("docs/a.md", lines: 251)
        try write("docs/sub/b.md", lines: 250)
        let r = eval(.init(lineLimits: [
            .init(glob: "docs/**/*.md", maxLines: 250, excludes: ["docs/INDEX.md"])]))
        XCTAssertEqual(r.failures, ["docs/a.md: 251 lines (limit 250)"])
    }

    func testProjectRootFallbackOnlyWhenOptedIn() throws {
        try write("llm-doc/plans/PLAN.md", lines: 300, under: project)
        let off = eval(.init(requiredPaths: ["llm-doc/plans/PLAN.md"]))
        XCTAssertEqual(off.failures, ["missing: llm-doc/plans/PLAN.md"])
        let on = eval(.init(requiredPaths: ["llm-doc/plans/PLAN.md"],
                            lineLimits: [.init(glob: "llm-doc/plans/PLAN.md", maxLines: 250)],
                            projectRootFallback: true))
        XCTAssertEqual(on.failures, ["llm-doc/plans/PLAN.md: 300 lines (limit 250)"])
    }

    func testCitationsResolveAgainstTheRepoRoot() throws {
        try write("src/real.swift", lines: 10)
        try write("docs/page.md", text: """
            Uses `src/real.swift`, `src/real.swift:9`, bare symbol `searchCodeIndex`, `docs/page.md`.
            Broken: `src/gone.swift`, `src/real.swift:99`, `nope/dir/file.mjs:3`.
            Not a path: `obj.method`, `https://x.io/a.js`, `git status`.
            ```
            `src/inside-fence.swift`
            ```

            """)
        let r = eval(.init(citationGlobs: ["docs/**/*.md"]))
        XCTAssertEqual(r.failures.count, 3, "\(r.failures)")
        XCTAssertTrue(r.failures.contains { $0.contains("`src/gone.swift`") })
        XCTAssertTrue(r.failures.contains { $0.contains("`src/real.swift:99`") })
        XCTAssertTrue(r.failures.contains { $0.contains("`nope/dir/file.mjs:3`") })
    }

    func testValidTreePasses() throws {
        try write("llm-doc/docs/INDEX.md", lines: 10)
        try write("src/x.swift")
        try write("llm-doc/docs/a.md", text: "see `src/x.swift:1`\n")
        XCTAssertTrue(eval(LoopStageDetector.docCheckSpec).passed)
    }

    // MARK: stage model

    func testArtifactCheckStageRoundTripsAndIsNeverAVerifyStage() throws {
        let stage = LoopStage(id: "c", name: "Check", kind: .artifactCheck, order: 1,
                              check: LoopStageDetector.planCheckSpec)
        let back = try JSONDecoder().decode(LoopStage.self, from: JSONEncoder().encode(stage))
        XCTAssertEqual(back, stage)
        XCTAssertTrue(stage.isBlockingArtifactCheck)
        XCTAssertFalse(stage.verifies)
        let apply = LoopStage(id: "a", name: "Apply", kind: .skill, order: 0, skillId: "skills/refactor-apply")
        XCTAssertTrue(LoopStage.lacksVerifyAfter(apply, in: [apply, stage]),
                      "an artifact check proves nothing about a code edit")
        var advisory = stage
        advisory.severity = .advisory
        XCTAssertFalse(advisory.isBlockingArtifactCheck)
    }

    func testOldStageJSONWithoutNewFieldsStillDecodes() throws {
        let json = #"{"id":"s","name":"Test","kind":"shellCommand","command":"x","order":0}"#
        let stage = try JSONDecoder().decode(LoopStage.self, from: Data(json.utf8))
        XCTAssertNil(stage.check)
        XCTAssertNil(stage.defaultRevision)
    }

    // MARK: default loops

    func testPlanAndDocsLoopsShipABlockingCheckWithStableIds() throws {
        let plan = LoopStageDetector.defaultStages(forLoop: LoopDefaultLoopKey.plan, gitRoot: root)
        let docs = LoopStageDetector.defaultStages(forLoop: LoopDefaultLoopKey.docs, gitRoot: root)
        XCTAssertEqual(plan.last?.id, "plan/plan-check")
        XCTAssertEqual(docs.last?.id, "docs/doc-check")
        XCTAssertEqual(plan.last?.kind, .artifactCheck)
        XCTAssertEqual(docs.last?.severity, .blocking)
        XCTAssertEqual(plan.last?.check?.lineLimits.map(\.maxLines), [300, 250])
        XCTAssertEqual(docs.last?.check?.citationGlobs, ["llm-doc/docs/**/*.md"])
    }

    // MARK: detection

    private func detect(makefile: String? = nil, packageJSON: String? = nil) throws -> String? {
        if let makefile { try write("Makefile", text: makefile) }
        if let packageJSON { try write("package.json", text: packageJSON) }
        return LoopStageDetector.detectTestCommand(gitRoot: root)
    }

    func testMakefileReturnsTheTargetThatMatched() throws {
        XCTAssertEqual(try detect(makefile: "regression:\n\techo hi\n"), "make regression")
    }

    func testMakefilePrefersTest() throws {
        XCTAssertEqual(try detect(makefile: "regression:\n\tx\ntest:\n\ty\n"), "make test")
    }

    func testNpmPlaceholderAndWatchScriptsAreNotTestSuites() throws {
        XCTAssertNil(try detect(packageJSON:
            #"{"scripts":{"test":"echo \"Error: no test specified\" && exit 1"}}"#))
        XCTAssertTrue(LoopStageDetector.isWatchScript("jest --watch"))
        XCTAssertTrue(LoopStageDetector.isWatchScript("vitest --watchAll"))
        XCTAssertFalse(LoopStageDetector.isWatchScript("jest --ci"))
        try write("package.json", text: #"{"scripts":{"test":"jest --watch"}}"#)
        XCTAssertNil(LoopStageDetector.detectTestCommand(gitRoot: root))
        try write("package.json", text: #"{"scripts":{"test":"node --test"}}"#)
        XCTAssertEqual(LoopStageDetector.detectTestCommand(gitRoot: root), "npm test")
    }

    // MARK: refactor-test re-detection (paired)

    private func refactorLoop(testCommand: String, detected: String?) -> LoopDefinition {
        var loop = LoopDefinition(id: "default-refactor", name: "Refactoring",
                                  defaultKey: LoopDefaultLoopKey.refactor,
                                  config: LoopEngineConfig(stages: [
            LoopStage(id: "refactor/refactor-apply", name: "Refactor Apply", kind: .skill, order: 1,
                      skillId: "skills/refactor-apply", isDefault: true, defaultKey: "refactor-apply"),
            LoopStage(id: "refactor/refactor-test", name: "Test", kind: .shellCommand, command: testCommand,
                      order: 2, isDefault: true, defaultKey: "refactor-test", detectedCommand: detected),
        ]))
        loop.isPrimary = false
        return loop
    }

    func testRefactorTestIsRevalidatedLikeTheOtherTestStages() throws {
        try write("Makefile", text: "test:\n\tx\n")
        let loop = refactorLoop(testCommand: "npm test", detected: "npm test")
        let (loops, changes) = LoopStageDetector.revalidatingTestStages(
            in: [loop], gitRoot: root, eligibleStageIDs: ["refactor/refactor-test"])
        XCTAssertEqual(loops[0].config.stages.last?.command, "make test")
        XCTAssertEqual(changes.first?.kind, .updated(from: "npm test", to: "make test"))
    }

    func testRefactorApplyIsDisabledWhenToolingDisappears() throws {
        let loop = refactorLoop(testCommand: "npm test", detected: "npm test")
        let (loops, changes) = LoopStageDetector.revalidatingTestStages(
            in: [loop], gitRoot: root, eligibleStageIDs: ["refactor/refactor-test"])
        let apply = loops[0].config.stages.first { $0.defaultKey == "refactor-apply" }
        XCTAssertEqual(apply?.enabled, false)
        XCTAssertEqual(changes.map(\.kind), [.disabledRefactorApply])
        XCTAssertTrue(loops[0].config.stages.contains { $0.defaultKey == "refactor-test" },
                      "the test stage itself is never dropped")
    }

    func testEditedRefactorTestStageIsLeftAlone() throws {
        let loop = refactorLoop(testCommand: "my custom", detected: "npm test")
        let (loops, changes) = LoopStageDetector.revalidatingTestStages(
            in: [loop], gitRoot: root, eligibleStageIDs: ["refactor/refactor-test"])
        XCTAssertEqual(loops, [loop])
        XCTAssertTrue(changes.isEmpty)
    }

    // MARK: versioned defaults

    private func catalog() -> (DefaultRevisionCatalog, LoopStage) {
        var old = LoopStageDetector.defaultStages(forLoop: LoopDefaultLoopKey.docs, gitRoot: root)[0]
        old.prompt = "OLD PROMPT"
        old.defaultRevision = nil
        return (DefaultRevisionCatalog(currentRevisions: ["doc-index": 2],
                                       history: ["doc-index": [1: old]]), old)
    }

    private func docsLoop(with stage: LoopStage) -> LoopDefinition {
        LoopDefinition(id: "default-docs", name: "Doc Optimization", defaultKey: LoopDefaultLoopKey.docs,
                       config: LoopEngineConfig(stages: [stage]))
    }

    func testUneditedOldRevisionUpgradesAutomatically() {
        let (cat, old) = catalog()
        var persisted = old
        persisted.enabled = false              // user tuning survives
        let (loops, changes) = LoopStageDetector.upgradingDefaultRevisions(
            in: [docsLoop(with: persisted)], gitRoot: root, catalog: cat)
        let stage = loops[0].config.stages[0]
        XCTAssertEqual(stage.prompt, LoopStageDetector.docIndexPrompt)
        XCTAssertEqual(stage.defaultRevision, 2)
        XCTAssertFalse(stage.enabled)
        XCTAssertEqual(changes.first?.kind, .upgradedDefault(revision: 2))
    }

    func testEditedStageShowsUpdateAvailableAndResetsOnRequest() {
        let (cat, old) = catalog()
        var edited = old
        edited.prompt = "my own prompt"
        let (loops, changes) = LoopStageDetector.upgradingDefaultRevisions(
            in: [docsLoop(with: edited)], gitRoot: root, catalog: cat)
        XCTAssertEqual(loops[0].config.stages[0].prompt, "my own prompt")
        XCTAssertTrue(changes.isEmpty)
        XCTAssertTrue(LoopStageDetector.updateAvailable(for: edited, catalog: cat))
        let reset = LoopStageDetector.resetToDefault(edited, loopKey: LoopDefaultLoopKey.docs, gitRoot: root)
        XCTAssertEqual(reset?.prompt, LoopStageDetector.docIndexPrompt)
        XCTAssertEqual(reset?.id, edited.id)
    }

    func testCurrentShippedDefaultsNeverReportAnUpdate() {
        for stage in LoopStageDetector.defaultStages(forLoop: LoopDefaultLoopKey.docs, gitRoot: root) {
            XCTAssertFalse(LoopStageDetector.updateAvailable(for: stage))
        }
    }

    // MARK: CI=1

    func testShellStagesRunWithCIEnvironment() async throws {
        let outcome = try await ShellFaultVerifier().verify(command: "echo CI=$CI", repoRoot: root, timeout: 30)
        XCTAssertTrue(outcome.output.contains("CI=1"), outcome.output)
    }
}
