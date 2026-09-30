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

    /// Cancel and release land in the same turn: the lock is handed to the
    /// waiter before its cancel hop runs. The waiter must give it back.
    func testCancelRacingReleaseDoesNotLeakTheLock() async throws {
        let root = "/tmp/loop-queue-\(UUID().uuidString)"
        try await LoopRunQueue.acquire(rootKey: root)
        let racer = Task { try await LoopRunQueue.acquire(rootKey: root) }
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(LoopRunQueue.queuedCount(rootKey: root), 1)

        racer.cancel()
        LoopRunQueue.release(rootKey: root)
        do { try await racer.value; XCTFail("a cancelled waiter must not acquire") }
        catch { XCTAssertTrue(error is CancellationError) }

        XCTAssertFalse(LoopRunQueue.isActive(rootKey: root), "lock leaked to a cancelled run")
        try await LoopRunQueue.acquire(rootKey: root)   // and is free for the next caller
    }

    func testCancellationRemovesWaiterWithoutAcquiring() async throws {
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
