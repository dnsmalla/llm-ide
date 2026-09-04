import XCTest
@testable import LlmIdeMacLib

/// The one rule that makes search line-jump work at all: never hand Monaco a
/// reveal for a buffer that has no content yet.
///
/// `MonacoHost.Coordinator.applyPendingChanges` records a reveal request's
/// `id` as soon as it fires it, whether or not the editor had anything to
/// scroll. So a reveal issued against an empty buffer is not merely a no-op —
/// it BURNS the request, and the same request can never fire again.
final class MonacoRevealGateTests: XCTestCase {

    func testNilTargetIsNeverApplied() {
        XCTAssertFalse(MonacoRevealGate.shouldApply(target: nil, contentIsEmpty: false))
        XCTAssertFalse(MonacoRevealGate.shouldApply(target: nil, contentIsEmpty: true))
    }

    func testTargetIsHeldBackWhileTheBufferIsEmpty() {
        XCTAssertFalse(MonacoRevealGate.shouldApply(
            target: MonacoRevealRequest(line: 42), contentIsEmpty: true))
    }

    func testTargetIsAppliedOnceContentIsLoaded() {
        XCTAssertTrue(MonacoRevealGate.shouldApply(
            target: MonacoRevealRequest(line: 42), contentIsEmpty: false))
    }

    func testTwoRequestsForTheSameLineAreDistinctValues() {
        // This is why the parameter type is MonacoRevealRequest and not Int:
        // clicking the SAME result twice must still look like a change to
        // SwiftUI's .onChange and to the Coordinator's id diff.
        let first = MonacoRevealRequest(line: 7)
        let second = MonacoRevealRequest(line: 7)
        XCTAssertNotEqual(first, second)
    }
}
