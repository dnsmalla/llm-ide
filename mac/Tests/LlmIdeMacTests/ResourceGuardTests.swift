import XCTest
@testable import LlmIdeMacLib

/// The ResourceGuard is now the ONLY thing that stops long-running local work on
/// its own — every wall-clock deadline that used to bound AI runs, spawned CLIs,
/// builds, and git was removed. That makes both directions of its decision
/// expensive to get wrong:
///
///  - Too eager, and it kills a healthy `swift build` that was about to pass,
///    which is exactly the failure the deadlines used to cause.
///  - Too lazy, and nothing stops a runaway job before the machine is unusable,
///    which is the only reason the guard exists.
///
/// So the sustained-pressure rule is tested directly, with injected timestamps
/// rather than sleeps.
final class MemoryPressureTrackerTests: XCTestCase {

    private let t0 = Date(timeIntervalSince1970: 1_000_000)

    func testNormalPressureNeverAborts() {
        var tracker = MemoryPressureTracker(abortAt: .critical, sustainedFor: 30)
        for i in 0..<100 {
            XCTAssertFalse(tracker.observe(.normal, at: t0.addingTimeInterval(Double(i))))
        }
    }

    func testWarningAloneNeverAbortsWhenThresholdIsCritical() {
        // macOS raises `.warning` routinely under ordinary load — a compile, a
        // big file open. Acting on it would make the guard indistinguishable
        // from the deadlines it replaced.
        var tracker = MemoryPressureTracker(abortAt: .critical, sustainedFor: 30)
        for i in 0..<600 {
            XCTAssertFalse(tracker.observe(.warning, at: t0.addingTimeInterval(Double(i))))
        }
    }

    func testFirstCriticalSightingDoesNotAbort() {
        var tracker = MemoryPressureTracker(abortAt: .critical, sustainedFor: 30)
        XCTAssertFalse(tracker.observe(.critical, at: t0),
                       "a momentary spike (a link step, a large read) must not kill work")
    }

    func testAbortsOnlyAfterPressureIsSustained() {
        var tracker = MemoryPressureTracker(abortAt: .critical, sustainedFor: 30)
        XCTAssertFalse(tracker.observe(.critical, at: t0))
        XCTAssertFalse(tracker.observe(.critical, at: t0.addingTimeInterval(29)),
                       "one second short of the window is still not enough")
        XCTAssertTrue(tracker.observe(.critical, at: t0.addingTimeInterval(30)),
                      "held for the full window — this is the machine in real trouble")
    }

    func testDroppingBelowThresholdClearsTheEpisode() {
        // Pressure that comes and goes must NOT accumulate toward a kill:
        // 29s of critical, a recovery, then 29s more is a machine that is coping.
        var tracker = MemoryPressureTracker(abortAt: .critical, sustainedFor: 30)
        XCTAssertFalse(tracker.observe(.critical, at: t0))
        XCTAssertFalse(tracker.observe(.critical, at: t0.addingTimeInterval(29)))
        XCTAssertFalse(tracker.observe(.normal, at: t0.addingTimeInterval(30)))
        XCTAssertFalse(tracker.observe(.critical, at: t0.addingTimeInterval(31)),
                       "the clock must restart, not resume")
        XCTAssertFalse(tracker.observe(.critical, at: t0.addingTimeInterval(60)))
        XCTAssertTrue(tracker.observe(.critical, at: t0.addingTimeInterval(61)),
                      "sustained for 30s measured from the NEW episode start")
    }

    func testWarningInterruptsACriticalEpisode() {
        var tracker = MemoryPressureTracker(abortAt: .critical, sustainedFor: 30)
        XCTAssertFalse(tracker.observe(.critical, at: t0))
        XCTAssertFalse(tracker.observe(.warning, at: t0.addingTimeInterval(10)))
        XCTAssertFalse(tracker.observe(.critical, at: t0.addingTimeInterval(40)),
                       "dropping to warning ended the episode; this is a fresh first sighting")
    }

    func testResetClearsPressure() {
        var tracker = MemoryPressureTracker(abortAt: .critical, sustainedFor: 30)
        _ = tracker.observe(.critical, at: t0)
        XCTAssertTrue(tracker.isUnderPressure)
        tracker.reset()
        XCTAssertFalse(tracker.isUnderPressure)
        XCTAssertFalse(tracker.observe(.critical, at: t0.addingTimeInterval(1000)),
                       "after a reset the next sighting is the first one again")
    }

    func testLevelsAreOrdered() {
        XCTAssertTrue(MemoryPressure.normal < MemoryPressure.warning)
        XCTAssertTrue(MemoryPressure.warning < MemoryPressure.critical)
        XCTAssertTrue(MemoryPressure.critical >= MemoryPressure.critical)
    }

    func testDispatchFlagsMapToLevels() {
        XCTAssertEqual(ResourceGuardService.level(from: DispatchSource.MemoryPressureEvent.normal.rawValue), .normal)
        XCTAssertEqual(ResourceGuardService.level(from: DispatchSource.MemoryPressureEvent.warning.rawValue), .warning)
        XCTAssertEqual(ResourceGuardService.level(from: DispatchSource.MemoryPressureEvent.critical.rawValue), .critical)
        // Critical wins when the mask carries both.
        let both = DispatchSource.MemoryPressureEvent.warning.rawValue
            | DispatchSource.MemoryPressureEvent.critical.rawValue
        XCTAssertEqual(ResourceGuardService.level(from: both), .critical)
    }
}

final class ResourceGuardServiceTests: XCTestCase {

    /// `sustainedFor: 0` means the second observation is already "sustained",
    /// which keeps these tests instant instead of sleeping for 30s.
    private func instantGuard() -> ResourceGuardService {
        ResourceGuardService(sustainedSeconds: 0)
    }

