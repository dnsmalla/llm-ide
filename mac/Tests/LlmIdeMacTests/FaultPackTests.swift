import Testing
import Foundation
@testable import LlmIdeMac

struct FaultPackTests {
    private func tmpRepo() throws -> URL {
        let u = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("pack-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }
    private func fault(_ prompt: String, verify: String?) -> FaultReport {
        FaultReport(prompt: prompt, response: "r", notes: "n", severity: .minor,
                    reportedAt: Date(timeIntervalSince1970: 1_716_465_600), gitHead: "deadbeef",
                    appVersion: "9.9", agent: "claude_code", status: .fixed, tags: ["t"],
                    verify: verify, verifyKind: verify == nil ? nil : .command)
    }

    @Test func exportStripsHostSpecificFields() throws {
        let svc = FaultPackService(store: MemoryStore())
        let data = try svc.export(faults: [fault("q1", verify: "make test")], sourceProject: "proj-a",
                                  exportedAt: Date(timeIntervalSince1970: 1_716_500_000))
        let json = String(data: data, encoding: .utf8) ?? ""
        #expect(json.contains("q1"))
        #expect(!json.contains("make test"))   // verify command stripped
        #expect(!json.contains("deadbeef"))    // git_head stripped
    }

    @Test func importWritesOpenFaultsAndDedupes() throws {
        let store = MemoryStore()
        let svc = FaultPackService(store: store)
        let repo = try tmpRepo(); defer { try? FileManager.default.removeItem(at: repo) }
        let data = try svc.export(faults: [fault("dup", verify: nil)], sourceProject: "src",
                                  exportedAt: Date(timeIntervalSince1970: 1_716_500_000))

        let s1 = try svc.importPack(data: data, into: repo)
        #expect(s1.imported == 1)
        let loaded = try store.loadFault(at: store.listFaults(at: repo)[0])
        #expect(loaded.status == .open)
        #expect(loaded.verify == nil)
        #expect(loaded.tags.contains("imported:src"))

        let s2 = try svc.importPack(data: data, into: repo)   // re-import is idempotent
        #expect(s2.imported == 0)
        #expect(s2.skipped == 1)
    }
}
