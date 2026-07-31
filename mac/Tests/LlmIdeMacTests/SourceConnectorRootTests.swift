import XCTest
@testable import LlmIdeMacLib

/// `sourceConnectorRootOverride` is the per-project base path under which all
/// Source Connectors store data (`<root>/<inboxFolder>/`, `<root>/llm-doc/`).
/// When unset, `SourceContext.sourceConnectorRoot` falls back to the `root`
/// the ingest service is constructed with — i.e. today's behavior. Uses a
/// throwaway UserDefaults suite so nothing leaks between tests.
@MainActor
final class SourceConnectorRootTests: XCTestCase {
    private var suiteName: String!
    private var suite: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "sc-root-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName)
        suite = nil
        super.tearDown()
    }

    func testOverridePersistsAcrossInstances() {
        let elsewhere = FileManager.default.temporaryDirectory
            .appendingPathComponent("elsewhere-\(UUID().uuidString)")

        let a = AppConfig(userDefaults: suite)
        a.sourceConnectorRootOverride = elsewhere
        XCTAssertEqual(a.sourceConnectorRootOverride, elsewhere)

        // A freshly-constructed AppConfig over the same suite must observe the
        // persisted override — this is what survives an app relaunch.
        let b = AppConfig(userDefaults: suite)
        XCTAssertEqual(b.sourceConnectorRootOverride, elsewhere)
    }

    func testClearingOverridePersists() {
        let elsewhere = FileManager.default.temporaryDirectory
            .appendingPathComponent("elsewhere-clear-\(UUID().uuidString)")

        let a = AppConfig(userDefaults: suite)
        a.sourceConnectorRootOverride = elsewhere
        XCTAssertEqual(a.sourceConnectorRootOverride, elsewhere)

        a.sourceConnectorRootOverride = nil
        XCTAssertNil(a.sourceConnectorRootOverride)

        let b = AppConfig(userDefaults: suite)
        XCTAssertNil(b.sourceConnectorRootOverride)
    }

    func testSourceContextDefaultsToRootWhenOverrideNil() {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("root-\(UUID().uuidString)")
        let config = AppConfig(userDefaults: suite)
        XCTAssertNil(config.sourceConnectorRootOverride)

        let api = LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456")
        let ctx = SourceContext(api: api, config: config, root: root,
                                notesOutputFolder: root.appendingPathComponent("llm-doc"))
        // No override passed → falls back to `root` (today's behavior).
        XCTAssertEqual(ctx.sourceConnectorRoot, root)
    }

    func testSourceContextHonorsExplicitOverride() {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("root2-\(UUID().uuidString)")
        let elsewhere = FileManager.default.temporaryDirectory
            .appendingPathComponent("elsewhere2-\(UUID().uuidString)")

        let config = AppConfig(userDefaults: suite)
        config.sourceConnectorRootOverride = elsewhere
        let api = LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456")
        let ctx = SourceContext(api: api, config: config, root: root,
                                notesOutputFolder: root.appendingPathComponent("llm-doc"),
                                sourceConnectorRoot: config.sourceConnectorRootOverride)
        XCTAssertEqual(ctx.sourceConnectorRoot, elsewhere)
    }
}
