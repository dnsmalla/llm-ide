import XCTest
@testable import LlmIdeMacLib

@MainActor
final class LoopRunQueueTests: XCTestCase {

    override func tearDown() {
        LoopRunQueue._resetForTesting()
        super.tearDown()
    }

    func testAcquireReleaseAllowsSecondCaller() async throws {
        let root = "/tmp/loop-queue-\(UUID().uuidString)"
        try await LoopRunQueue.acquire(rootKey: root)
        XCTAssertTrue(LoopRunQueue.isActive(rootKey: root))

        let second = Task {
            try await LoopRunQueue.acquire(rootKey: root)
        }
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(LoopRunQueue.queuedCount(rootKey: root), 1)

        LoopRunQueue.release(rootKey: root)
        try await second.value
        XCTAssertTrue(LoopRunQueue.isActive(rootKey: root))

        LoopRunQueue.release(rootKey: root)
        XCTAssertFalse(LoopRunQueue.isActive(rootKey: root))
    }

    func testCancellationRemovesWaiterWithoutAcquiring() async {
        let root = "/tmp/loop-queue-\(UUID().uuidString)"
        try await LoopRunQueue.acquire(rootKey: root)

        let cancelled = Task {
            try await LoopRunQueue.acquire(rootKey: root)
        }
        try await Task.sleep(nanoseconds: 50_000_000)
        cancelled.cancel()

        do {
            _ = try await cancelled.value
            XCTFail("expected CancellationError")
        } catch is CancellationError {
            // expected
        } catch {
            XCTFail("unexpected error: \(error)")
        }

        XCTAssertEqual(LoopRunQueue.queuedCount(rootKey: root), 0)
        XCTAssertTrue(LoopRunQueue.isActive(rootKey: root))
        LoopRunQueue.release(rootKey: root)
    }
}
