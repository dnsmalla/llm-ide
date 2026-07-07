// Tests for MemoryService — the high-level service layer over MemoryStorage.
//
// Uses swift-testing (the repo's preferred framework). Follows the same
// repo-root-per-test pattern as MemoryStorageTests (struct + make/remove +
// defer), since @Suite structs cannot have deinit and the codebase keeps
// tests flat / self-contained per repo root.
//
// Notes on adapting the task template:
//   - ChatMemoryFact.timestamp is `Int` (ms), so tests pass
//     `Int(Date().timeIntervalSince1970 * 1000)` (a plain Double would not
//     compile against the real Phase 1 type).
//   - Two extra validateFact tests cover both branches of the validator
//     (length and file-existence), satisfying the "all methods tested"
//     constraint rather than only the over-length path.

import Testing
import Foundation
@testable import LlmIdeMac

@Suite("MemoryService")
struct MemoryServiceTests {
    private let service = MemoryServiceImpl()

    /// Per-test unique repo root under the system temp dir, cleaned up via
    /// `defer` in each test (structs can't have deinit).
    private func makeRepo() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("llm-ide-svc-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func removeRepo(_ url: URL) {
        try? FileManager.default.removeItem(at: url)
    }

    // MARK: - readMemory

    @Test("readMemory returns empty data for missing repo")
    func readMemoryReturnsEmpty() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let result = try await service.readMemory(repoRoot: repo)
        #expect(result.facts.isEmpty)
        #expect(result.bugs.isEmpty)
        #expect(result.qa.isEmpty)
    }

    // MARK: - readChatMemory

    @Test("readChatMemory returns empty array for missing file")
    func readChatMemoryReturnsEmpty() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let facts = try await service.readChatMemory(repoRoot: repo)
        #expect(facts.isEmpty)
    }

    // MARK: - writeChatMemory / readChatMemory round-trip

    @Test("writeChatMemory then readChatMemory round-trips")
    func writeAndReadChatMemory() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let facts = [
            ChatMemoryFact(
                text: "Test fact",
                category: .convention,
                timestamp: Int(Date().timeIntervalSince1970 * 1000),
                source: .agent
            )
        ]
        try await service.writeChatMemory(repoRoot: repo, facts: facts)
        let read = try await service.readChatMemory(repoRoot: repo)

        #expect(read.count == 1)
        #expect(read[0].text == "Test fact")
    }

    // MARK: - validateFact

    @Test("validateFact flags text over 280 chars")
    func validateFactChecksLength() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let longFact = ChatMemoryFact(
            text: String(repeating: "x", count: 281),
            category: .convention,
            timestamp: Int(Date().timeIntervalSince1970 * 1000),
            source: .agent
        )
        let result = try await service.validateFact(repoRoot: repo, fact: longFact)

        #expect(!result.valid)
        // `details` carries the per-check breakdown; search it for the substring.
        #expect(result.details?.contains(where: { $0.contains("280 characters") }) == true)
    }

    @Test("validateFact accepts a short fact with no file refs")
    func validateFactAcceptsShortFact() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let fact = ChatMemoryFact(
            text: "prefers composition over inheritance",
            category: .architecture,
            timestamp: Int(Date().timeIntervalSince1970 * 1000),
            source: .agent
        )
        let result = try await service.validateFact(repoRoot: repo, fact: fact)

        #expect(result.valid)
        // A valid fact has no failure details (nil) and no contradiction flag.
        #expect(result.details == nil)
        #expect(result.contradicts == false)
    }

    @Test("validateFact flags a missing referenced file")
    func validateFactFlagsMissingFile() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let fact = ChatMemoryFact(
            text: "see missing doc",
            timestamp: Int(Date().timeIntervalSince1970 * 1000),
            metadata: FactMetadata(files: ["does/not/exist.md"])
        )
        let result = try await service.validateFact(repoRoot: repo, fact: fact)

        #expect(!result.valid)
        #expect(result.details?.contains(where: { $0.contains("does/not/exist.md") }) == true)
    }

    // MARK: - updateRepoMD

    @Test("updateRepoMD writes content that round-trips via storage")
    func updateRepoMDWrites() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        try await service.updateRepoMD(repoRoot: repo, content: "# Test\n\nNew content")

        let storage = MemoryStorage()
        let read = try? await storage.readMemoryFile(repoRoot: repo, filename: "repo.md")
        #expect(read?.contains("New content") == true)
    }
}
