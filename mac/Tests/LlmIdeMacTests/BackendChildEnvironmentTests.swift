import XCTest
@testable import LlmIdeMacLib

/// The backend child's environment carries the user's ACTIVE feature set as
/// `LLMIDE_FEATURES`, and only ever the app's own value: the `LLMIDE_` prefix
/// allowlist would otherwise forward a stale list the app was launched with.
final class BackendChildEnvironmentTests: XCTestCase {
    private let base: [String: String] = [
        "PATH": "/usr/bin:/bin",
        "HOME": "/Users/tester",
        "LLMIDE_OTHER": "kept",
        "AWS_SECRET_ACCESS_KEY": "must-not-leak",
    ]

    func testFeatureKeysAreWrittenSortedAndCommaJoined() {
        let env = BackendManager.childEnvironment(base: base, featureKeys: ["auto_tasks", "agent_chat"])
        XCTAssertEqual(env["LLMIDE_FEATURES"], "agent_chat,auto_tasks")
    }

    func testNilFeatureKeysLeaveTheVariableUnset() {
        let env = BackendManager.childEnvironment(base: base, featureKeys: nil)
        XCTAssertNil(env["LLMIDE_FEATURES"])
    }

    func testInheritedFeatureListIsNeverPassedThrough() {
        var inherited = base
        inherited["LLMIDE_FEATURES"] = "code_graph_3d,terminal"

        let unset = BackendManager.childEnvironment(base: inherited, featureKeys: nil)
        XCTAssertNil(unset["LLMIDE_FEATURES"])

        let replaced = BackendManager.childEnvironment(base: inherited, featureKeys: ["agent_chat"])
        XCTAssertEqual(replaced["LLMIDE_FEATURES"], "agent_chat")
    }

    func testBenchFakeSwitchesAreNeverPassedThrough() {
        var inherited = base
        inherited["LLMIDE_BENCH_FAKE"] = "1"
        inherited["LLMIDE_BENCH_FAKE_TOKEN"] = "x"
        let env = BackendManager.childEnvironment(base: inherited, featureKeys: ["agent_chat"])
        XCTAssertNil(env["LLMIDE_BENCH_FAKE"])
        XCTAssertNil(env["LLMIDE_BENCH_FAKE_TOKEN"])
        XCTAssertEqual(env["LLMIDE_FEATURES"], "agent_chat")
    }

    func testAllowlistStillAppliesAroundTheFeatureKey() {
        let env = BackendManager.childEnvironment(base: base, featureKeys: ["agent_chat"])
        XCTAssertEqual(env["LLMIDE_OTHER"], "kept")
        XCTAssertNil(env["AWS_SECRET_ACCESS_KEY"])
        XCTAssertEqual(env["TERM"], "dumb")
        XCTAssertTrue(env["PATH"]?.hasPrefix("/Users/tester/.local/bin:") ?? false)
    }

    // MARK: - Data locations (LLMIDE_DATA_DIR)

    func testDataDirIsWrittenWhenGiven() {
        let env = BackendManager.childEnvironment(base: base, featureKeys: nil,
                                                  dataDir: "/Users/tester/Library/Application Support/llm-ide/system")
        XCTAssertEqual(env["LLMIDE_DATA_DIR"], "/Users/tester/Library/Application Support/llm-ide/system")
    }

    func testDataDirIsAbsentWithoutAnAppDir() {
        let env = BackendManager.childEnvironment(base: base, featureKeys: nil, dataDir: nil)
        XCTAssertNil(env["LLMIDE_DATA_DIR"])
    }

    func testInheritedDataLocationsAreNeverPassedThrough() {
        var inherited = base
        inherited["LLMIDE_DATA_DIR"] = "/Users/someone/checkout/kb"
        inherited["LLMIDE_DB_PATH"] = "/Users/someone/checkout/kb/data.db"
        inherited["LLMIDE_AGENT_DB_PATH"] = "/Users/someone/checkout/kb/agent.db"

        let unset = BackendManager.childEnvironment(base: inherited, featureKeys: nil, dataDir: nil)
        XCTAssertNil(unset["LLMIDE_DATA_DIR"])
        XCTAssertNil(unset["LLMIDE_DB_PATH"])
        XCTAssertNil(unset["LLMIDE_AGENT_DB_PATH"])

        let set = BackendManager.childEnvironment(base: inherited, featureKeys: nil, dataDir: "/app/system")
        XCTAssertEqual(set["LLMIDE_DATA_DIR"], "/app/system")
        XCTAssertNil(set["LLMIDE_DB_PATH"])
        XCTAssertNil(set["LLMIDE_AGENT_DB_PATH"])
    }

    func testSystemDataDirIsCreatedPrivateUnderTheSupportRoot() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("llmide-support-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let path = BackendManager.systemDataDirForChild(useRepoKb: false, supportRoot: root)
        XCTAssertEqual(path, root.appendingPathComponent("system", isDirectory: true).path)
        let attrs = try FileManager.default.attributesOfItem(atPath: try XCTUnwrap(path))
        XCTAssertEqual((attrs[.posixPermissions] as? NSNumber)?.intValue, 0o700)
    }

    func testRepoKbEscapeGivesNoDataDir() {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("llmide-support-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        XCTAssertNil(BackendManager.systemDataDirForChild(useRepoKb: true, supportRoot: root))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path), "escape must not create the dir")
    }
}
