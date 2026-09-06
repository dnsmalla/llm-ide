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
        let store = DocGenOutputStore()
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
}
