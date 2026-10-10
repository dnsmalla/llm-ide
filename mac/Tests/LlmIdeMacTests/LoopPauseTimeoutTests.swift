import XCTest
@testable import LlmIdeMacLib

@MainActor
final class LoopPauseTimeoutTests: XCTestCase {

    /// Fake clock advancing 1 s per read, so no real waiting is needed.
    private final class Clock { var t = Date(timeIntervalSince1970: 0)
        func read() -> Date { t.addTimeInterval(1); return t } }

    func testNotPausedReturnsImmediately() async {
        let out = await LoopEngineRunner.waitWhilePaused(
            isPaused: { false }, isCancelled: { false },
            timeout: 10, now: Date.init, pollNanoseconds: 1)
        XCTAssertEqual(out, .notPaused)
    }

    func testTimesOutWhenNeverResumed() async {
        let clock = Clock()
        let out = await LoopEngineRunner.waitWhilePaused(
            isPaused: { true }, isCancelled: { false },
            timeout: 5, now: { clock.read() }, pollNanoseconds: 1)
        XCTAssertEqual(out, .timedOut)
    }

    func testZeroTimeoutIsUnlimitedAndResumeWins() async {
        let clock = Clock()
        var polls = 0
        let out = await LoopEngineRunner.waitWhilePaused(
            isPaused: { polls += 1; return polls < 200 }, isCancelled: { false },
            timeout: 0, now: { clock.read() }, pollNanoseconds: 1)
        XCTAssertEqual(out, .resumed)
    }

    func testResumeBeforeDeadlineDoesNotTimeOut() async {
        let clock = Clock()
        var polls = 0
        let out = await LoopEngineRunner.waitWhilePaused(
            isPaused: { polls += 1; return polls < 3 }, isCancelled: { false },
            timeout: 100, now: { clock.read() }, pollNanoseconds: 1)
        XCTAssertEqual(out, .resumed)
    }

    func testCancellationWinsOverTimeout() async {
        let clock = Clock()
        let out = await LoopEngineRunner.waitWhilePaused(
            isPaused: { true }, isCancelled: { true },
            timeout: 1, now: { clock.read() }, pollNanoseconds: 1)
        XCTAssertEqual(out, .cancelled)
    }

    func testConfigDecodeFallbackAndRoundTrip() throws {
        var cfg = LoopEngineConfig(stages: [])
        XCTAssertEqual(cfg.pauseTimeoutSeconds, 1800)
        cfg.pauseTimeoutSeconds = 0
        let data = try JSONEncoder().encode(cfg)
        XCTAssertEqual(try JSONDecoder().decode(LoopEngineConfig.self, from: data).pauseTimeoutSeconds, 0)
        let legacy = #"{"stages":[]}"#.data(using: .utf8)!
        XCTAssertEqual(try JSONDecoder().decode(LoopEngineConfig.self, from: legacy).pauseTimeoutSeconds, 1800)
    }

    func testSnapshotCarriesPauseTimeoutAndOldJSONDecodesNil() throws {
        var cfg = LoopEngineConfig(stages: [])
        cfg.pauseTimeoutSeconds = 600
        let snap = LoopRunConfigSnapshot(cfg)
        XCTAssertEqual(snap.pauseTimeoutSeconds, 600)
        let data = try JSONEncoder().encode(snap)
        XCTAssertEqual(try JSONDecoder().decode(LoopRunConfigSnapshot.self, from: data).pauseTimeoutSeconds, 600)
        // An old record: strip the key and confirm it decodes to nil.
        var obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        obj.removeValue(forKey: "pauseTimeoutSeconds")
        let old = try JSONSerialization.data(withJSONObject: obj)
        XCTAssertNil(try JSONDecoder().decode(LoopRunConfigSnapshot.self, from: old).pauseTimeoutSeconds)
    }
}
