import XCTest
@testable import LlmIdeMacLib

final class LoopEngineConfigTests: XCTestCase {
    private var suiteName: String!
    private var suite: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "loop-engine-config-test-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName)
        suite = nil
        super.tearDown()
    }

    func testLoadReturnsNilWhenNothingSaved() {
        XCTAssertNil(LoopEngineConfig.load(for: "proj-1", defaults: suite))
    }

    func testSaveThenLoadRoundTrips() {
        let config = LoopEngineConfig(
            stages: [LoopStage(name: "Regression", kind: .regressionSweep, command: nil, order: 0)],
            maxIterations: 7,
            consecutiveFailureStop: 3
        )
        config.save(for: "proj-1", defaults: suite)
        let loaded = LoopEngineConfig.load(for: "proj-1", defaults: suite)
        XCTAssertEqual(loaded, config)
    }

    func testDifferentProjectsDoNotShareConfig() {
        let a = LoopEngineConfig(stages: [], maxIterations: 5, consecutiveFailureStop: 2)
        a.save(for: "proj-a", defaults: suite)
        XCTAssertNil(LoopEngineConfig.load(for: "proj-b", defaults: suite))
        XCTAssertEqual(LoopEngineConfig.load(for: "proj-a", defaults: suite), a)
    }

    func testUserDefaultsKeyIsNamespacedByProjectId() {
        let config = LoopEngineConfig(stages: [])
        config.save(for: "abc-123", defaults: suite)
        XCTAssertNotNil(suite.data(forKey: "loopEngineConfig_abc-123"))
    }

    func testDefaultsAreFiveAndTwo() {
        let config = LoopEngineConfig(stages: [])
        XCTAssertEqual(config.maxIterations, 5)
        XCTAssertEqual(config.consecutiveFailureStop, 2)
    }
}
