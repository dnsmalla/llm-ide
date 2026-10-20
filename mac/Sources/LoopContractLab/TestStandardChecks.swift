import Foundation
import LlmIdeMacLib

#if FEATURE_AUTOTASK

// Asserts the Test loop's alignment with the company test guideline.

func runTestStandardChecks() {
    print("test standard")

    let stalled = TestMapCheck.mapCheckOutcome(delta: ["untestedFunctions": 0], writerChanged: true)
    expect(stalled.passed, "map check passes when the untested count did not fall")
    expect(stalled.note?.contains("advisory") == true, "map check notes the stall as advisory")

    let idle = TestMapCheck.mapCheckOutcome(delta: [:], writerChanged: false)
    expect(idle.passed, "map check passes when the writer covered nothing")
    expect(idle.note == nil, "map check has no note when the writer changed nothing")

    expect(CodeQuadrantClassifier.classify(loc: 20, functionCount: 2, collaborators: 1, role: nil) == .trivial,
           "small file is trivial")
    expect(CodeQuadrantClassifier.classify(loc: 120, functionCount: 5, collaborators: 2, role: "service") == .domainLogic,
           "complex file with few collaborators is domain logic")
    expect(CodeQuadrantClassifier.classify(loc: 120, functionCount: 5, collaborators: 2, role: "view") == .controller,
           "view role is a controller")
    expect(CodeQuadrantClassifier.classify(loc: 200, functionCount: 8, collaborators: 9, role: nil) == .overComplex,
           "complex file with many collaborators is over-complex")
    expect(CodeQuadrantClassifier.classify(loc: 500, functionCount: 1, collaborators: 0, role: nil) == .overComplex,
           "500-line file is over-complex")

    runLayeredLayoutChecks()
    runPruneChecks()
    runTestContractChecks()
}

private func makeLayoutFixture(_ files: [String]) -> URL {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("layout-\(UUID().uuidString)")
    for rel in files {
        let url = root.appendingPathComponent(rel)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: url.path, contents: Data("x".utf8))
    }
    return root
}

private func runLayeredLayoutChecks() {
    let layered = makeLayoutFixture(["pytest.ini", "tests/unit/domain/test_a.py",
                                     "tests/integration/test_p.py", "tests/performance/test_perf.py"])
    defer { try? FileManager.default.removeItem(at: layered) }
    let layeredRoot = TestStructureDetector(gitRoot: layered).detect().roots.first
    expect(layeredRoot?.layout == .layered, "tests/unit marks the pytest root layered")
    expect(layeredRoot?.testDir == "tests", "layered root keeps testDir tests")
    expect(layeredRoot?.command == "pytest tests/unit tests/integration", "layered command skips performance")

    let flat = makeLayoutFixture(["pytest.ini", "tests/test_a.py"])
    defer { try? FileManager.default.removeItem(at: flat) }
    let flatRoot = TestStructureDetector(gitRoot: flat).detect().roots.first
    expect(flatRoot?.layout == nil, "flat pytest layout has nil layout")
    expect(flatRoot?.command == "pytest", "flat pytest command unchanged")

    if let root = layeredRoot {
        var rooted = root
        rooted.packageDir = ""
        expect(TestSourceMapper.newTestPath(forSourcePath: "logic/domain/time_range.py", root: rooted)
               == "tests/unit/domain/test_time_range.py", "layered placement mirrors the source tree")
        expect(TestSourceMapper.newTestPath(forSourcePath: "logic/a.py", root: rooted)
               == "tests/unit/test_a.py", "layered placement for a top-level module")
    }
    expect(!TestSourceMapper.isSourceCandidate("analysis/visualize/plot.py"), "analysis/ is not a source candidate")
    expect(TestSourceMapper.isSourceCandidate("logic/plot.py"), "logic/ stays a source candidate")
    expect(LoopStageDetector.detectTestCommand(gitRoot: layered) == "pytest tests/unit tests/integration",
           "detectTestCommand excludes performance")
}

private func runPruneChecks() {
    let root = makeLayoutFixture([
        "Package.swift",
        "Sources/Foo.swift",
        "Tests/FooTests.swift",
        "Tests/BarTests.swift",
    ])
    defer { try? FileManager.default.removeItem(at: root) }
    func put(_ rel: String, _ text: String) {
        try? text.write(to: root.appendingPathComponent(rel), atomically: true, encoding: .utf8)
    }
    put("Tests/FooTests.swift", "func testA() {\n    // placeholder\n    // func testOld() {}\n}\n")
    put("Tests/BarTests.swift", "func testB() { XCTAssertTrue(true) }\n")
    let structure = TestStructure(
        generatedAt: Date(),
        roots: [TestRoot(packageDir: "", testDir: "Tests", runner: .xctest, command: "swift test",
                         namingRule: "XTests.swift", languages: ["swift"])],
        status: "ok", notes: [])
    let scanner = TestPruneScanner(gitRoot: root, structure: structure)
    let found = scanner.scan()
    expect(found.contains(TestPruneFinding(path: "Tests/FooTests.swift", reason: .noAssertion)),
           "prune flags a test file with no assertion")
    expect(found.contains(TestPruneFinding(path: "Tests/FooTests.swift", reason: .commentedOutTest, line: 3)),
           "prune reports a commented-out test with its line")
    expect(found.contains(TestPruneFinding(path: "Tests/BarTests.swift", reason: .sourceGone)),
           "prune flags a test whose source is gone")
    expect(!found.contains { $0.path == "Tests/BarTests.swift" && $0.reason == .noAssertion },
           "prune leaves an asserting test alone")
    _ = try? scanner.write(found, outputRoot: root)
    expect(FileManager.default.fileExists(atPath: root.appendingPathComponent("Tests/FooTests.swift").path),
           "prune never deletes a test file")
    let report = (try? String(contentsOf: root.appendingPathComponent("llm-doc/loop/test/TEST-PRUNE.md"), encoding: .utf8)) ?? ""
    expect(report.contains("the loop never deletes tests"), "prune report states it never deletes")
}

#endif
