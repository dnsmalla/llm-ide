// mac/Tests/LlmIdeMacTests/CaptionDeltaStateTests.swift
import XCTest
@testable import LlmIdeMacLib

final class CaptionDeltaStateTests: XCTestCase {
    private typealias Row = (row: Int, speaker: String, text: String)

    private func lines(_ items: (String, String)...) -> [(speaker: String, text: String)] {
        items.map { (speaker: $0.0, text: $0.1) }
    }

    /// Feeds `snapshots` through a fresh state and returns the resulting rows.
    private func run(_ snapshots: [[(speaker: String, text: String)]]) -> [Row] {
        var state = CaptionDeltaState()
        var rows: [Row] = []
        for snapshot in snapshots {
            CaptionDeltaState.apply(state.ingest(snapshot), to: &rows)
        }
        return rows
    }

    private func texts(_ rows: [Row]) -> [String] {
        rows.map { "\($0.speaker):\($0.text)" }
    }

    func testUnchangedSnapshotEmitsNothingAfterFirst() {
        var state = CaptionDeltaState()
        XCTAssertEqual(state.ingest(lines(("A", "Hello"))),
                       [.append(row: 0, speaker: "A", text: "Hello")])
        XCTAssertTrue(state.ingest(lines(("A", "Hello"))).isEmpty)
        XCTAssertTrue(state.ingest(lines(("A", "Hello"))).isEmpty)
    }

    func testRealGrowthReplacesInPlaceAndKeepsOrder() {
        var state = CaptionDeltaState()
        _ = state.ingest(lines(("A", "Hello")))
        XCTAssertEqual(state.ingest(lines(("A", "Hello there"))),
                       [.replace(row: 0, speaker: "A", oldText: "Hello", newText: "Hello there")])
        let rows = run([lines(("A", "Hello")), lines(("A", "Hello there")),
                        lines(("A", "Hello there again"))])
        XCTAssertEqual(texts(rows), ["A:Hello there again"])
    }

    func testRepeatedTextAfterOtherSpeakerIsKept() {
        let rows = run([lines(("A", "Yes.")),
                        lines(("A", "Yes."), ("B", "Agreed?")),
                        lines(("A", "Yes."), ("B", "Agreed?"), ("A", "Yes."))])
        XCTAssertEqual(texts(rows), ["A:Yes.", "B:Agreed?", "A:Yes."])
    }

    func testSameTextFromDifferentSpeakersInOneSnapshotBothKept() {
        let rows = run([lines(("A", "OK"), ("B", "OK"))])
        XCTAssertEqual(texts(rows), ["A:OK", "B:OK"])
    }

    func testSameTextTwiceFromSameSpeakerOnScreenBothKept() {
        let rows = run([lines(("A", "OK"), ("B", "Hmm"), ("A", "OK"))])
        XCTAssertEqual(texts(rows), ["A:OK", "B:Hmm", "A:OK"])
    }

    func testUnknownSpeakersDoNotCollapse() {
        let rows = run([lines(("Unknown", "Thanks")),
                        lines(("Unknown", "Thanks"), ("Unknown", "Yes")),
                        lines(("Unknown", "Thanks"), ("Unknown", "Yes"), ("Unknown", "Thanks"))])
        XCTAssertEqual(texts(rows), ["Unknown:Thanks", "Unknown:Yes", "Unknown:Thanks"])
    }

    func testPrefixWhileOldLineStillOnScreenIsSeparateRow() {
        let rows = run([lines(("A", "Yes.")),
                        lines(("A", "Yes."), ("A", "Yes. Let's ship it."))])
        XCTAssertEqual(texts(rows), ["A:Yes.", "A:Yes. Let's ship it."])
    }

    func testPrefixWithoutWordBoundaryIsNotGrowth() {
        let rows = run([lines(("A", "No")), lines(("A", "Nothing else"))])
        XCTAssertEqual(texts(rows), ["A:No", "A:Nothing else"])
    }

    func testInterleavedGrowthReplacesOriginalRow() {
        let rows = run([lines(("A", "Hello")),
                        lines(("A", "Hello"), ("B", "Hi")),
                        lines(("A", "Hello there, team"), ("B", "Hi"))])
        XCTAssertEqual(texts(rows), ["A:Hello there, team", "B:Hi"])
    }

