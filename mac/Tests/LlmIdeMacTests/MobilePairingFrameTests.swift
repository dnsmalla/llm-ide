import Testing
import Foundation
import SharedProtocol
@testable import LlmIdeMacLib

/// `isPairingFrame` gates every pairing attempt, so a real encoded `Pairing`
/// MUST pass it — if `Pairing` ever stopped emitting its `type` field, every
/// pairing would be refused AND charged a throttle failure, locking users out
/// of their own Mac.
struct MobilePairingFrameTests {

    @Test("a real encoded Pairing frame passes the envelope gate")
    func realPairingFrameAccepted() throws {
        let data = try JSONEncoder().encode(Pairing(pin: "123456"))
        #expect(MobileWebSocketServer.isPairingFrame(data))
    }

    // The gate exists because `decode(Pairing.self)` does NOT validate `type`:
    // any JSON carrying a `pin` field would otherwise be treated as a pairing
    // attempt (and every non-pairing frame on an unpaired socket too).
    @Test("frames that merely carry a pin, or another type, are refused")
    func foreignFramesRefused() throws {
        #expect(!MobileWebSocketServer.isPairingFrame(Data(#"{"pin":"123456"}"#.utf8)))
        #expect(!MobileWebSocketServer.isPairingFrame(try JSONEncoder().encode(Heartbeat())))
        #expect(!MobileWebSocketServer.isPairingFrame(Data("not json".utf8)))
    }

    /// The token form of `Pairing` (pin empty, token + deviceId set) rides the
    /// same tag, so it must pass the same gate — otherwise every reconnect of
    /// an already-paired phone would be refused and charged a throttle failure.
    @Test("the token form of Pairing passes the envelope gate too")
    func tokenFormAccepted() throws {
        let data = try JSONEncoder().encode(
            Pairing(pin: "", token: "tok", deviceId: "dev-1", deviceName: "iPhone"))
        #expect(MobileWebSocketServer.isPairingFrame(data))
    }

    /// Device ids come from the phone. A UUID is what we expect; whitespace is
    /// noise, empty means "legacy phone, no token", and something absurdly long
    /// is not an id at all.
    @Test("cleanDeviceId normalises phone-supplied ids and rejects junk")
    func cleanDeviceId() {
        #expect(MobileWebSocketServer.cleanDeviceId("  ABC-123 \n") == "ABC-123")
        #expect(MobileWebSocketServer.cleanDeviceId(nil) == nil)
        #expect(MobileWebSocketServer.cleanDeviceId("") == nil)
        #expect(MobileWebSocketServer.cleanDeviceId("   ") == nil)
        #expect(MobileWebSocketServer.cleanDeviceId(String(repeating: "x", count: 129)) == nil)
        #expect(MobileWebSocketServer.cleanDeviceId(String(repeating: "x", count: 128)) != nil)
    }

    /// A throttle/lockout refusal must be marked retryable so the phone keeps a
    /// PIN it was never given the chance to prove.
    @Test("AuthFailed carries retryable across the wire; absent decodes as nil")
    func retryableRoundTrips() throws {
        let encoded = try JSONEncoder().encode(AuthFailed(message: "slow down", retryable: true))
        #expect(try JSONDecoder().decode(AuthFailed.self, from: encoded).retryable == true)

        let legacy = Data(#"{"type":"auth_failed","message":"Wrong PIN"}"#.utf8)
        #expect(try JSONDecoder().decode(AuthFailed.self, from: legacy).retryable == nil)
    }
}
