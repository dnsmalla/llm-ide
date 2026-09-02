import XCTest
@testable import LlmIdeMacLib

/// The two catalogs the Auto Task Settings card offers: the project's Library
/// folders, and the agent skills the CLI can actually invoke.
final class AutoTaskFolderCatalogTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("auto-task-folders-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
        root = nil
        try super.tearDownWithError()
    }

    private func makeDir(_ relative: String) throws {
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent(relative), withIntermediateDirectories: true)
    }

    func testNoProjectReturnsNothing() {
        XCTAssertTrue(AutoTaskFolderCatalog.scan(projectRoot: nil).isEmpty)
    }

    func testLibraryRootsAppearWhenTheyExist() throws {
        try makeDir("code")
        try makeDir("llm-doc")
        let paths = AutoTaskFolderCatalog.scan(projectRoot: root).map(\.path)
        XCTAssertEqual(paths, ["code", "llm-doc"])
    }

    /// Only the four Library roots are offered — `system/` is generated data,
    /// not somewhere a user points a task.
    func testNonLibraryFoldersAreIgnored() throws {
        try makeDir("code")
        try makeDir("system/faults")
        try makeDir("node_modules/foo")
        let paths = AutoTaskFolderCatalog.scan(projectRoot: root).map(\.path)
        XCTAssertEqual(paths, ["code"])
    }

    /// An output folder usually has no files in it yet, which is exactly why
    /// this scans directories rather than the Library's file index.
    func testEmptyNestedFolderIsStillOffered() throws {
        try makeDir("llm-doc/reports")
        let paths = AutoTaskFolderCatalog.scan(projectRoot: root).map(\.path)
        XCTAssertTrue(paths.contains("llm-doc/reports"))
    }

    func testNestedFoldersCarryTheirDepthAndCategory() throws {
        try makeDir("llm-doc/emails/2026/08")
        let folders = AutoTaskFolderCatalog.scan(projectRoot: root)
        let deepest = try XCTUnwrap(folders.first { $0.path == "llm-doc/emails/2026/08" })
        XCTAssertEqual(deepest.depth, 4)
        XCTAssertEqual(deepest.category, .notes)
        XCTAssertEqual(folders.first { $0.path == "llm-doc" }?.depth, 1)
    }

    /// The depth cap keeps a deep `code/` tree from producing an unscrollable
    /// list; the deepest canonical layout (`<type>/<YYYY>/<MM>/`) still fits.
    func testDescentStopsAtMaxDepth() throws {
        try makeDir("code/a/b/c/d/e")
        let paths = AutoTaskFolderCatalog.scan(projectRoot: root).map(\.path)
        XCTAssertTrue(paths.contains("code/a/b/c"))
        XCTAssertFalse(paths.contains("code/a/b/c/d"))
    }

    func testAFileNamedLikeAFolderIsNotOffered() throws {
        try makeDir("data")
        try "x".write(to: root.appendingPathComponent("data/readme.md"),
                      atomically: true, encoding: .utf8)
        XCTAssertEqual(AutoTaskFolderCatalog.scan(projectRoot: root).map(\.path), ["data"])
    }
}

final class AutoTaskSkillCatalogTests: XCTestCase {

    func testDirectiveIsThePromptLineTheCLIUnderstands() {
        XCTAssertEqual(AutoTaskSkillCatalog.directive(for: "code-review"),
                       "Use the code-review skill:")
    }

    func testParseReadsNameAndDescription() {
        let manifest = """
        ---
        name: code-review
        description: Review a diff for defects
        ---

        Body of the skill.
        """
        let entry = AutoTaskSkillCatalog.parse(manifest: manifest, folderName: "code-review")
        XCTAssertEqual(entry.name, "code-review")
        XCTAssertEqual(entry.description, "Review a diff for defects")
    }

    /// A malformed manifest still yields an invocable entry: the folder name is
    /// the identifier the CLI resolves, so dropping the skill would hide one
    /// that actually works.
    func testMissingHeaderFallsBackToTheFolderName() {
        let entry = AutoTaskSkillCatalog.parse(manifest: "No header here.",
                                               folderName: "my-skill")
        XCTAssertEqual(entry.name, "my-skill")
        XCTAssertEqual(entry.description, "")
        XCTAssertEqual(entry.directive, "Use the my-skill skill:")
    }

    func testHeaderWithoutNameFallsBackToTheFolderName() {
        let manifest = "---\ndescription: Does a thing\n---\n\nBody."
        let entry = AutoTaskSkillCatalog.parse(manifest: manifest, folderName: "fallback")
        XCTAssertEqual(entry.name, "fallback")
        XCTAssertEqual(entry.description, "Does a thing")
    }

    func testScanReadsSkillFoldersFromDisk() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("auto-task-skills-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let skills = root.appendingPathComponent(".claude/skills")
        for name in ["beta-skill", "alpha-skill"] {
            let dir = skills.appendingPathComponent(name)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try "---\nname: \(name)\ndescription: d\n---\n\nBody."
                .write(to: dir.appendingPathComponent("SKILL.md"),
                       atomically: true, encoding: .utf8)
        }
        // A folder with no manifest is not a skill the CLI can invoke.
        try FileManager.default.createDirectory(
            at: skills.appendingPathComponent("not-a-skill"), withIntermediateDirectories: true)

        let found = AutoTaskSkillCatalog.scan(projectRoot: root)
        XCTAssertEqual(found.map(\.name), ["alpha-skill", "beta-skill"])
    }

    func testScanOfAProjectWithoutSkillsIsEmpty() {
        XCTAssertTrue(AutoTaskSkillCatalog.scan(
            projectRoot: FileManager.default.temporaryDirectory
                .appendingPathComponent("missing-\(UUID().uuidString)")).isEmpty)
    }
}