    func testRegistrationTracksLiveJobs() {
        let guardService = instantGuard()
        XCTAssertEqual(guardService._registeredCountForTesting, 0)
        let a = guardService.register(label: "a") { _ in }
        let b = guardService.register(label: "b") { _ in }
        XCTAssertEqual(guardService._registeredCountForTesting, 2)
        a.cancel()
        XCTAssertEqual(guardService._registeredCountForTesting, 1)
        b.cancel()
        XCTAssertEqual(guardService._registeredCountForTesting, 0)
    }

    func testCancellingTwiceIsHarmless() {
        let guardService = instantGuard()
        let token = guardService.register(label: "a") { _ in }
        token.cancel()
        token.cancel()
        XCTAssertEqual(guardService._registeredCountForTesting, 0)
    }

    func testNormalPressureStopsNothing() {
        let guardService = instantGuard()
        let stopped = expectation(description: "must not be called")
        stopped.isInverted = true
        let token = guardService.register(label: "job") { _ in stopped.fulfill() }
        for _ in 0..<5 { guardService._observeForTesting(.normal) }
        wait(for: [stopped], timeout: 0.2)
        token.cancel()
    }

    func testSustainedCriticalStopsTheJobWithAReason() {
        let guardService = instantGuard()
        let stopped = expectation(description: "stop handler called")
        var receivedReason: String?
        let token = guardService.register(label: "job") { reason in
            receivedReason = reason
            stopped.fulfill()
        }
        guardService._observeForTesting(.critical)   // first sighting — arms
        guardService._observeForTesting(.critical)   // sustained — fires
        wait(for: [stopped], timeout: 1)
        token.cancel()

        let reason = receivedReason ?? ""
        XCTAssertTrue(reason.contains("memory"), "the reason must name the real cause: \(reason)")
        // The whole point of this change set: work is never blamed for its
        // duration, and the message the user sees has to say so.
        XCTAssertFalse(reason.lowercased().contains("timed out"), reason)
        XCTAssertTrue(reason.lowercased().contains("not a time limit"), reason)
        // States the REAL configured window (0 here), not the static default.
        XCTAssertTrue(reason.contains("0s or more"),
                      "must report this instance's threshold, not the 30s default: \(reason)")
    }

    func testStopsTheNEWESTJobFirstAndOnlyOne() {
        // Stopping one job may be enough to recover, and the most recently
        // started one is the likeliest culprit — so an episode takes exactly one
        // victim and re-arms rather than killing everything registered.
        let guardService = instantGuard()
        let oldStopped = expectation(description: "old job must survive")
        oldStopped.isInverted = true
        let newStopped = expectation(description: "new job stopped")

        let oldToken = guardService.register(label: "old") { _ in oldStopped.fulfill() }
        let newToken = guardService.register(label: "new") { _ in newStopped.fulfill() }

        guardService._observeForTesting(.critical)
        guardService._observeForTesting(.critical)

        wait(for: [newStopped], timeout: 1)
        wait(for: [oldStopped], timeout: 0.2)
        XCTAssertEqual(guardService._registeredCountForTesting, 1,
                       "the stopped job is deregistered; the survivor stays")
        oldToken.cancel()
        newToken.cancel()
    }

    func testAStoppedJobIsNotStoppedTwice() {
        let guardService = instantGuard()
        var calls = 0
        let lock = NSLock()
        let token = guardService.register(label: "job") { _ in
            lock.lock(); calls += 1; lock.unlock()
        }
        for _ in 0..<6 { guardService._observeForTesting(.critical) }
        // Give the handler time to run on the guard's queue.
        let settle = expectation(description: "settle")
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) { settle.fulfill() }
        wait(for: [settle], timeout: 1)
        lock.lock(); let observed = calls; lock.unlock()
        XCTAssertEqual(observed, 1, "one registration must receive at most one stop")
        token.cancel()
    }

    /// `stopAll` is the app-termination path, not the memory-pressure one —
    /// every registered job must be stopped regardless of pressure level, and
    /// deregistered so a stale handler isn't kept around after the app is
    /// already on its way out.
    func testStopAllStopsEveryJobRegardlessOfPressure() {
        let guardService = instantGuard()
        var reasons: [String] = []
        let lock = NSLock()
        let a = guardService.register(label: "a") { r in lock.lock(); reasons.append(r); lock.unlock() }
        let b = guardService.register(label: "b") { r in lock.lock(); reasons.append(r); lock.unlock() }
        guardService.stopAll(reason: "app is quitting")
        lock.lock(); let observed = reasons; lock.unlock()
        XCTAssertEqual(observed, ["app is quitting", "app is quitting"])
        XCTAssertEqual(guardService._registeredCountForTesting, 0)
        a.cancel()
        b.cancel()
    }

    func testStopAllOnAnEmptyGuardIsHarmless() {
        let guardService = instantGuard()
        guardService.stopAll(reason: "app is quitting")
        XCTAssertEqual(guardService._registeredCountForTesting, 0)
    }

    func testRecoveryBetweenSpikesSparesEveryJob() {
        let guardService = instantGuard()
        let stopped = expectation(description: "must not be called")
        stopped.isInverted = true
        let token = guardService.register(label: "job") { _ in stopped.fulfill() }
        // critical → normal → critical → normal: never two criticals in a row,
        // so the episode never survives to become sustained.
        for _ in 0..<4 {
            guardService._observeForTesting(.critical)
            guardService._observeForTesting(.normal)
        }
        wait(for: [stopped], timeout: 0.3)
        token.cancel()
    }
}
