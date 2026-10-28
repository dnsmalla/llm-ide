import XCTest
@testable import LlmIdeMacLib

@MainActor
final class DocGenOutputConfigTests: XCTestCase {

    func testOnlyLocalFolderIsAvailable() {
        XCTAssertTrue(DocGenOutputDestination.localFolder.isAvailable)
        for dest in [DocGenOutputDestination.box, .slack, .email] {
            XCTAssertFalse(dest.isAvailable, "\(dest) must render as coming soon")
        }
    }

    /// The default is human-readable output, so it lives under `llm-doc/` (D4/D5),
    /// not `data/`.
    func testResolvedDirectoryDefaultsToLlmDocGenerated() {
        let root = URL(fileURLWithPath: "/tmp/proj", isDirectory: true)
        let config = DocGenOutputConfig()
        let resolved = config.resolvedDirectory(projectRoot: root)
        XCTAssertEqual(resolved, ProjectLayout(root: root).generatedDocsDir)
        XCTAssertEqual(resolved?.path, root.appendingPathComponent("llm-doc/generated", isDirectory: true).path)
        XCTAssertNotEqual(resolved, ProjectLayout(root: root).dataDir)
    }

    /// A folder saved before the default moved keeps working: the stored path wins
    /// over the new `llm-doc/generated/` default, with no migration.
    func testSavedCustomPathStillWinsOverNewDefault() {
        var config = DocGenOutputConfig()
        config.localFolderPath = "/tmp/legacy-data-folder"
        let root = URL(fileURLWithPath: "/tmp/proj", isDirectory: true)
        XCTAssertEqual(config.resolvedDirectory(projectRoot: root),
                       URL(fileURLWithPath: "/tmp/legacy-data-folder", isDirectory: true))
    }

    /// The scaffolder creates the default folder on open, so the first Doc Gen save
    /// has a home. The folder is the one the default resolves to.
    func testScaffolderRequiresTheGeneratedDocsFolder() {
        XCTAssertTrue(ProjectScaffolder.requiredDirectories.contains("llm-doc/generated"))
    }

    func testResolvedDirectoryPrefersExplicitPath() {
        var config = DocGenOutputConfig()
        config.localFolderPath = "/tmp/custom-out"
        // `isDirectory: true` so the expected URL carries the trailing slash
        // the resolver produces. `URL` compares the string form, so
        // "/tmp/custom-out" and "/tmp/custom-out/" are unequal despite naming
        // the same directory — without this the assertion fails on a purely
        // cosmetic difference.
        XCTAssertEqual(config.resolvedDirectory(projectRoot: URL(fileURLWithPath: "/tmp/proj")),
                       URL(fileURLWithPath: "/tmp/custom-out", isDirectory: true))
    }

    func testResolvedDirectoryIsNilWithNoProjectAndNoPath() {
        XCTAssertNil(DocGenOutputConfig().resolvedDirectory(projectRoot: nil))
    }

    func testStoreKeepsConfigPerProject() {
        let tempDir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("doc-gen-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let store = DocGenOutputStore(storeDirectory: tempDir)
        let a = URL(fileURLWithPath: "/tmp/proj-a")
        let b = URL(fileURLWithPath: "/tmp/proj-b")

        store.activate(projectRoot: a)
        var configA = store.config
        configA.localFolderPath = "/tmp/out-a"
        store.update(configA)

        store.activate(projectRoot: b)
        XCTAssertNil(store.config.localFolderPath, "project b must not inherit a's folder")

        store.activate(projectRoot: a)
        XCTAssertEqual(store.config.localFolderPath, "/tmp/out-a")
    }

    func testSendCopyToEmailDefaultsOff() {
        XCTAssertFalse(DocGenOutputConfig().sendCopyToEmail)
    }

    func testPreexistingProjectDataSurvivesUpdate() {
        let tempDir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("doc-gen-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        // Pre-write a JSON file with project B's settings.
        let projectB = URL(fileURLWithPath: "/tmp/proj-b")
        var configB = DocGenOutputConfig()
        configB.localFolderPath = "/tmp/out-b"
        let initialData = try! JSONEncoder().encode([projectB.path: configB])
        try! FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        try! initialData.write(to: tempDir.appendingPathComponent("doc-gen-output.json"))

        // Construct a new store and update project A's config.
        let store = DocGenOutputStore(storeDirectory: tempDir)
        let projectA = URL(fileURLWithPath: "/tmp/proj-a")
        store.activate(projectRoot: projectA)
        var configA = store.config
        configA.localFolderPath = "/tmp/out-a"
        store.update(configA)

        // Verify project B's config was preserved.
        let savedData = try! Data(contentsOf: tempDir.appendingPathComponent("doc-gen-output.json"))
        let saved = try! JSONDecoder().decode([String: DocGenOutputConfig].self, from: savedData)
        XCTAssertEqual(saved[projectB.path]?.localFolderPath, "/tmp/out-b",
                       "project B's settings must survive after updating project A")
    }
}
