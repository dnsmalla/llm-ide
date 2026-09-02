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
final class GraphModuleTests: XCTestCase {

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
}
