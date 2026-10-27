import XCTest
import GraphCore
@testable import LlmIdeMacLib

/// The System view's native data (G2a): the `native` message, the skill-library
/// allowlist entry, the v1.1 graph file conversion and node cap, the Core
/// registries, and the JSON bodies native answers with.
@MainActor
final class SystemBridgeNativeTests: XCTestCase {

    // MARK: native message decode

    func testDecodesEachNativeName() {
        XCTAssertEqual(SystemBridgeInbound.decode(["type": "native", "id": "n1", "name": "projectGraph"]),
                       .native(SystemBridgeNativeRequest(id: "n1", call: .projectGraph)))
        XCTAssertEqual(SystemBridgeInbound.decode(["type": "native", "id": "n2", "name": "routines"]),
                       .native(SystemBridgeNativeRequest(id: "n2", call: .routines)))
    }

    func testAnUnknownNativeNameIsRefusedWithItsId() {
        XCTAssertEqual(SystemBridgeInbound.decode(["type": "native", "id": "n3", "name": "shell"]),
                       .native(SystemBridgeNativeRequest(id: "n3", call: nil)))
        XCTAssertEqual(SystemBridgeInbound.decode(["type": "native", "id": "n4"]),
                       .native(SystemBridgeNativeRequest(id: "n4", call: nil)))
        XCTAssertEqual(SystemBridgeInbound.decode(["type": "native", "id": "n5", "name": 3]),
                       .native(SystemBridgeNativeRequest(id: "n5", call: nil)))
    }

    func testANativeMessageWithABadIdIsIgnored() {
        XCTAssertNil(SystemBridgeInbound.decode(["type": "native", "name": "routines"]))
        XCTAssertNil(SystemBridgeInbound.decode(["type": "native", "id": "", "name": "routines"]))
        XCTAssertNil(SystemBridgeInbound.decode(["type": "native", "id": "has space", "name": "routines"]))
        XCTAssertNil(SystemBridgeInbound.decode(["type": "native", "id": 7, "name": "routines"]))
    }

    // MARK: skill-library allowlist

    func testSkillLibraryIsTheExactGetWithNoQueryOrBody() {
        let call = SystemBridge.validate(method: "GET", path: "/kb/agent/skill-library", body: nil)
        XCTAssertEqual(call, .skillLibrary)
        XCTAssertEqual(call?.method, "GET")
        XCTAssertEqual(call?.path, "/kb/agent/skill-library")
        XCTAssertNil(call?.body)
    }

    func testSkillLibraryRefusesQueriesBodiesOtherMethodsAndPathTricks() {
        XCTAssertNil(SystemBridge.validate(method: "GET", path: "/kb/agent/skill-library?", body: nil))
        XCTAssertNil(SystemBridge.validate(method: "GET", path: "/kb/agent/skill-library?family=x", body: nil))
        XCTAssertNil(SystemBridge.validate(method: "GET", path: "/kb/agent/skill-library", body: ["x": "y"]))
        XCTAssertNil(SystemBridge.validate(method: "POST", path: "/kb/agent/skill-library", body: nil))
        XCTAssertNil(SystemBridge.validate(method: "GET", path: "/kb/agent/skill-library/", body: nil))
        XCTAssertNil(SystemBridge.validate(method: "GET", path: "/kb/agent/skill-library/../state", body: nil))
        XCTAssertNil(SystemBridge.validate(method: "GET", path: "/kb/agent/skills", body: nil))
    }

    func testSkillLibraryRequestDecodesThroughTheRequestMessage() {
        XCTAssertEqual(
            SystemBridgeInbound.decode(["type": "request", "id": "r9", "method": "GET", "path": "/kb/agent/skill-library"]),
            .request(SystemBridgeRequest(id: "r9", call: .skillLibrary)))
    }

    // MARK: v1.1 graph file conversion

    private let fixture = Data("""
    {
      "version": "1.1",
      "summary": {"totalFiles": 3, "totalEdges": 2, "totalCalls": 2},
      "files": [
        {"path": "src/a.swift", "name": "a.swift", "language": "swift", "loc": 10, "role": "x",
         "imports": ["src/b.swift", "src/missing.swift", "src/a.swift"], "usedBy": [], "types": [], "functions": []},
        {"path": "src/b.swift", "name": "b.swift", "language": "swift", "loc": 5, "role": "x",
         "imports": ["src/a.swift"], "usedBy": [], "types": [], "functions": []},
        {"path": "src/a.swift", "name": "dup.swift", "language": "swift", "loc": 1, "role": "x",
         "imports": [], "usedBy": [], "types": [], "functions": []}
      ],
      "calls": [
        {"from": "src/a.swift", "to": "src/b.swift", "symbol": "helper"},
        {"from": "src/a.swift", "to": "src/b.swift", "symbol": "other"},
        {"from": "src/b.swift", "to": "src/nowhere.swift", "symbol": "gone"}
      ]
    }
    """.utf8)

