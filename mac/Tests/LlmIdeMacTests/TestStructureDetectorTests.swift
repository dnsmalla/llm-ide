import XCTest
@testable import LlmIdeMacLib

final class TestStructureDetectorTests: XCTestCase {
    private func make(_ files: [String: String]) throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        for (rel, body) in files {
            let url = root.appendingPathComponent(rel)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try body.write(to: url, atomically: true, encoding: .utf8)
        }
        return root
    }
    func testDetectsSwiftAndNodeRootsAtDepthOne() throws {
        let root = try make([
            "mac/Package.swift": "let p = Package(targets: [.testTarget(name: \"AppTests\", dependencies: [])])",
            "mac/Tests/AppTests/ATests.swift": "import XCTest",
            "extension/package.json": "{\"scripts\":{\"test\":\"node --test tests/\"}}",
            "extension/tests/a.test.mjs": "test('x',()=>{})",
        ])
        let s = TestStructureDetector(gitRoot: root).detect()
        XCTAssertEqual(s.status, "ok")
        XCTAssertEqual(s.roots.map(\.testDir).sorted(), ["extension/tests", "mac/Tests/AppTests"])
        XCTAssertEqual(s.roots.first { $0.packageDir == "mac" }?.command, "cd mac && swift test")
        XCTAssertEqual(s.roots.first { $0.packageDir == "extension" }?.runner, .nodeTest)
        XCTAssertEqual(s.testRoot(forSourcePath: "mac/Sources/App/Foo.swift")?.testDir, "mac/Tests/AppTests")
        XCTAssertEqual(s.testRoot(forSourcePath: "extension/kb/db.mjs")?.testDir, "extension/tests")
    }
    func testFlaggedNodeTestScriptIsNpmNotNodeTest() throws {
        let root = try make([
            "package.json": "{\"scripts\":{\"test\":\"node --experimental-strip-types --test tests/**/*.test.{ts,mjs}\"}}",
            "tests/a.test.mjs": "test('x',()=>{})",
        ])
        XCTAssertEqual(TestStructureDetector(gitRoot: root).detect().roots.first?.runner, .npm)
        let plain = try make([
            "package.json": "{\"scripts\":{\"test\":\"node --test\"}}",
            "tests/a.test.mjs": "test('x',()=>{})",
        ])
        XCTAssertEqual(TestStructureDetector(gitRoot: plain).detect().roots.first?.runner, .nodeTest)
    }
    func testPackageDirWithSpaceIsQuotedInDetectedCommand() throws {
        let root = try make(["my pkg/pytest.ini": "[pytest]\n", "my pkg/tests/test_a.py": "def test_a(): pass"])
        XCTAssertEqual(TestStructureDetector(gitRoot: root).detect().roots.first?.command, "cd 'my pkg' && pytest")
    }
    func testMissingStructureIsReportedNotCreated() throws {
        let root = try make(["src/a.py": "def f(): pass", "mac/Package.swift": "let p = Package(targets: [.target(name: \"A\")])"])
        let s = TestStructureDetector(gitRoot: root).detect()
        XCTAssertEqual(s.status, "missing")
        XCTAssertTrue(s.notes.contains { $0.contains("no testTarget") })
        XCTAssertEqual(s.notes.first, "mac: Package.swift has no testTarget")
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("tests").path))
    }
    func testWriteRendersPlacementRule() throws {
        let root = try make(["Package.swift": ".testTarget(name: \"XTests\")", "Tests/XTests/A.swift": ""])
        let d = TestStructureDetector(gitRoot: root)
        try d.write(d.detect())
        let md = try String(contentsOf: root.appendingPathComponent(LoopOutputLayout.testStructureMD), encoding: .utf8)
        XCTAssertTrue(md.contains("status: ok"))
        XCTAssertTrue(md.contains("Foo.swift → FooTests.swift") || md.contains("X.swift"))
        XCTAssertTrue(md.contains("Tests/XTests"))
    }
    func testNodeWithoutTestDirNotesPackageFirst() throws {
        let root = try make(["package.json": "{\"scripts\":{\"test\":\"jest\"}}"])
        let s = TestStructureDetector(gitRoot: root).detect()
        XCTAssertEqual(s.status, "missing")
        XCTAssertEqual(s.notes.first, ".: no test directory found for package.json")
    }
    func testManifestsDeeperThanTwoLevelsAreIgnored() throws {
        let root = try make(["a/b/c/go.mod": "module x", "node_modules/p/Package.swift": ".testTarget(name: \"T\")"])
        XCTAssertTrue(TestStructureDetector(gitRoot: root).detect().roots.isEmpty)
    }
}
