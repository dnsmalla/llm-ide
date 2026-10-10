import XCTest
@testable import LlmIdeMacLib

final class ArtifactCheckSectionRulesTests: XCTestCase {
    private var root: URL!
    private var project: URL!

    override func setUpWithError() throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("artifact-sections-\(UUID().uuidString)").resolvingSymlinksInPath()
        root = base.appendingPathComponent("repo")
        project = base.appendingPathComponent("project")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
    }

    override func tearDown() {
        if let root { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
    }

    private func write(_ rel: String, _ text: String) throws {
        let url = root.appendingPathComponent(rel)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try text.write(to: url, atomically: true, encoding: .utf8)
    }

    private let stages = [
        LoopStage(name: "Refactor Plan", kind: .skill, order: 0, outputPath: "llm-doc/refactor.md",
                  isDefault: true, defaultKey: "refactor-plan"),
    ]

    private func eval(_ spec: ArtifactCheckSpec) -> ArtifactCheckEvaluator.Result {
        ArtifactCheckEvaluator.evaluate(spec, roots: .init(repo: root, project: project), stages: stages)
    }

    private func sectionSpec() -> ArtifactCheckSpec {
        .init(outputRules: [.init(stage: "refactor-plan", shape: .file, maxLines: 250)],
              sectionRules: [.init(headerPrefix: "### R",
                                   requiredLinePrefixes: ["- Files:", "- Expect:", "- Tests:"])])
    }

    func testSectionMissingExpectNamesTheHeader() throws {
        try write("llm-doc/refactor.md", """
        # Refactor

        ### R1 Extract parser
        - Files: a.swift
        - Expect: parses
        - Tests: ParserTests

        ### R2 Rename thing
        - Files: b.swift
        - Tests: RenameTests

        """)
        let r = eval(sectionSpec())
        XCTAssertEqual(r.failures, ["### R2 Rename thing: missing `- Expect:`"])
    }

    func testAllRequiredLinesPresentPasses() throws {
        try write("llm-doc/refactor.md", """
        ### R1 One
        - Files: a.swift
        - Expect: ok
        - Tests: t

        ### R2 Two
        - Files: b.swift
        - Expect: ok
        - Tests: t

        """)
        XCTAssertEqual(eval(sectionSpec()).failures, [])
    }

    func testFileWithNoRSectionsHasNoSectionFailures() throws {
        try write("llm-doc/refactor.md", "# Refactor\n\nNothing to refactor.\n")
        XCTAssertEqual(eval(sectionSpec()).failures, [])
    }

    func testIndentedPrefixDoesNotSatisfyRequiredLine() throws {
        try write("llm-doc/refactor.md", """
        ### R1 One
        - Files: a.swift
          - Expect: indented does not count
        - Tests: t

        """)
        XCTAssertEqual(eval(sectionSpec()).failures, ["### R1 One: missing `- Expect:`"])
    }

    func testSectionRulesDecodeAsEmptyWhenAbsent() throws {
        let old = Data(#"{"requiredPaths":["a.md"],"lineLimits":[],"citationGlobs":[],"projectRootFallback":false}"#.utf8)
        let spec = try JSONDecoder().decode(ArtifactCheckSpec.self, from: old)
        XCTAssertEqual(spec.sectionRules, [])
    }

    func testRefactorPlanCheckSpecRequiresTheThreeLinesPerRSection() throws {
        XCTAssertEqual(LoopStageDetector.refactorPlanCheckSpec.sectionRules,
                       [.init(headerPrefix: "### R", requiredLinePrefixes: ["- Files:", "- Expect:", "- Tests:"])])
        try write("llm-doc/refactor.md", "### R1 Only\n- Files: a.swift\n")
        let r = eval(LoopStageDetector.refactorPlanCheckSpec)
        XCTAssertEqual(r.failures, ["### R1 Only: missing `- Expect:`", "### R1 Only: missing `- Tests:`"])
    }
}
