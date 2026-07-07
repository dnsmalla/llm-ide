// Tests for GraphService — the high-level service layer over GraphStorage.
//
// Uses swift-testing (the repo's preferred framework). Follows the same
// repo-root-per-test pattern as MemoryServiceTests / GraphStorageTests (struct
// + make/remove + defer), since @Suite structs cannot have deinit and the
// codebase keeps tests flat / self-contained per repo root.
//
// Notes on adapting the task template:
//   - The template's `GraphData`/`GraphNode` are GraphKit's `CGData`/`CGNode`.
//   - `CGNode` has `title` (not `label`), so test nodes use `title:` and
//     `queryGraph` matches on title.
//   - `CGData` has no `mode:` field, so graph literals omit it; the protocol's
//     `mode:` argument is still exercised on `generateGraph`.

import Testing
import Foundation
import GraphKit
@testable import LlmIdeMac

@Suite("GraphService")
struct GraphServiceTests {
    /// Stateless actor — safe to share across tests.
    private let service = GraphServiceImpl()

    /// Per-test unique repo root under the system temp dir, cleaned up via
    /// `defer` in each test (structs can't have deinit).
    private func makeRepo() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("llm-ide-graph-svc-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func removeRepo(_ url: URL) {
        try? FileManager.default.removeItem(at: url)
    }

    // MARK: - generateGraph

    @Test("generateGraph returns empty graph for new repo")
    func generateGraphReturnsEmpty() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let result = try await service.generateGraph(repoRoot: repo, mode: .code)

        #expect(result.nodes.isEmpty)
        #expect(result.edges.isEmpty)
    }

    @Test("generateGraph reads existing graph")
    func generateGraphReadsExisting() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let storage = GraphStorage()
        let existingGraph = CGData(
            nodes: [CGNode(id: "test", title: "Test", kind: .file)],
            edges: []
        )
        try await storage.writeGraphFile(repoRoot: repo, graph: existingGraph)

        let result = try await service.generateGraph(repoRoot: repo, mode: .code)

        #expect(result.nodes.count == 1)
        #expect(result.nodes[0].id == "test")
    }

    // MARK: - queryGraph

    @Test("queryGraph finds matching nodes")
    func queryGraphFindsMatches() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let storage = GraphStorage()
        let graph = CGData(
            nodes: [
                CGNode(id: "file1", title: "Component", kind: .file),
                CGNode(id: "file2", title: "TestFile", kind: .file)
            ],
            edges: []
        )
        try await storage.writeGraphFile(repoRoot: repo, graph: graph)

        let results = try await service.queryGraph(repoRoot: repo, query: "component", limit: 10)

        #expect(results.count == 1)
        #expect(results[0].id == "file1")
    }

    @Test("queryGraph respects limit")
    func queryGraphRespectsLimit() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let storage = GraphStorage()
        let nodes = (0..<20).map { i in
            CGNode(id: "file\(i)", title: "Component\(i)", kind: .file)
        }
        let graph = CGData(nodes: nodes, edges: [])
        try await storage.writeGraphFile(repoRoot: repo, graph: graph)

        let results = try await service.queryGraph(repoRoot: repo, query: "component", limit: 5)

        #expect(results.count == 5)
    }

    // MARK: - regenerateGraph

    @Test("regenerateGraph writes fingerprint")
    func regenerateGraphWritesFingerprint() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        try await service.regenerateGraph(repoRoot: repo)

        let storage = GraphStorage()
        let fingerprint = try? await storage.readDocFingerprint(repoRoot: repo)

        #expect(fingerprint != nil)
    }
}
