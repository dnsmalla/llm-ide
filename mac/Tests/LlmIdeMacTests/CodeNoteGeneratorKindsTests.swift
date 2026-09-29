import XCTest
import GraphCore
@testable import LlmIdeMacLib

/// Verifies that CodeNoteGenerator includes all symbol kinds (struct, enum,
/// protocol, extension, interface, class) and methods (with parent) in the
/// generated notes, not just classes and functions.
final class CodeNoteGeneratorKindsTests: XCTestCase {

    private var tempDir: URL!
    private let fm = FileManager.default

    override func setUpWithError() throws {
        tempDir = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("codegen-\(UUID().uuidString)", isDirectory: true)
            .resolvingSymlinksInPath()
        try fm.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? fm.removeItem(at: tempDir)
    }

    /// Test that all type kinds and methods are included in per-file notes.
    func testNoteIncludesAllTypeKindsAndMethods() {
        // Build a scan with all the kinds we care about
        let symbols = [
            ScanResult.Symbol(name: "MyClass", kind: "class", line: 1),
            ScanResult.Symbol(name: "MyStruct", kind: "struct", line: 2),
            ScanResult.Symbol(name: "MyEnum", kind: "enum", line: 3),
            ScanResult.Symbol(name: "MyProtocol", kind: "protocol", line: 4),
            ScanResult.Symbol(name: "MyExtension", kind: "extension", line: 5),
            ScanResult.Symbol(name: "MyInterface", kind: "interface", line: 6),
            ScanResult.Symbol(name: "topLevelFunction", kind: "function", line: 7),
            ScanResult.Symbol(name: "doSomething", kind: "method", line: 8, parent: "MyClass"),
        ]

        let scan = ScanResult(
            files: [ScanResult.FileEntry(path: "src/Test.swift", language: "swift", loc: 100)],
            imports: [:],
            symbols: ["src/Test.swift": symbols]
        )

        let markdown = CodeNoteGenerator.noteMarkdown(path: "src/Test.swift", scan: scan, usedBy: [:])

        // Assert that all types are mentioned in the note
        XCTAssertTrue(markdown.contains("`MyClass`"), "class should appear in Types section")
        XCTAssertTrue(markdown.contains("`MyStruct`"), "struct should appear in Types section")
        XCTAssertTrue(markdown.contains("`MyEnum`"), "enum should appear in Types section")
        XCTAssertTrue(markdown.contains("`MyProtocol`"), "protocol should appear in Types section")
        XCTAssertTrue(markdown.contains("`MyExtension`"), "extension should appear in Types section")
        XCTAssertTrue(markdown.contains("`MyInterface`"), "interface should appear in Types section")

        // Assert that both function and method are listed
        XCTAssertTrue(markdown.contains("`topLevelFunction`"), "function should appear in Functions section")
        // The method should appear with parent notation: "MyClass.doSomething"
        XCTAssertTrue(markdown.contains("`MyClass.doSomething`"), "method should appear as Parent.name in Functions section")
    }

    /// Test that methods already prefixed with parent (e.g., "Cls.meth" from the scanner)
    /// are not double-prefixed (e.g., NOT "Cls.Cls.meth").
    func testMethodsWithPrefixedNamesAreNotDoubleQualified() {
        // The tree-sitter scanners already emit methods as "Cls.meth" in the name field
        let symbols = [
            ScanResult.Symbol(name: "MyClass.doSomething", kind: "method", line: 1, parent: "MyClass"),
        ]

        let scan = ScanResult(
            files: [ScanResult.FileEntry(path: "src/Test.swift", language: "swift", loc: 100)],
            imports: [:],
            symbols: ["src/Test.swift": symbols]
        )

        let markdown = CodeNoteGenerator.noteMarkdown(path: "src/Test.swift", scan: scan, usedBy: [:])

        // The method should appear as "MyClass.doSomething" (not double-qualified)
        XCTAssertTrue(markdown.contains("`MyClass.doSomething`"), "method should appear as MyClass.doSomething")
        XCTAssertFalse(markdown.contains("MyClass.MyClass.doSomething"), "method must NOT be double-prefixed")
    }

    /// Test that the index.md and graph.json correctly filter all type kinds and functions.
    /// This verifies the writeIndex and writeGraphJSON functions use the correct filters.
    func testIndexAndGraphJsonIncludeAllKinds() throws {
        let symbols = [
            ScanResult.Symbol(name: "MyStruct", kind: "struct", line: 1),
            ScanResult.Symbol(name: "topLevelFunction", kind: "function", line: 2),
            ScanResult.Symbol(name: "MyClass.helper", kind: "method", line: 3, parent: "MyClass"),
        ]

        let scan = ScanResult(
            files: [ScanResult.FileEntry(path: "src/Test.swift", language: "swift", loc: 50)],
            imports: [:],
            symbols: ["src/Test.swift": symbols]
        )

        // Generate the notes (which calls writeIndex and writeGraphJSON)
        CodeNoteGenerator.generate(scan: scan, repoRoot: tempDir)

        // Read index.md and verify it lists 2 functions for src/Test.swift
        // (topLevelFunction + helper method)
        let indexPath = tempDir.appendingPathComponent("system/graph/index.md")
        let indexContent = try String(contentsOf: indexPath, encoding: .utf8)
        XCTAssertTrue(indexContent.contains("2 functions"), "index.md should report 2 functions for src/Test.swift (function + method)")

        // Read graph.json and verify it includes the struct and the method
        let graphPath = tempDir.appendingPathComponent("system/graph/graph.json")
        let graphData = try Data(contentsOf: graphPath)
        let graphJson = try JSONSerialization.jsonObject(with: graphData) as? [String: Any]
        XCTAssertNotNil(graphJson, "graph.json must be valid JSON")

        guard let files = graphJson?["files"] as? [[String: Any]],
              let testFile = files.first(where: { ($0["path"] as? String) == "src/Test.swift" }) else {
            XCTFail("graph.json must contain src/Test.swift file node")
            return
        }

        // Verify the struct is listed in types
        guard let types = testFile["types"] as? [[String: Any]] else {
            XCTFail("file node must have types array")
            return
        }
        XCTAssertTrue(types.contains { ($0["name"] as? String) == "MyStruct" }, "struct must appear in types")

        // Verify the method is listed in functions
        guard let functions = testFile["functions"] as? [[String: Any]] else {
            XCTFail("file node must have functions array")
            return
        }
        XCTAssertEqual(functions.count, 2, "should list 2 functions (function + method)")
        XCTAssertTrue(functions.contains { ($0["name"] as? String) == "topLevelFunction" }, "function must appear")
        XCTAssertTrue(functions.contains { ($0["name"] as? String) == "MyClass.helper" }, "method must appear")
    }
}
