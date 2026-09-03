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
final class AutoTaskModuleTests: XCTestCase {

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
}
