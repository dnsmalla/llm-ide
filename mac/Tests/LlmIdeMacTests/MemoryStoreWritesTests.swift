import Testing
import Foundation
@testable import LlmIdeMac

struct MemoryStoreWritesTests {
    private func tmpRepoDir() throws -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("memory-writes-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func sampleBug() -> BugReport {
        BugReport(
            prompt: "explain auth", response: "answer", notes: "wrong",
            severity: .major, reportedAt: Date(timeIntervalSince1970: 1_716_465_600),
            gitHead: "abc123", appVersion: "0.1.0", agent: "claude_code",
            status: .open, tags: ["auth"]
        )
    }

    @Test func writeBugCreatesBugsDirAndFile() throws {
        let repo = try tmpRepoDir()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        let url = try store.writeBug(at: repo, sampleBug())

        let bugsDir = repo.appendingPathComponent(".understand-anything/memory/bugs")
        #expect(FileManager.default.fileExists(atPath: bugsDir.path))
        #expect(FileManager.default.fileExists(atPath: url.path))
        #expect(url.lastPathComponent.hasSuffix(".md"))
    }

    @Test func loadBugReturnsRoundTrippedReport() throws {
        let repo = try tmpRepoDir()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        let written = sampleBug()
        let url = try store.writeBug(at: repo, written)

        let loaded = try store.loadBug(at: url)
        #expect(loaded.prompt == written.prompt)
        #expect(loaded.status == .open)
    }

    @Test func updateBugStatusFlipsFieldAndPersists() throws {
        let repo = try tmpRepoDir()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        let url = try store.writeBug(at: repo, sampleBug())

        try store.updateBugStatus(at: url, to: .fixed)
        let loaded = try store.loadBug(at: url)
        #expect(loaded.status == .fixed)
    }

    @Test func listBugsSurfacesNewFile() throws {
        let repo = try tmpRepoDir()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        #expect(store.listBugs(at: repo).isEmpty)
        _ = try store.writeBug(at: repo, sampleBug())
        #expect(store.listBugs(at: repo).count == 1)
    }
}
