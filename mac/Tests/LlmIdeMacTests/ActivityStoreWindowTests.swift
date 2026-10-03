import XCTest
@testable import LlmIdeMacLib

@MainActor
final class ActivityStoreWindowTests: XCTestCase {
    private func date(_ iso: String) -> Date {
        ISO8601DateFormatter().date(from: iso)!
    }

    private func item(
        _ id: Int, _ iso: String, title: String? = nil, kind: ActivityKind? = nil,
        link: String? = nil
    ) -> ActivityItem {
        ActivityItem(
            id: id, kind: kind, title: title ?? "t\(id)", detail: nil, link: link,
            createdAt: date(iso))
    }

    // MARK: Window

    func testWindowIsTheLast48Hours() {
        let now = date("2026-10-03T15:30:00Z")
        XCTAssertEqual(ActivityStore.windowStart(now: now), date("2026-10-01T15:30:00Z"))
    }

    func testRecentKeepsOnlyTheLast48HoursInOrder() {
        let now = date("2026-10-03T15:30:00Z")
        let items = [
            item(5, "2026-10-03T14:00:00Z"),
            item(4, "2026-10-02T23:59:00Z"),
            item(3, "2026-10-01T15:30:00Z"),  // exactly at the cutoff: kept
            item(2, "2026-10-01T15:29:59Z"),  // one second too old
            item(1, "2026-09-20T10:00:00Z"),
        ]
        XCTAssertEqual(ActivityStore.recent(items, now: now).map(\.id), [5, 4, 3])
    }

    func testRecentOfEmptyListIsEmpty() {
        XCTAssertTrue(ActivityStore.recent([], now: Date()).isEmpty)
    }

    // MARK: Repeats

    func testRepeatedAlertKeepsOnlyTheNewestCopy() {
        let items = [
            item(9, "2026-10-03T14:00:00Z", title: "Knowledge updated", kind: .knowledgeUpdated),
            item(8, "2026-10-03T13:00:00Z", title: "Issue created", kind: .issueCreated),
            item(7, "2026-10-03T12:00:00Z", title: "Knowledge updated", kind: .knowledgeUpdated),
            item(6, "2026-10-02T12:00:00Z", title: "Knowledge updated", kind: .knowledgeUpdated),
        ]
        XCTAssertEqual(ActivityStore.deduped(items).map(\.id), [9, 8])
    }

    func testSameTitleWithDifferentKindOrLinkIsNotARepeat() {
        let items = [
            item(4, "2026-10-03T14:00:00Z", title: "Done", kind: .regressionDone),
            item(3, "2026-10-03T13:00:00Z", title: "Done", kind: .issueCreated),
            item(2, "2026-10-03T12:00:00Z", title: "Done", kind: .issueCreated, link: "https://x/1"),
            item(1, "2026-10-03T11:00:00Z", title: "Done", kind: .issueCreated, link: "https://x/2"),
        ]
        XCTAssertEqual(ActivityStore.deduped(items).map(\.id), [4, 3, 2, 1])
    }

    func testAnExpiredCopyNeverShadowsANewerOne() {
        // The old copy is outside the window and must not matter either way.
        let now = date("2026-10-03T15:30:00Z")
        let items = [
            item(2, "2026-10-03T14:00:00Z", title: "Knowledge updated"),
            item(1, "2026-09-01T14:00:00Z", title: "Knowledge updated"),
        ]
        XCTAssertEqual(ActivityStore.recent(items, now: now).map(\.id), [2])
    }

    // MARK: Badge

    func testBadgeIsNeverLargerThanTheVisibleList() {
        XCTAssertEqual(ActivityStore.visibleUnread(unread: 5, shown: 1), 1)
        XCTAssertEqual(ActivityStore.visibleUnread(unread: 2, shown: 10), 2)
        XCTAssertEqual(ActivityStore.visibleUnread(unread: 0, shown: 3), 0)
        XCTAssertEqual(ActivityStore.visibleUnread(unread: 4, shown: 0), 0)
        XCTAssertEqual(ActivityStore.visibleUnread(unread: -1, shown: 3), 0)
    }
}
