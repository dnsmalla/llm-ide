import XCTest
@testable import LlmIdeMacLib

/// Phone-started implement / review-merge need the person at the Mac to confirm.
@MainActor
final class PhoneDesktopApprovalGateTests: XCTestCase {
    private let request = PhoneDesktopApprovalRequest(title: "t", lines: ["Project: P"])

    func testAnswersMapToOutcomes() async {
        let allow = PhoneDesktopApprovalGate(presenter: { _, _ in true })
        let deny = PhoneDesktopApprovalGate(presenter: { _, _ in false })
        let silent = PhoneDesktopApprovalGate(presenter: { _, _ in nil })
        let a = await allow.request(request)
        let d = await deny.request(request)
        let s = await silent.request(request)
        XCTAssertEqual(a, .approved)
        XCTAssertEqual(d, .denied)
        XCTAssertEqual(s, .timedOut, "no answer is a denial")
    }

    func testTheGateHandsThePresenterTheOneTwentySecondLimit() async {
        var seen: TimeInterval = 0
        let gate = PhoneDesktopApprovalGate(presenter: { _, t in seen = t; return false })
        _ = await gate.request(request)
        XCTAssertEqual(seen, 120)
    }

    func testOnlyOneDialogAtATime() async {
        var release: CheckedContinuation<Bool?, Never>?
        let gate = PhoneDesktopApprovalGate(presenter: { _, _ in
            await withCheckedContinuation { release = $0 }
        })
        let first = Task { await gate.request(request) }
        while release == nil { await Task.yield() }
        XCTAssertTrue(gate.isShowing)
        let second = await gate.request(request)
        XCTAssertEqual(second, .busy)
        release?.resume(returning: true)
        let r = await first.value
        XCTAssertEqual(r, .approved)
        XCTAssertFalse(gate.isShowing)
    }

    func testRateLimitedThenRecovers() async {
        var clock = Date(timeIntervalSince1970: 1_000_000)
        let gate = PhoneDesktopApprovalGate(now: { clock }, presenter: { _, _ in false })
        for _ in 0..<PhoneDesktopApprovalGate.maxPerWindow {
            let o = await gate.request(request)
            XCTAssertEqual(o, .denied)
        }
        let limited = await gate.request(request)
        XCTAssertEqual(limited, .busy, "a phone cannot spam the desktop with prompts")
        clock = clock.addingTimeInterval(PhoneDesktopApprovalGate.window + 1)
        let later = await gate.request(request)
        XCTAssertEqual(later, .denied, "the window slides")
    }
}

