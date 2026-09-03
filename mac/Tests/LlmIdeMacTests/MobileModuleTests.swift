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
final class MobileModuleTests: XCTestCase {

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
}
