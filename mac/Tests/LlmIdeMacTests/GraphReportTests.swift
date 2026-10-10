import XCTest
@testable import LlmIdeMacLib

final class GraphReportTests: XCTestCase {
    private func index(_ json: String) throws -> GraphIndex { try JSONDecoder().decode(GraphIndex.self, from: Data(json.utf8)) }
    private let cyclic = """
    {"version":"1.1","files":[
      {"path":"a.mjs","language":"mjs","loc":600,"imports":["b.mjs"],"usedBy":["c.mjs"],"types":[],"functions":[]},
      {"path":"b.mjs","language":"mjs","loc":100,"imports":["c.mjs"],"usedBy":["a.mjs"],"types":[],"functions":[]},
      {"path":"c.mjs","language":"mjs","loc":100,"imports":["a.mjs"],"usedBy":["b.mjs"],"types":[],"functions":[]},
      {"path":"d.swift","language":"swift","loc":50,"imports":[],"usedBy":[],"types":[],"functions":[]}],
     "calls":[{"from":"d.swift","to":"a.mjs","symbol":"x"}]}
    """
    func testCountersCyclesAndFanIn() throws {
        let r = GraphReport.build(from: try index(cyclic), commit: "abc", boundaryWarnings: 46)
        XCTAssertEqual(r.filesOver500.map(\.path), ["a.mjs"])
        XCTAssertEqual(r.cycles, [["a.mjs", "b.mjs", "c.mjs"]])
        XCTAssertEqual(r.counters["cycleCount"], 1); XCTAssertEqual(r.counters["filesInCycles"], 3)
        XCTAssertEqual(r.topFanIn.first?.path, "a.mjs"); XCTAssertEqual(r.topFanIn.first?.fanIn, 2)   // usedBy c + caller d
        XCTAssertEqual(r.counters["boundaryWarnings"], 46); XCTAssertEqual(r.counters["maxFanIn"], 2)
    }
    func testNoCyclesWhenAcyclic() throws {
        let j = #"{"version":"1.1","files":[{"path":"a","language":"mjs","loc":1,"imports":["b"],"usedBy":[],"types":[],"functions":[]},{"path":"b","language":"mjs","loc":1,"imports":[],"usedBy":["a"],"types":[],"functions":[]}]}"#
        XCTAssertEqual(GraphReport.build(from: try index(j), commit: nil, boundaryWarnings: nil).cycles, [])
    }
    func testDeltaRules() throws {
        let before = GraphReport.build(from: try index(cyclic), commit: nil, boundaryWarnings: 46)
        var after = before; after.counters["cycleCount"] = 0; after.counters["filesInCycles"] = 0; after.counters["totalLoc"] = (before.counters["totalLoc"] ?? 0) * 1.01
        let d = GraphReport.delta(before: before, after: after, expect: "cycleCount")
        XCTAssertEqual(d.expectedMoved, true); XCTAssertTrue(d.regressions.isEmpty)
        var worse = before; worse.counters["filesOver500Count"] = 2
        XCTAssertEqual(GraphReport.delta(before: before, after: worse, expect: "cycleCount").regressions, ["filesOver500Count"])
        XCTAssertEqual(GraphReport.delta(before: before, after: worse, expect: "cycleCount").expectedMoved, false)
    }
    func testRenderNamesCountersAndCycles() throws {
        let md = GraphReport.build(from: try index(cyclic), commit: "abc", boundaryWarnings: nil).render()
        XCTAssertTrue(md.contains("cycleCount")); XCTAssertTrue(md.contains("a.mjs → b.mjs → c.mjs → a.mjs")); XCTAssertTrue(md.contains("## How to read"))
    }
    func testBoundaryProbeNilWhenScriptAbsent() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("probe-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let count = await BoundaryWarningsProbe.count(gitRoot: dir)
        XCTAssertNil(count)
    }
    /// Another repo can ship `mac/Scripts/feature-boundaries.sh` too; the gate
    /// runs only in LLM-IDE's own checkout, never in a project that merely has it.
    func testBoundaryProbeRunsOnlyInTheAppSourceRoot() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("probe-app-\(UUID().uuidString)")
        let scripts = dir.appendingPathComponent("mac/Scripts", isDirectory: true)
        try FileManager.default.createDirectory(at: scripts, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        try "echo 'total: 7  sealed violations: 0'\n".write(
            to: scripts.appendingPathComponent("feature-boundaries.sh"), atomically: true, encoding: .utf8)
        let saved = LoopStageDetector.appSourceRoot
        defer { LoopStageDetector.appSourceRoot = saved }

        LoopStageDetector.appSourceRoot = { FileManager.default.temporaryDirectory.appendingPathComponent("other-app") }
        let foreign = await BoundaryWarningsProbe.count(gitRoot: dir)
        XCTAssertNil(foreign, "a repo with the script but not the app marker must not run it")

        LoopStageDetector.appSourceRoot = { dir }
        let own = await BoundaryWarningsProbe.count(gitRoot: dir)
        XCTAssertEqual(own, 7)
    }