    func testConvertsFilesImportsAndCallsToCGData() throws {
        let graph = try XCTUnwrap(ProjectGraphFile.graph(fromJSON: fixture))
        // One node per path: the duplicate `src/a.swift` entry is dropped.
        XCTAssertEqual(graph.nodes.map(\.id), ["src/a.swift", "src/b.swift"])
        let a = try XCTUnwrap(graph.nodes.first)
        XCTAssertEqual(a.kind, .file)
        XCTAssertEqual(a.title, "a.swift")
        XCTAssertEqual(a.metadata, ["path": "src/a.swift", "language": "swift"])

        // Imports: a->b and b->a; the self import and the unknown target are dropped.
        // Calls: one a->b edge (deduplicated across symbols); the unknown callee is dropped.
        let imports = graph.edges.filter { $0.kind == .imports }
        XCTAssertEqual(imports.map { "\($0.fromId)->\($0.toId)" }, ["src/a.swift->src/b.swift", "src/b.swift->src/a.swift"])
        XCTAssertTrue(imports.allSatisfy { $0.confidence == .extracted })
        let calls = graph.edges.filter { $0.kind == .calls }
        XCTAssertEqual(calls.map { "\($0.fromId)->\($0.toId)" }, ["src/a.swift->src/b.swift"])
        XCTAssertTrue(calls.allSatisfy { $0.confidence == .inferred })
        XCTAssertEqual(graph.edges.count, 3)
    }

