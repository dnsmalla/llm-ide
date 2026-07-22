import XCTest
@testable import SharedProtocol

final class MobileProtocolTests: XCTestCase {
    func testServiceTypeMatchesLlmIde() {
        XCTAssertEqual(MobileProtocol.serviceType, "_llmide._tcp")
    }

    func testDefaultPort() {
        XCTAssertEqual(MobileProtocol.defaultPort, 3006)
    }

    func testHeartbeatIntervals() {
        XCTAssertEqual(MobileProtocol.heartbeatInterval, 10)
        XCTAssertEqual(MobileProtocol.heartbeatTimeout, 25)
    }
}
