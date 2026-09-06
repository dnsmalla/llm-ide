import XCTest
@testable import LlmIdeMac

@MainActor
final class DocCommandStoreTests: XCTestCase {

    private func makeTempProject() throws -> URL {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("docgen-cmd-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    func testSeederWritesEveryDefaultCommand() throws {
        let root = try makeTempProject()
        defer { try? FileManager.default.removeItem(at: root) }

        ProjectDocCommandsSeeder.seedIfNeeded(at: root)

        for def in DocCommand.seedDefinitions {
            let file = ProjectLayout(root: root)
                .commandDir(named: def.folderName)
                .appendingPathComponent("command.md")
            XCTAssertTrue(FileManager.default.fileExists(atPath: file.path),
                          "missing \(def.folderName)/command.md")
        }
    }

    func testSeederIsIdempotentAndKeepsEdits() throws {
        let root = try makeTempProject()
        defer { try? FileManager.default.removeItem(at: root) }

        ProjectDocCommandsSeeder.seedIfNeeded(at: root)
        let file = ProjectLayout(root: root)
            .commandDir(named: "summarize")
            .appendingPathComponent("command.md")
        try "# Summarize\n\n<!-- llmide:doc-command -->\n\nEdited.".write(
            to: file, atomically: true, encoding: .utf8)

        ProjectDocCommandsSeeder.seedIfNeeded(at: root)

        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8),
                       "# Summarize\n\n<!-- llmide:doc-command -->\n\nEdited.")
    }

    func testReloadPublishesProjectCommands() throws {
        let root = try makeTempProject()
        defer { try? FileManager.default.removeItem(at: root) }
        ProjectDocCommandsSeeder.seedIfNeeded(at: root)

        let store = DocCommandStore()
        store.reloadProjectCommands(at: root)

        XCTAssertEqual(store.commands.count, DocCommand.seedDefinitions.count)
        XCTAssertTrue(store.commands.allSatisfy { $0.isProjectCommand })
        XCTAssertEqual(store.commands.map(\.name), store.commands.map(\.name).sorted {
            $0.localizedCaseInsensitiveCompare($1) == .orderedAscending
        })
    }

    func testFallsBackToBuiltinsWithNoProject() {
        let store = DocCommandStore()
        store.reloadProjectCommands(at: nil)
        XCTAssertEqual(store.commands.map(\.id), DocCommand.builtins.map(\.id))
    }

    func testImportWritesIntoProjectAndSelectsIt() throws {
        let root = try makeTempProject()
        defer { try? FileManager.default.removeItem(at: root) }
        ProjectDocCommandsSeeder.seedIfNeeded(at: root)

        let src = root.appendingPathComponent("incoming.md")
        try "# Tighten\n\nRemove filler words.".write(to: src, atomically: true, encoding: .utf8)

        let store = DocCommandStore()
        store.reloadProjectCommands(at: root)
        let imported = store.importMarkdownFile(at: src)

        XCTAssertEqual(imported?.name, "Tighten")
        XCTAssertEqual(imported?.instruction, "Remove filler words.")
        XCTAssertTrue(store.commands.contains { $0.name == "Tighten" })
    }

    func testDeleteRemovesTheFolder() throws {
        let root = try makeTempProject()
        defer { try? FileManager.default.removeItem(at: root) }
        ProjectDocCommandsSeeder.seedIfNeeded(at: root)

        let store = DocCommandStore()
        store.reloadProjectCommands(at: root)
        let target = try XCTUnwrap(store.commands.first { $0.folderName == "summarize" })
        store.delete(id: target.id)

        XCTAssertFalse(store.commands.contains { $0.folderName == "summarize" })
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: ProjectLayout(root: root).commandDir(named: "summarize").path))
    }
}
