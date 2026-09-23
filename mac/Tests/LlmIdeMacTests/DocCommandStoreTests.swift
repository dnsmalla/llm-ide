import XCTest
@testable import LlmIdeMacLib

@MainActor
final class DocCommandStoreTests: XCTestCase {

    private func makeTempProject() throws -> URL {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("docgen-cmd-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    /// Build one kit entry the way the server sends it.
    ///
    /// Goes through `JSONDecoder` because `GenerationLibraryEntry` declares
    /// `init(from:)` in its body, which suppresses the memberwise init — and
    /// decoding is what production does anyway, so a field renamed on the wire
    /// breaks these tests too. `folderName` is the last `/` component of `id`.
    private func kitEntry(id: String, body: String,
                          surface: String = "doc") throws -> LlmIdeAPIClient.GenerationLibraryEntry {
        let json: [String: Any] = ["id": id, "name": id, "description": "",
                                   "surface": surface, "body": body]
        return try JSONDecoder().decode(
            LlmIdeAPIClient.GenerationLibraryEntry.self,
            from: try JSONSerialization.data(withJSONObject: json))
    }

    // These four tests used to seed with no `kit` at all and assert against
    // `DocCommand.seedDefinitions`. Both are `[]` now — the shipped defaults
    // moved to the server-supplied kit (`/kb/agent/generation-library`) so
    // adding one no longer needs an app release. Against an empty kit the
    // seeder writes nothing, so two of these failed outright and two passed
    // while asserting nothing at all (`0 == 0`, and `allSatisfy` over an
    // empty array). Each now supplies its own kit and asserts the real
    // contract.

    func testSeederWritesEveryKitCommand() throws {
        let root = try makeTempProject()
        defer { try? FileManager.default.removeItem(at: root) }

        let kit = [try kitEntry(id: "doc/summarize", body: "# Summarize\n\nShorten it."),
                   try kitEntry(id: "doc/translate", body: "# Translate\n\nInto Japanese.")]
        ProjectDocCommandsSeeder.seedIfNeeded(at: root, kit: kit)

        for entry in kit {
            let file = ProjectLayout(root: root)
                .commandDir(named: entry.folderName)
                .appendingPathComponent("command.md")
            XCTAssertTrue(FileManager.default.fileExists(atPath: file.path),
                          "missing \(entry.folderName)/command.md")
            let written = try String(contentsOf: file, encoding: .utf8)
            // Asserted in two parts, not as one `contains(entry.body)`: the
            // marker is INSERTED directly under the title, so the body is no
            // longer contiguous in the written file.
            for fragment in entry.body.components(separatedBy: "\n\n") where !fragment.isEmpty {
                XCTAssertTrue(written.contains(fragment),
                              "\(entry.folderName)/command.md is missing kit text: \(fragment)")
            }
            // The scanner reads this marker to decide which menu the command
            // belongs in; seeding without it files every command in the wrong one.
            XCTAssertTrue(written.contains("llmide:doc-command"),
                          "\(entry.folderName)/command.md lost its surface marker")
        }
    }

    func testSeederIsIdempotentAndKeepsEdits() throws {
        let root = try makeTempProject()
        defer { try? FileManager.default.removeItem(at: root) }

        let kit = [try kitEntry(id: "doc/summarize", body: "# Summarize\n\nShipped text.")]
        ProjectDocCommandsSeeder.seedIfNeeded(at: root, kit: kit)
        let file = ProjectLayout(root: root)
            .commandDir(named: "summarize")
            .appendingPathComponent("command.md")

        let edited = "# Summarize\n\n<!-- llmide:doc-command -->\n\nEdited."
        try edited.write(to: file, atomically: true, encoding: .utf8)

        // Re-seeding the SAME kit must not clobber the user's copy: this is
        // the write-if-absent guarantee, and it runs on every project open.
        ProjectDocCommandsSeeder.seedIfNeeded(at: root, kit: kit)

        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), edited,
                       "re-seeding overwrote an edited command")
    }

    func testReloadPublishesProjectCommands() throws {
        let root = try makeTempProject()
        defer { try? FileManager.default.removeItem(at: root) }
        // Folder order and display-name order deliberately DISAGREE (aa-→Zulu,
        // zz-→Alpha), so the sort assertion below fails if the store ever
        // publishes in directory-scan order instead of by name.
        let kit = [try kitEntry(id: "doc/aa-long", body: "# Zulu Long\n\nBody."),
                   try kitEntry(id: "doc/zz-brief", body: "# Alpha Brief\n\nBody.")]
        ProjectDocCommandsSeeder.seedIfNeeded(at: root, kit: kit)

        let store = DocCommandStore()
        store.reloadProjectCommands(at: root)

        XCTAssertEqual(store.commands.count, kit.count)
        XCTAssertTrue(store.commands.allSatisfy { $0.isProjectCommand })
        XCTAssertEqual(store.commands.map(\.name), ["Alpha Brief", "Zulu Long"])
    }

    func testFallsBackToBuiltinsWithNoProject() throws {
        // `DocCommand.builtins` is deliberately `[]` now — the shipped
        // fallback moved to `GenerationLibraryStore` (cached, so it survives
        // offline). With no project open the store must show exactly the
        // kit's commands, and none may claim to BE a project command.
        //
        // The library is seeded here rather than read as-is: it is a
        // machine-local cache of a server fetch, so reading it made the test
        // pass on a dev machine that had ever reached the server and fail on
        // a fresh CI runner (no cache, no server) — and comparing against it
        // unseeded would be `0 == 0`, which asserts nothing.
        let library = GenerationLibraryStore.shared
        let (savedTemplates, savedCommands) = (library.templates, library.commands)
        defer { library.replaceEntriesForTesting(templates: savedTemplates, commands: savedCommands) }
        func entry(_ id: String, _ name: String) throws -> LlmIdeAPIClient.GenerationLibraryEntry {
            let json = try JSONSerialization.data(withJSONObject: [
                "id": id, "name": name, "description": "d", "surface": "doc",
                "body": "# \(name)\n\nDo it.",
            ])
            return try JSONDecoder().decode(LlmIdeAPIClient.GenerationLibraryEntry.self, from: json)
        }
        library.replaceEntriesForTesting(templates: [], commands: [
            try entry("doc/brief-summary", "Brief Summary"),
            try entry("doc/risk-review", "Risk Review"),
            try entry("", "No Folder"),   // no folder → never shown
        ])

        let store = DocCommandStore()
        store.reloadProjectCommands(at: nil)
        XCTAssertEqual(Set(store.commands.map(\.name)), ["Brief Summary", "Risk Review"])
        XCTAssertTrue(store.commands.allSatisfy { !$0.isProjectCommand })
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
        ProjectDocCommandsSeeder.seedIfNeeded(
            at: root, kit: [try kitEntry(id: "doc/summarize", body: "# Summarize\n\nShorten it.")])

        let store = DocCommandStore()
        store.reloadProjectCommands(at: root)
        let target = try XCTUnwrap(store.commands.first { $0.folderName == "summarize" })
        store.delete(id: target.id)

        XCTAssertFalse(store.commands.contains { $0.folderName == "summarize" })
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: ProjectLayout(root: root).commandDir(named: "summarize").path))
    }
}
