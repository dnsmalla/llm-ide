import Testing
import Foundation
@testable import LlmIdeMac

struct MemoryStoreTests {
    /// Helper — create a unique tmp dir scoped to this test method.
    private func tmpRepoDir() throws -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("memory-store-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    @Test func seedIfMissingCreatesDirAndRepoTemplate() throws {
        let repo = try tmpRepoDir()
        defer { try? FileManager.default.removeItem(at: repo) }

        let store = MemoryStore()
        try store.seedIfMissing(in: repo)

        let memoryDir = repo.appendingPathComponent(".understand-anything/memory")
        let repoMd = memoryDir.appendingPathComponent("repo.md")
        #expect(FileManager.default.fileExists(atPath: memoryDir.path))
        #expect(FileManager.default.fileExists(atPath: repoMd.path))

        let contents = try String(contentsOf: repoMd, encoding: .utf8)
        #expect(contents.contains("# Project facts"))
    }

    @Test func seedIsIdempotent() throws {
        let repo = try tmpRepoDir()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()

        try store.seedIfMissing(in: repo)
        let repoMd = repo.appendingPathComponent(".understand-anything/memory/repo.md")
        try "user-edited content".write(to: repoMd, atomically: true, encoding: .utf8)

        // Second seed must not clobber existing content.
        try store.seedIfMissing(in: repo)
        let after = try String(contentsOf: repoMd, encoding: .utf8)
        #expect(after == "user-edited content")
    }

    @Test func repoMdAbsentBeforeSeed() throws {
        let repo = try tmpRepoDir()
        defer { try? FileManager.default.removeItem(at: repo) }
        let repoMd = repo.appendingPathComponent(".understand-anything/memory/repo.md")
        #expect(!FileManager.default.fileExists(atPath: repoMd.path))
    }

    @Test func seedCreatesRepoMdWithProjectFacts() throws {
        let repo = try tmpRepoDir()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        try store.seedIfMissing(in: repo)
        let repoMd = repo.appendingPathComponent(".understand-anything/memory/repo.md")
        #expect(FileManager.default.fileExists(atPath: repoMd.path))
        let contents = try String(contentsOf: repoMd, encoding: .utf8)
        #expect(contents.contains("# Project facts"))
    }

    @Test func listBugsAndQAReturnEmptyWhenAbsent() throws {
        let repo = try tmpRepoDir()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        #expect(store.listBugs(at: repo).isEmpty)
        #expect(store.listQA(at: repo).isEmpty)
    }

    @Test func listBugsAndQAReturnMarkdownFilesSorted() throws {
        let repo = try tmpRepoDir()
        defer { try? FileManager.default.removeItem(at: repo) }
        let bugs = repo.appendingPathComponent(".understand-anything/memory/bugs", isDirectory: true)
        let qa   = repo.appendingPathComponent(".understand-anything/memory/q&a", isDirectory: true)
        try FileManager.default.createDirectory(at: bugs, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: qa,   withIntermediateDirectories: true)
        try "b".write(to: bugs.appendingPathComponent("2026-05-23-flow.md"), atomically: true, encoding: .utf8)
        try "b".write(to: bugs.appendingPathComponent("2026-05-22-auth.md"), atomically: true, encoding: .utf8)
        try "q".write(to: qa.appendingPathComponent("deploy.md"), atomically: true, encoding: .utf8)
        try "ignored".write(to: bugs.appendingPathComponent("not-markdown.txt"), atomically: true, encoding: .utf8)

        let store = MemoryStore()
        let listedBugs = store.listBugs(at: repo).map { $0.lastPathComponent }
        let listedQA = store.listQA(at: repo).map { $0.lastPathComponent }
        #expect(listedBugs == ["2026-05-22-auth.md", "2026-05-23-flow.md"])   // sorted ascending by file name
        #expect(listedQA == ["deploy.md"])
    }
}
