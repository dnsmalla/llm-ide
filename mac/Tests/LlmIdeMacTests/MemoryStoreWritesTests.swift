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

    private func sampleFault() -> FaultReport {
        FaultReport(
            prompt: "explain auth", response: "answer", notes: "wrong",
            severity: .major, reportedAt: Date(timeIntervalSince1970: 1_716_465_600),
            gitHead: "abc123", appVersion: "0.1.0", agent: "claude_code",
            status: .open, tags: ["auth"]
        )
    }

    @Test func writeFaultCreatesFaultsDirAndFile() throws {
        let repo = try tmpRepoDir()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        let url = try store.writeFault(at: repo, sampleFault())

        let faultsDir = repo.appendingPathComponent("system/faults/faults")
        #expect(FileManager.default.fileExists(atPath: faultsDir.path))
        #expect(FileManager.default.fileExists(atPath: url.path))
        #expect(url.lastPathComponent.hasSuffix(".md"))
    }

    @Test func loadFaultReturnsRoundTrippedReport() throws {
        let repo = try tmpRepoDir()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        let written = sampleFault()
        let url = try store.writeFault(at: repo, written)

        let loaded = try store.loadFault(at: url)
        #expect(loaded.prompt == written.prompt)
        #expect(loaded.status == .open)
    }

    @Test func updateFaultStatusFlipsFieldAndPersists() throws {
        let repo = try tmpRepoDir()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        let url = try store.writeFault(at: repo, sampleFault())

        try store.updateFaultStatus(at: url, to: .fixed)
        let loaded = try store.loadFault(at: url)
        #expect(loaded.status == .fixed)
    }

    @Test func listFaultsSurfacesNewFile() throws {
        let repo = try tmpRepoDir()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        #expect(store.listFaults(at: repo).isEmpty)
        _ = try store.writeFault(at: repo, sampleFault())
        #expect(store.listFaults(at: repo).count == 1)
    }
}
