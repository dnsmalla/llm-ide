import XCTest
@testable import LlmIdeMacLib

@MainActor
final class ActivityStoreWindowTests: XCTestCase {
    private var calendar: Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        return cal
    }

    private func date(_ iso: String) -> Date {
        let formatter = ISO8601DateFormatter()
        return formatter.date(from: iso)!
    }

    private func item(_ id: Int, _ iso: String) -> ActivityItem {
        ActivityItem(
            id: id, kind: nil, title: "t\(id)", detail: nil, link: nil, createdAt: date(iso))
    }

    func testWindowStartsAtMidnightOfYesterday() {
        let now = date("2026-10-03T15:30:00Z")
        XCTAssertEqual(
            ActivityStore.windowStart(now: now, calendar: calendar),
            date("2026-10-02T00:00:00Z"))
    }

    func testRecentKeepsTodayAndYesterdayOnlyInOrder() {
        let now = date("2026-10-03T15:30:00Z")
        let items = [
            item(5, "2026-10-03T14:00:00Z"),
            item(4, "2026-10-02T23:59:00Z"),
            item(3, "2026-10-02T00:00:00Z"),
            item(2, "2026-10-01T23:59:59Z"),
            item(1, "2026-09-20T10:00:00Z"),
        ]
        let kept = ActivityStore.recent(items, now: now, calendar: calendar)
        XCTAssertEqual(kept.map(\.id), [5, 4, 3])
    }

    func testRecentOfEmptyListIsEmpty() {
        XCTAssertTrue(ActivityStore.recent([], now: Date(), calendar: calendar).isEmpty)
    }
}
