import XCTest
@testable import LlmIdeMacLib

/// The phone bridge must see only the ACTIVE project's custom tasks.
@MainActor
final class MobileAutoTaskBridgeScopeTests: XCTestCase {
    func testPhoneSeesOnlyActiveProjectsCustomTasks() {
        let name = "bridge-scope-\(UUID().uuidString)"
        let suite = UserDefaults(suiteName: name)!
        defer { UserDefaults().removePersistentDomain(forName: name) }

        var a = CustomAutoTask(name: "A", template: "p"); a.projectId = "projA"
        var b = CustomAutoTask(name: "B", template: "p"); b.projectId = "projB"
        a.save(in: suite); b.save(in: suite)

        let forA = MobileAutoTaskBridge.customTasks(activeProjectId: "projA", defaults: suite)
        XCTAssertEqual(forA.map(\.id), [a.id])
        let forB = MobileAutoTaskBridge.customTasks(activeProjectId: "projB", defaults: suite)
        XCTAssertEqual(forB.map(\.id), [b.id])
        XCTAssertTrue(MobileAutoTaskBridge.customTasks(activeProjectId: nil, defaults: suite).isEmpty)
    }
}
