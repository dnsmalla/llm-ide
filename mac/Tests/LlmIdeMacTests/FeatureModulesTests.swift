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

    func testGraphModuleRoutesStartStopAndGatesOnAuth() {
        let spy = SpyService()
        var authed = false
        let module = GraphModule(updater: spy, isAuthenticated: { authed })
        XCTAssertFalse(module.runtimeReady)
        authed = true
        XCTAssertTrue(module.runtimeReady)
        module.start()
        module.stop()
        XCTAssertEqual(spy.startCount, 1)
        XCTAssertEqual(spy.stopCount, 1)
        XCTAssertEqual(module.feature, .codeGraph3D)
    }

    func testChatModuleGatesOnAuth() {
        let spy = SpyService()
        let module = ChatModule(mirror: spy, isAuthenticated: { true })
        XCTAssertTrue(module.runtimeReady)
        XCTAssertEqual(module.feature, .agentChat)
        module.start()
        XCTAssertEqual(spy.startCount, 1)
    }

    func testAutoTaskModuleStartsCaptureAlwaysSchedulerOnlyWhenEnabled() {
        let scheduler = SpyService()
        let capture = SpyService()
        var masterEnabled = false
        let module = AutoTaskModule(
            scheduler: scheduler, capture: capture,
            schedulerEnabled: { masterEnabled })
        module.start()
        XCTAssertEqual(capture.startCount, 1)
        XCTAssertEqual(scheduler.startCount, 0)   // master off → no cron arm
        module.stop()
        masterEnabled = true
        module.start()
        XCTAssertEqual(scheduler.startCount, 1)
        module.stop()
        XCTAssertEqual(scheduler.stopCount, 2)
        XCTAssertEqual(capture.stopCount, 2)
    }

    func testMobileModuleRespectsControlEnabledAndAutoStart() {
        let spy = SpyService()
        let module = MobileModule(
            manager: spy, controlEnabled: { true }, autoStart: { false })
        XCTAssertTrue(module.runtimeReady)
        module.start()
        XCTAssertEqual(spy.startCount, 0)   // autoStart off → no server launch
        module.stop()
        XCTAssertEqual(spy.stopCount, 1)    // stop always stops the server
    }

    func testPassiveModuleCoversViewOnlyFeatures() {
        let module = PassiveModule(feature: .terminal)
        XCTAssertEqual(module.feature, .terminal)
        module.start()   // must be a no-op, must not crash
        module.stop()
    }
}
