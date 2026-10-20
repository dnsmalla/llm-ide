import XCTest
@testable import LlmIdeMacLib

final class TestPruneScannerTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("prune-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func put(_ rel: String, _ text: String) throws {
        let url = root.appendingPathComponent(rel)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try text.write(to: url, atomically: true, encoding: .utf8)
    }

    private func scanner() -> TestPruneScanner {
        let structure = TestStructure(
            generatedAt: Date(),
            roots: [TestRoot(packageDir: "", testDir: "Tests", runner: .xctest, command: "swift test",
                             namingRule: "XTests.swift", languages: ["swift"])],
            status: "ok", notes: [])
        return TestPruneScanner(gitRoot: root, structure: structure)
    }

    private let asserting = "func testA() { XCTAssertTrue(true) }\n"

    func testSourceGone() throws {
        try put("Sources/Foo.swift", "struct Foo {}\n")
        try put("Tests/FooTests.swift", asserting)
        try put("Tests/BarTests.swift", asserting)
        XCTAssertEqual(scanner().scan(), [TestPruneFinding(path: "Tests/BarTests.swift", reason: .sourceGone)])
    }

    func testNoAssertion() throws {
        try put("Sources/Foo.swift", "struct Foo {}\n")
        try put("Tests/FooTests.swift", "func testA() { print(1) }\n")
        XCTAssertEqual(scanner().scan(), [TestPruneFinding(path: "Tests/FooTests.swift", reason: .noAssertion)])
    }

    func testCommentedOutTest() throws {
        try put("Sources/Foo.swift", "struct Foo {}\n")
        try put("Tests/FooTests.swift", "func testA() { XCTAssertTrue(true) }\n\n// func testOld() {}\n")
        XCTAssertEqual(scanner().scan(),
                       [TestPruneFinding(path: "Tests/FooTests.swift", reason: .commentedOutTest, line: 3)])
    }

    func testGapDuplicate() throws {
        try put("Sources/Foo.swift", "struct Foo {}\n")
        try put("Tests/FooTests.swift", asserting)
        try put("Tests/FooGapTests.swift", asserting)
        XCTAssertEqual(scanner().scan(), [TestPruneFinding(path: "Tests/FooGapTests.swift", reason: .gapDuplicate)])
    }

    func testCleanSuiteHasNoFindings() throws {
        try put("Sources/Foo.swift", "struct Foo {}\n")
        try put("Tests/FooTests.swift", asserting)
        XCTAssertEqual(scanner().scan(), [])
    }

    func testScanNeverDeletes() throws {
        try put("Tests/BarTests.swift", "func testA() {}\n")
        let target = scanner()
        let findings = target.scan()
        _ = try target.write(findings, outputRoot: root)
        XCTAssertFalse(findings.isEmpty)
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("Tests/BarTests.swift").path))
    }
}
