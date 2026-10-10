import XCTest
import GraphCore
@testable import LlmIdeMacLib

/// graph.json 1.1 carries file-level call edges derived from the in-memory CGData.
final class CodeNoteGeneratorCallsTests: XCTestCase {
    private var tempDir: URL!
    private let fm = FileManager.default

    override func setUpWithError() throws {
        tempDir = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("codecalls-\(UUID().uuidString)", isDirectory: true)
            .resolvingSymlinksInPath()
        try fm.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? fm.removeItem(at: tempDir)
    }

    private func scan() -> ScanResult {
        ScanResult(
            files: [ScanResult.FileEntry(path: "src/A.swift", language: "swift", loc: 10),
                    ScanResult.FileEntry(path: "src/B.swift", language: "swift", loc: 10)],
            imports: [:],
            symbols: ["src/A.swift": [ScanResult.Symbol(name: "run", kind: "function", line: 1)],
                      "src/B.swift": [ScanResult.Symbol(name: "draw", kind: "function", line: 1),
                                      ScanResult.Symbol(name: "draw2", kind: "function", line: 2)]])
    }

    /// B.draw and B.draw2 both call A.run: two symbol-level edges, one file-level call.
    private func graph() -> CGData {
        let run = CGNode(id: "function:src/A.swift:run", title: "run", kind: .function,
                         metadata: ["source_file": "src/A.swift"])
        let draw = CGNode(id: "function:src/B.swift:draw", title: "draw", kind: .function,
                          metadata: ["source_file": "src/B.swift"])
        let draw2 = CGNode(id: "function:src/B.swift:draw2", title: "draw2", kind: .function,
                           metadata: ["source_file": "src/B.swift"])
        let edges = [CGEdge(fromId: draw.id, toId: run.id, kind: .calls, confidence: .inferred),
                     CGEdge(fromId: draw2.id, toId: run.id, kind: .calls, confidence: .inferred)]
        return CGData(nodes: [run, draw, draw2], edges: edges)
    }

    func testFileCallsAreDedupedCrossFileAndSorted() {
        XCTAssertEqual(CodeNoteGenerator.fileCalls(from: graph()),
                       [CodeNoteGenerator.FileCall(from: "src/B.swift", to: "src/A.swift", symbol: "run")])
    }

    func testSameFileCallsAreNotFileCalls() {
        let run = CGNode(id: "function:src/A.swift:run", title: "run", kind: .function,
                         metadata: ["source_file": "src/A.swift"])
        let helper = CGNode(id: "function:src/A.swift:helper", title: "helper", kind: .function,
                            metadata: ["source_file": "src/A.swift"])
        let g = CGData(nodes: [run, helper],
                       edges: [CGEdge(fromId: helper.id, toId: run.id, kind: .calls, confidence: .inferred)])
        XCTAssertEqual(CodeNoteGenerator.fileCalls(from: g), [])
    }

    func testGraphJSONCarriesOneCallAndVersion11() throws {
        CodeNoteGenerator.generate(scan: scan(), repoRoot: tempDir,
                                   calls: CodeNoteGenerator.fileCalls(from: graph()))
        let data = try Data(contentsOf: tempDir.appendingPathComponent("system/graph/graph.json"))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["version"] as? String, "1.1")
        let summary = try XCTUnwrap(json["summary"] as? [String: Any])
        XCTAssertEqual(summary["totalCalls"] as? Int, 1)
        let calls = try XCTUnwrap(json["calls"] as? [[String: Any]])
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(calls.first?["from"] as? String, "src/B.swift")
        XCTAssertEqual(calls.first?["to"] as? String, "src/A.swift")
        XCTAssertEqual(calls.first?["symbol"] as? String, "run")
    }
}
