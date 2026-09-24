import XCTest
@testable import LlmIdeMacLib

/// `MobileControlManager.pinMatches` — the check behind the WebSocket
/// server's `validatePin`.
final class MobilePinValidationTests: XCTestCase {
    func testMatchesCurrentPin() {
        XCTAssertTrue(MobileControlManager.pinMatches(candidate: "123456", current: "123456"))
        XCTAssertFalse(MobileControlManager.pinMatches(candidate: "123457", current: "123456"))
        XCTAssertFalse(MobileControlManager.pinMatches(candidate: "1234567", current: "123456"))
    }

    func testOmittedLeadingZerosStillMatch() {
        XCTAssertTrue(MobileControlManager.pinMatches(candidate: "42", current: "000042"))
        XCTAssertFalse(MobileControlManager.pinMatches(candidate: "42x", current: "000042"))
    }

    /// No readable current PIN → reject everything; never fall back to a
    /// start-time PIN that may have been retired since.
    func testFailsClosedWhenCurrentPinUnreadable() {
        XCTAssertFalse(MobileControlManager.pinMatches(candidate: "123456", current: nil))
        XCTAssertFalse(MobileControlManager.pinMatches(candidate: "", current: nil))
        XCTAssertFalse(MobileControlManager.pinMatches(candidate: "", current: ""))
    }
}
