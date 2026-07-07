// Tests for AutomationService — the high-level orchestration layer over
// MemoryService (Task 4) and GraphService (Task 5).
//
// Uses swift-testing (the repo's preferred framework) and the same
// repo-root-per-test pattern as MemoryServiceTests / GraphServiceTests (struct
// + make/remove + defer), since @Suite structs cannot have deinit.
//
// Notes on adapting the task template:
//   - The template's `AgentContext` is `AgentTurnContext` here — a same-named
//     `AgentContext` domain type already exists in the module (see
//     AutomationService.swift's header for the full rationale).
//   - `ChatMemoryFact.timestamp` is `Int` ms, so test facts pass ms values
//     (`Int(Date().timeIntervalSince1970 * 1000)`).
//   - `cleanupStaleFacts` is driven through an in-memory `MockMemoryService`
//     because the Phase 1 storage layer synthesises every read-back timestamp
//     as "now" (documented parity quirk in `MemoryStorage.readChatMemory`): an
//     age-based removal cannot be exercised through a real write→read round
//     trip. The mock preserves timestamps so the age logic is genuinely
//     tested. `detectContradictions` (text-only) uses the real MemoryService.

import Testing
import Foundation
@testable import LlmIdeMac

@Suite("AutomationService")
struct AutomationServiceTests {
    /// Per-test unique repo root under the system temp dir, cleaned up via
    /// `defer` in each test (structs can't have deinit).
    private func makeRepo() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("llm-ide-auto-svc-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func removeRepo(_ url: URL) {
        try? FileManager.default.removeItem(at: url)
    }

    // MARK: - captureFromAgentTurn

    @Test("captureFromAgentTurn does not crash")
    func captureFromAgentTurnWorks() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }
        let service = AutomationServiceImpl()

        let context = AgentTurnContext(
            repoRoot: repo,
            userMessage: "How do I deploy?",
            agentReply: "Run fly deploy",
            timestamp: Date().timeIntervalSince1970
        )

        // No-op today; must not throw.
        try await service.captureFromAgentTurn(context: context)
    }

    // MARK: - captureFromUI

    @Test("captureFromUI does not crash")
    func captureFromUIWorks() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }
        let service = AutomationServiceImpl()

        let action = UIAction.fileViewed(file: URL(fileURLWithPath: "/test.ts"))

        // No-op today; must not throw.
        try await service.captureFromUI(action: action)
    }

    // MARK: - cleanupStaleFacts

    @Test("cleanupStaleFacts removes old facts")
    func cleanupRemovesStaleFacts() async throws {
        // Use an in-memory memory service so the old fact's timestamp survives
        // the read-back (the file-backed layer re-stamps every fact as "now").
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let nowMs = Int(Date().timeIntervalSince1970 * 1000)
        let oldFact = ChatMemoryFact(
            text: "Old fact",
            category: .convention,
            timestamp: nowMs - 40 * 24 * 60 * 60 * 1000, // 40 days ago, in ms
            source: .agent
        )
        let newFact = ChatMemoryFact(
            text: "New fact",
            category: .convention,
            timestamp: nowMs,
            source: .agent
        )
        let mock = MockMemoryService(facts: [oldFact, newFact])
        let service = AutomationServiceImpl(
            memoryService: mock,
            graphService: GraphServiceImpl()
        )

        let report = try await service.cleanupStaleFacts(repoRoot: repo, olderThanDays: 30)

        #expect(report.removed.count == 1)
        #expect(report.kept.count == 1)
        #expect(report.removed[0].reason == "stale_age")
        #expect(report.removed[0].fact.text == "Old fact")
        #expect(report.kept[0].text == "New fact")

        // The survivor must have been persisted back to the (mock) service.
        let remaining = try await mock.readChatMemory(repoRoot: repo)
        #expect(remaining == [newFact])
    }

    // MARK: - detectContradictions

    @Test("detectContradictions finds conflicting facts")
    func detectContradictionsWorks() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        // Text round-trips through the real file-backed MemoryService, so this
        // exercises the full detect path (read + analyse).
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

        let service = AutomationServiceImpl()
        let report = try await service.detectContradictions(repoRoot: repo)

        #expect(report.contradictions.count > 0)
    }

    // MARK: - regenerateOnDocChange

    @Test("regenerateOnDocChange calls graph service")
    func regenerateOnDocChangeWorks() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }
        let service = AutomationServiceImpl()

        // Must not throw; delegates to GraphService.regenerateGraph, which
        // writes a fresh doc fingerprint.
        try await service.regenerateOnDocChange(repoRoot: repo)

        // Confirm the fingerprint was actually written through GraphService.
        let storage = GraphStorage()
        let fingerprint = try? await storage.readDocFingerprint(repoRoot: repo)
        #expect(fingerprint != nil)
    }

    // MARK: - regenerateOnCodeChange

    @Test("regenerateOnCodeChange calls graph service")
    func regenerateOnCodeChangeWorks() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }
        let service = AutomationServiceImpl()

        try await service.regenerateOnCodeChange(repoRoot: repo)

        let storage = GraphStorage()
        let fingerprint = try? await storage.readDocFingerprint(repoRoot: repo)
        #expect(fingerprint != nil)
    }
}

/// In-memory `MemoryService` for unit tests. Preserves fact timestamps across
/// read/write (unlike the file-backed layer, which re-stamps as "now") so
/// age-based cleanup logic is testable. An actor so it is implicitly
/// `Sendable` and safe to share with the actor-based service under test.
private actor MockMemoryService: MemoryService {
    private var facts: [ChatMemoryFact]
    private var repoMD: String = ""

    init(facts: [ChatMemoryFact]) {
        self.facts = facts
    }

    func readMemory(repoRoot: URL) async throws -> MemoryData {
        MemoryData(facts: facts, bugs: [], qa: [])
    }

    func readChatMemory(repoRoot: URL) async throws -> [ChatMemoryFact] {
        facts
    }

    func writeChatMemory(repoRoot: URL, facts: [ChatMemoryFact]) async throws {
        self.facts = facts
    }

    func validateFact(repoRoot: URL, fact: ChatMemoryFact) async throws -> ValidationResult {
        ValidationResult(valid: true, errors: [])
    }

    func updateRepoMD(repoRoot: URL, content: String) async throws {
        self.repoMD = content
    }
}