    func testAGraphWithoutCallsStillConverts() throws {
        let json = Data(#"{"version":"1.1","files":[{"path":"x.py","language":"python","imports":[]}]}"#.utf8)
        let graph = try XCTUnwrap(ProjectGraphFile.graph(fromJSON: json))
        XCTAssertEqual(graph.nodes.map(\.title), ["x.py"])
        XCTAssertTrue(graph.edges.isEmpty)
    }

    func testNotAV11GraphConvertsToNil() {
        XCTAssertNil(ProjectGraphFile.graph(fromJSON: Data("not json".utf8)))
        XCTAssertNil(ProjectGraphFile.graph(fromJSON: Data(#"{"version":"1.1"}"#.utf8)))
    }

    func testLoadReadsTheRepoGraphFileAndAMissingFileIsNil() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("g2a-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        // Nothing on disk: no graph.
        XCTAssertNil(ProjectGraphFile.load(projectRoot: root))

        // The graph lives in the code/<repo>/system/graph/graph.json the generator writes.
        let repo = root.appendingPathComponent("code/repo", isDirectory: true)
        let graphDir = ProjectLayout(root: repo).graphDir
        try FileManager.default.createDirectory(at: graphDir, withIntermediateDirectories: true)
        try fixture.write(to: graphDir.appendingPathComponent("graph.json"))
        let loaded = try XCTUnwrap(ProjectGraphFile.load(projectRoot: root))
        XCTAssertEqual(loaded.nodes.count, 2)
    }

    // MARK: node cap

    func testTheCapKeepsTheHighestDegreeNodesAndOnlyTheirEdges() {
        let count = ProjectGraphCap.maxNodes + 1
        let nodes = (0..<count).map { CGNode(id: "k\($0)", title: "k\($0)", kind: .file) }
        // A chain k1 -> k2 -> ... leaves k0 with no edges: the one node the cap drops.
        let edges = (1..<(count - 1)).map { CGEdge(fromId: "k\($0)", toId: "k\($0 + 1)", kind: .imports) }
        let layers = [UALayer(id: "all", name: "All", nodeIds: ["k0", "k1"])]
        let capped = ProjectGraphCap.capped(CGData(nodes: nodes, edges: edges, layers: layers))
        XCTAssertEqual(capped.nodes.count, ProjectGraphCap.maxNodes)
        XCTAssertFalse(capped.nodes.contains { $0.id == "k0" })
        XCTAssertEqual(capped.edges.count, edges.count)
        XCTAssertEqual(capped.layers.first?.nodeIds, ["k1"])
    }

    func testAGraphUnderTheCapIsReturnedUnchanged() {
        let graph = CGData(nodes: [CGNode(id: "a", title: "a", kind: .file)], edges: [])
        XCTAssertEqual(ProjectGraphCap.capped(graph), graph)
    }

    // MARK: registries

    func testRegistriesAnswerNothingUntilInstalled() async {
        let graphs = ProjectGraphRegistry()
        let routines = RoutinesRegistry()
        XCTAssertFalse(graphs.isInstalled)
        XCTAssertFalse(routines.isInstalled)
        let none = await graphs.graph(forProjectRoot: URL(fileURLWithPath: "/nowhere"))
        XCTAssertNil(none)
        XCTAssertEqual(routines.routines(projectId: "p1"), [])
    }

    func testInstalledProvidersAnswerAndALaterInstallReplaces() async {
        let graphs = ProjectGraphRegistry()
        let routines = RoutinesRegistry()
        let first = CGData(nodes: [CGNode(id: "one", title: "one", kind: .file)], edges: [])
        graphs.install { _ in first }
        routines.install { projectId in
            [RoutineSummary(id: "custom.\(projectId ?? "none")", title: "T", schedule: nil,
                            nextRunAt: nil, lastRunAt: nil, enabled: false)]
        }
        let got = await graphs.graph(forProjectRoot: URL(fileURLWithPath: "/p"))
        XCTAssertEqual(got, first)
        XCTAssertEqual(routines.routines(projectId: "abc").map(\.id), ["custom.abc"])
        XCTAssertEqual(routines.routines(projectId: nil).map(\.id), ["custom.none"])

        graphs.install { _ in nil }
        let replaced = await graphs.graph(forProjectRoot: URL(fileURLWithPath: "/p"))
        XCTAssertNil(replaced)
    }

    // MARK: bodies

    func testRoutineSummaryEncodesWithIsoDatesAndTheOsRoutineFields() throws {
        let next = Date(timeIntervalSince1970: 1_790_000_000)
        let routines = [RoutineSummary(id: "builtin.reviewCode", title: "Review Code", schedule: "0 * * * *",
                                       nextRunAt: next, lastRunAt: nil, enabled: true)]
        let body = SystemBridge.routinesBodyJSON(routines)
        let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(body.utf8)) as? [[String: Any]])
        XCTAssertEqual(parsed.count, 1)
        let row = try XCTUnwrap(parsed.first)
        XCTAssertEqual(row["id"] as? String, "builtin.reviewCode")
        XCTAssertEqual(row["title"] as? String, "Review Code")
        XCTAssertEqual(row["schedule"] as? String, "0 * * * *")
        XCTAssertEqual(row["enabled"] as? Bool, true)
        XCTAssertEqual(row["nextRunAt"] as? String, ISO8601DateFormatter().string(from: next))
        XCTAssertNil(row["lastRunAt"])
    }

    func testAnEmptyRoutineListIsAnEmptyArray() {
        XCTAssertEqual(SystemBridge.routinesBodyJSON([]), "[]")
    }

    func testAGraphBodyIsTheCanonicalGraphDocumentOrNull() throws {
        XCTAssertEqual(SystemBridge.graphBodyJSON(nil), "null")
        let graph = CGData(nodes: [CGNode(id: "a", title: "a", kind: .file, metadata: ["path": "a"])],
                           edges: [CGEdge(fromId: "a", toId: "a", kind: .calls)])
        let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(SystemBridge.graphBodyJSON(graph).utf8))
                                   as? [String: Any])
        XCTAssertEqual(parsed["schemaVersion"] as? Int, GraphDocument.currentSchemaVersion)
        let nodes = try XCTUnwrap(parsed["nodes"] as? [[String: Any]])
        XCTAssertEqual(nodes.first?["id"] as? String, "a")
        XCTAssertEqual(nodes.first?["kind"] as? String, "file")
        XCTAssertEqual((nodes.first?["metadata"] as? [String: String])?["path"], "a")
        let edges = try XCTUnwrap(parsed["edges"] as? [[String: Any]])
        XCTAssertEqual(edges.first?["fromId"] as? String, "a")
        XCTAssertEqual(edges.first?["confidence"] as? String, "EXTRACTED")
    }

    func testTheRawResponseScriptSplicesTheBodyAndEscapesTheId() throws {
        let script = try XCTUnwrap(SystemBridge.responseScript(id: "r\"1", status: 200, bodyJSON: "[]", error: nil))
        XCTAssertEqual(script, #"window.llmideResponse("r\"1", {"status":200,"body":[],"error":null});"#)
        let refused = try XCTUnwrap(SystemBridge.responseScript(id: "n1", status: 400, bodyJSON: "null", error: "not_allowed"))
        XCTAssertEqual(refused, #"window.llmideResponse("n1", {"status":400,"body":null,"error":"not_allowed"});"#)
    }
}
