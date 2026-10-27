import XCTest
@testable import LlmIdeMacLib

/// Doc Gen and Visual seed their templates and commands on first open, not at
/// project create. The ingest templates stay eager. Existing files are never
/// overwritten.
@MainActor
final class DocGenLazySeedingTests: XCTestCase {

    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("docgen-lazy-seed-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    // MARK: - Fixtures

    private func entry(_ json: String) throws -> LlmIdeAPIClient.GenerationLibraryEntry {
        try JSONDecoder().decode(LlmIdeAPIClient.GenerationLibraryEntry.self, from: Data(json.utf8))
    }

    private func docTemplate() throws -> LlmIdeAPIClient.GenerationLibraryEntry {
        try entry(###"{"id":"doc/meeting-summary","name":"Meeting summary","description":"d","surface":"doc","body":"## Summary\n\n## Actions\n"}"###)
    }

    private func visualTemplate() throws -> LlmIdeAPIClient.GenerationLibraryEntry {
        try entry(###"{"id":"vis/chart-brief","name":"Chart brief","description":"d","surface":"visual","body":"## Chart\n"}"###)
    }

    private func command() throws -> LlmIdeAPIClient.GenerationLibraryEntry {
        try entry(###"{"id":"doc/explain-code","name":"Explain code","description":"d","surface":"doc","body":"Explain the code."}"###)
    }

    private func firstOpen() throws {
        DocGenProvider.seedProjectFiles(at: root,
                                        templateKit: [try docTemplate(), try visualTemplate()],
                                        commandKit: [try command()])
    }

    private func scaffold() throws {
        let project = Project(id: "p", displayName: "Lazy seed", createdAt: Date(),
                              settings: ProjectSettings(language: "en"))
        try ProjectScaffolder.scaffold(at: root, project: project)
    }

    /// Every file under `dir`, relative to it, sorted. Empty when `dir` is absent.
    private func files(under dir: URL) -> [String] {
        // The enumerator reports `/private/var/...` for a `/var/...` root, so both
        // sides are resolved before the relative path is cut.
        let base = dir.resolvingSymlinksInPath().path + "/"
        guard let walker = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil) else { return [] }
        var out: [String] = []
        for case let url as URL in walker {
            var isDir: ObjCBool = false
            let full = url.resolvingSymlinksInPath().path
            if FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir), !isDir.boolValue,
               full.hasPrefix(base) {
                out.append(String(full.dropFirst(base.count)))
            }
        }
        return out.sorted()
    }

    private func snapshot(of dir: URL) throws -> [String: (text: String, modified: Date)] {
        var result: [String: (text: String, modified: Date)] = [:]
        for rel in files(under: dir) {
            let url = dir.appendingPathComponent(rel)
            let text = try String(contentsOf: url, encoding: .utf8)
            let modified = try XCTUnwrap(
                try FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate] as? Date)
            result[rel] = (text, modified)
        }
        return result
    }

    // MARK: - New project

    func testNewProjectHasNoDocGenTemplatesOrCommands() throws {
        try scaffold()
        let layout = ProjectLayout(root: root)

        XCTAssertFalse(FileManager.default.fileExists(
            atPath: layout.templatesDir.appendingPathComponent("README.md").path),
            "the Doc Gen README is seeded on first open, not at create")
        let folders = try FileManager.default.contentsOfDirectory(atPath: layout.templatesDir.path).sorted()
        XCTAssertEqual(folders, ["email-note", "meeting-note"],
                       "only the ingest templates exist after create")
        XCTAssertEqual(files(under: layout.commandsDir), [],
                       "no commands are seeded at create")
    }

    func testNewProjectSeedsIngestTemplates() throws {
        try scaffold()
        let layout = ProjectLayout(root: root)
        let meeting = try String(contentsOf: layout.templateDir(named: "meeting-note")
            .appendingPathComponent("template.md"), encoding: .utf8)
        XCTAssertEqual(meeting, IngestTemplateRenderer.defaultTemplate(.meetingNote))
    }

    // MARK: - First open

    func testFirstOpenSeedsExactlyTheDocGenFiles() throws {
        try scaffold()
        try firstOpen()
        let layout = ProjectLayout(root: root)

        XCTAssertEqual(files(under: layout.templatesDir), [
            "README.md",
            "chart-brief/template.md",
            "email-note/template.md",
            "meeting-note/template.md",
            "meeting-summary/template.md",
        ])
        XCTAssertEqual(try String(contentsOf: layout.templateDir(named: "meeting-summary")
            .appendingPathComponent("template.md"), encoding: .utf8),
                       ProjectDocTemplatesSeeder.projectMarkdown(for: try docTemplate()))
        XCTAssertEqual(try String(contentsOf: layout.templateDir(named: "chart-brief")
            .appendingPathComponent("template.md"), encoding: .utf8),
                       ProjectDocTemplatesSeeder.projectMarkdown(for: try visualTemplate()))
        XCTAssertTrue(files(under: layout.commandsDir).contains("explain-code/command.md"))
        XCTAssertTrue(files(under: layout.commandsDir).contains("README.md"))
    }

    func testFirstOpenWithoutKitSeedsOnlyIngestAndReadme() throws {
        try scaffold()
        DocGenProvider.seedProjectFiles(at: root, templateKit: [], commandKit: [])
        let layout = ProjectLayout(root: root)
        XCTAssertEqual(files(under: layout.templatesDir), [
            "README.md",
            "email-note/template.md",
            "meeting-note/template.md",
        ])
    }

    // MARK: - Idempotence and user edits

    func testSecondOpenIsANoOp() throws {
        try scaffold()
        try firstOpen()
        let layout = ProjectLayout(root: root)
        let before = try snapshot(of: layout.templatesDir)
        let commandsBefore = try snapshot(of: layout.commandsDir)

        try firstOpen()

        let after = try snapshot(of: layout.templatesDir)
        XCTAssertEqual(after.keys.sorted(), before.keys.sorted())
        for (rel, file) in before {
            XCTAssertEqual(after[rel]?.text, file.text, rel)
            XCTAssertEqual(after[rel]?.modified, file.modified, "\(rel) was rewritten")
        }
        let commandsAfter = try snapshot(of: layout.commandsDir)
        for (rel, file) in commandsBefore {
            XCTAssertEqual(commandsAfter[rel]?.modified, file.modified, "\(rel) was rewritten")
        }
    }

    func testUserEditedTemplateIsNeverOverwritten() throws {
        try scaffold()
        try firstOpen()
        let layout = ProjectLayout(root: root)
        let mine = layout.templateDir(named: "meeting-summary").appendingPathComponent("template.md")
        try "## My own sections\n".write(to: mine, atomically: true, encoding: .utf8)

        try firstOpen()

        XCTAssertEqual(try String(contentsOf: mine, encoding: .utf8), "## My own sections\n")
    }

    func testIngestTemplateEditedByUserSurvivesFirstOpen() throws {
        try scaffold()
        let layout = ProjectLayout(root: root)
        let ingest = layout.templateDir(named: "email-note").appendingPathComponent("template.md")
        try "EDITED\n".write(to: ingest, atomically: true, encoding: .utf8)

        try firstOpen()

        XCTAssertEqual(try String(contentsOf: ingest, encoding: .utf8), "EDITED\n")
    }
}
