import XCTest
import Foundation
@testable import LlmIdeMacLib

/// Regression for the SharedProtocol `let type = "…"` Codable gotcha.
/// `routeInbound` detected heartbeats with `decode(Heartbeat.self)`, but the
/// synthesized `init(from:)` reads `type` without VALIDATING it — so every
/// chat / explorer / auto-task frame decoded successfully as a `Heartbeat`,
/// was swallowed (Mac sent `heartbeat_ack` and returned), and never reached
/// `handleInbound`. Live symptom: Mac showed nothing and never replied, on
/// every surface, and the iPhone spun to its timeout. Runtime fingerprint: the
/// explorer session files (`~/Library/Application Support/llm-ide/sessions/`)
/// stopped being written the day this greedy decode landed.
final class MobileWebSocketServerRoutingTests: XCTestCase {

    func testOnlyRealHeartbeatFramesAreDetectedAsHeartbeats() {
        // A genuine heartbeat frame → true.
        XCTAssertTrue(
            MobileWebSocketServer.isHeartbeatFrame(Data(#"{"type":"heartbeat"}"#.utf8))
        )

        // Every real app message MUST be false — these are not heartbeats.
        XCTAssertFalse(
            MobileWebSocketServer.isHeartbeatFrame(
                Data(#"{"type":"llmide_chat","commandId":"c1","text":"hi"}"#.utf8))
        )
        XCTAssertFalse(
            MobileWebSocketServer.isHeartbeatFrame(
                Data(#"{"type":"explore_chat","commandId":"c2","sessionId":"S","text":"hi"}"#.utf8))
        )
        XCTAssertFalse(
            MobileWebSocketServer.isHeartbeatFrame(
                Data(#"{"type":"auto_task_run","taskId":"review_code"}"#.utf8))
        )
        XCTAssertFalse(
            MobileWebSocketServer.isHeartbeatFrame(
                Data(#"{"type":"explore_list_sessions"}"#.utf8))
        )

        // Non-JSON and type-less frames are not heartbeats either.
        XCTAssertFalse(MobileWebSocketServer.isHeartbeatFrame(Data("not json".utf8)))
        XCTAssertFalse(MobileWebSocketServer.isHeartbeatFrame(Data(#"{"foo":"bar"}"#.utf8)))
    }

    /// Revoking every device (sign-out, "disconnect all") must drop whoever is
    /// connected — including a phone paired with the PIN alone, which has no
    /// device id and so matched none of the revoked ids. It kept issuing
    /// commands against the next account.
    func testRevokeAllDropsAPinOnlyClientThatHasNoDeviceId() {
        XCTAssertTrue(MobileWebSocketServer.disconnectMatches(clientDeviceId: nil, target: nil),
                      "a PIN-only client (no device id) is dropped by a revoke-all")
        XCTAssertTrue(MobileWebSocketServer.disconnectMatches(clientDeviceId: "phone-a", target: nil),
                      "an identified client is dropped by a revoke-all too")
    }

    func testRevokingOneDeviceDropsOnlyThatDevice() {
        XCTAssertTrue(MobileWebSocketServer.disconnectMatches(clientDeviceId: "phone-a", target: "phone-a"))
        XCTAssertFalse(MobileWebSocketServer.disconnectMatches(clientDeviceId: "phone-a", target: "phone-b"))
        XCTAssertFalse(MobileWebSocketServer.disconnectMatches(clientDeviceId: nil, target: "phone-a"),
                       "a PIN-only client is not the device being revoked in Settings")
    }
}
