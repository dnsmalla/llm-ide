import XCTest
@testable import LlmIdeMacLib

final class CronExpressionTests: XCTestCase {
    // Fixed "now" = 2026-08-01T10:00:00 local so nextFire is deterministic.
    private let now = Calendar.current.date(from: DateComponents(year: 2026, month: 8, day: 1, hour: 10, minute: 0))!

    func testParsesValidExpressions() {
        XCTAssertNotNil(CronExpression.parse("0 9 * * *"))
        XCTAssertNotNil(CronExpression.parse("*/15 * * * *"))
        XCTAssertNotNil(CronExpression.parse("0 9 * * 1-5"))
        XCTAssertNotNil(CronExpression.parse("30 8,12,18 * * *"))
    }

    func testRejectsInvalidExpressions() {
        XCTAssertNil(CronExpression.parse(""))
        XCTAssertNil(CronExpression.parse("0 9 * *"))        // 4 fields
        XCTAssertNil(CronExpression.parse("0 9 * * * extra"))// 6 fields
        XCTAssertNil(CronExpression.parse("99 * * * *"))     // minute out of range
        XCTAssertNil(CronExpression.parse("0 9 * * 8"))      // DOW out of range
    }

    func testNextFireEveryMinute() throws {
        let expr = try XCTUnwrap(CronExpression.parse("* * * * *"))
        let next = expr.nextFire(after: now, now: now)
        XCTAssertEqual(next, now.addingTimeInterval(60))
    }

    func testNextFireHourly() throws {
        let expr = try XCTUnwrap(CronExpression.parse("0 * * * *"))
        let next = expr.nextFire(after: now, now: now)
        // 10:00 → next top-of-hour is 11:00.
        XCTAssertEqual(next, Calendar.current.date(byAdding: .hour, value: 1, to: now))
    }

    func testNextFireDailyAt9() throws {
        let expr = try XCTUnwrap(CronExpression.parse("0 9 * * *"))
        let next = expr.nextFire(after: now, now: now) // now = 10:00 → tomorrow 09:00.
        XCTAssertEqual(next, Calendar.current.date(byAdding: .day, value: 1, to: now)?
                        .setting(hour: 9, minute: 0, second: 0))
    }

    func testNextFireWeekday() throws {
        // 2026-08-01 is a Saturday. "0 9 * * 1-5" → Mon 2026-08-03 09:00.
        let expr = try XCTUnwrap(CronExpression.parse("0 9 * * 1-5"))
        let next = expr.nextFire(after: now, now: now)
        let cal = Calendar.current
        let expected = cal.date(from: DateComponents(year: 2026, month: 8, day: 3, hour: 9, minute: 0))
        XCTAssertEqual(next, expected)
    }

    func testImpossibleCronReturnsNil() throws {
        // Feb 30 never exists.
        let expr = try XCTUnwrap(CronExpression.parse("0 0 30 2 *"))
        XCTAssertNil(expr.nextFire(after: now, now: now))
    }

    func testDescribe() throws {
        XCTAssertEqual(try XCTUnwrap(CronExpression.parse("0 9 * * *")).describe, "At 09:00")
        XCTAssertEqual(try XCTUnwrap(CronExpression.parse("*/30 * * * *")).describe, "Every 30 min")
    }
}

/// Local helper for the multi-component `Date.setting(hour:minute:second:)` form used
/// in the brief — Foundation on this toolchain only exposes single-component
/// `setting(_:value:)`. Bridges to the standard `bySettingHour` API.
private extension Date {
    func setting(hour: Int, minute: Int, second: Int) -> Date {
        Calendar.current.date(bySettingHour: hour, minute: minute, second: second, of: self)!
    }
}
