// Tests for MemoryStorage — Swift mirror of the Task 3 TS suite.
//
// Uses swift-testing (the repo's preferred framework: 84 swift-testing files
// vs 10 XCTest). Test file is flat in Tests/LlmIdeMacTests/ to match the
// existing test layout (no test subdirectories exist today).

import Testing
import Foundation
@testable import LlmIdeMac

@Suite("MemoryStorage")
struct MemoryStorageTests {
    let storage = MemoryStorage()

    /// Per-test unique repo root under the system temp dir, cleaned up after.
    /// Using a struct with @Suite + deinit isn't supported, so each @Test
    /// creates its own throwaway repo root via this helper.
    private func makeRepo() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("llm-ide-mem-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func removeRepo(_ url: URL) {
        try? FileManager.default.removeItem(at: url)
    }

    // MARK: - getMemoryDir

    @Test func getMemoryDirReturnsCanonicalPath() throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let result = storage.getMemoryDir(repoRoot: repo)
        let expected = repo
            .appendingPathComponent(".llm-ide")
            .appendingPathComponent("memory")

        #expect(result == expected)
        #expect(result.path == "\(repo.path)/.llm-ide/memory")
    }

    // MARK: - write + read round-trip

    @Test func writeThenReadRoundTripsContent() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        try await storage.writeMemoryFile(repoRoot: repo, filename: "test.md", content: "hello world")
        let read = try await storage.readMemoryFile(repoRoot: repo, filename: "test.md")
        #expect(read == "hello world")
    }

    @Test func writeCreatesMemoryDirectoryIfMissing() async throws {
        // Fresh repo: .llm-ide/memory does not exist yet.
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        try await storage.writeMemoryFile(repoRoot: repo, filename: "test.md", content: "x")

        let memDir = storage.getMemoryDir(repoRoot: repo)
        #expect(FileManager.default.fileExists(atPath: memDir.path))
        #expect(try String(contentsOf: memDir.appendingPathComponent("test.md"), encoding: .utf8) == "x")
    }

    @Test func writeOverwritesExistingFileAtomically() async throws {
        // The TS layer's fs.rename overwrites; Swift's moveItem does not, so
        // the impl uses replaceItem for the overwrite path. Verify it.
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        try await storage.writeMemoryFile(repoRoot: repo, filename: "test.md", content: "first")
        try await storage.writeMemoryFile(repoRoot: repo, filename: "test.md", content: "second")

        let read = try await storage.readMemoryFile(repoRoot: repo, filename: "test.md")
        #expect(read == "second")
    }

    @Test func writePreservesMultilineAndUnicodeContent() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }
        let content = "line1\nline2\némojî: 🚀\n\tindented\n"
        try await storage.writeMemoryFile(repoRoot: repo, filename: "test.md", content: content)
        #expect(try await storage.readMemoryFile(repoRoot: repo, filename: "test.md") == content)
    }

    @Test func writeLeavesNoTempFilesBehind() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        try await storage.writeMemoryFile(repoRoot: repo, filename: "test.md", content: "a")
        try await storage.writeMemoryFile(repoRoot: repo, filename: "test.md", content: "b")

        let memDir = storage.getMemoryDir(repoRoot: repo)
        let entries = (try FileManager.default.contentsOfDirectory(atPath: memDir.path))
        let temps = entries.filter { $0.contains(".tmp.") }
        #expect(temps.isEmpty, "leftover temp files: \(temps)")
    }

    // MARK: - read error mapping

    @Test func readMissingFileThrowsNotFound() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        await #expect(throws: MemoryStorageError.self) {
            _ = try await storage.readMemoryFile(repoRoot: repo, filename: "missing.md")
        }
        // Verify it's specifically the notFound case (and carries the path).
        do {
            _ = try await storage.readMemoryFile(repoRoot: repo, filename: "missing.md")
            Issue.record("expected notFound")
        } catch let MemoryStorageError.notFound(path) {
            #expect(path.contains("missing.md"))
        } catch {
            Issue.record("wrong error: \(error)")
        }
    }

    @Test func readMissingFileHasNotFoundCode() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }
        do {
            _ = try await storage.readMemoryFile(repoRoot: repo, filename: "x.md")
            Issue.record("expected throw")
        } catch let err as MemoryStorageError {
            #expect(err.code == "NOT_FOUND")
        } catch {
            Issue.record("wrong error: \(error)")
        }
    }

    // MARK: - readRepoMD graceful degradation

    @Test func readRepoMDEmptyStringWhenMissing() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }
        let result = try await storage.readRepoMD(repoRoot: repo)
        #expect(result == "")
    }

    @Test func readRepoMDReturnsContentWhenPresent() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }
        try await storage.writeMemoryFile(repoRoot: repo, filename: "repo.md", content: "# Facts\n- uses Swift\n")
        let result = try await storage.readRepoMD(repoRoot: repo)
        #expect(result == "# Facts\n- uses Swift\n")
    }

    // MARK: - chat-memory round-trip (the [ChatMemoryFact] contract)

    @Test func writeChatMemoryProducesExactHeaderAndBullets() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let facts = [
            ChatMemoryFact(text: "uses Swift 6", timestamp: 1_700_000_000_000),
            ChatMemoryFact(text: "tests via swift-testing", timestamp: 1_700_000_000_001),
        ]
        try await storage.writeChatMemory(repoRoot: repo, facts: facts)

        let raw = try await storage.readMemoryFile(repoRoot: repo, filename: "chat-memory.md")
        // Byte-exact match of the TS header + body.
        let expected = """
            # Chat memory
            _Auto-captured by the Code Assistant from prior chats about this project._
            _Recalled automatically next session. View or clear these in the app._

            - uses Swift 6
            - tests via swift-testing
            """ + "\n"
        #expect(raw == expected)
    }

    @Test func writeChatMemoryEmptyFactsWritesHeaderOnly() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }
        try await storage.writeChatMemory(repoRoot: repo, facts: [])

        let raw = try await storage.readMemoryFile(repoRoot: repo, filename: "chat-memory.md")
        // header + "" + "\n"
        #expect(raw.hasPrefix("# Chat memory\n"))
        #expect(raw.hasSuffix("_Recalled automatically next session. View or clear these in the app._\n\n\n"))
    }

    @Test func readChatMemoryEmptyWhenFileMissing() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }
        let result = try await storage.readChatMemory(repoRoot: repo)
        #expect(result.isEmpty)
    }

    @Test func readChatMemoryParsesBulletsAndSkipsHeader() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        // Write a chat-memory.md that includes the standard header plus some
        // non-bullet lines; only "- " lines should parse to facts.
        let content = """
            # Chat memory
            _Auto-captured..._

            - prefers composition over inheritance
            - ships on Tuesdays
            not a fact
            - also uses graph-kit
            """
        try await storage.writeMemoryFile(repoRoot: repo, filename: "chat-memory.md", content: content)

        let facts = try await storage.readChatMemory(repoRoot: repo)
        #expect(facts.count == 3)
        #expect(facts[0].text == "prefers composition over inheritance")
        #expect(facts[1].text == "ships on Tuesdays")
        #expect(facts[2].text == "also uses graph-kit")
        // MVP parser tags every parsed fact as convention/agent (TS parity).
        for fact in facts {
            #expect(fact.category == .convention)
            #expect(fact.source == .agent)
            #expect(fact.timestamp > 0)
        }
    }

    @Test func chatMemoryWriteThenReadRoundTripsText() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let original = [
            ChatMemoryFact(text: "fact one", timestamp: 1),
            ChatMemoryFact(text: "fact two", timestamp: 2),
        ]
        try await storage.writeChatMemory(repoRoot: repo, facts: original)
        let read = try await storage.readChatMemory(repoRoot: repo)
        #expect(read.map(\.text) == ["fact one", "fact two"])
    }

    // MARK: - repo root with spaces (parity with TS spaces test)

    @Test func repoRootWithSpacesResolvesCorrectly() async throws {
        let repo = FileManager.default.temporaryDirectory
            .appendingPathComponent("llm-ide with spaces \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        defer { removeRepo(repo) }

        try await storage.writeMemoryFile(repoRoot: repo, filename: "repo.md", content: "spacy")
        let memDir = storage.getMemoryDir(repoRoot: repo)
        #expect(memDir.path.contains("/.llm-ide/memory"))
        #expect(try await storage.readRepoMD(repoRoot: repo) == "spacy")
    }

    // MARK: - error type shape

    @Test func errorCodeStringsMatchTSContract() {
        #expect(MemoryStorageError.notFound(path: "x").code == "NOT_FOUND")
        #expect(MemoryStorageError.permissionDenied(path: "x").code == "PERMISSION_DENIED")
        #expect(MemoryStorageError.corrupted(path: "x", underlyingDescription: "boom").code == "CORRUPTED")
        #expect(MemoryStorageError.migrationFailed(path: "x", reason: "r").code == "MIGRATION_FAILED")
    }

    @Test func errorHasLocalizedDescription() {
        let err = MemoryStorageError.notFound(path: "/a/b.md")
        #expect(err.errorDescription?.contains("/a/b.md") == true)
    }
}
