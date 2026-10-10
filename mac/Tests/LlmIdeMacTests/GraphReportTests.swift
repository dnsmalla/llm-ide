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
}
