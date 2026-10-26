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
}
