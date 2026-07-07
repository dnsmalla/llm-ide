// Tests for Migration — Swift mirror of the Task 5 TS suite
// (`extension/tests/storage/migrate.test.ts`).
//
// Uses swift-testing (the repo's preferred framework: 84 swift-testing files
// vs 10 XCTest), flat in Tests/LlmIdeMacTests/ to match the existing test
// layout (no test subdirectories exist today; see GraphStorageTests.swift /
// MemoryStorageTests.swift for the same convention).

import Testing
import Foundation
@testable import LlmIdeMac

@Suite("Migration")
struct MigrationTests {
    let migration = Migration()

    /// Per-test unique repo root under the system temp dir, cleaned up after.
    /// Matches the makeRepo/removeRepo helpers in GraphStorageTests.
    private func makeRepo() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("llm-ide-migrate-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func removeRepo(_ url: URL) {
        try? FileManager.default.removeItem(at: url)
    }

    // MARK: - needsMigration

    @Test func needsMigrationReturnsFalseForFreshRepo() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let needed = await migration.needsMigration(repoRoot: repo)

        #expect(needed == false)
    }

    @Test func needsMigrationReturnsTrueForLegacyMemory() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let legacy = repo.appendingPathComponent("graphify-out").appendingPathComponent("memory")
        try FileManager.default.createDirectory(at: legacy, withIntermediateDirectories: true)

        let needed = await migration.needsMigration(repoRoot: repo)

        #expect(needed == true)
    }

    @Test func needsMigrationReturnsTrueForLegacyGraph() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let legacy = repo.appendingPathComponent("system").appendingPathComponent("graph")
        try FileManager.default.createDirectory(at: legacy, withIntermediateDirectories: true)

        let needed = await migration.needsMigration(repoRoot: repo)

        #expect(needed == true)
    }

    // MARK: - migrateToLLMIdeStructure: fresh repo / no-op

    @Test func migrateOnFreshRepoSkipsBothLegacyPaths() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let result = await migration.migrateToLLMIdeStructure(repoRoot: repo)

        #expect(result.migrated.isEmpty)
        #expect(result.errors.isEmpty)
        #expect(result.skipped.count == 2)
        let reasons = result.skipped.map(\.reason)
        #expect(reasons == ["not_found", "not_found"])
        let skippedPaths = result.skipped.map(\.path.path)
        #expect(skippedPaths.contains(where: { $0.hasSuffix("graphify-out/memory") }))
        #expect(skippedPaths.contains(where: { $0.hasSuffix("system/graph") }))
    }

    // MARK: - migrateToLLMIdeStructure: memory migration

    @Test func migrateMovesLegacyMemoryIntoCanonicalDir() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let legacy = repo.appendingPathComponent("graphify-out").appendingPathComponent("memory")
        try FileManager.default.createDirectory(at: legacy, withIntermediateDirectories: true)
        try "content".write(
            to: legacy.appendingPathComponent("repo.md"), atomically: true, encoding: .utf8)
        try "facts".write(
            to: legacy.appendingPathComponent("chat-memory.md"), atomically: true, encoding: .utf8)

        let result = await migration.migrateToLLMIdeStructure(repoRoot: repo)

        #expect(result.migrated.count == 1)
        #expect(result.errors.isEmpty)

        // Files now live under .llm-ide/memory with their contents preserved.
        let canonical = repo.appendingPathComponent(".llm-ide").appendingPathComponent("memory")
        let repoMD = try String(contentsOf: canonical.appendingPathComponent("repo.md"), encoding: .utf8)
        let chat = try String(contentsOf: canonical.appendingPathComponent("chat-memory.md"), encoding: .utf8)
        #expect(repoMD == "content")
        #expect(chat == "facts")
    }

    @Test func migrateRemovesEmptyLegacyMemoryLeaf() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let legacy = repo.appendingPathComponent("graphify-out").appendingPathComponent("memory")
        try FileManager.default.createDirectory(at: legacy, withIntermediateDirectories: true)
        try "x".write(to: legacy.appendingPathComponent("a.md"), atomically: true, encoding: .utf8)

        _ = await migration.migrateToLLMIdeStructure(repoRoot: repo)

        // After moving the only entry, the legacy leaf is removed (mirrors fs.rmdir).
        #expect(!FileManager.default.fileExists(atPath: legacy.path))
    }

    // MARK: - migrateToLLMIdeStructure: graph migration

    @Test func migrateMovesLegacyGraphIntoCanonicalDir() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let legacy = repo.appendingPathComponent("system").appendingPathComponent("graph")
        try FileManager.default.createDirectory(at: legacy, withIntermediateDirectories: true)
        let graphJSON = #"{"nodes":[],"edges":[]}"#
        try graphJSON.write(
            to: legacy.appendingPathComponent("graph.json"), atomically: true, encoding: .utf8)

        let result = await migration.migrateToLLMIdeStructure(repoRoot: repo)

        #expect(result.migrated.count == 1)
        #expect(result.errors.isEmpty)

        let canonical = repo.appendingPathComponent(".llm-ide").appendingPathComponent("graph")
        let read = try String(contentsOf: canonical.appendingPathComponent("graph.json"), encoding: .utf8)
        #expect(read == graphJSON)
    }

    // MARK: - migrateToLLMIdeStructure: both legacy paths at once

    @Test func migrateMovesBothLegacyDirsWhenBothPresent() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let legacyMem = repo.appendingPathComponent("graphify-out").appendingPathComponent("memory")
        try FileManager.default.createDirectory(at: legacyMem, withIntermediateDirectories: true)
        try "m".write(to: legacyMem.appendingPathComponent("repo.md"), atomically: true, encoding: .utf8)

        let legacyGraph = repo.appendingPathComponent("system").appendingPathComponent("graph")
        try FileManager.default.createDirectory(at: legacyGraph, withIntermediateDirectories: true)
        try "g".write(to: legacyGraph.appendingPathComponent("graph.json"), atomically: true, encoding: .utf8)

        let result = await migration.migrateToLLMIdeStructure(repoRoot: repo)

        #expect(result.migrated.count == 2)
        #expect(result.skipped.isEmpty)
        #expect(result.errors.isEmpty)
        let toSuffixes = result.migrated.map { $0.to.path }
        #expect(toSuffixes.contains(where: { $0.hasSuffix(".llm-ide/memory") }))
        #expect(toSuffixes.contains(where: { $0.hasSuffix(".llm-ide/graph") }))
    }

    // MARK: - migrateToLLMIdeStructure: only one legacy path present

    @Test func migrateMigratesOneSkipsOneWhenOnlyMemoryPresent() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let legacyMem = repo.appendingPathComponent("graphify-out").appendingPathComponent("memory")
        try FileManager.default.createDirectory(at: legacyMem, withIntermediateDirectories: true)
        try "m".write(to: legacyMem.appendingPathComponent("repo.md"), atomically: true, encoding: .utf8)

        let result = await migration.migrateToLLMIdeStructure(repoRoot: repo)

        #expect(result.migrated.count == 1)
        #expect(result.skipped.count == 1)
        #expect(result.errors.isEmpty)
        #expect(result.skipped[0].reason == "not_found")
    }

    // MARK: - idempotency

    @Test func migrateIsIdempotent() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let legacy = repo.appendingPathComponent("graphify-out").appendingPathComponent("memory")
        try FileManager.default.createDirectory(at: legacy, withIntermediateDirectories: true)
        try "content".write(to: legacy.appendingPathComponent("repo.md"), atomically: true, encoding: .utf8)

        let first = await migration.migrateToLLMIdeStructure(repoRoot: repo)
        #expect(first.migrated.count == 1)

        // Second run: legacy dir is gone, so it's skipped. Canonical dir is
        // untouched (no overwrite, no duplication, no error).
        let second = await migration.migrateToLLMIdeStructure(repoRoot: repo)
        #expect(second.migrated.isEmpty)
        #expect(second.errors.isEmpty)
        #expect(second.skipped.count == 2)

        let canonical = repo.appendingPathComponent(".llm-ide").appendingPathComponent("memory")
        let repoMD = try String(contentsOf: canonical.appendingPathComponent("repo.md"), encoding: .utf8)
        #expect(repoMD == "content")
    }

    // MARK: - preserves subdirectories, not just files

    @Test func migrateMovesSubdirectoriesToo() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        let legacy = repo.appendingPathComponent("graphify-out").appendingPathComponent("memory")
        let nested = legacy.appendingPathComponent("archive")
        try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)
        try "deep".write(to: nested.appendingPathComponent("old.md"), atomically: true, encoding: .utf8)

        let result = await migration.migrateToLLMIdeStructure(repoRoot: repo)

        #expect(result.migrated.count == 1)
        let canonical = repo.appendingPathComponent(".llm-ide").appendingPathComponent("memory")
        let read = try String(
            contentsOf: canonical.appendingPathComponent("archive").appendingPathComponent("old.md"),
            encoding: .utf8)
        #expect(read == "deep")
    }

    // MARK: - repo root with spaces (parity with the TS + sibling storage tests)

    @Test func migrateHandlesRepoRootWithSpaces() async throws {
        let repo = FileManager.default.temporaryDirectory
            .appendingPathComponent("llm-ide migrate spaces \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        defer { removeRepo(repo) }

        let legacy = repo.appendingPathComponent("system").appendingPathComponent("graph")
        try FileManager.default.createDirectory(at: legacy, withIntermediateDirectories: true)
        try "{}".write(to: legacy.appendingPathComponent("graph.json"), atomically: true, encoding: .utf8)

        let needed = await migration.needsMigration(repoRoot: repo)
        #expect(needed == true)

        let result = await migration.migrateToLLMIdeStructure(repoRoot: repo)
        #expect(result.migrated.count == 1)
        #expect(result.errors.isEmpty)

        let canonical = repo.appendingPathComponent(".llm-ide").appendingPathComponent("graph")
        #expect(canonical.path.contains("/.llm-ide/graph"))
        #expect(FileManager.default.fileExists(
            atPath: canonical.appendingPathComponent("graph.json").path))
    }

    // MARK: - overwrites a same-named destination entry (fs.rename parity)

    @Test func migrateOverwritesSameNamedDestination() async throws {
        let repo = try makeRepo()
        defer { removeRepo(repo) }

        // Legacy has a repo.md; the canonical dir already has a DIFFERENT
        // repo.md (e.g. user started using the new layout, then ran migrate).
        let legacy = repo.appendingPathComponent("graphify-out").appendingPathComponent("memory")
        try FileManager.default.createDirectory(at: legacy, withIntermediateDirectories: true)
        try "legacy".write(to: legacy.appendingPathComponent("repo.md"), atomically: true, encoding: .utf8)

        let canonical = repo.appendingPathComponent(".llm-ide").appendingPathComponent("memory")
        try FileManager.default.createDirectory(at: canonical, withIntermediateDirectories: true)
        try "canonical".write(to: canonical.appendingPathComponent("repo.md"), atomically: true, encoding: .utf8)

        let result = await migration.migrateToLLMIdeStructure(repoRoot: repo)

        #expect(result.migrated.count == 1)
        #expect(result.errors.isEmpty)
        // fs.rename clobbers; the legacy content wins after migration.
        let read = try String(contentsOf: canonical.appendingPathComponent("repo.md"), encoding: .utf8)
        #expect(read == "legacy")
    }
}
