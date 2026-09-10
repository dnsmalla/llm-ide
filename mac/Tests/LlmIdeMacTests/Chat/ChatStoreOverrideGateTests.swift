import Foundation
import Testing

/// Characterization suite for `ChatStoreOverrideGate` — the primitive three
/// override-driving suites now rest on. Its whole job is staying a correct
/// binary semaphore; a later "simplification" (notably converting it to an
/// actor, which is reentrant — see the gate's doc comment) would silently
/// reintroduce the cross-suite flake it exists to prevent, and these tests
/// are what makes that regression loud instead.
///
/// Each test drives its OWN gate instance (the init is open for exactly
/// this), never `.shared` — touching the shared gate from here would
/// serialize this suite against the engine suites for no benefit and one
/// more way to hang the run.
///
/// The "did the racer get in?" assertions use a settled-flag plus a short
/// sleep rather than awaiting the racer directly: awaiting would park the
/// test forever on the very regression being tested (a lost handoff), and a
/// hung suite is a much worse failure mode than a red `#expect`. 50 ms is
/// generous for a hop that takes microseconds when correct.
@MainActor
@Suite("ChatStoreOverrideGate", .serialized)
struct ChatStoreOverrideGateTests {

    @Test("A second acquire parks until the holder releases — mutual exclusion")
    func secondAcquireBlocksUntilRelease() async throws {
        let gate = ChatStoreOverrideGate()
        await gate.acquire()

        var entered = false
        let racer = Task {
            await gate.acquire()
            entered = true
            gate.release()
        }
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(!entered)

        gate.release()
        _ = await racer.value
        #expect(entered)
    }

    @Test("Every parked waiter eventually acquires — no lost wakeup on release")
    func noLostWakeup() async throws {
        let gate = ChatStoreOverrideGate()
        await gate.acquire()

        // Three racers park; a release hands off to ONE of them, and that
        // racer's own trailing release hands off to the next, down the queue.
        var settled = 0
        let racers = (1...3).map { _ in
            Task {
                await gate.acquire()
                settled += 1
                gate.release()
            }
        }
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(settled == 0)

        gate.release()
        for racer in racers { _ = await racer.value }
        #expect(settled == 3)
    }

    @Test("The documented acquire/defer pattern releases when the body throws")
    func deferPatternReleasesOnThrow() async throws {
        let gate = ChatStoreOverrideGate()
        struct Boom: Error {}
        do {
            await gate.acquire()
            defer { gate.release() }
            throw Boom()
        } catch {}

        var entered = false
        let racer = Task {
            await gate.acquire()
            entered = true
            gate.release()
        }
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(entered)
        _ = await racer.value
    }
}