    // MARK: - Pinned contracts

    private func file(_ path: String, loc: Int = 1, imports: [String] = [], usedBy: [String] = []) -> String {
        func array(_ items: [String]) -> String { "[" + items.map { "\"\($0)\"" }.joined(separator: ",") + "]" }
        return "{\"path\":\"\(path)\",\"language\":\"mjs\",\"loc\":\(loc),\"imports\":\(array(imports)),\"usedBy\":\(array(usedBy)),\"types\":[],\"functions\":[]}"
    }
    private func indexJSON(_ files: [String]) -> String {
        "{\"version\":\"1.1\",\"files\":[" + files.joined(separator: ",") + "]}"
    }

    func testRenderHeaderFormat() throws {
        let md = GraphReport.build(from: try index(cyclic), commit: "abc", boundaryWarnings: nil).render()
        let first = md.components(separatedBy: "\n")[0]
        XCTAssertNotNil(first.range(of: #"^# Code graph \(1\.1, abc, \d{4}-\d{2}-\d{2}\)$"#, options: .regularExpression))
        let unknown = GraphReport.build(from: try index(cyclic), commit: nil, boundaryWarnings: nil).render()
        XCTAssertTrue(unknown.components(separatedBy: "\n")[0].contains(", unknown, "))
    }

    func testTotalLocToleranceBoundary() throws {
        let before = GraphReport.build(from: try index(cyclic), commit: nil, boundaryWarnings: nil)
        XCTAssertEqual(before.counters["totalLoc"], 850)
        var atEdge = before; atEdge.counters["totalLoc"] = 867          // 850 * 1.02 exactly
        XCTAssertEqual(GraphReport.delta(before: before, after: atEdge, expect: nil).regressions, [])
        var over = before; over.counters["totalLoc"] = 868              // one line past the tolerance
        XCTAssertEqual(GraphReport.delta(before: before, after: over, expect: nil).regressions, ["totalLoc"])
    }

    func testCycleOrderingBySizeThenFirstPath() throws {
        let json = indexJSON([
            file("a.mjs", imports: ["b.mjs"]), file("b.mjs", imports: ["c.mjs"]), file("c.mjs", imports: ["a.mjs"]),
            file("x.mjs", imports: ["y.mjs"]), file("y.mjs", imports: ["x.mjs"]),
            file("m2.mjs", imports: ["m1.mjs"]), file("m1.mjs", imports: ["m2.mjs"]),
            file("k1.mjs", imports: ["k2.mjs"]), file("k2.mjs", imports: ["k1.mjs"]),
        ])
        let r = GraphReport.build(from: try index(json), commit: nil, boundaryWarnings: nil)
        XCTAssertEqual(r.cycles, [["a.mjs", "b.mjs", "c.mjs"], ["k1.mjs", "k2.mjs"], ["m1.mjs", "m2.mjs"], ["x.mjs", "y.mjs"]])
        XCTAssertEqual(r.counters["cycleCount"], 4)
        XCTAssertEqual(r.counters["filesInCycles"], 9)
    }

    func testParseTotal() {
        XCTAssertEqual(BoundaryWarningsProbe.parseTotal("total: 47  sealed violations: 0"), 47)
        XCTAssertNil(BoundaryWarningsProbe.parseTotal("total: abc"))
        XCTAssertEqual(BoundaryWarningsProbe.parseTotal("header line\nnoise\ntotal: 5  sealed violations: 1\n"), 5)
        XCTAssertNil(BoundaryWarningsProbe.parseTotal("no total line here"))
    }

    func testSelfLoopOnlyIsNotACycle() throws {
        let json = indexJSON([file("a.mjs", imports: ["a.mjs"])])
        let r = GraphReport.build(from: try index(json), commit: nil, boundaryWarnings: nil)
        XCTAssertEqual(r.cycles, [])
        XCTAssertEqual(r.counters["cycleCount"], 0)
    }

    func testFanInTiesSortByAscendingPath() throws {
        let json = indexJSON([
            file("q.mjs", usedBy: ["r.mjs"]), file("p.mjs", usedBy: ["r.mjs"]), file("r.mjs"),
        ])
        let r = GraphReport.build(from: try index(json), commit: nil, boundaryWarnings: nil)
        XCTAssertEqual(r.topFanIn, [GraphReport.FileFanIn(path: "p.mjs", fanIn: 1), GraphReport.FileFanIn(path: "q.mjs", fanIn: 1)])
    }
}
