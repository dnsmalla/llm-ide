import Foundation
import Testing
@testable import LlmIdeMacLib

/// Parity between the Swift project-folder scan and the Node server's scan
/// (docs-kit K1b). Both sides build the same project from the K1a fixtures
/// (`LAYOUT` in `scripts/docs-kit-parity-golden.mjs`), and must agree on every
/// template and command. The golden file is written by that script from the
/// server's own scan, and this test decodes it through the Mac's response types,
/// so it checks what the server answers, not a Swift copy of it.
///
/// One documented difference, kept by design: a symlinked template folder is
/// listed by Swift and skipped by the server. `symlinkedFolderStaysLocal` pins
/// the Swift side. `ServerDocFilesTests` pins the merge.
@MainActor
@Suite("Doc Gen server store parity")
struct DocGenServerStoreParityTests {

    /// Mirrors `LAYOUT` in `scripts/docs-kit-parity-golden.mjs`. Keep the two in step.
    static let layout: [(path: String, fixture: String)] = [
        ("templates/v0-bare/template.md", "template-md.v0-bare-marker.md"),
        ("templates/v2-visual/template.md", "template-md.v2-visual-marker.md"),
        ("templates/auto_task/template.md", "template-md.v0-bare-marker.md"),
        ("commands/v0-bare/command.md", "command-md.v0-bare-marker.md"),
    ]

    /// The golden the Node script writes: the server's response bodies for the layout.
    struct ServerScanGolden: Decodable {
        let templates: LlmIdeAPIClient.DocTemplatesPage
        let commands: LlmIdeAPIClient.DocCommandsPage
    }

    static func fixturesDir() -> URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("Fixtures/docgen", isDirectory: true)
    }

    static func goldenData() throws -> Data {
        try Data(contentsOf: fixturesDir().appendingPathComponent("server-scan.golden.json"))
    }

    /// A temp project with the layout copied in from the K1a fixtures.
    static func buildProject() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("docgen-parity-\(UUID().uuidString.lowercased())", isDirectory: true)
        let fm = FileManager.default
        try fm.createDirectory(at: root.appendingPathComponent("system"), withIntermediateDirectories: true)
        try Data((#"{"schemaVersion":1,"id":"golden"}"# + "\n").utf8)
            .write(to: root.appendingPathComponent("system/project.json"))
        let project = fixturesDir().appendingPathComponent("project", isDirectory: true)
        for entry in layout {
            let dest = root.appendingPathComponent(entry.path)
            try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
            try fm.copyItem(at: project.appendingPathComponent(entry.fixture), to: dest)
        }
        return root
    }

    @Test func localTemplateScanMatchesTheServerGolden() throws {
        let root = try Self.buildProject()
        defer { try? FileManager.default.removeItem(at: root) }
        let golden = try JSONDecoder().decode(ServerScanGolden.self, from: Self.goldenData())
        let local = LocalDocFiles.scanTemplates(at: root)

        #expect(golden.templates.truncated == false)
        #expect(golden.templates.count == golden.templates.templates.count)
        #expect(local.count == golden.templates.templates.count)
        for (mine, theirs) in zip(local, golden.templates.templates) {
            #expect(mine.id == theirs.id, "id for \(theirs.folderName ?? "?")")
            #expect(mine.name == theirs.name, "name for \(theirs.folderName ?? "?")")
            #expect(mine.folderName == theirs.folderName)
            #expect(mine.surface == theirs.surface, "surface for \(theirs.folderName ?? "?")")
            #expect(mine.sections == theirs.sections, "sections for \(theirs.folderName ?? "?")")
            #expect(mine.rawContent == theirs.rawContent, "rawContent for \(theirs.folderName ?? "?")")
        }
    }

    @Test func localCommandScanMatchesTheServerGolden() throws {
        let root = try Self.buildProject()
        defer { try? FileManager.default.removeItem(at: root) }
        let golden = try JSONDecoder().decode(ServerScanGolden.self, from: Self.goldenData())
        let local = LocalDocFiles.scanCommands(at: root)

        #expect(golden.commands.truncated == false)
        #expect(local.count == golden.commands.commands.count)
        for (mine, theirs) in zip(local, golden.commands.commands) {
            #expect(mine.id == theirs.id)
            #expect(mine.name == theirs.name)
            #expect(mine.folderName == theirs.folderName)
            #expect(mine.surface == theirs.surface)
            #expect(mine.instruction == theirs.instruction)
            #expect(mine.rawContent == theirs.rawContent)
        }
    }

    @Test func autoTaskFolderIsSkippedOnBothSides() throws {
        let root = try Self.buildProject()
        defer { try? FileManager.default.removeItem(at: root) }
        let golden = try JSONDecoder().decode(ServerScanGolden.self, from: Self.goldenData())
        let local = LocalDocFiles.scanTemplates(at: root)

        #expect(!local.contains { $0.folderName == "auto_task" })
        #expect(!golden.templates.templates.contains { $0.folderName == "auto_task" })
    }

    /// A symlinked template folder is skipped by both sides, so there is no
    /// difference to merge. (`isDirectory` is false for a link, in the Swift
    /// scan and in the server's scan alike.)
    @Test func symlinkedFolderIsSkippedByBothSides() throws {
        let root = try Self.buildProject()
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createSymbolicLink(
            at: root.appendingPathComponent("templates/linked"),
            withDestinationURL: root.appendingPathComponent("templates/v0-bare"))

        #expect(!LocalDocFiles.scanTemplates(at: root).contains { $0.folderName == "linked" })
        #expect(LocalDocFiles.symlinkedTemplates(at: root).isEmpty)
        let golden = try JSONDecoder().decode(ServerScanGolden.self, from: Self.goldenData())
        #expect(!golden.templates.templates.contains { $0.folderName == "linked" })
    }

    /// A real folder whose `template.md` is a link: the Swift scan reads it and
    /// the server refuses it, so the server path merges it from the local scan.
    @Test func symlinkedEntryFileIsTheOneDifference() throws {
        let root = try Self.buildProject()
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = root.appendingPathComponent("templates/linkedfile", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(
            at: folder.appendingPathComponent("template.md"),
            withDestinationURL: root.appendingPathComponent("templates/v0-bare/template.md"))

        #expect(LocalDocFiles.scanTemplates(at: root).contains { $0.folderName == "linkedfile" })
        #expect(LocalDocFiles.symlinkedTemplates(at: root).map(\.folderName) == ["linkedfile"])
        let golden = try JSONDecoder().decode(ServerScanGolden.self, from: Self.goldenData())
        #expect(!golden.templates.templates.contains { $0.folderName == "linkedfile" })
    }
}
