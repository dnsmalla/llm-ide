import XCTest
@testable import LlmIdeMacLib

final class AutoCaptureTerminationTests: XCTestCase {
    func testIngestsWhenAuthenticatedWithAPI() {
        XCTAssertEqual(AutoCaptureService.terminationAction(hasAPI: true, isAuthenticated: true), .stopAndIngest)
    }

    func testStopsOnlyWhenLoggedOut() {
        XCTAssertEqual(AutoCaptureService.terminationAction(hasAPI: true, isAuthenticated: false), .stopOnly)
    }

    func testStopsOnlyWithoutAPI() {
        XCTAssertEqual(AutoCaptureService.terminationAction(hasAPI: false, isAuthenticated: true), .stopOnly)
    }
}
