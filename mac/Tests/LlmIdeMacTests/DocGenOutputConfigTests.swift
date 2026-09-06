import XCTest
@testable import LlmIdeMac

@MainActor
final class DocGenOutputConfigTests: XCTestCase {

    func testOnlyLocalFolderIsAvailable() {
        XCTAssertTrue(DocGenOutputDestination.localFolder.isAvailable)
        for dest in [DocGenOutputDestination.box, .slack, .email] {
            XCTAssertFalse(dest.isAvailable, "\(dest) must render as coming soon")
        }
    }

    func testResolvedDirectoryDefaultsToProjectData() {
        let root = URL(fileURLWithPath: "/tmp/proj")
        let config = DocGenOutputConfig()
        XCTAssertEqual(config.resolvedDirectory(projectRoot: root),
                       ProjectLayout(root: root).dataDir)
    }

    func testResolvedDirectoryPrefersExplicitPath() {
        var config = DocGenOutputConfig()
        config.localFolderPath = "/tmp/custom-out"
        XCTAssertEqual(config.resolvedDirectory(projectRoot: URL(fileURLWithPath: "/tmp/proj")),
                       URL(fileURLWithPath: "/tmp/custom-out"))
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
