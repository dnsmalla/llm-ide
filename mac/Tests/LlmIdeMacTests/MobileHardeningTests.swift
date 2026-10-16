import XCTest
@testable import LlmIdeMacLib

/// Pure pieces of the 2026-10 mobile hardening pass: the log policy (never
/// frame content), frame routing for a torn-down connection, the chat-deletion
/// switch, and the session identity the Self-Heal review cache binds to.
final class MobileHardeningTests: XCTestCase {

    // MARK: - MobileLogPolicy

    func testFrameLabelShowsTypeAndSizeButNoContent() {
        let frame = Data(#"{"type":"llmide_chat","text":"my secret plan sk-ant-123"}"#.utf8)
        let label = MobileLogPolicy.frameLabel(frame)
        XCTAssertEqual(label, "type='llmide_chat', \(frame.count) bytes")
        XCTAssertFalse(label.contains("secret"))
    }

    func testFrameLabelWithoutTypeNeverEchoesTheFrame() {
        let frame = Data(String(repeating: "x", count: 100_000).utf8)
        XCTAssertEqual(MobileLogPolicy.frameLabel(frame), "no type, 100000 bytes")
        XCTAssertEqual(MobileLogPolicy.frameLabel(nil), "no data")
    }

    func testTypeLabelStripsNonTagCharactersAndCaps() {
        XCTAssertEqual(MobileLogPolicy.typeLabel("explore_chat"), "explore_chat")
        XCTAssertEqual(MobileLogPolicy.typeLabel("a b\n<script>"), "abscript")
        XCTAssertEqual(MobileLogPolicy.typeLabel("  "), "?")
        let long = MobileLogPolicy.typeLabel(String(repeating: "a", count: 1_000))
        XCTAssertEqual(long.count, MobileLogPolicy.maxTypeLabel + 1)   // + the ellipsis
    }

    func testCapLineBoundsEveryLine() {
        XCTAssertEqual(MobileLogPolicy.capLine("short"), "short")
        let capped = MobileLogPolicy.capLine(String(repeating: "y", count: 10_000))
        XCTAssertLessThan(capped.count, MobileLogPolicy.maxLineLength + 40)
        XCTAssertTrue(capped.hasSuffix("chars cut]"))
    }

    func testOutboundLabelNamesTheTypeOnly() {
        struct FakeReply: Encodable { let text = "file contents" }
        let label = MobileLogPolicy.outboundLabel(FakeReply(), byteCount: 42)
        XCTAssertEqual(label, "FakeReply, 42 bytes")
    }

    // MARK: - Frame routing after revoke / replace

    func testFrameRoute() {
        XCTAssertEqual(MobileWebSocketServer.frameRoute(isClient: true, isPaired: true, isChallenger: false), .app)
        XCTAssertEqual(MobileWebSocketServer.frameRoute(isClient: false, isPaired: false, isChallenger: true), .pairing)
        // Revoked / replaced / stopped: no longer the client, not a challenger.
        XCTAssertEqual(MobileWebSocketServer.frameRoute(isClient: false, isPaired: false, isChallenger: false), .drop)
        XCTAssertEqual(MobileWebSocketServer.frameRoute(isClient: false, isPaired: true, isChallenger: false), .drop)
        // The client slot without `paired` must never reach the app.
        XCTAssertEqual(MobileWebSocketServer.frameRoute(isClient: true, isPaired: false, isChallenger: false), .drop)
    }

    // MARK: - Chat deletion switch

    func testChatDeletionFollowsExploreEditAndDefaultsOff() {
        XCTAssertEqual(MobileControlManager.chatDeletionSwitch, .exploreEdit)
        XCTAssertFalse(MobileControlManager.chatDeletionSwitch.defaultsOn)
        XCTAssertFalse(MobileControlManager.chatDeletionAllowed { _ in false })
        XCTAssertTrue(MobileControlManager.chatDeletionAllowed { $0 == .exploreEdit })
        XCTAssertFalse(MobileControlManager.chatDeletionAllowed { $0 == .fileBrowse })
    }

    // MARK: - Session identity for the reviewed-patch cache

    func testTwoPinOnlySessionsGetDistinctIdentities() {
        let first = MobileControlManager.makePhoneSessionIdentity(generation: 1, deviceId: nil)
        let second = MobileControlManager.makePhoneSessionIdentity(generation: 2, deviceId: nil)
        XCTAssertNotEqual(first, second)
    }

    func testReviewFromOnePinOnlySessionIsNotHeldForAnother() {
        let proposal = IncidentProposal(mainRepo: "/r", worktreePath: "/w/a", branch: "a", baseCommit: "abc")
        let patch = SelfHealProposalService.ReviewedPatch(text: "diff", binaryPatch: Data("p".utf8))
        let now = Date()
        var cache = ReviewedPatchCache()
        let sessionA = MobileControlManager.makePhoneSessionIdentity(generation: 1, deviceId: nil)
        let sessionB = MobileControlManager.makePhoneSessionIdentity(generation: 2, deviceId: nil)
        cache.store(patch, for: "i1", proposal: proposal, deviceId: sessionA, now: now)
        guard case .missing = cache.lookup(for: "i1", proposal: proposal, deviceId: sessionB, now: now) else {
            return XCTFail("a review from another PIN-only session must not be held")
        }
        guard case .held = cache.lookup(for: "i1", proposal: proposal, deviceId: sessionA, now: now) else {
            return XCTFail("the reviewing session itself must still find its patch")
        }
    }
}
