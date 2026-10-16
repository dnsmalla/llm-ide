import XCTest
import GraphCore
@testable import LlmIdeMacLib

/// Pure helpers behind the Issues / Gantt / Code Graph / Source Control fixes:
/// GitHub milestone due dates as calendar days, the schedule editor's range
/// check, the graph session store's structure signature + LRU, and the `-z`
/// path parser used by Discard All.
@MainActor
final class IssuesGanttGraphFixesTests: XCTestCase {

    // MARK: - GitHub milestone due_on

    func testGitHubDueOnKeepsUTCCalendarDay() {
        // 07:00Z is the previous evening west of UTC; the day must not shift.
        XCTAssertEqual(GitHubDueDate.calendarDate(fromDueOn: "2026-10-16T07:00:00Z"), "2026-10-16")
        XCTAssertEqual(GitHubDueDate.calendarDate(fromDueOn: "2026-10-16T23:59:59Z"), "2026-10-16")
        XCTAssertEqual(GitHubDueDate.calendarDate(fromDueOn: "2026-10-16T07:00:00.000Z"), "2026-10-16")
    }

    func testGitHubDueOnPassesThroughDateOnlyAndNil() {
        XCTAssertEqual(GitHubDueDate.calendarDate(fromDueOn: "2026-10-16"), "2026-10-16")
        XCTAssertNil(GitHubDueDate.calendarDate(fromDueOn: nil))
        XCTAssertNil(GitHubDueDate.calendarDate(fromDueOn: ""))
    }

    // MARK: - Schedule editor range

    func testDueBeforeStartIsInvalidByCalendarDay() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0) ?? .current
        let start = Date(timeIntervalSince1970: 1_760_600_000)          // some day, mid-day
        let sameDayEarlier = cal.startOfDay(for: start)
        let dayBefore = start.addingTimeInterval(-86_400)
        XCTAssertTrue(IssueScheduleEditorSheet.isDueBeforeStart(start: start, due: dayBefore, calendar: cal))
        XCTAssertFalse(IssueScheduleEditorSheet.isDueBeforeStart(start: start, due: sameDayEarlier, calendar: cal))
        XCTAssertFalse(IssueScheduleEditorSheet.isDueBeforeStart(start: nil, due: dayBefore, calendar: cal))
        XCTAssertFalse(IssueScheduleEditorSheet.isDueBeforeStart(start: start, due: nil, calendar: cal))
    }

    // MARK: - Graph session store

    private func graph(positioned: Bool, extraEdge: Bool = false) -> CGData {
        let pos = positioned ? CGPoint(x: 12, y: 34) : .zero
        let nodes = [
            CGNode(id: "a", title: "A", kind: .file, position: pos),
            CGNode(id: "b", title: "B", kind: .file, position: pos),
        ]
        var edges = [CGEdge(fromId: "a", toId: "b", kind: .imports)]
        if extraEdge { edges.append(CGEdge(fromId: "b", toId: "a", kind: .imports)) }
        return CGData(nodes: nodes, edges: edges)
    }

    func testStructuralSignatureIgnoresPositions() {
        XCTAssertEqual(GraphSessionStore.structuralSignature(graph(positioned: false)),
                       GraphSessionStore.structuralSignature(graph(positioned: true)))
        XCTAssertNotEqual(GraphSessionStore.structuralSignature(graph(positioned: false)),
                          GraphSessionStore.structuralSignature(graph(positioned: false, extraEdge: true)))
    }

    func testUnchangedRawRestoreKeepsLaidOutGraph() {
        let store = GraphSessionStore()
        let repo = URL(fileURLWithPath: "/tmp/repo-a")
        store.store(repo: repo, mode: "code", graph: graph(positioned: true), laidOut: true)
        store.store(repo: repo, mode: "code", graph: graph(positioned: false), laidOut: false)
        let entry = store.entry(repo: repo, mode: "code")
        XCTAssertEqual(entry?.laidOut, true)
        XCTAssertEqual(entry?.graph.nodes.first?.position, CGPoint(x: 12, y: 34))

        // A structural change still replaces it and asks for a relayout.
        store.store(repo: repo, mode: "code", graph: graph(positioned: false, extraEdge: true), laidOut: false)
        XCTAssertEqual(store.entry(repo: repo, mode: "code")?.laidOut, false)
        XCTAssertEqual(store.entry(repo: repo, mode: "code")?.graph.edges.count, 2)
    }

    func testStoreEvictsLeastRecentRepos() {
        let store = GraphSessionStore()
        let limit = GraphSessionStore.maxCachedRepos
        let repos = (0...limit).map { URL(fileURLWithPath: "/tmp/repo-\($0)") }
        for repo in repos {
            store.store(repo: repo, mode: "code", graph: graph(positioned: true))
            store.store(repo: repo, mode: "all", graph: graph(positioned: true))
        }
        XCTAssertNil(store.entry(repo: repos[0], mode: "code"))
        XCTAssertNil(store.entry(repo: repos[0], mode: "all"))
        for repo in repos.dropFirst() {
            XCTAssertNotNil(store.entry(repo: repo, mode: "code"))
        }
    }

    func testTouchRecentMovesToFrontAndTrims() {
        let first = GraphSessionStore.touchRecent("c", in: ["a", "b", "c"], limit: 3)
        XCTAssertEqual(first.order, ["c", "a", "b"])
        XCTAssertEqual(first.evicted, [])
        let second = GraphSessionStore.touchRecent("d", in: ["a", "b", "c"], limit: 2)
        XCTAssertEqual(second.order, ["d", "a"])
        XCTAssertEqual(second.evicted, ["b", "c"])
    }

    // MARK: - Discard All path listing

    func testNulSeparatedPathsKeepsSpacesAndDropsEmptyTail() {
        XCTAssertEqual(SourceControlService.nulSeparatedPaths("a.txt\0dir with space/\0"),
                       ["a.txt", "dir with space/"])
        XCTAssertEqual(SourceControlService.nulSeparatedPaths(""), [])
    }

    // MARK: - GitLab deleted milestone

    func testGitLabNotFoundDetection() {
        XCTAssertTrue(GitLabClient.isNotFound(.httpError(404, "HTTP 404")))
        XCTAssertFalse(GitLabClient.isNotFound(.httpError(500, "HTTP 500")))
    }
}
