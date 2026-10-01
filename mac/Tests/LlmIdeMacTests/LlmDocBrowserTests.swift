import XCTest
@testable import LlmIdeMacLib

final class LlmDocBrowserTests: XCTestCase {
    private var tmp: URL!
    private var root: URL!

    override func setUpWithError() throws {
        tmp = FileManager.default.temporaryDirectory.appendingPathComponent("llmdoc-\(UUID().uuidString)")
        root = tmp.appendingPathComponent("llm-doc")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("generated"), withIntermediateDirectories: true)
        try "# hi".write(to: root.appendingPathComponent("generated/a.md"), atomically: true, encoding: .utf8)
        try "x".write(to: root.appendingPathComponent("b.txt"), atomically: true, encoding: .utf8)
        try "bin".write(to: root.appendingPathComponent("c.png"), atomically: true, encoding: .utf8)
        try "secret".write(to: tmp.appendingPathComponent("secret.md"), atomically: true, encoding: .utf8)
    }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: tmp) }

    func testResolveRejectsEscapes() {
        for bad in ["../secret.md", "generated/../../secret.md", "/etc/passwd", "~/x", "a/./b", "x\0y"] {
            XCTAssertNil(LlmDocBrowser.resolve(bad, under: root), bad)
        }
        XCTAssertNotNil(LlmDocBrowser.resolve("", under: root))
        XCTAssertNotNil(LlmDocBrowser.resolve("generated/a.md", under: root))
    }

    func testSymlinkOutOfRootIsRefusedAndHidden() throws {
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("leak.md"),
                                                   withDestinationURL: tmp.appendingPathComponent("secret.md"))
        XCTAssertNil(LlmDocBrowser.resolve("leak.md", under: root))
        XCTAssertNotNil(LlmDocBrowser.read(root: root, relative: "leak.md").error)
        XCTAssertFalse(LlmDocBrowser.list(root: root, relative: "").entries.contains { $0.name == "leak.md" })
    }

    func testListShowsFoldersAndTextOnly() {
        let names = LlmDocBrowser.list(root: root, relative: "").entries.map(\.name)
        XCTAssertEqual(names, ["generated", "b.txt"])   // folder first, png hidden
    }

    func testReadReturnsTextAndRefusesNonText() {
        XCTAssertEqual(LlmDocBrowser.read(root: root, relative: "generated/a.md").text, "# hi")
        XCTAssertNotNil(LlmDocBrowser.read(root: root, relative: "c.png").error)
        XCTAssertNotNil(LlmDocBrowser.read(root: root, relative: "").error)
    }

    func testReadTruncatesAtCap() throws {
        let big = String(repeating: "a", count: LlmDocBrowser.readCap + 10)
        try big.write(to: root.appendingPathComponent("big.md"), atomically: true, encoding: .utf8)
        let f = LlmDocBrowser.read(root: root, relative: "big.md")
        XCTAssertTrue(f.truncated)
        XCTAssertEqual(f.text?.utf8.count, LlmDocBrowser.readCap)
    }

    func testRelativePathSurvivesSymlinkedTmp() throws {
        let saved = root.appendingPathComponent("generated/a.md")
        XCTAssertEqual(MobileGenerationBridge.relativePath(of: saved, under: root), "generated/a.md")
    }
}
