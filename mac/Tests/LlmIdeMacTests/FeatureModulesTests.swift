import XCTest
@testable import LlmIdeMacLib

@MainActor
private final class SpyService: FeatureService {
    var startCount = 0
    var stopCount = 0
    func start() { startCount += 1 }
    func stop() { stopCount += 1 }
}

@MainActor
final class FeatureModulesTests: XCTestCase {

    func testChatModuleGatesOnAuth() {
        let spy = SpyService()
        let module = ChatModule(mirror: spy, isAuthenticated: { true })
        XCTAssertTrue(module.runtimeReady)
        XCTAssertEqual(module.feature, .agentChat)
        module.start()
        XCTAssertEqual(spy.startCount, 1)
    }

    func testPassiveModuleCoversViewOnlyFeatures() {
        let module = PassiveModule(feature: .terminal)
        XCTAssertEqual(module.feature, .terminal)
        module.start()   // must be a no-op, must not crash
        module.stop()
    }
}
