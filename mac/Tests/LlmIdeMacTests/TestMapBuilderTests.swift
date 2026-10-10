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

    private func write(_ root: URL, _ files: [String: String]) throws {
        for (rel, body) in files {
            let url = root.appendingPathComponent(rel)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try body.write(to: url, atomically: true, encoding: .utf8)
        }
    }
    private func graph(_ files: [(String, String, [String])]) -> String {
        let fs = files.map { (p, lang, fns) in
            "{\"path\":\"\(p)\",\"name\":\"x\",\"language\":\"\(lang)\",\"loc\":10,\"functions\":[" +
            fns.enumerated().map { "{\"name\":\"\($1)\",\"line\":\($0 + 1)}" }.joined(separator: ",") + "]}"
        }.joined(separator: ",")
        return "{\"version\":\"1.0\",\"files\":[\(fs)]}"
    }
    func testSharedPackageDirPrefersLanguageMatchingRoot() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try write(root, [
            "system/graph/graph.json": graph([("pkg/Core.swift", "swift", ["parse"]), ("pkg/core.mjs", "js", ["parse"])]),
            "pkg/Core.swift": "", "pkg/core.mjs": "",
            "pkg/Tests/CoreTests.swift": "final class CoreTests: XCTestCase { func testA() { Core().parse() } }",
            "pkg/test/core.test.mjs": "import test from 'node:test'\ntest('x', () => {})\n"])
        let s = TestStructure(generatedAt: Date(), roots: [
            TestRoot(packageDir: "pkg", testDir: "pkg/Tests", runner: .xctest, command: "swift test", namingRule: "", languages: ["swift"]),
            TestRoot(packageDir: "pkg", testDir: "pkg/test", runner: .nodeTest, command: "node --test", namingRule: "", languages: ["mjs"])], status: "ok", notes: [])
        let map = try TestMapBuilder(gitRoot: root, structure: s).build()
        XCTAssertEqual(map.entries.first { $0.path == "pkg/Core.swift" }?.testedBy, ["pkg/Tests/CoreTests.swift"])
        XCTAssertEqual(map.entries.first { $0.path == "pkg/core.mjs" }?.testedBy, [])
    }
    func testExactTokenRule() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try write(root, [
            "system/graph/graph.json": graph([("Sources/Core.swift", "swift", ["render"]), ("Sources/UI.swift", "swift", ["render"])]),
            "Sources/Core.swift": "", "Sources/UI.swift": "",
            "Tests/CoreTests.swift": "final class CoreTests: XCTestCase { func testA() { Core().prerender() } }",
            "Tests/UITests.swift": "final class UITests: XCTestCase { func testA() { call(\"render\") } }"])
        let s = TestStructure(generatedAt: Date(), roots: [TestRoot(packageDir: "", testDir: "Tests", runner: .xctest, command: "swift test", namingRule: "", languages: ["swift"])], status: "ok", notes: [])
        let map = try TestMapBuilder(gitRoot: root, structure: s).build()
        XCTAssertEqual(map.entries.first { $0.path == "Sources/Core.swift" }?.testedBy, [])
        XCTAssertEqual(map.entries.first { $0.path == "Sources/UI.swift" }?.testedBy, ["Tests/UITests.swift"])
    }

    func testFanInCountsCallerFilesFromCallsEdges() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try write(root, [
            "system/graph/graph.json": """
            {"version":"1.1","files":[
              {"path":"Sources/Core.swift","name":"Core.swift","language":"swift","loc":10,"usedBy":[],"imports":[],"types":[],"functions":[{"name":"render","line":4}]},
              {"path":"Sources/UI.swift","name":"UI.swift","language":"swift","loc":10,"usedBy":[],"imports":[],"types":[],"functions":[{"name":"draw","line":1}]},
              {"path":"Sources/API.swift","name":"API.swift","language":"swift","loc":10,"usedBy":[],"imports":[],"types":[],"functions":[{"name":"serve","line":1}]}],
             "calls":[{"from":"Sources/UI.swift","to":"Sources/Core.swift","symbol":"render"},
                      {"from":"Sources/API.swift","to":"Sources/Core.swift","symbol":"render"}]}
            """,
            "Sources/Core.swift": "", "Sources/UI.swift": "", "Sources/API.swift": ""])
        let s = TestStructure(generatedAt: Date(), roots: [TestRoot(packageDir: "", testDir: "Tests/AppTests", runner: .xctest, command: "swift test", namingRule: "", languages: ["swift"])], status: "ok", notes: [])
        let map = try TestMapBuilder(gitRoot: root, structure: s).build()
        XCTAssertEqual(map.entries.first { $0.function == "render" }?.fanIn, 2)
    }
    func testReadsGraphFromGraphRootWhenGiven() throws {
        let worktree = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let main = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try write(main, ["system/graph/graph.json": graph([("Sources/Core.swift", "swift", ["render"])]), "Sources/Core.swift": ""])
        try write(worktree, ["Sources/Core.swift": ""])
        let s = TestStructure(generatedAt: Date(), roots: [], status: "missing", notes: [])
        XCTAssertNil(GraphIndex.load(gitRoot: worktree))
        let map = try TestMapBuilder(gitRoot: worktree, structure: s, graphRoot: main).build()
        XCTAssertEqual(map.source, "graph")
    }
}
