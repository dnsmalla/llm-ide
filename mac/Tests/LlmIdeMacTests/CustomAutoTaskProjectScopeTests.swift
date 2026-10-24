import XCTest
@testable import LlmIdeMacLib

/// Project scoping of custom auto-tasks.
final class CustomAutoTaskProjectScopeTests: XCTestCase {
    private var suiteName: String!
    private var suite: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "custom-auto-task-scope-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName)
        suite = nil
        super.tearDown()
    }

    func testLegacyJSONDecodesWithNilProjectId() throws {
        let json = #"{"id":"a","name":"N","template":"T"}"#.data(using: .utf8)!
        let task = try JSONDecoder().decode(CustomAutoTask.self, from: json)
        XCTAssertNil(task.projectId)
    }

    func testProjectIdRoundTrips() {
        CustomAutoTask(name: "N", template: "T", projectId: "p1").save(in: suite)
        XCTAssertEqual(CustomAutoTask.loadAll(from: suite).first?.projectId, "p1")
    }

    func testLoadForProjectFilters() {
        CustomAutoTask(name: "A", template: "T", projectId: "p1").save(in: suite)
        CustomAutoTask(name: "B", template: "T", projectId: "p2").save(in: suite)
        XCTAssertEqual(CustomAutoTask.loadAll(forProject: "p1", from: suite).map(\.name), ["A"])
        XCTAssertTrue(CustomAutoTask.loadAll(forProject: nil, from: suite).isEmpty)
    }

    func testAdoptLegacyStampsOnceAndLeavesOthers() {
        CustomAutoTask(name: "Old", template: "T").save(in: suite)
        CustomAutoTask(name: "Other", template: "T", projectId: "p2").save(in: suite)
        XCTAssertEqual(CustomAutoTask.adoptLegacyTasks(into: "p1", in: suite), 1)
        XCTAssertEqual(CustomAutoTask.loadAll(forProject: "p1", from: suite).map(\.name), ["Old"])
        XCTAssertEqual(CustomAutoTask.loadAll(forProject: "p2", from: suite).map(\.name), ["Other"])
        XCTAssertEqual(CustomAutoTask.adoptLegacyTasks(into: "p3", in: suite), 0)
        XCTAssertTrue(CustomAutoTask.loadAll(forProject: "p3", from: suite).isEmpty)
    }
}
