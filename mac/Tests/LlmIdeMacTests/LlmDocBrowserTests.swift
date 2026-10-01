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

    func testSafeFileBaseIsVisibleAndWritable() {
        XCTAssertEqual(MobileGenerationBridge.safeFileBase(".hidden-doc"), "hidden-doc")
        XCTAssertEqual(MobileGenerationBridge.safeFileBase("a/b:c-doc"), "a-b-c-doc")
        XCTAssertEqual(MobileGenerationBridge.safeFileBase("x\ny\u{0}z"), "xyz")
        XCTAssertEqual(MobileGenerationBridge.safeFileBase("..."), "generated-doc")
        XCTAssertLessThanOrEqual(MobileGenerationBridge.safeFileBase(String(repeating: "あ", count: 300)).utf8.count, 200)
    }

    func testEnvelopeValueRecoversTheIdFromAnUndecodableBody() {
        let data = Data(#"{"type":"generation_run","commandId":"gen_1","sources":"wrong shape"}"#.utf8)
        XCTAssertEqual(MobileGenerationBridge.envelopeValue("commandId", in: data), "gen_1")
        XCTAssertNil(MobileGenerationBridge.envelopeValue("commandId", in: Data("nope".utf8)))
        XCTAssertNil(MobileGenerationBridge.envelopeValue("commandId", in: nil))
    }

    func testRelativePathIsNilOutsideRoot() {
        XCTAssertNil(MobileGenerationBridge.relativePath(of: tmp.appendingPathComponent("secret.md"), under: root))
    }
}
