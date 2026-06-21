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

    /// Builds a project skeleton (`system/project.json` marker + `source/`)
    /// and returns its layout.
    private func makeProject() throws -> ProjectLayout {
        let layout = ProjectLayout(root: tempRoot.appendingPathComponent("Proj"))
        try FileManager.default.createDirectory(at: layout.systemDir, withIntermediateDirectories: true)
        try Data("{}".utf8).write(to: layout.projectJSON)
        try FileManager.default.createDirectory(at: layout.sourceDir, withIntermediateDirectories: true)
        return layout
    }

    @Test func writeAndScanOrphans() throws {
        let rec = PartialRecovery(notesFolder: tempRoot)
        try rec.record(id: "01HABC",
                       path: tempRoot.appendingPathComponent("2026/05/x.partial.md"),
                       pid: 99999, startedAt: Date())
        let orphans = try rec.scanOrphans()
        #expect(orphans.map(\.id) == ["01HABC"])
    }

    @Test func cleanupRemovesRecord() throws {
        let rec = PartialRecovery(notesFolder: tempRoot)
        try rec.record(id: "01HABC",
                       path: tempRoot.appendingPathComponent("x.partial.md"),
                       pid: 99999, startedAt: Date())
        try rec.cleanup(id: "01HABC")
        #expect(try rec.scanOrphans().count == 0)
    }

    /// When the notes folder is a project's `source/` dir, recovery records
    /// live under the project's `system/` tree — never as a stray `.llmide`.
    @Test func recordsLiveUnderProjectSystemDir() throws {
        let layout = try makeProject()
        let rec = PartialRecovery(notesFolder: layout.sourceDir)
        try rec.record(id: "01HABC",
                       path: layout.sourceDir.appendingPathComponent("x.partial.md"),
                       pid: 99999, startedAt: Date())

        let expected = layout.cacheDir
            .appendingPathComponent("recovery", isDirectory: true)
            .appendingPathComponent("01HABC.json")
        #expect(FileManager.default.fileExists(atPath: expected.path))
        #expect(!FileManager.default.fileExists(
            atPath: layout.sourceDir.appendingPathComponent(".llmide").path))
        #expect(try rec.scanOrphans().map(\.id) == ["01HABC"])
    }
}
