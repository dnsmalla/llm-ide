import XCTest
@testable import LlmIdeMacLib

final class TestMapBuilderTests: XCTestCase {
    private func fixture() throws -> (URL, TestStructure) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let graph = """
        {"version":"1.0","summary":{"totalFiles":2,"totalEdges":1},"files":[
          {"path":"Sources/Core.swift","name":"Core.swift","language":"swift","loc":300,"role":"service","imports":[],"usedBy":["Sources/UI.swift","Sources/API.swift"],
           "types":[],"functions":[{"name":"parse","line":10,"declaration":"func parse()"},{"name":"render","line":40,"declaration":"func render()"},{"name":"init","line":1,"declaration":"init()"}]},
          {"path":"Sources/UI.swift","name":"UI.swift","language":"swift","loc":50,"role":"view","imports":["Sources/Core.swift"],"usedBy":[],
           "types":[],"functions":[{"name":"draw","line":5,"declaration":"func draw()"}]}]}
        """
        let files = ["system/graph/graph.json": graph,
                     "Sources/Core.swift": "", "Sources/UI.swift": "",
                     "Tests/AppTests/CoreTests.swift": "import XCTest\nfinal class CoreTests: XCTestCase { func testParse() { _ = Core().parse() } }\n"]
        for (rel, body) in files {
            let url = root.appendingPathComponent(rel)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try body.write(to: url, atomically: true, encoding: .utf8)
        }
        let structure = TestStructure(generatedAt: Date(), roots: [TestRoot(packageDir: "", testDir: "Tests/AppTests", runner: .xctest, command: "swift test", namingRule: "Foo.swift → FooTests.swift", languages: ["swift"])], status: "ok", notes: [])
        return (root, structure)
    }
    func testRanksUntestedByFanInAndSkipsInit() throws {
        let (root, s) = try fixture()
        let map = try TestMapBuilder(gitRoot: root, structure: s).build()
        XCTAssertEqual(map.source, "graph")
        XCTAssertEqual(map.untestedFunctions, 2)      // render, draw
        XCTAssertEqual(map.testedFunctions, 1)        // parse
        XCTAssertEqual(map.entries.first?.function, "render"); XCTAssertEqual(map.entries.first?.fanIn, 2)
        XCTAssertEqual(map.entries.first { $0.function == "parse" }?.testedBy, ["Tests/AppTests/CoreTests.swift"])
        XCTAssertFalse(map.entries.contains { $0.function == "init" })
        XCTAssertEqual(map.untestedFiles, 1)          // UI.swift
    }
    func testFallsBackToFilesWithoutGraph() throws {
        let (root, s) = try fixture()
        try FileManager.default.removeItem(at: root.appendingPathComponent("system/graph/graph.json"))
        let map = try TestMapBuilder(gitRoot: root, structure: s).build()
        XCTAssertEqual(map.source, "files")
        XCTAssertEqual(map.untestedFiles, 1)
    }
    func testDeltaAndRender() throws {
        let (root, s) = try fixture()
        let b = TestMapBuilder(gitRoot: root, structure: s)
        let before = try b.build()
        try "final class UITests: XCTestCase { func testDraw() { UI().draw() } }".write(to: root.appendingPathComponent("Tests/AppTests/UITests.swift"), atomically: true, encoding: .utf8)
        let after = try b.build()
        XCTAssertEqual(TestMap.delta(before: before, after: after)["untestedFunctions"], -1)
        let md = after.render()
        XCTAssertTrue(md.contains("untestedFunctions")); XCTAssertTrue(md.contains("Sources/Core.swift:40 render"))
        try b.write(after)
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent(LoopOutputLayout.testMapJSON).path))
    }
}
