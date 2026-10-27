import XCTest
@testable import LlmIdeMacLib

/// Pins every on-disk format Doc Gen state has had, using real historical
/// output (see `Fixtures/docgen/README.md` for provenance). K1 moves this
/// logic to Node; these cases are the old-user data that must survive it.
@MainActor
final class DocGenLegacyStateTests: XCTestCase {

    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("docgen-legacy-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    // MARK: - Helpers

    private func fixtureURL(_ relativePath: String) -> URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("Fixtures/docgen", isDirectory: true)
            .appendingPathComponent(relativePath)
    }

    private func fixture(_ relativePath: String) throws -> Data {
        try Data(contentsOf: fixtureURL(relativePath))
    }

    /// Copy a fixture to `dir/<fileName>` as if it were the app's own file.
    @discardableResult
    private func install(_ relativePath: String, as fileName: String) throws -> URL {
        let url = dir.appendingPathComponent(fileName)
        try fixture(relativePath).write(to: url)
        return url
    }

    /// Parse JSON and add an unknown key everywhere it could appear, so a
    /// future build's extra fields can be simulated on a real fixture.
    private func withExtraFields(_ data: Data) throws -> Data {
        var root = try JSONSerialization.jsonObject(with: data)
        func inject(_ node: Any) -> Any {
            if var dict = node as? [String: Any] {
                for key in dict.keys { dict[key] = inject(dict[key]!) }
                dict["futureField"] = ["added": "by a later build", "n": 1]
                return dict
            }
            if let arr = node as? [Any] { return arr.map(inject) }
            return node
        }
        root = inject(root)
        return try JSONSerialization.data(withJSONObject: root)
    }

    private func templateStore(_ fileName: String = "doc-templates.json") -> DocTemplateStore {
        DocTemplateStore(storeURL: dir.appendingPathComponent(fileName))
    }

