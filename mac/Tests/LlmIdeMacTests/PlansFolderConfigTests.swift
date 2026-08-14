import XCTest
@testable import LlmIdeMacLib

final class PlansFolderConfigTests: XCTestCase {

    /// Each test gets its own UserDefaults suite so the global Plans-folder
    /// setting is isolated from any real app state on the machine running
    /// tests — and torn down afterwards so suites don't leak plists per run.
    private func makeConfig() -> PlansFolderConfig {
        let suiteName = "plans-cfg-test-\(UUID().uuidString)"
        let suite = UserDefaults(suiteName: suiteName)!
        addTeardownBlock {
            suite.removePersistentDomain(forName: suiteName)
        }
        return PlansFolderConfig(userDefaults: suite)
    }

    // MARK: - Default

    func testDefaultFolderLivesUnderDocumentsRootNamedPlans() {
        let plans = makeConfig()
        let def = plans.defaultFolder()
        XCTAssertEqual(def.lastPathComponent, "Plans")
        XCTAssertEqual(def.deletingLastPathComponent().path,
                       AppIdentity.documentsRoot().path)
    }

    func testCurrentFolderFallsBackToDefaultWhenUnset() {
        let plans = makeConfig()
        XCTAssertEqual(plans.currentFolder.path, plans.defaultFolder().path)
    }

    // MARK: - setFolder (security-scoped bookmark)

    func testSetFolderResolvesBackToSameFolderViaBookmark() throws {
        let plans = makeConfig()
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("planscfg-bm-\(UUID().uuidString)", isDirectory: true)

        try plans.setFolder(tmp)

        XCTAssertEqual(plans.currentFolder.standardizedFileURL.path,
                       tmp.standardizedFileURL.path)
    }
}
