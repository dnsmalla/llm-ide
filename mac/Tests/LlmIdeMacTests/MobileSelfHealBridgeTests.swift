import XCTest
import SharedProtocol
@testable import LlmIdeMacLib

final class MobileSelfHealBridgeTests: XCTestCase {
    private func decide(_ a: SelfHealAction.Kind, status: String, proposal: Bool = true,
                        apply: Bool = true, busy: String? = nil) -> MobileSelfHealBridge.Decision {
        MobileSelfHealBridge.decide(action: a, status: status, hasProposal: proposal,
                                    applyAllowed: apply, busyReason: busy)
    }

    func testApplyNeedsTheSwitchAProposalAndAQuietCheckout() {
        XCTAssertEqual(decide(.apply, status: "proposed"), .allow)
        XCTAssertEqual(decide(.apply, status: "proposed", apply: false),
                       .refuse(PhoneAccess.selfHealApply.deniedMessage))
        if case .refuse = decide(.apply, status: "new", proposal: false) {} else { XCTFail() }
        if case .refuse = decide(.apply, status: "fixing") {} else { XCTFail("a fixing incident must never be touched") }
        XCTAssertEqual(decide(.apply, status: "proposed", busy: "loop running"), .refuse("loop running"))
    }

    func testBookkeepingActionsMirrorTheMacUI() {
        XCTAssertEqual(decide(.ignore, status: "new"), .allow)
        XCTAssertEqual(decide(.ignore, status: "needsHuman"), .allow)
        if case .refuse = decide(.ignore, status: "proposed") {} else { XCTFail() }
        XCTAssertEqual(decide(.retry, status: "ignored"), .allow)
        if case .refuse = decide(.retry, status: "fixing") {} else { XCTFail() }
        XCTAssertEqual(decide(.discard, status: "proposed", apply: false), .allow, "discard needs no switch")
    }

    func testStateIsCappedRedactedAndPathFree() throws {
        let proposal = IncidentProposal(mainRepo: "/Users/me/llm-ide", worktreePath: "/Users/me/wt",
                                        branch: "self-heal/abc", baseCommit: "deadbeef")
        var incidents: [Incident] = []
        for n in 0..<80 {
            let isTop = n == 79
            let longMessage: String = String(repeating: "m", count: 900)
            let seen: Date = Date(timeIntervalSince1970: Double(n))
            let note: String? = isTop ? "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 in /Users/me/x" : nil
            let status: IncidentStatus = isTop ? .proposed : .new
            incidents.append(Incident(
                id: String(format: "%016x", n), source: .crash, category: "c", message: longMessage,
                stack: "secret stack", firstSeen: Date(timeIntervalSince1970: 1), lastSeen: seen,
                count: 1, attempts: 0, status: status, note: note, proposal: isTop ? proposal : nil))
        }
        let state = MobileSelfHealBridge.state(incidents: incidents, canApply: false, enabled: true,
                                               message: nil, error: nil)
        XCTAssertEqual(state.incidents.count, MobileSelfHealBridge.maxIncidents)
        XCTAssertEqual(state.incidents.first?.id, String(format: "%016x", 79))     // newest first
        XCTAssertEqual(state.incidents.first?.message.count, MobileSelfHealBridge.maxMessage)
        XCTAssertEqual(state.incidents.first?.branch, "self-heal/abc")
        let json = String(data: try JSONEncoder().encode(state), encoding: .utf8)!
        XCTAssertFalse(json.contains("secret stack"), "stacks never leave the Mac")
        XCTAssertFalse(json.contains("/Users/me"), "no absolute paths")
        XCTAssertFalse(json.contains("ghp_abcdefghijklmnopqrstuvwxyz"), "note must be redacted")
    }

    func testDiffIsRedactedCappedAndFastEvenWithAPathologicalLine() {
        // A real-looking diff, a secret, then ONE enormous unbroken token (the quadratic-regex case).
        var raw = "+token=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n"
        raw += (0..<3_000).map { "+let value\($0) = \($0)" }.joined(separator: "\n")
        raw += "\n+" + String(repeating: "x", count: 200_000) + "\n"
        let started = Date()
        let (text, truncated) = MobileSelfHealBridge.shapeDiff(raw)
        XCTAssertLessThan(Date().timeIntervalSince(started), 5, "was ~7 minutes before per-line capping")
        XCTAssertTrue(truncated)
        XCTAssertTrue(text.contains("[line truncated]"))
        XCTAssertFalse(text.contains("ghp_abcdefghijklmnopqrstuvwxyz"))
        XCTAssertLessThanOrEqual(text.count, MobileSelfHealBridge.maxDiffChars)
    }

    func testShortDiffPassesThroughUntouchedExceptSecrets() {
        let (text, truncated) = MobileSelfHealBridge.shapeDiff("+a\n-b\n c")
        XCTAssertEqual(text, "+a\n-b\n c")
        XCTAssertFalse(truncated)
    }
}