    func testScrolledOffLineIsClosedAndCanReappearAsNew() {
        var state = CaptionDeltaState()
        _ = state.ingest(lines(("A", "One"), ("B", "Two")))
        XCTAssertEqual(state.ingest(lines(("B", "Two"), ("A", "Three"))),
                       [.append(row: 2, speaker: "A", text: "Three"), .closed(row: 0)])
        XCTAssertEqual(state.ingest(lines(("B", "Two"), ("A", "Three"), ("A", "One"))),
                       [.append(row: 3, speaker: "A", text: "One")])
    }

    func testEmptySnapshotFlickerEmitsNothing() {
        var state = CaptionDeltaState()
        _ = state.ingest(lines(("A", "Hello")))
        XCTAssertTrue(state.ingest([]).isEmpty)
        XCTAssertTrue(state.ingest(lines(("A", "Hello"))).isEmpty)
    }

    func testLongEmptyStreakClosesRows() {
        var state = CaptionDeltaState()
        _ = state.ingest(lines(("A", "Hello")))
        var last: [CaptionDelta] = []
        for _ in 0..<CaptionDeltaState.maxEmptyTicks { last = state.ingest([]) }
        XCTAssertEqual(last, [.closed(row: 0)])
    }

    func testReplaceFallsBackToAppendWhenRowGone() {
        var rows: [Row] = []
        CaptionDeltaState.apply(
            [.replace(row: 9, speaker: "A", oldText: "x", newText: "x y")], to: &rows)
        XCTAssertEqual(rows.count, 1)
    }

    // MARK: - Alignment equivalence

    private typealias Key = CaptionDeltaState.LineKey

    /// Test-only reference: size of the maximum in-order matching via the
    /// plain full-table LCS (the pre-optimisation algorithm).
    private func referenceLCSSize(_ prev: [Key], _ cur: [Key]) -> Int {
        var table = [[Int]](repeating: [Int](repeating: 0, count: cur.count + 1),
                            count: prev.count + 1)
        for i in stride(from: prev.count - 1, through: 0, by: -1) {
            for j in stride(from: cur.count - 1, through: 0, by: -1) {
                table[i][j] = prev[i] == cur[j]
                    ? table[i + 1][j + 1] + 1
                    : max(table[i + 1][j], table[i][j + 1])
            }
        }
        return table[0][0]
    }

    func testOptimizedAlignmentMatchesFullLCSOnRandomSnapshots() {
        var seed: UInt64 = 0x2545F4914F6CDD1D
        func next(_ bound: Int) -> Int {
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            return Int((seed >> 33) % UInt64(bound))
        }
        func randomLines(_ count: Int) -> [Key] {
            (0..<count).map { _ in
                Key(speaker: "S\(next(2))", text: "t\(next(5))")
            }
        }
        for _ in 0..<300 {
            let prev = randomLines(next(12))
            var cur = randomLines(next(12))
            if next(2) == 0 {
                // Scroll-like: drop a head, keep the rest, append new lines.
                cur = Array(prev.dropFirst(next(3))) + randomLines(next(3))
            }
            let aligned = CaptionDeltaState.align(previous: prev, snapshot: cur)
            XCTAssertEqual(aligned.count, cur.count)
            var lastPrev = -1
            var matched = 0
            for (j, maybe) in aligned.enumerated() {
                guard let i = maybe else { continue }
                XCTAssertGreaterThan(i, lastPrev, "matches must be strictly in order")
                XCTAssertEqual(prev[i], cur[j], "matched lines must be equal")
                lastPrev = i
                matched += 1
            }
            XCTAssertEqual(matched, referenceLCSSize(prev, cur))
        }
    }

    func testIdenticalAndShiftedSnapshotsAlignWithoutTable() {
        let prev = (0..<2000).map { Key(speaker: "A", text: "line \($0)") }
        let same = CaptionDeltaState.align(previous: prev, snapshot: prev)
        XCTAssertEqual(same, (0..<2000).map { Optional($0) })
        let shifted = Array(prev.dropFirst()) + [Key(speaker: "A", text: "new")]
        let result = CaptionDeltaState.align(previous: prev, snapshot: shifted)
        XCTAssertEqual(result.last!, nil)
        XCTAssertEqual(result.first!, 1)
        XCTAssertEqual(result.compactMap { $0 }.count, 1999)
    }
}
