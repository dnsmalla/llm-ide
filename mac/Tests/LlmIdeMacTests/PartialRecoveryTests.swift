import Testing
@testable import LlmIdeMac
import Foundation

final class PartialRecoveryTests {

    let tempRoot: URL

    init() throws {
        tempRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("rec-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
    }

    deinit {
        try? FileManager.default.removeItem(at: tempRoot)
    }

    @Test func writeAndScanOrphans() throws {
        let rec = PartialRecovery(root: tempRoot)
        try rec.record(id: "01HABC",
                       path: tempRoot.appendingPathComponent("2026/05/x.partial.md"),
                       pid: 99999, startedAt: Date())
        let orphans = try rec.scanOrphans()
        #expect(orphans.map(\.id) == ["01HABC"])
    }

    @Test func cleanupRemovesRecord() throws {
        let rec = PartialRecovery(root: tempRoot)
        try rec.record(id: "01HABC",
                       path: tempRoot.appendingPathComponent("x.partial.md"),
                       pid: 99999, startedAt: Date())
        try rec.cleanup(id: "01HABC")
        #expect(try rec.scanOrphans().count == 0)
    }
}
