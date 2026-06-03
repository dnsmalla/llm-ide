import Testing
import Foundation
@testable import MeetNotesMac

struct UAParserTests {
    private let repoRoot = URL(fileURLWithPath: "/repo")

    @Test func parsesMinimalValidGraph() throws {
        let json = """
        {
          "version": "1.0.0",
          "project": "TestProject",
          "nodes": [
            {
              "id": "func:login",
              "type": "func",
              "name": "login",
              "filePath": "src/auth.swift",
              "lineRange": [10, 50],
              "summary": "Authenticates the user",
              "tags": ["auth", "core"],
              "complexity": "moderate"
            },
            {
              "id": "struct:User",
              "type": "struct",
              "name": "User",
              "filePath": "src/models.swift",
              "lineRange": [1, 30],
              "summary": "User model",
              "tags": ["model"],
              "complexity": "simple"
            },
            {
              "id": "doc:readme",
              "type": "doc",
              "name": "README",
              "filePath": "README.md",
              "summary": "Project overview"
            },
            {
              "id": "api:v1",
              "type": "api",
              "name": "v1 endpoint",
              "filePath": "src/api.swift"
            },
            {
              "id": "pkg:auth",
              "type": "package",
              "name": "AuthLib"
            }
          ],
          "edges": [
            {
              "source": "func:login",
              "target": "struct:User",
              "type": "uses",
              "direction": "forward",
              "weight": 0.9
            }
          ],
          "layers": [
            {
              "id": "layer1",
              "name": "Core",
              "description": "Core layer",
              "nodeIds": ["func:login", "struct:User"]
            }
          ],
          "tour": [
            {
              "order": 1,
              "title": "Start Here",
              "description": "Begin with login",
              "nodeIds": ["func:login"],
              "languageLesson": "Swift intro"
            }
          ]
        }
        """.data(using: .utf8)!

        let parsed = try UAParser.parse(data: json, repoRoot: repoRoot)
        #expect(parsed.nodes.count == 5)
        #expect(parsed.edges.count == 1)

        // Node kinds
        let funcNode = parsed.nodes.first { $0.id == "func:login" }!
        #expect(funcNode.kind == .function)

        let structNode = parsed.nodes.first { $0.id == "struct:User" }!
        #expect(structNode.kind == .classType)

        let docNode = parsed.nodes.first { $0.id == "doc:readme" }!
        #expect(docNode.kind == .docPage)

        let apiNode = parsed.nodes.first { $0.id == "api:v1" }!
        #expect(apiNode.kind == .endpoint)

        let pkgNode = parsed.nodes.first { $0.id == "pkg:auth" }!
        #expect(pkgNode.kind == .module)

        // Metadata on funcNode
        #expect(funcNode.metadata["fileURL"] == "file:///repo/src/auth.swift")
        #expect(funcNode.metadata["line"] == "L10-L50")
        #expect(funcNode.metadata["summary"] == "Authenticates the user")
        #expect(funcNode.metadata["complexity"] == "moderate")
        #expect(funcNode.metadata["tags"] == "auth, core")

        // Edge kind (uses -> dependsOn)
        let edge = parsed.edges.first!
        #expect(edge.kind == .dependsOn)

        // Layers
        #expect(parsed.layers.count == 1)
        #expect(parsed.layers.first?.name == "Core")
        #expect(parsed.layers.first?.nodeIds == ["func:login", "struct:User"])

        // Tour
        #expect(parsed.tour.count == 1)
        #expect(parsed.tour.first?.title == "Start Here")
        #expect(parsed.tour.first?.nodeId == "func:login")
        #expect(parsed.tour.first?.body == "Begin with login")
    }

    @Test func mapsNodeTypeAliases() {
        #expect(UAParser.mapNodeType("func") == .function)
        #expect(UAParser.mapNodeType("struct") == .classType)
        #expect(UAParser.mapNodeType("doc") == .docPage)
        #expect(UAParser.mapNodeType("api") == .endpoint)
        #expect(UAParser.mapNodeType("package") == .module)
        #expect(UAParser.mapNodeType("file") == .file)
        #expect(UAParser.mapNodeType("module") == .module)
        #expect(UAParser.mapNodeType("document") == .docPage)
        #expect(UAParser.mapNodeType("function") == .function)
        #expect(UAParser.mapNodeType("class") == .classType)
        #expect(UAParser.mapNodeType("endpoint") == .endpoint)
        #expect(UAParser.mapNodeType("config") == .config)
        #expect(UAParser.mapNodeType("service") == .service)
        #expect(UAParser.mapNodeType("table") == .table)
        #expect(UAParser.mapNodeType("pipeline") == .pipeline)
        #expect(UAParser.mapNodeType("schema") == .schemaNode)
    }

    @Test func mapsEdgeTypeAliases() {
        // Alias mappings — UA vocab → CGEdgeKind
        #expect(UAParser.mapEdgeType("extends") == .inherits)
        #expect(UAParser.mapEdgeType("invokes") == .calls)
        #expect(UAParser.mapEdgeType("uses") == .dependsOn)
        // Direct mappings verified through aliases
        #expect(UAParser.mapEdgeType("tested_by") == .testedBy)
        #expect(UAParser.mapEdgeType("publishes") == .publishes)
        #expect(UAParser.mapEdgeType("reads_from") == .readsFrom)
    }

    @Test func unknownEdgeTypeFallsBackToRelatedTo() {
        #expect(UAParser.mapEdgeType("teleports") == .relatedTo)
        #expect(UAParser.mapEdgeType("zaps") == .relatedTo)
        #expect(UAParser.mapEdgeType("foobar_xyz") == .relatedTo)
    }

    @Test func missingNodesKeyThrowsParseFailed() {
        let json = #"{"version": "1.0.0", "project": "test"}"#.data(using: .utf8)!
        #expect(throws: UAError.self) {
            try UAParser.parse(data: json, repoRoot: repoRoot)
        }
    }

    @Test func emptyNodesArrayParsesCleanly() throws {
        let json = #"{"nodes": [], "edges": []}"#.data(using: .utf8)!
        let parsed = try UAParser.parse(data: json, repoRoot: repoRoot)
        #expect(parsed.nodes.isEmpty)
        #expect(parsed.edges.isEmpty)
    }

    @Test func resolvesRelativeFilePath() throws {
        let repoRoot = URL(fileURLWithPath: "/repo")
        let url = UAParser.resolveFileURL(filePath: "src/main.swift", repoRoot: repoRoot)
        #expect(url.path == "/repo/src/main.swift")
    }

    @Test func resolvesAbsoluteFilePathInsideRepo() throws {
        let repoRoot = URL(fileURLWithPath: "/repo")
        let url = UAParser.resolveFileURL(filePath: "/repo/src/main.swift", repoRoot: repoRoot)
        #expect(url.path == "/repo/src/main.swift")
    }

    @Test func rebasesStaleAbsolutePath() throws {
        let newRoot = URL(fileURLWithPath: "/new/repo")
        let url = UAParser.resolveFileURL(filePath: "/old/repo/src/main.swift", repoRoot: newRoot)
        #expect(url.path == "/new/repo/src/main.swift")
    }

    @Test func defaultsNilTypeToFile() throws {
        // UA spec: nil/missing type defaults to "file"
        #expect(UAParser.mapNodeType(nil) == .file)
    }

    @Test func unknownNodeTypeFallsBackToOther() {
        #expect(UAParser.mapNodeType("alien") == .other)
        #expect(UAParser.mapNodeType("foobar_xyz") == .other)
    }
}
