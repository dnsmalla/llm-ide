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

    func testMobileModuleRespectsControlEnabledAndAutoStart() {
        let spy = SpyService()
        let module = MobileModule(
            manager: spy, controlEnabled: { true }, autoStart: { false })
        XCTAssertTrue(module.runtimeReady)  // default: registry tracks the feature flag alone
        module.start()
        XCTAssertEqual(spy.startCount, 0)   // autoStart off → no server launch
        module.stop()
        XCTAssertEqual(spy.stopCount, 1)    // stop always stops the server

        let disabled = MobileModule(
            manager: spy, controlEnabled: { false }, autoStart: { true })
        XCTAssertTrue(disabled.runtimeReady)
        disabled.start()
        XCTAssertEqual(spy.startCount, 0)   // control disabled → no server launch
    }

    func testPassiveModuleCoversViewOnlyFeatures() {
        let module = PassiveModule(feature: .terminal)
        XCTAssertEqual(module.feature, .terminal)
        module.start()   // must be a no-op, must not crash
        module.stop()
    }
}
