// mac/Tests/LlmIdeMacTests/LiveCaptureRobustnessTests.swift
import XCTest
@testable import LlmIdeMacLib

final class CaptionSpeakerSanitizeTests: XCTestCase {
    func testStripsEnglishCombinedSpeakerSuffix() {
        XCTAssertEqual(CaptionSpeaker.sanitize("Tanaka & 2 others"), "Tanaka")
        XCTAssertEqual(CaptionSpeaker.sanitize("Tanaka & 1 other"), "Tanaka")
        XCTAssertEqual(CaptionSpeaker.sanitize("Tanaka ＆3 more"), "Tanaka")
    }

    func testStripsJapaneseCombinedSpeakerSuffix() {
        XCTAssertEqual(CaptionSpeaker.sanitize("田中 他2名"), "田中")
        XCTAssertEqual(CaptionSpeaker.sanitize("田中ほか3人"), "田中")
    }

    func testCollapsesControlCharactersAndWhitespace() {
        XCTAssertEqual(CaptionSpeaker.sanitize("  Bob\u{0007}   Smith \n"), "Bob Smith")
    }

    func testEmptyResultBecomesUnknown() {
        XCTAssertEqual(CaptionSpeaker.sanitize(""), CaptionSpeaker.unknown)
        XCTAssertEqual(CaptionSpeaker.sanitize("& 2 others"), CaptionSpeaker.unknown)
    }

    func testCapsLength() {
        let long = String(repeating: "a", count: 80)
        XCTAssertEqual(CaptionSpeaker.sanitize(long).count, CaptionSpeaker.maxLength)
    }

    func testPlainNamesAreUntouched() {
        XCTAssertEqual(CaptionSpeaker.sanitize("Anderson"), "Anderson")
        XCTAssertEqual(CaptionSpeaker.sanitize("Others Team"), "Others Team")
    }

    /// A combined label and the bare name are one speaker, so a growing
    /// line is still a replace, not a new row.
    func testDeltaStateMergesCombinedLabelWithBareName() {
        var state = CaptionDeltaState()
        _ = state.ingest([(speaker: "Tanaka & 2 others", text: "Hello")])
        let deltas = state.ingest([(speaker: "Tanaka", text: "Hello there")])
        XCTAssertEqual(deltas, [.replace(row: 0, speaker: "Tanaka",
                                         oldText: "Hello", newText: "Hello there")])
    }
}

final class TeamsCaptionPairingTests: XCTestCase {
    private func pairs(_ groups: [[String]]) -> [String] {
        TeamsCaptionScraper.pairCaptionRows(groups).map { "\($0.speaker)|\($0.text)" }
    }

    func testStructuredRowsPairWithinEachGroup() {
        XCTAssertEqual(pairs([["A", "hi"], ["B", "yo", "there"]]), ["A|hi", "B|yo there"])
    }

    /// One stray node must not shift every later row.
    func testSingleTextGroupContinuesPreviousSpeaker() {
        XCTAssertEqual(pairs([["A", "hi"], ["more"], ["B", "yo"]]),
                       ["A|hi", "A|more", "B|yo"])
    }

    func testLeadingSingleTextGroupIsDropped() {
        XCTAssertEqual(pairs([["Live captions"], ["A", "hi"]]), ["A|hi"])
    }

    func testFlatListFallsBackToAlternation() {
        XCTAssertEqual(pairs([["A", "hi", "B", "yo", "dangling"]]), ["A|hi", "B|yo"])
    }

    func testEmptyInput() {
        XCTAssertTrue(pairs([]).isEmpty)
        XCTAssertTrue(pairs([[]]).isEmpty)
    }
}

final class AXBoundedPreorderTests: XCTestCase {
    private struct Node {
        let value: Int
        let kids: [Node]
    }

    // 1 -> (2 -> 3), 4
    private let tree = Node(value: 1, kids: [Node(value: 2, kids: [Node(value: 3, kids: [])]),
                                             Node(value: 4, kids: [])])

    private func run(maxDepth: Int = 10, budget: Int = 100,
                     stopAt: Int? = nil) -> (seen: [Int], visited: Int) {
        var seen: [Int] = []
        let visited = AXCaptionReader.boundedPreorder(
            root: tree, maxDepth: maxDepth, nodeBudget: budget,
            children: { $0.kids },
            visit: { node in
                seen.append(node.value)
                return node.value == stopAt ? .stop : .continueWalk
            })
        return (seen, visited)
    }

    func testVisitsInPreorder() {
        XCTAssertEqual(run().seen, [1, 2, 3, 4])
    }

    func testStopEndsTheWholeWalk() {
        let result = run(stopAt: 2)
        XCTAssertEqual(result.seen, [1, 2])
        XCTAssertEqual(result.visited, 2)
    }

    func testNodeBudgetCapsVisits() {
        XCTAssertEqual(run(budget: 3).seen, [1, 2, 3])
    }

