// Tests for GraphStorage — Swift mirror of the Task 4 TS suite.
//
// Uses swift-testing (the repo's preferred framework: 84 swift-testing files
// vs 10 XCTest). Test file is flat in Tests/LlmIdeMacTests/ to match the
// existing test layout (no test subdirectories exist today; see
// MemoryStorageTests.swift for the same convention).

import Testing
import Foundation
@testable import LlmIdeMac
import GraphKit

@Suite("GraphStorage")
struct GraphStorageTests {
    let storage = GraphStorage()

    /// Per-test unique repo root under the system temp dir, cleaned up after.
    /// Using a struct with @Suite + deinit isn't supported, so each @Test
    /// creates its own throwaway repo root via this helper.
    private func makeRepo() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("llm-ide-graph-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func removeRepo(_ url: URL) {
        try? FileManager.default.removeItem(at: url)
    }

    // MARK: - getGraphDir

    @Test func getGraphDirReturnsCanonicalPath() throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let result = storage.getGraphDir(repoRoot: repo)
        let expected = repo
            .appendingPathComponent(".llm-ide")
            .appendingPathComponent("graph")

        #expect(result == expected)
        #expect(result.path == "\(repo.path)/.llm-ide/graph")
    }

    // MARK: - readGraphFile graceful degradation

    @Test func readGraphFileReturnsEmptyWhenMissing() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let result = try await storage.readGraphFile(repoRoot: repo)

        #expect(result.nodes.isEmpty)
        #expect(result.edges.isEmpty)
        #expect(result == CGData.empty)
    }

    // MARK: - write + read round-trip

    @Test func writeThenReadRoundTripsGraph() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let graph = CGData(
            nodes: [
                CGNode(id: "src/a.swift", title: "a.swift", kind: .file),
                CGNode(id: "sym/foo", title: "foo()", kind: .function),
            ],
            edges: [
                CGEdge(fromId: "src/a.swift", toId: "sym/foo", kind: .contains),
            ]
        )

        try await storage.writeGraphFile(repoRoot: repo, graph: graph)
        let read = try await storage.readGraphFile(repoRoot: repo)

        #expect(read.nodes.count == 2)
        #expect(read.edges.count == 1)
        #expect(read.nodes.map(\.id).sorted() == ["src/a.swift", "sym/foo"])
        #expect(read.edges[0].fromId == "src/a.swift")
        #expect(read.edges[0].toId == "sym/foo")
        #expect(read.edges[0].kind == .contains)
    }

    @Test func writeGraphCreatesDirectoryIfMissing() async throws {
        // Fresh repo: .llm-ide/graph does not exist yet.
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        try await storage.writeGraphFile(repoRoot: repo, graph: .empty)

        let graphDir = storage.getGraphDir(repoRoot: repo)
        let fileURL = graphDir.appendingPathComponent("graph.json")
        #expect(FileManager.default.fileExists(atPath: fileURL.path))
    }

    @Test func writeGraphOverwritesExistingFileAtomically() async throws {
        // The TS layer's fs.rename overwrites; Swift's moveItem does not, so
        // the impl uses replaceItem for the overwrite path. Verify it.
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        try await storage.writeGraphFile(repoRoot: repo, graph: CGData(
            nodes: [CGNode(id: "1", title: "first", kind: .file)], edges: []))
        try await storage.writeGraphFile(repoRoot: repo, graph: CGData(
            nodes: [CGNode(id: "2", title: "second", kind: .file)], edges: []))

        let read = try await storage.readGraphFile(repoRoot: repo)
        #expect(read.nodes.count == 1)
        #expect(read.nodes[0].id == "2")
        #expect(read.nodes[0].title == "second")
    }

    @Test func writeGraphPreservesNodePositionAndMetadata() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let node = CGNode(
            id: "n1", title: "WithLayout", kind: .symbol,
            position: CGPoint(x: 12.5, y: -7.0),
            metadata: ["file": "Sources/Foo.swift", "line": "42"])
        try await storage.writeGraphFile(repoRoot: repo, graph: CGData(nodes: [node], edges: []))

        let read = try await storage.readGraphFile(repoRoot: repo)
        #expect(read.nodes.count == 1)
        let n = read.nodes[0]
        #expect(n.id == "n1")
        #expect(n.position.x == 12.5)
        #expect(n.position.y == -7.0)
        #expect(n.metadata["file"] == "Sources/Foo.swift")
        #expect(n.metadata["line"] == "42")
    }

    @Test func writeGraphLeavesNoTempFilesBehind() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        try await storage.writeGraphFile(repoRoot: repo, graph: .empty)
        try await storage.writeGraphFile(repoRoot: repo, graph: .empty)

        let graphDir = storage.getGraphDir(repoRoot: repo)
        let entries = (try FileManager.default.contentsOfDirectory(atPath: graphDir.path))
        let temps = entries.filter { $0.contains(".tmp.") }
        #expect(temps.isEmpty, "leftover temp files: \(temps)")
    }

    // MARK: - readGraphFile lenient decode (cross-layer parity with TS)

    @Test func readGraphFileParsesTSFormWithoutLayersOrTour() async throws {
        // The TS `GraphData` schema only writes {nodes, edges}. Swift's CGData
        // adds layers/tour; a naive decode would throw keyNotFound. Verify the
        // lenient decode accepts the two-field TS form.
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let graphDir = storage.getGraphDir(repoRoot: repo)
        try FileManager.default.createDirectory(at: graphDir, withIntermediateDirectories: true)
        // Minimal TS-shaped payload: nodes carry only id/title/kind and edges
        // carry only fromId/toId/kind (no `confidence`; Swift's CGEdge adds it).
        let tsForm = """
        {
          "nodes": [
            { "id": "code/a.ts", "title": "a.ts", "kind": "file" }
          ],
          "edges": [
            { "fromId": "code/a.ts", "toId": "code/b.ts", "kind": "imports" }
          ]
        }
        """
        let fileURL = graphDir.appendingPathComponent("graph.json")
        try tsForm.write(to: fileURL, atomically: true, encoding: .utf8)

        let read = try await storage.readGraphFile(repoRoot: repo)
        #expect(read.nodes.count == 1)
        #expect(read.nodes[0].id == "code/a.ts")
        #expect(read.edges.count == 1)
        #expect(read.edges[0].fromId == "code/a.ts")
        #expect(read.edges[0].toId == "code/b.ts")
        #expect(read.edges[0].kind == .imports)
        // TS-written confidence defaults to .extracted (Swift-only field).
        #expect(read.edges[0].confidence == .extracted)
        // layers/tour default to empty (Swift-only fields).
        #expect(read.layers.isEmpty)
        #expect(read.tour.isEmpty)
    }

    @Test func readGraphFileThrowsCorruptedForInvalidJSON() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let graphDir = storage.getGraphDir(repoRoot: repo)
        try FileManager.default.createDirectory(at: graphDir, withIntermediateDirectories: true)
        let fileURL = graphDir.appendingPathComponent("graph.json")
        try "{ not valid json ".write(to: fileURL, atomically: true, encoding: .utf8)

        do {
            _ = try await storage.readGraphFile(repoRoot: repo)
            Issue.record("expected corrupted error")
        } catch let err as GraphStorageError {
            #expect(err.code == "CORRUPTED")
            if case .corrupted(let path, _) = err {
                #expect(path.contains("graph.json"))
            } else {
                Issue.record("wrong case: \(err)")
            }
        } catch {
            Issue.record("wrong error type: \(error)")
        }
    }

    // MARK: - doc-fingerprint round-trip

    @Test func writeThenReadDocFingerprint() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        try await storage.writeDocFingerprint(repoRoot: repo, fingerprint: "sha256:abc123")
        let read = try await storage.readDocFingerprint(repoRoot: repo)
        #expect(read == "sha256:abc123")
    }

    @Test func readDocFingerprintReturnsNilWhenMissing() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let result = try await storage.readDocFingerprint(repoRoot: repo)
        #expect(result == nil)
    }

    @Test func writeDocFingerprintOverwritesExisting() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        try await storage.writeDocFingerprint(repoRoot: repo, fingerprint: "first")
        try await storage.writeDocFingerprint(repoRoot: repo, fingerprint: "second")
        let read = try await storage.readDocFingerprint(repoRoot: repo)
        #expect(read == "second")
    }

    @Test func writeDocFingerprintCreatesDirectoryIfMissing() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        try await storage.writeDocFingerprint(repoRoot: repo, fingerprint: "x")
        let fileURL = storage.getGraphDir(repoRoot: repo).appendingPathComponent("doc-fingerprint.txt")
        #expect(FileManager.default.fileExists(atPath: fileURL.path))
    }

    // MARK: - repo root with spaces (parity with TS spaces test)

    @Test func repoRootWithSpacesResolvesCorrectly() async throws {
        let repo = FileManager.default.temporaryDirectory
            .appendingPathComponent("llm-ide graph spaces \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        defer { removeRepo(repo) }

        let graph = CGData(nodes: [CGNode(id: "1", title: "spacy", kind: .file)], edges: [])
        try await storage.writeGraphFile(repoRoot: repo, graph: graph)

        let graphDir = storage.getGraphDir(repoRoot: repo)
        #expect(graphDir.path.contains("/.llm-ide/graph"))

        let read = try await storage.readGraphFile(repoRoot: repo)
        #expect(read.nodes[0].title == "spacy")
    }

    // MARK: - error type shape

    @Test func errorCodeStringsMatchTSContract() {
        #expect(GraphStorageError.notFound(path: "x").code == "NOT_FOUND")
        #expect(GraphStorageError.permissionDenied(path: "x").code == "PERMISSION_DENIED")
        #expect(GraphStorageError.corrupted(path: "x", underlyingDescription: "boom").code == "CORRUPTED")
    }

    @Test func errorHasLocalizedDescription() {
        let err = GraphStorageError.corrupted(path: "/a/graph.json", underlyingDescription: "boom")
        #expect(err.errorDescription?.contains("/a/graph.json") == true)
        #expect(err.errorDescription?.contains("boom") == true)
    }

    @Test func errorIsEquatable() {
        // Equatable lets callers (migration, tests) compare on the case+payload.
        #expect(GraphStorageError.notFound(path: "p") == GraphStorageError.notFound(path: "p"))
        #expect(GraphStorageError.notFound(path: "p") != GraphStorageError.permissionDenied(path: "p"))
    }
}
