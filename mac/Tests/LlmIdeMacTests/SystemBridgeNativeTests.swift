import XCTest
import WebKit
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

    func testConvertsFilesImportsAndCalls() throws {
        let graph = try XCTUnwrap(ProjectGraphFile.graph(fromJSON: fixture))
        // One node per path: the duplicate `src/a.swift` entry is dropped.
        XCTAssertEqual(graph.nodes.map(\.id), ["src/a.swift", "src/b.swift"])
        let a = try XCTUnwrap(graph.nodes.first)
        XCTAssertEqual(a.kind, "file")
        XCTAssertEqual(a.title, "a.swift")
        XCTAssertEqual(a.metadata, ["path": "src/a.swift", "language": "swift"])

        // Imports: a->b and b->a; the self import and the unknown target are dropped.
        // Calls: one a->b edge (deduplicated across symbols); the unknown callee is dropped.
        let imports = graph.edges.filter { $0.kind == "imports" }
        XCTAssertEqual(imports.map { "\($0.fromId)->\($0.toId)" }, ["src/a.swift->src/b.swift", "src/b.swift->src/a.swift"])
        XCTAssertTrue(imports.allSatisfy { $0.confidence == "EXTRACTED" })
        let calls = graph.edges.filter { $0.kind == "calls" }
        XCTAssertEqual(calls.map { "\($0.fromId)->\($0.toId)" }, ["src/a.swift->src/b.swift"])
        XCTAssertTrue(calls.allSatisfy { $0.confidence == "INFERRED" })
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

    // MARK: wire shape pinned to GraphCore

    /// The Core mirror must encode to exactly what graph-kit's `GraphDocument`
    /// encodes, and decode what GraphCore writes. The test target links GraphCore.
    func testTheWireShapeMatchesGraphCoresGraphDocument() throws {
        let graph = CGData(
            nodes: [
                CGNode(id: "a", title: "A", kind: .file, metadata: ["path": "a", "language": "swift"]),
                CGNode(id: "b", title: "B", kind: .function, position: CGPoint(x: 3, y: 4), metadata: [:]),
            ],
            edges: [
                CGEdge(fromId: "a", toId: "b", kind: .imports, confidence: .extracted),
                CGEdge(fromId: "b", toId: "a", kind: .calls, confidence: .inferred),
            ],
            layers: [UALayer(id: "l", name: "L", nodeIds: ["a"])],
            tour: [UATourStep(nodeId: "a", title: "T", body: "B")])
        let fromGraphKit = try JSONEncoder().encode(GraphDocument(graph))
        let mirror = ProjectGraphDocument(
            nodes: [
                .init(id: "a", title: "A", kind: "file", metadata: ["path": "a", "language": "swift"]),
                .init(id: "b", title: "B", kind: "function", position: .init(x: 3, y: 4), metadata: [:]),
            ],
            edges: [
                .init(fromId: "a", toId: "b", kind: "imports", confidence: "EXTRACTED"),
                .init(fromId: "b", toId: "a", kind: "calls", confidence: "INFERRED"),
            ],
            layers: [.init(id: "l", name: "L", nodeIds: ["a"])],
            tour: [.init(nodeId: "a", title: "T", body: "B")])

        let mine = try JSONSerialization.jsonObject(with: try XCTUnwrap(mirror.jsonData())) as? NSDictionary
        let theirs = try JSONSerialization.jsonObject(with: fromGraphKit) as? NSDictionary
        XCTAssertEqual(mine, theirs)
        XCTAssertEqual(mine?["schemaVersion"] as? Int, GraphDocument.currentSchemaVersion)
        XCTAssertEqual(ProjectGraphDocument.schemaVersion, GraphDocument.currentSchemaVersion)

        // And the other way: GraphCore's bytes decode to the same value.
        XCTAssertEqual(ProjectGraphDocument.decode(graphDocumentJSON: fromGraphKit), mirror)
    }

    func testAZeroPositionIsOmittedLikeGraphCore() throws {
        let mirror = ProjectGraphDocument(
            nodes: [.init(id: "a", title: "A", kind: "file", position: .init(x: 0, y: 0))], edges: [])
        let json = try XCTUnwrap(mirror.jsonData())
        let mine = try JSONSerialization.jsonObject(with: json) as? [String: Any]
        let nodes = try XCTUnwrap(mine?["nodes"] as? [[String: Any]])
        XCTAssertNil(nodes.first?["position"])
        let fromGraphKit = try JSONEncoder().encode(
            GraphDocument(CGData(nodes: [CGNode(id: "a", title: "A", kind: .file, position: .zero)], edges: [])))
        let theirs = try JSONSerialization.jsonObject(with: fromGraphKit) as? NSDictionary
        XCTAssertEqual(mine as NSDictionary?, theirs)
    }

    func testUndecodableGraphBytesAreNotADocument() {
        XCTAssertNil(ProjectGraphDocument.decode(graphDocumentJSON: Data("nope".utf8)))
        XCTAssertNil(ProjectGraphDocument.decode(graphDocumentJSON: Data(#"{"schemaVersion":1}"#.utf8)))
    }

    // MARK: cap

    func testTheDefaultBudgetsAreFiveThousandNodesAndFourEdgesEach() {
        XCTAssertEqual(ProjectGraphCap.maxNodes, 5_000)
        XCTAssertEqual(ProjectGraphCap.maxEdgesPerNode, 4)
    }

    func testTheNodeCapKeepsTheHighestDegreeNodesAndOnlyTheirEdges() {
        // k1-k2-k3-k4 is a chain (degrees 1, 2, 2, 1); k0 and k5 are isolated.
        let nodes = (0..<6).map { ProjectGraphDocument.Node(id: "k\($0)", title: "k\($0)", kind: "file") }
        let edges = [("k1", "k2"), ("k2", "k3"), ("k3", "k4")].map {
            ProjectGraphDocument.Edge(fromId: $0.0, toId: $0.1, kind: "imports", confidence: "EXTRACTED")
        }
        let layers = [ProjectGraphDocument.Layer(id: "all", name: "All", nodeIds: ["k0", "k1"])]
        let tour = [ProjectGraphDocument.TourStep(nodeId: "k0", title: "t", body: "b"),
                    ProjectGraphDocument.TourStep(nodeId: "k2", title: "t", body: "b")]
        let capped = ProjectGraphCap.capped(
            ProjectGraphDocument(nodes: nodes, edges: edges, layers: layers, tour: tour), maxNodes: 4)
        // Ranked: k2 (2), k3 (2), k1 (1), k4 (1); k0 and k5 (0) go. Ties keep file order.
        XCTAssertEqual(capped.nodes.map(\.id), ["k1", "k2", "k3", "k4"])
        XCTAssertEqual(capped.edges.count, 3)
        XCTAssertEqual(capped.layers.first?.nodeIds, ["k1"])
        XCTAssertEqual(capped.tour.map(\.nodeId), ["k2"])
    }

    func testTheDefaultCapDropsTheLastLowestDegreeNodeOfALongChain() {
        let count = ProjectGraphCap.maxNodes + 1
        let nodes = (0..<count).map { ProjectGraphDocument.Node(id: "k\($0)", title: "k\($0)", kind: "file") }
        let edges = (1..<count).map {
            ProjectGraphDocument.Edge(fromId: "k\($0 - 1)", toId: "k\($0)", kind: "imports", confidence: "EXTRACTED")
        }
        let capped = ProjectGraphCap.capped(ProjectGraphDocument(nodes: nodes, edges: edges))
        XCTAssertEqual(capped.nodes.count, ProjectGraphCap.maxNodes)
        // Both ends have degree 1; the tie keeps file order, so the last one goes.
        XCTAssertEqual(capped.nodes.first?.id, "k0")
        XCTAssertFalse(capped.nodes.contains { $0.id == "k\(count - 1)" })
        XCTAssertEqual(capped.edges.count, ProjectGraphCap.maxNodes - 1)
        XCTAssertTrue(capped.edges.count <= ProjectGraphCap.maxEdgesPerNode * capped.nodes.count)
    }

    func testTheEdgeCapKeepsTheHighestCombinedDegreeEdgesInInputOrder() {
        let nodes = ["a", "b", "c"].map { ProjectGraphDocument.Node(id: $0, title: $0, kind: "file") }
        // Five edges: four parallel a-b edges of different kinds, then c-b.
        // Degrees: a 4, b 5, c 1. Each a-b edge scores 4 + 5 = 9; c-b scores 1 + 5 = 6.
        let kinds = ["imports", "calls", "defines", "references"]
        var edges = kinds.map { ProjectGraphDocument.Edge(fromId: "a", toId: "b", kind: $0, confidence: "EXTRACTED") }
        edges.append(ProjectGraphDocument.Edge(fromId: "c", toId: "b", kind: "contains", confidence: "EXTRACTED"))
        // The budget is 1 edge per node x 3 nodes = 3: the three highest-scoring a-b
        // edges, in input order. The fourth a-b edge and the c-b edge go.
        let capped = ProjectGraphCap.capped(ProjectGraphDocument(nodes: nodes, edges: edges), maxEdgesPerNode: 1)
        XCTAssertEqual(capped.edges.map(\.kind), ["imports", "calls", "defines"])
        XCTAssertEqual(capped.nodes.count, 3)
        // Deterministic: the same input gives the same output.
        XCTAssertEqual(ProjectGraphCap.capped(ProjectGraphDocument(nodes: nodes, edges: edges), maxEdgesPerNode: 1), capped)
    }

    func testDanglingEdgesAreDroppedEvenUnderTheCap() {
        let nodes = [ProjectGraphDocument.Node(id: "a", title: "a", kind: "file")]
        let edges = [ProjectGraphDocument.Edge(fromId: "a", toId: "ghost", kind: "imports", confidence: "EXTRACTED")]
        XCTAssertTrue(ProjectGraphCap.capped(ProjectGraphDocument(nodes: nodes, edges: edges)).edges.isEmpty)
    }

    func testAGraphUnderTheCapIsReturnedUnchanged() {
        let graph = ProjectGraphDocument(
            nodes: [ProjectGraphDocument.Node(id: "a", title: "a", kind: "file")],
            edges: [ProjectGraphDocument.Edge(fromId: "a", toId: "a", kind: "calls", confidence: "INFERRED")])
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
        let first = Data(#"{"schemaVersion":1,"nodes":[],"edges":[]}"#.utf8)
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

    // MARK: graph reply

    private func sampleDocument(nodes: Int = 2) -> ProjectGraphDocument {
        ProjectGraphDocument(
            nodes: (0..<nodes).map { ProjectGraphDocument.Node(id: "n\($0)", title: "N\($0)", kind: "file",
                                                               metadata: ["path": "n\($0)"]) },
            edges: [])
    }

    func testNoGraphIsA200Null() {
        let reply = SystemBridge.projectGraphReply(provided: nil, loadFile: { nil })
        XCTAssertEqual(reply, SystemBridge.NativeReply(status: 200, bodyJSON: "null", error: nil))
    }

    func testTheProvidedGraphWinsOverTheFileAndIsEncodedCanonically() throws {
        let provided = try XCTUnwrap(sampleDocument().jsonData())
        var fileRead = false
        let reply = SystemBridge.projectGraphReply(provided: provided, loadFile: {
            fileRead = true
            return nil
        })
        XCTAssertFalse(fileRead)
        XCTAssertEqual(reply.status, 200)
        let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(reply.bodyJSON.utf8)) as? [String: Any])
        XCTAssertEqual((parsed["nodes"] as? [[String: Any]])?.count, 2)
    }

    func testTheFileIsTheFallbackWhenNothingIsProvided() throws {
        let reply = SystemBridge.projectGraphReply(provided: nil, loadFile: { self.sampleDocument(nodes: 3) })
        XCTAssertEqual(reply.status, 200)
        let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(reply.bodyJSON.utf8)) as? [String: Any])
        XCTAssertEqual((parsed["nodes"] as? [[String: Any]])?.count, 3)
    }

    func testBytesThatAreNotAGraphDocumentAreAnEncodeFailureNotASilentNull() {
        let reply = SystemBridge.projectGraphReply(provided: Data("garbage".utf8), loadFile: { self.sampleDocument() })
        XCTAssertEqual(reply, SystemBridge.NativeReply(status: 500, bodyJSON: "null", error: "graph_encode_failed"))
    }

    func testTheGraphReplyIsCappedBeforeItIsEncoded() throws {
        let provided = try XCTUnwrap(sampleDocument(nodes: ProjectGraphCap.maxNodes + 3).jsonData())
        let reply = SystemBridge.projectGraphReply(provided: provided, loadFile: { nil })
        let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(reply.bodyJSON.utf8)) as? [String: Any])
        XCTAssertEqual((parsed["nodes"] as? [[String: Any]])?.count, ProjectGraphCap.maxNodes)
    }

    func testRoutinesEncodeWithIsoDatesAndTheOsRoutineFields() throws {
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
        XCTAssertEqual(SystemBridge.routinesBodyJSON([]), "[]")
    }

    // MARK: skill library body

    func testTheSkillLibraryLosesItsPathsAndRepoBeforeItReachesThePage() throws {
        let server = Data("""
        {"repo":"/Users/me/skills","extra":1,"skills":[
          {"id":"s1","family":"chat","name":"Plan","description":"d","path":"/Users/me/skills/plan/SKILL.md",
           "sourceId":"src1","sourceName":"Kit","secret":"x"}]}
        """.utf8)
        let cleaned = try XCTUnwrap(SystemBridge.sanitizeSkillLibrary(server))
        let text = try XCTUnwrap(String(data: cleaned, encoding: .utf8))
        XCTAssertFalse(text.contains("/Users"))
        XCTAssertFalse(text.contains("secret"))
        let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: cleaned) as? [String: Any])
        XCTAssertNil(parsed["repo"])
        XCTAssertEqual(parsed["extra"] as? Int, 1)
        let skill = try XCTUnwrap((parsed["skills"] as? [[String: Any]])?.first)
        XCTAssertEqual(Set(skill.keys), ["id", "family", "name", "description", "sourceId", "sourceName"])
        XCTAssertEqual(skill["sourceName"] as? String, "Kit")
    }

    func testANonObjectSkillLibraryBodyIsRefused() {
        XCTAssertNil(SystemBridge.sanitizeSkillLibrary(Data("[1]".utf8)))
        XCTAssertNil(SystemBridge.sanitizeSkillLibrary(Data("nope".utf8)))
    }

    // MARK: script escaping

    /// Parses `window.llmideResponse(ID, REPLY);` back into its two arguments.
    private func decodeResponseScript(_ script: String) throws -> (id: String, reply: [String: Any]) {
        let prefix = "window.llmideResponse("
        XCTAssertTrue(script.hasPrefix(prefix))
        XCTAssertTrue(script.hasSuffix(");"))
        let args = String(script.dropFirst(prefix.count).dropLast(2))
        let array = try XCTUnwrap(JSONSerialization.jsonObject(with: Data("[\(args)]".utf8)) as? [Any])
        XCTAssertEqual(array.count, 2)
        return (try XCTUnwrap(array[0] as? String), try XCTUnwrap(array[1] as? [String: Any]))
    }

    func testAResponseBodyWithQuotesBackslashesLineSeparatorsAndEmojiRoundTrips() throws {
        let original = "a\"b\\c\u{2028}d\u{2029}e 😀"
        let body = try JSONSerialization.data(withJSONObject: ["s": original], options: [])
        let script = try XCTUnwrap(SystemBridge.responseScript(id: "r1", status: 200, body: body, error: nil))
        XCTAssertFalse(script.contains("\u{2028}"))
        XCTAssertFalse(script.contains("\u{2029}"))
        let decoded = try decodeResponseScript(script)
        XCTAssertEqual(decoded.id, "r1")
        XCTAssertEqual(decoded.reply["status"] as? Int, 200)
        XCTAssertEqual((decoded.reply["body"] as? [String: Any])?["s"] as? String, original)
    }

    func testARawBodyScriptRoundTripsItsSeparatorsAndTheIdStaysSafe() throws {
        let bodyJSON = "[\"x\u{2028}y\u{2029}\\\"z\"]"
        let script = try XCTUnwrap(SystemBridge.responseScript(id: "r\"2", status: 200, bodyJSON: bodyJSON, error: nil))
        XCTAssertFalse(script.contains("\u{2028}"))
        let decoded = try decodeResponseScript(script)
        XCTAssertEqual(decoded.id, "r\"2")
        XCTAssertEqual(decoded.reply["body"] as? [String], ["x\u{2028}y\u{2029}\"z"])
    }

    func testTheRawResponseScriptSplicesTheBodyAndEscapesTheId() throws {
        let script = try XCTUnwrap(SystemBridge.responseScript(id: "r\"1", status: 200, bodyJSON: "[]", error: nil))
        XCTAssertEqual(script, #"window.llmideResponse("r\"1", {"status":200,"body":[],"error":null});"#)
        let refused = try XCTUnwrap(SystemBridge.responseScript(id: "n1", status: 400, bodyJSON: "null", error: "not_allowed"))
        XCTAssertEqual(refused, #"window.llmideResponse("n1", {"status":400,"body":null,"error":"not_allowed"});"#)
        let failed = try XCTUnwrap(SystemBridge.responseScript(id: "g1", status: 500, bodyJSON: "null", error: "graph_encode_failed"))
        XCTAssertEqual(failed, #"window.llmideResponse("g1", {"status":500,"body":null,"error":"graph_encode_failed"});"#)
    }

    // MARK: project change

    func testAProjectChangeIsClassifiedByWhatMoved() {
        let root = URL(fileURLWithPath: "/work/a")
        let other = URL(fileURLWithPath: "/work/b")
        XCTAssertEqual(SystemBridge.projectChange(fromName: "A", fromRoot: root, fromId: "1",
                                                  toName: "A", toRoot: root, toId: "1"), .none)
        // A new name restarts the feed (the page reloads its extras itself).
        XCTAssertEqual(SystemBridge.projectChange(fromName: "A", fromRoot: root, fromId: "1",
                                                  toName: "B", toRoot: root, toId: "1"), .renamed)
        // The same name in another folder or with another id: the page must reload.
        XCTAssertEqual(SystemBridge.projectChange(fromName: "A", fromRoot: root, fromId: "1",
                                                  toName: "A", toRoot: other, toId: "1"), .reloadPage)
        XCTAssertEqual(SystemBridge.projectChange(fromName: "A", fromRoot: root, fromId: "1",
                                                  toName: "A", toRoot: root, toId: "2"), .reloadPage)
        XCTAssertEqual(SystemBridge.projectChange(fromName: nil, fromRoot: nil, fromId: nil,
                                                  toName: "A", toRoot: root, toId: "1"), .renamed)
    }

    // MARK: coordinator teardown

    func testDetachStopsTheFeedAndTheOldPageAndIsSafeTwice() {
        let api = LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456")
        let session = SessionStore(server: "http://test-\(UUID().uuidString.lowercased()).invalid")
        let view = SystemWebView(api: api, session: session, theme: .dark, projectName: nil,
                                 projectRoot: nil, projectId: nil, onOpen: { _ in })
        let coordinator = SystemWebView.Coordinator(view)
        let web = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        web.navigationDelegate = coordinator
        coordinator.attach(web, indexURL: nil)

        coordinator.handle(.subscribe)
        XCTAssertTrue(coordinator.hasFeed)

        coordinator.detach()
        XCTAssertFalse(coordinator.hasFeed)
        XCTAssertNil(web.navigationDelegate, "the detached page must not keep the coordinator as its delegate")
        coordinator.detach()
        XCTAssertFalse(coordinator.hasFeed)
    }
}
