import Testing
import Foundation
@testable import LlmIdeMac

struct MemoryStoreFaultSnapshotTests {
    private func tmpRepo() throws -> URL {
        let u = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("snap-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }
    private func write(_ store: MemoryStore, at repo: URL, prompt: String,
                       status: FaultStatus, reportedAt: Date) throws -> URL {
        try store.writeFault(at: repo, FaultReport(
            prompt: prompt, response: "r", notes: "", severity: .minor,
            reportedAt: reportedAt, gitHead: nil, appVersion: "0.1",
            agent: "claude_code", status: status, tags: []))
    }

    @Test func snapshotListsUrlsAndDecodesStatuses() throws {
        let repo = try tmpRepo(); defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        let openURL = try write(store, at: repo, prompt: "open-q", status: .open,
                                reportedAt: Date(timeIntervalSince1970: 1_716_000_000))
        let fixedURL = try write(store, at: repo, prompt: "fixed-q", status: .fixed,
                                 reportedAt: Date(timeIntervalSince1970: 1_716_100_000))

        let snap = store.faultStatusSnapshot(at: repo)
        #expect(snap.urls.count == 2)
        // Match by filename — /tmp vs /private/tmp symlink prefixes mean raw
        // URL keys differ from the writeFault-returned URLs (production keys
        // via standardizedFileURL.path for the same reason).
        let byName = Dictionary(uniqueKeysWithValues: snap.statuses.map { ($0.key.lastPathComponent, $0.value) })
        #expect(byName[openURL.lastPathComponent] == .open)
        #expect(byName[fixedURL.lastPathComponent] == .fixed)
    }

    @Test func openCountReflectsOnlyOpenFaults() throws {
        let repo = try tmpRepo(); defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        _ = try write(store, at: repo, prompt: "a", status: .open,
                      reportedAt: Date(timeIntervalSince1970: 1_716_000_000))
        _ = try write(store, at: repo, prompt: "b", status: .open,
                      reportedAt: Date(timeIntervalSince1970: 1_716_100_000))
        _ = try write(store, at: repo, prompt: "c", status: .fixed,
                      reportedAt: Date(timeIntervalSince1970: 1_716_200_000))

        #expect(store.faultStatusSnapshot(at: repo).openCount == 2)
    }

    @Test func emptyRepoYieldsEmptySnapshot() throws {
        let repo = try tmpRepo(); defer { try? FileManager.default.removeItem(at: repo) }
        let snap = MemoryStore().faultStatusSnapshot(at: repo)
        #expect(snap.urls.isEmpty)
        #expect(snap.openCount == 0)
    }
}