    private func quarantined(prefix: String) throws -> [URL] {
        try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasPrefix(prefix) }
    }

    private let sprintID = UUID(uuidString: "11111111-2222-4333-8444-555555555555")!
    private let retroID = UUID(uuidString: "66666666-7777-4888-8999-000000000000")!

    /// Assertions shared by every shape that stores the same two templates.
    private func assertSprintAndRetro(_ templates: [DocTemplate], file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(templates.map(\.name), ["Sprint Review", "Retro"], file: file, line: line)
        XCTAssertEqual(templates.map(\.id), [sprintID, retroID], file: file, line: line)
        XCTAssertEqual(templates[0].sections, ["Summary", "Decisions"], file: file, line: line)
        XCTAssertEqual(templates[1].sections, ["Went well", "Improve"], file: file, line: line)
    }

    // MARK: - DocTemplateStore: app-support file, every historical shape

    func testBareArrayFixtureLoadsEveryTemplateWithDefaultsForMissingFields() throws {
        try install("doc-templates.v0-bare-array.json", as: "doc-templates.json")
        let store = templateStore()
        store.bootstrap()

        assertSprintAndRetro(store.customTemplates)
        // The first entry carried rawContent; the second predates nothing
        // but has no rawContent key at all. Every field added after the
        // bare-array era must default: surface to Doc Gen, the folder fields
        // to project-off.
        XCTAssertEqual(store.customTemplates[0].rawContent,
                       "# Sprint Review\n\n## Summary\n\nWhat shipped this sprint.\n\n## Decisions\n\n")
        XCTAssertNil(store.customTemplates[1].rawContent)
        for template in store.customTemplates {
            XCTAssertEqual(template.surface, .doc)
            XCTAssertNil(template.folderName)
            XCTAssertFalse(template.isProjectTemplate)
            XCTAssertFalse(template.isBuiltin)
        }
    }

    func testEnvelopeV1FixtureLoads() throws {
        try install("doc-templates.v1-envelope.json", as: "doc-templates.json")
        let store = templateStore()
        store.bootstrap()

        assertSprintAndRetro(store.customTemplates)
        XCTAssertNotNil(store.customTemplates[0].rawContent)
        XCTAssertNil(store.customTemplates[1].rawContent)
        XCTAssertTrue(store.customTemplates.allSatisfy { $0.surface == .doc })
    }

    func testEnvelopeWithFolderFieldsButNoSurfaceLoadsAsDocGen() throws {
        try install("doc-templates.v1.1-envelope-folders.json", as: "doc-templates.json")
        let store = templateStore()
        store.bootstrap()

        assertSprintAndRetro(store.customTemplates)
        XCTAssertEqual(store.customTemplates[0].folderName, "sprint-review")
        XCTAssertFalse(store.customTemplates[0].isProjectTemplate)
        XCTAssertEqual(store.customTemplates[1].folderName, "retro")
        XCTAssertTrue(store.customTemplates[1].isProjectTemplate)
        XCTAssertTrue(store.customTemplates.allSatisfy { $0.surface == .doc })
    }

    func testCurrentEnvelopeKeepsSurface() throws {
        try install("doc-templates.v2-envelope-surface.json", as: "doc-templates.json")
        let store = templateStore()
        store.bootstrap()

        XCTAssertEqual(store.customTemplates.map(\.surface), [.visual, .doc])
        XCTAssertEqual(store.customTemplates.first?.folderName, "sprint-review")
    }

    func testUnknownExtraFieldsAreIgnoredInEveryShape() throws {
        for shape in ["doc-templates.v0-bare-array.json",
                      "doc-templates.v1-envelope.json",
                      "doc-templates.v1.1-envelope-folders.json",
                      "doc-templates.v2-envelope-surface.json"] {
            let data = try withExtraFields(try fixture(shape))
            try data.write(to: dir.appendingPathComponent("doc-templates.json"))
            let store = templateStore()
            store.bootstrap()
            XCTAssertEqual(store.customTemplates.count, 2, "shape \(shape) lost templates to an unknown field")
            XCTAssertEqual(store.customTemplates.map(\.name), ["Sprint Review", "Retro"], shape)
        }
    }

    func testCorruptFileIsMovedAsideAndStoreStartsEmptyAndWritable() throws {
        let garbage = Data("{ this is not json".utf8)
        let url = dir.appendingPathComponent("doc-templates.json")
        try garbage.write(to: url)

        let store = templateStore()
        store.bootstrap()

        XCTAssertTrue(store.customTemplates.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path),
                       "the damaged file is moved out of the way, not left in place")
        let copies = try quarantined(prefix: "doc-templates.json.corrupt-")
        XCTAssertEqual(copies.count, 1)
        XCTAssertEqual(try copies.first.map { try Data(contentsOf: $0) }, garbage,
                       "the damaged bytes are preserved for manual recovery")

        // Writable afterwards: the next save creates a fresh envelope.
        store.add(DocTemplate(id: UUID(), name: "After Corruption", sections: ["A"]))
        let reloaded = templateStore()
        reloaded.bootstrap()
        XCTAssertEqual(reloaded.customTemplates.map(\.name), ["After Corruption"])
    }

    func testMissingFileIsEmptyAndLoadWritesNothing() throws {
        let store = templateStore()
        store.bootstrap()

        XCTAssertTrue(store.customTemplates.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("doc-templates.json").path))
    }

    func testLegacyFileIsNotRewrittenOnLoad() throws {
        let url = try install("doc-templates.v0-bare-array.json", as: "doc-templates.json")
        let before = try Data(contentsOf: url)

        let store = templateStore()
        store.bootstrap()

        XCTAssertEqual(try Data(contentsOf: url), before, "loading must not change the user's file")
    }

    func testLegacyFileIsRewrittenAsEnvelopeOnlyOnNextSave() throws {
        let url = try install("doc-templates.v0-bare-array.json", as: "doc-templates.json")
        let legacy = try JSONDecoder().decode([DocTemplate].self, from: try fixture("doc-templates.v0-bare-array.json"))

        let store = templateStore()
        store.bootstrap()
        let added = DocTemplate(id: UUID(), name: "Added Later", sections: ["Only"])
        store.add(added)

        let root = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        XCTAssertEqual(root?["storeVersion"] as? Int, 1, "the rewrite is the envelope, not a bare array")
        let rows = root?["templates"] as? [[String: Any]]
        XCTAssertEqual(rows?.count, legacy.count + 1)

        // The legacy entries survive the rewrite with their content intact.
        let reloaded = templateStore()
        reloaded.bootstrap()
        XCTAssertEqual(reloaded.customTemplates.count, 3)
        XCTAssertEqual(reloaded.customTemplates[0].id, legacy[0].id)
        XCTAssertEqual(reloaded.customTemplates[0].rawContent, legacy[0].rawContent)
        XCTAssertEqual(reloaded.customTemplates[1].sections, legacy[1].sections)
        XCTAssertEqual(reloaded.customTemplates[2], added)
    }

    /// N-1 readability. The envelope has been the write format since the first
    /// commit, so an older Mac build decodes it with a struct shaped like
    /// `ed5b1802`'s `DocTemplate`. The rewritten file must still decode that way
    /// after a save made by this build.
    func testRewrittenEnvelopeStillDecodesWithTheOriginalModelShape() throws {
        let url = try install("doc-templates.v2-envelope-surface.json", as: "doc-templates.json")
        let store = templateStore()
        store.bootstrap()
        store.add(DocTemplate(id: UUID(), name: "N1 check", sections: ["X"]))

        struct OriginalTemplate: Decodable {
            let id: UUID
            let name: String
            let sections: [String]
            let rawContent: String?
            let isBuiltin: Bool
        }
        struct OriginalStoreFile: Decodable {
            let storeVersion: Int
            let templates: [OriginalTemplate]
        }
        let decoded = try JSONDecoder().decode(OriginalStoreFile.self, from: Data(contentsOf: url))
        XCTAssertEqual(decoded.storeVersion, 1)
        XCTAssertEqual(decoded.templates.map(\.name), ["Sprint Review", "Retro", "N1 check"])
        XCTAssertEqual(decoded.templates.map(\.sections), [["Summary", "Decisions"], ["Went well", "Improve"], ["X"]])
    }

    func testRewriteOfCurrentShapeKeepsSurfaceAndFolderFields() throws {
        try install("doc-templates.v2-envelope-surface.json", as: "doc-templates.json")
        let store = templateStore()
        store.bootstrap()
        var edited = store.customTemplates[0]
        edited.name = "Sprint Review (renamed)"
        store.update(edited)

        let reloaded = templateStore()
        reloaded.bootstrap()
        XCTAssertEqual(reloaded.customTemplates.first?.name, "Sprint Review (renamed)")
        XCTAssertEqual(reloaded.customTemplates.first?.surface, .visual)
        XCTAssertEqual(reloaded.customTemplates.first?.folderName, "sprint-review")
    }

    func testEnvelopeRoundTripsThroughAFreshStore() throws {
        let store = templateStore()
        store.bootstrap()
        let made = DocTemplate(id: UUID(), name: "Round trip", sections: ["A", "B"],
                               rawContent: "# Round trip\n\n## A\n\n## B\n\n", surface: .visual)
        store.add(made)

        let reloaded = templateStore()
        reloaded.bootstrap()
        XCTAssertEqual(reloaded.customTemplates, [made])
    }

    // MARK: - DocGenOutputStore: per-project map, no envelope

    private func outputStore() -> DocGenOutputStore {
        DocGenOutputStore(storeDirectory: dir)
    }

    private var alphaRoot: URL { URL(fileURLWithPath: "/Users/example/projects/alpha", isDirectory: true) }
    private var betaRoot: URL { URL(fileURLWithPath: "/Users/example/projects/beta", isDirectory: true) }

    func testOutputV0FixtureLoadsPerProjectConfig() throws {
        try install("doc-gen-output.v0.json", as: "doc-gen-output.json")
        let store = outputStore()

        store.activate(projectRoot: alphaRoot)
        XCTAssertEqual(store.config.destination, .localFolder)
        XCTAssertEqual(store.config.localFolderPath, "/Users/example/projects/alpha/exports")
        XCTAssertEqual(store.config.resolvedDirectory(projectRoot: alphaRoot),
                       URL(fileURLWithPath: "/Users/example/projects/alpha/exports", isDirectory: true))

        store.activate(projectRoot: betaRoot)
        XCTAssertNil(store.config.localFolderPath, "a project with no saved folder gets the default")
        XCTAssertFalse(store.config.sendCopyToEmail)

        store.activate(projectRoot: nil)
        XCTAssertEqual(store.config, DocGenOutputConfig())
    }

    func testOutputFileIsNotRewrittenOnActivate() throws {
        let url = try install("doc-gen-output.v0.json", as: "doc-gen-output.json")
        let before = try Data(contentsOf: url)
        let store = outputStore()
        store.activate(projectRoot: alphaRoot)
        store.activate(projectRoot: betaRoot)
        XCTAssertEqual(try Data(contentsOf: url), before)
    }

    func testOutputUpdateKeepsEveryOtherProjectsEntry() throws {
        let url = try install("doc-gen-output.v0.json", as: "doc-gen-output.json")
        let store = outputStore()
        store.activate(projectRoot: alphaRoot)
        store.update(DocGenOutputConfig(destination: .localFolder, localFolderPath: "/Users/example/elsewhere"))

        let map = try JSONDecoder().decode([String: DocGenOutputConfig].self, from: Data(contentsOf: url))
        XCTAssertEqual(Set(map.keys), ["/Users/example/projects/alpha", "/Users/example/projects/beta"],
                       "saving one project must not drop another project's settings")
        XCTAssertEqual(map["/Users/example/projects/alpha"]?.localFolderPath, "/Users/example/elsewhere")
    }

    func testOutputUnreadableFileIsMovedAsideBeforeAnyWrite() throws {
        let garbage = Data("not a dictionary".utf8)
        let url = dir.appendingPathComponent("doc-gen-output.json")
        try garbage.write(to: url)

        let store = outputStore()
        store.activate(projectRoot: alphaRoot)
        XCTAssertEqual(store.config, DocGenOutputConfig(), "an unreadable file yields the default, not an error")

        let copies = try quarantined(prefix: "doc-gen-output.json.corrupt-")
        XCTAssertEqual(copies.count, 1)
        XCTAssertEqual(try copies.first.map { try Data(contentsOf: $0) }, garbage)

        store.update(DocGenOutputConfig(localFolderPath: "/Users/example/new"))
        let reloaded = outputStore()
        reloaded.activate(projectRoot: alphaRoot)
        XCTAssertEqual(reloaded.config.localFolderPath, "/Users/example/new")
        XCTAssertEqual(try copies.first.map { try Data(contentsOf: $0) }, garbage,
                       "the write after recovery does not touch the preserved copy")
    }

    func testOutputMissingFileIsDefaultAndWritesNothingOnActivate() throws {
        let store = outputStore()
        store.activate(projectRoot: alphaRoot)
        XCTAssertEqual(store.config, DocGenOutputConfig())
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("doc-gen-output.json").path))
    }

    func testOutputUnknownExtraFieldsAreIgnored() throws {
        // The top level of this file is project paths, so the extra key goes
        // inside each project's config, not beside the project keys.
        var map = try JSONSerialization.jsonObject(with: fixture("doc-gen-output.v0.json")) as? [String: Any] ?? [:]
        for (project, value) in map {
            var config = value as? [String: Any] ?? [:]
            config["futureField"] = ["added": "by a later build"]
            map[project] = config
        }
        try JSONSerialization.data(withJSONObject: map)
            .write(to: dir.appendingPathComponent("doc-gen-output.json"))
        let store = outputStore()
        store.activate(projectRoot: alphaRoot)
        XCTAssertEqual(store.config.localFolderPath, "/Users/example/projects/alpha/exports")
    }

    // MARK: - GenerationLibraryStore cache

    private func libraryStore(_ fileName: String = "generation-library.json") -> GenerationLibraryStore {
        GenerationLibraryStore(cacheURL: dir.appendingPathComponent(fileName))
    }

    func testLibraryCacheV0FixtureLoadsTemplatesAndCommands() throws {
        try install("generation-library.v0.json", as: "generation-library.json")
        let store = libraryStore()

        XCTAssertTrue(store.isLoaded)
        XCTAssertEqual(store.templates.map(\.folderName), ["sprint-review", "storyboard"])
        XCTAssertEqual(store.templates.map(\.templateSurface), [.doc, .visual])
        XCTAssertEqual(store.commands.map(\.folderName), ["summarize"])
        XCTAssertEqual(store.commands.first?.body, "# Summarize\n\n<!-- llmide:doc-command -->\n\nSummarize the source into five bullet points.")
    }

    func testLibraryCacheUnknownExtraFieldsAreIgnored() throws {
        try withExtraFields(try fixture("generation-library.v0.json"))
            .write(to: dir.appendingPathComponent("generation-library.json"))
        XCTAssertEqual(libraryStore().templates.count, 2)
    }

    func testMissingLibraryCacheIsEmptyAndNotCreated() throws {
        let store = libraryStore()
        XCTAssertFalse(store.isLoaded)
        XCTAssertTrue(store.templates.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("generation-library.json").path))
    }

    /// The cache is a re-fetchable copy of the server's kit, so a damaged
    /// file is not quarantined the way user state is: the store starts
    /// empty and the next successful refresh overwrites it. Pinned here so a
    /// later change to that policy is a conscious one.
    func testCorruptLibraryCacheStartsEmptyAndIsLeftForTheNextRefresh() throws {
        let garbage = Data("{{".utf8)
        let url = dir.appendingPathComponent("generation-library.json")
        try garbage.write(to: url)

        let store = libraryStore()
        XCTAssertTrue(store.templates.isEmpty)
        XCTAssertTrue(store.commands.isEmpty)
        XCTAssertEqual(try Data(contentsOf: url), garbage)
        XCTAssertTrue(try quarantined(prefix: "generation-library.json.corrupt-").isEmpty)
    }

    // MARK: - Project-folder files with historical markers

    private func writeProjectFile(_ relativePath: String, from fixturePath: String? = nil, text: String? = nil) throws {
        let url = dir.appendingPathComponent("proj").appendingPathComponent(relativePath)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let fixturePath {
            try fixture(fixturePath).write(to: url)
        } else {
            try (text ?? "").write(to: url, atomically: true, encoding: .utf8)
        }
    }

    func testProjectTemplatesWithBareAndSurfaceMarkersParse() throws {
        try writeProjectFile("templates/retro/template.md", from: "project/template-md.v0-bare-marker.md")
        try writeProjectFile("templates/sprint-review/template.md", from: "project/template-md.v2-visual-marker.md")
        // Folders the scanner must skip: Auto Task prompts and ingest layouts.
        try writeProjectFile("templates/auto_task/prompt.md", text: "# Prompt\n\nDo the thing.")
        try writeProjectFile("templates/meeting-note/template.md",
                             text: "# {{title}}\n\n<!-- llmide:ingest-template source=meeting -->\n\n## Summary\n")

        let store = templateStore()
        store.reloadProjectTemplates(at: dir.appendingPathComponent("proj"))

        XCTAssertEqual(store.projectTemplates.map(\.folderName), ["retro", "sprint-review"])
        let retro = try XCTUnwrap(store.projectTemplates.first { $0.folderName == "retro" })
        XCTAssertEqual(retro.name, "Retro")
        XCTAssertEqual(retro.sections, ["Went well", "Improve"])
        XCTAssertEqual(retro.surface, .doc, "a template with no surface= attribute is Doc Gen")
        XCTAssertTrue(retro.isProjectTemplate)

        let sprint = try XCTUnwrap(store.projectTemplates.first { $0.folderName == "sprint-review" })
        XCTAssertEqual(sprint.surface, .visual)

        XCTAssertEqual(store.templates(for: .doc).map(\.folderName), ["retro"])
        XCTAssertEqual(store.templates(for: .visual).map(\.folderName), ["sprint-review"])
    }

    func testProjectCommandWithBareMarkerParsesInstructionAndSurface() throws {
        try writeProjectFile("commands/summarize/command.md", from: "project/command-md.v0-bare-marker.md")
        // Same shape with the attributed marker written by the surface change.
        try writeProjectFile("commands/visual-brief/command.md",
                             text: "# Visual Brief\n\n<!-- llmide:doc-command surface=visual -->\n\nDescribe the frame.")

        let store = DocCommandStore()
        store.reloadProjectCommands(at: dir.appendingPathComponent("proj"))

        let summarize = try XCTUnwrap(store.commands.first { $0.folderName == "summarize" })
        XCTAssertEqual(summarize.name, "Summarize")
        XCTAssertEqual(summarize.instruction, "Summarize the source into five bullet points.",
                       "the marker line and the title are not sent to the model as instruction")
        XCTAssertEqual(summarize.surface, .doc)

        let brief = try XCTUnwrap(store.commands.first { $0.folderName == "visual-brief" })
        XCTAssertEqual(brief.instruction, "Describe the frame.")
        XCTAssertEqual(brief.surface, .visual)
        XCTAssertEqual(store.commands(for: .doc).map(\.folderName), ["summarize"])
    }

    // MARK: - Quarantine never overwrites an earlier damaged copy

    private let fixedNow = Date(timeIntervalSince1970: 1_700_000_000)

    private func directoryEntries(prefix: String) throws -> [String] {
        try quarantined(prefix: prefix).map(\.lastPathComponent).sorted()
    }

    func testDocTemplateQuarantineTwoCorruptionsInOneSecondKeepBothCopies() throws {
        let url = dir.appendingPathComponent("doc-templates.json")
        let first = Data("first damage { ".utf8)
        let second = Data("second damage [".utf8)

        try first.write(to: url)
        DocTemplateStore(storeURL: url, now: { self.fixedNow }).bootstrap()
        try second.write(to: url)
        DocTemplateStore(storeURL: url, now: { self.fixedNow }).bootstrap()

        let names = try directoryEntries(prefix: "doc-templates.json.corrupt-")
        XCTAssertEqual(names, ["doc-templates.json.corrupt-1700000000",
                               "doc-templates.json.corrupt-1700000000-2"])
        let contents = try names.map { try Data(contentsOf: dir.appendingPathComponent($0)) }
        XCTAssertEqual(contents, [first, second], "both damaged files survive byte-exact, in order")
    }

    func testDocTemplateFailedQuarantineBlocksSaveSoTheDamagedFileSurvives() throws {
        let url = dir.appendingPathComponent("doc-templates.json")
        let garbage = Data("{ damaged but the only copy".utf8)
        try garbage.write(to: url)

        // A read-only folder makes the move aside fail, so the damaged file stays.
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: dir.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir.path) }
        let store = templateStore()
        store.bootstrap()
        XCTAssertTrue(store.customTemplates.isEmpty)
        XCTAssertEqual(try Data(contentsOf: url), garbage)

        // Writable again: without the guard the next save would replace the file.
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir.path)
        store.add(DocTemplate(id: UUID(), name: "Blocked", sections: ["A"]))

        XCTAssertEqual(try Data(contentsOf: url), garbage, "the damaged original is not overwritten")
        XCTAssertTrue(try quarantined(prefix: "doc-templates.json.corrupt-").isEmpty)
    }

    func testDocGenOutputQuarantineTwoCorruptionsInOneSecondKeepBothCopies() throws {
        let first = Data("first damage".utf8)
        let second = Data("second damage".utf8)
        let url = dir.appendingPathComponent("doc-gen-output.json")

        try first.write(to: url)
        DocGenOutputStore(storeDirectory: dir, now: { self.fixedNow }).activate(projectRoot: alphaRoot)
        try second.write(to: url)
        DocGenOutputStore(storeDirectory: dir, now: { self.fixedNow }).activate(projectRoot: alphaRoot)

        let names = try directoryEntries(prefix: "doc-gen-output.json.corrupt-")
        XCTAssertEqual(names, ["doc-gen-output.json.corrupt-1700000000",
                               "doc-gen-output.json.corrupt-1700000000-2"])
        let contents = try names.map { try Data(contentsOf: dir.appendingPathComponent($0)) }
        XCTAssertEqual(contents, [first, second])
    }

    func testDocGenOutputFailedQuarantineBlocksSaveSoTheDamagedFileSurvives() throws {
        let url = dir.appendingPathComponent("doc-gen-output.json")
        let garbage = Data("not a dictionary".utf8)
        try garbage.write(to: url)

        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: dir.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir.path) }
        let store = outputStore()
        store.activate(projectRoot: alphaRoot)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir.path)
        store.update(DocGenOutputConfig(localFolderPath: "/Users/example/new"))

        XCTAssertEqual(try Data(contentsOf: url), garbage, "the damaged original is not overwritten")
        XCTAssertTrue(try quarantined(prefix: "doc-gen-output.json.corrupt-").isEmpty)
    }
}