    func testMaxDepthStopsDescent() {
        XCTAssertEqual(run(maxDepth: 1).seen, [1, 2, 4])
    }
}

final class MeetingPresenceTrackerTests: XCTestCase {
    func testStartsWhenMeetingUIAppears() {
        var tracker = MeetingPresenceTracker()
        XCTAssertEqual(tracker.observe(present: false, now: 0, isCapturing: false), .none)
        XCTAssertEqual(tracker.observe(present: true, now: 3, isCapturing: false), .start)
        XCTAssertEqual(tracker.observe(present: true, now: 6, isCapturing: true), .none)
    }

    func testStopsOnlyAfterGracePeriod() {
        var tracker = MeetingPresenceTracker(absenceGrace: 60)
        _ = tracker.observe(present: true, now: 0, isCapturing: false)
        XCTAssertEqual(tracker.observe(present: false, now: 30, isCapturing: true), .none)
        // Back within the grace period: the absence clock restarts.
        XCTAssertEqual(tracker.observe(present: true, now: 40, isCapturing: true), .none)
        XCTAssertEqual(tracker.observe(present: false, now: 90, isCapturing: true), .none)
        XCTAssertEqual(tracker.observe(present: false, now: 100, isCapturing: true), .stop)
    }

    func testNeverStopsAManuallyStartedCapture() {
        var tracker = MeetingPresenceTracker(absenceGrace: 10)
        _ = tracker.observe(present: true, now: 0, isCapturing: true)
        XCTAssertEqual(tracker.observe(present: false, now: 100, isCapturing: true), .none)
    }

    func testUserStopIsNotUndoneWhileMeetingContinues() {
        var tracker = MeetingPresenceTracker(absenceGrace: 10)
        XCTAssertEqual(tracker.observe(present: true, now: 0, isCapturing: false), .start)
        // User pressed Stop; meeting UI still there.
        XCTAssertEqual(tracker.observe(present: true, now: 3, isCapturing: false), .none)
        XCTAssertEqual(tracker.observe(present: true, now: 6, isCapturing: false), .none)
        // Meeting ends, then a new one begins: auto-capture resumes.
        XCTAssertEqual(tracker.observe(present: false, now: 20, isCapturing: false), .none)
        XCTAssertEqual(tracker.observe(present: true, now: 30, isCapturing: false), .start)
    }

    /// A capture the user started by hand and then stopped must not be
    /// restarted while the meeting is still on screen.
    func testUserStopOfManualCaptureIsRespected() {
        var tracker = MeetingPresenceTracker(absenceGrace: 10)
        XCTAssertEqual(tracker.observe(present: true, now: 0, isCapturing: true), .none)
        XCTAssertEqual(tracker.observe(present: true, now: 3, isCapturing: false), .none)
        XCTAssertEqual(tracker.observe(present: true, now: 6, isCapturing: false), .none)
    }

    /// The tracker's own stop at the end of a meeting is not a user Stop:
    /// the next meeting in the same app session still auto-starts.
    func testNextMeetingStartsAfterOwnStop() {
        var tracker = MeetingPresenceTracker(absenceGrace: 10)
        XCTAssertEqual(tracker.observe(present: true, now: 0, isCapturing: false), .start)
        XCTAssertEqual(tracker.observe(present: true, now: 3, isCapturing: true), .none)
        XCTAssertEqual(tracker.observe(present: false, now: 20, isCapturing: true), .stop)
        XCTAssertEqual(tracker.observe(present: false, now: 23, isCapturing: false), .none)
        XCTAssertEqual(tracker.observe(present: true, now: 40, isCapturing: false), .start)
    }

    func testResetForgetsOwnership() {
        var tracker = MeetingPresenceTracker(absenceGrace: 10)
        _ = tracker.observe(present: true, now: 0, isCapturing: false)
        tracker.reset()
        XCTAssertFalse(tracker.ownsCapture)
        XCTAssertEqual(tracker.observe(present: true, now: 5, isCapturing: false), .start)
    }
}

@MainActor
final class MeetingSummarizeTrackerTests: XCTestCase {
    func testSecondBeginForSameFileIsRefused() {
        let tracker = MeetingSummarizeTracker()
        let url = URL(fileURLWithPath: "/tmp/meetings/a.md")
        XCTAssertTrue(tracker.begin(url))
        XCTAssertFalse(tracker.begin(url))
        XCTAssertTrue(tracker.isSummarizing(url))
        tracker.end(url)
        XCTAssertFalse(tracker.isSummarizing(url))
        XCTAssertTrue(tracker.begin(url))
    }

    func testStateOutlivesTheViewModelThatStartedIt() {
        let tracker = MeetingSummarizeTracker()
        let url = URL(fileURLWithPath: "/tmp/meetings/b.md")
        _ = tracker.begin(url)
        let replacement = MeetingDetailViewModel(fileURL: url, api: nil, summaries: tracker)
        XCTAssertTrue(replacement.summarizing)
        tracker.end(url)
        XCTAssertFalse(replacement.summarizing)
    }
}
