// Cross-platform service parity tests (Phase 2, Task 7).
//
// These are INTEGRATION tests: they chain multiple services together against a
// real temp filesystem and verify the behaviors that must match the TypeScript
// extension's service tier (extension/graphkit/tests/service-parity.test.ts)
// one-for-one. The per-service unit tests (MemoryServiceTests /
// GraphServiceTests / AutomationServiceTests) already cover each service in
// isolation; this file covers the end-to-end workflows and the shared on-disk
// contract that both platforms depend on.
//
// Uses swift-testing (the repo's preferred framework) and the same
// repo-root-per-test pattern as the sibling service test files
// (struct + make/remove + defer), since @Suite structs cannot have deinit and
// the codebase keeps tests flat / self-contained per repo root.
//
// Drift corrections vs. the original task template (forced by the real Phase 1
// types / module contents so the code compiles with no breaking changes — the
// sibling service test files document the same drift):
//   - The template used `deinit` on a @Suite struct. Structs cannot have
//     deinit; cleanup is done via `defer { removeRepo(repo) }` per test, as in
//     MemoryServiceTests / GraphServiceTests / AutomationServiceTests.
//   - `ChatMemoryFact.timestamp` is `Int` ms (Phase 1 contract), not Double
//     seconds. Tests pass `Int(Date().timeIntervalSince1970 * 1000)`.
//   - The template's `GraphData`/`GraphNode` are GraphKit's `CGData`/`CGNode`.
//     `CGNode` exposes `title` (not `label`), so test nodes use `title:` and
//     `queryGraph` matches on title. `CGData` has no `mode:` field, so graph
//     literals omit it. (Hence `import GraphKit`.)
//   - `GraphStorage.writeGraphFile` labels its first parameter `repoRoot:`, so
//     the call passes it explicitly (a positional call would not compile).

import Testing
import Foundation
import GraphKit
@testable import LlmIdeMac

@Suite("Service parity")
struct ServiceParityTests {
    /// Per-test unique repo root under the system temp dir, cleaned up via
    /// `defer` in each test (structs can't have deinit).
    private func makeRepo() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("llm-ide-parity-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func removeRepo(_ url: URL) {
        try? FileManager.default.removeItem(at: url)
    }

    // MARK: - MemoryService read shape

    @Test("Parity: MemoryService read shape matches the cross-platform contract")
    func memoryServiceReadShape() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let memoryService = MemoryServiceImpl()

        // Fresh repo: readMemory must degrade gracefully and return the
        // canonical empty shape — the TS MemoryService returns the identical
        // { facts: [], bugs: [], qa: [] }.
        let empty = try await memoryService.readMemory(repoRoot: repo)
        #expect(empty.facts.isEmpty)
        #expect(empty.bugs.isEmpty)
        #expect(empty.qa.isEmpty)

        // Seed a chat-memory.md via the storage layer (the on-disk format both
        // platforms read). The service must surface those facts.
        let storage = MemoryStorage()
        try await storage.writeMemoryFile(
            repoRoot: repo,
            filename: "chat-memory.md",
            content: "# Chat memory\n\n- This project uses Swift\n"
        )

        let populated = try await memoryService.readMemory(repoRoot: repo)
        #expect(populated.facts.count == 1)
        #expect(populated.facts[0].text == "This project uses Swift")
        // bugs/qa are forward-looking placeholders, always empty today (parity).
        #expect(populated.bugs.isEmpty)
        #expect(populated.qa.isEmpty)
    }

    // MARK: - GraphService query

    @Test("Parity: GraphService query matches the cross-platform contract")
    func graphServiceQuery() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        // Write a graph via the Phase 1 storage layer using the SHIPPED CGData
        // shape (CGNode.title, no mode field). queryGraph searches `title`
        // case-insensitively on both platforms.
        let storage = GraphStorage()
        let graph = CGData(
            nodes: [
                CGNode(id: "test.swift", title: "test.swift", kind: .file),
                CGNode(id: "other.swift", title: "other.swift", kind: .file)
            ],
            edges: []
        )
        try await storage.writeGraphFile(repoRoot: repo, graph: graph)

        let graphService = GraphServiceImpl()
        let results = try await graphService.queryGraph(
            repoRoot: repo, query: "test", limit: 10)

        #expect(results.count == 1)
        #expect(results[0].id == "test.swift")
        #expect(results[0].title == "test.swift")
    }

    // MARK: - AutomationService safe cleanup

    @Test("Parity: AutomationService cleanup is safe on an empty repo")
    func automationServiceCleanupSafe() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        // No facts on disk — cleanup must not crash and must report nothing
        // removed/kept. The TS AutomationService makes the same guarantee.
        let automationService = AutomationServiceImpl()
        let report = try await automationService.cleanupStaleFacts(
            repoRoot: repo, olderThanDays: 30)

        #expect(report.removed.isEmpty)
        #expect(report.kept.isEmpty)
        #expect(report.errors.isEmpty)
    }

    // MARK: - End-to-end workflow

    @Test("Parity: end-to-end write → read → validate → cleanup keeps a fresh, valid fact")
    func endToEndWorkflow() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let memoryService = MemoryServiceImpl()
        let automationService = AutomationServiceImpl()

        // 1. Write a fresh, valid fact through MemoryService.
        let facts = [
            ChatMemoryFact(
                text: "This project uses SwiftUI",
                category: .tooling,
                timestamp: Int(Date().timeIntervalSince1970 * 1000),
                source: .agent
            )
        ]
        try await memoryService.writeChatMemory(repoRoot: repo, facts: facts)

        // 2. Read it back through MemoryService.
        let read = try await memoryService.readChatMemory(repoRoot: repo)
        #expect(read.count == 1)
        #expect(read[0].text == "This project uses SwiftUI")

        // 3. Validate the read-back fact: short text, no file refs -> valid.
        let validation = try await memoryService.validateFact(
            repoRoot: repo, fact: read[0])
        #expect(validation.valid)

        // 4. Cleanup with a 30-day cutoff must KEEP the fresh, valid fact (it
        //    is neither stale nor invalid). Parity with the TS end-to-end test.
        let cleanupReport = try await automationService.cleanupStaleFacts(
            repoRoot: repo, olderThanDays: 30)
        #expect(cleanupReport.kept.count == 1)
        #expect(cleanupReport.removed.isEmpty)
        #expect(cleanupReport.kept[0].text == "This project uses SwiftUI")
    }

    // MARK: - Contradiction detection (cross-platform signature)

    @Test("Parity: AutomationService detects the cross-platform contradiction signature")
    func contradictionSignature() async throws {
        // The contradiction pair ("uses npm" vs "does not use npm") is the
        // canonical fixture used by BOTH platforms' AutomationService tests.
        // Verifying the Swift side flags it guarantees the same input yields a
        // contradiction on TS.
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let memoryService = MemoryServiceImpl()
        let facts = [
            ChatMemoryFact(
                text: "This project uses npm for package management",
                category: .tooling,
                timestamp: Int(Date().timeIntervalSince1970 * 1000),
                source: .agent
            ),
            ChatMemoryFact(
                text: "This project does not use npm",
                category: .tooling,
                timestamp: Int(Date().timeIntervalSince1970 * 1000),
                source: .agent
            )
        ]
        try await memoryService.writeChatMemory(repoRoot: repo, facts: facts)

        let automationService = AutomationServiceImpl()
        let report = try await automationService.detectContradictions(repoRoot: repo)

        #expect(report.contradictions.count > 0)
    }
}
