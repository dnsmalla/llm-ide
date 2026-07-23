import XCTest
@testable import SharedProtocol

final class ConnectionMessagesTests: XCTestCase {
    private func roundTrip<T: Codable & Equatable>(_ value: T) throws -> T {
        let data = try JSONEncoder().encode(value)
        return try JSONDecoder().decode(T.self, from: data)
    }

    func testHeartbeatHasTypeTag() throws {
        let data = try JSONEncoder().encode(Heartbeat())
        let json = try XCTUnwrap(String(data: data, encoding: .utf8))
        XCTAssertEqual(json, #"{"type":"heartbeat"}"#)
    }

    func testHeartbeatAckRoundTrips() throws {
        let original = HeartbeatAck(ts: 1_700_000_000)
        let decoded = try roundTrip(original)
        XCTAssertEqual(decoded, original)
        XCTAssertEqual(decoded.type, "heartbeat_ack")
    }

    func testConnectedRoundTrips() throws {
        let original = Connected(deviceName: "Dinesh's Mac")
        let decoded = try roundTrip(original)
        XCTAssertEqual(decoded, original)
        XCTAssertEqual(decoded.type, "connected")
    }

    func testAuthFailedRoundTrips() throws {
        let original = AuthFailed(message: "Wrong PIN")
        let decoded = try roundTrip(original)
        XCTAssertEqual(decoded, original)
        XCTAssertEqual(decoded.type, "auth_failed")
    }

    func testPairingRoundTrips() throws {
        let original = Pairing(pin: "123456")
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(Pairing.self, from: data)
        XCTAssertEqual(decoded, original)
        XCTAssertEqual(decoded.type, "pairing")
        XCTAssertEqual(decoded.pin, "123456")
    }
}
