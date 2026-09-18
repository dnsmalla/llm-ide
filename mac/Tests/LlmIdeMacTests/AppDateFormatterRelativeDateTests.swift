import XCTest
@testable import LlmIdeMacLib

/// `AppDateFormatter.relativeDate` buckets by CALENDAR DAY, not elapsed hours.
///
/// Every assertion here compares two labels rather than matching literal text:
/// the wording comes from `RelativeDateTimeFormatter` and is localized, so
/// "Yesterday" is 昨日 on a Japanese-locale machine and asserting the English
/// would only pin the developer's own region. Comparing labels pins the
/// BEHAVIOUR — which is where the bug was — in any locale.
final class AppDateFormatterRelativeDateTests: XCTestCase {

    /// Built through `Calendar.current`, so the calendar-day arithmetic under
    /// test is exercised in whatever timezone the suite runs in.
    private func at(_ year: Int, _ month: Int, _ day: Int, _ hour: Int, _ minute: Int) -> Date {
        let components = DateComponents(year: year, month: month, day: day, hour: hour, minute: minute)
        guard let date = Calendar.current.date(from: components) else {
            XCTFail("could not build \(year)-\(month)-\(day) \(hour):\(minute)")
            return Date()
        }
        return date
    }

    /// The reported bug, in its exact shape: a meeting at 23:02 on the 16th,
    /// read on the 18th. 36 h elapsed is under the old 48-hour cutoff, so it
    /// was labelled "Yesterday" — while sitting under a "This Week" header,
    /// because `LibraryViewModel` buckets by `isDateInYesterday` and was right.
    func testTwoCalendarDaysBackIsNotLabelledYesterday() {
        let meeting = at(2026, 9, 16, 23, 2)
        let whileItWasYesterday = AppDateFormatter.relativeDate(meeting, now: at(2026, 9, 17, 9, 0))
        let twoDaysLater = AppDateFormatter.relativeDate(meeting, now: at(2026, 9, 18, 11, 20))
        XCTAssertNotEqual(twoDaysLater, whileItWasYesterday,
                          "the same meeting must not still read as yesterday a calendar day later")
    }

    /// 36 h and 47 h are both two calendar days out. Neither may borrow
    /// yesterday's label just for sitting under the old 48-hour threshold.
    func testElapsedHoursDoNotDecideTheDayBucket() {
        let meeting = at(2026, 9, 16, 23, 2)
        let yesterdayLabel = AppDateFormatter.relativeDate(meeting, now: at(2026, 9, 17, 9, 0))
        for now in [at(2026, 9, 18, 11, 20), at(2026, 9, 18, 22, 0)] {
            XCTAssertNotEqual(AppDateFormatter.relativeDate(meeting, now: now), yesterdayLabel,
                              "two calendar days out must not read as yesterday, whatever the hour")
        }
    }

    /// The mirror failure: 68 minutes elapsed, but across midnight. The old
    /// code named the interval ("1 Hour Ago at 11:02 PM"); the calendar says
    /// yesterday, and it must say so identically however long ago that was.
    func testAcrossMidnightIsYesterdayEvenWhenMinutesHaveElapsed() {
        let meeting = at(2026, 9, 16, 23, 2)
        let justAfterMidnight = AppDateFormatter.relativeDate(meeting, now: at(2026, 9, 17, 0, 10))
        let laterThatDay = AppDateFormatter.relativeDate(meeting, now: at(2026, 9, 17, 9, 0))
        XCTAssertEqual(justAfterMidnight, laterThatDay,
                       "a date is yesterday for the whole of the next day, not for its first hour")
    }

    /// The "Today at 2:15 PM" form the doc comment always promised and the
    /// interval-based version could never produce.
    func testSameCalendarDayIsDistinctFromYesterday() {
        let meeting = at(2026, 9, 16, 23, 2)
        let sameDay = AppDateFormatter.relativeDate(meeting, now: at(2026, 9, 16, 23, 50))
        let nextDay = AppDateFormatter.relativeDate(meeting, now: at(2026, 9, 17, 9, 0))
        XCTAssertNotEqual(sameDay, nextDay, "today and yesterday must not render identically")
        XCTAssertTrue(sameDay.contains(":"), "today carries a clock time")
    }

    /// Today and yesterday carry a clock time; past that the time of day stops
    /// identifying the meeting and is dropped. A colon stands in for "has a
    /// time" in both 12- and 24-hour locales.
    func testOnlyTodayAndYesterdayCarryAClockTime() {
        let meeting = at(2026, 9, 16, 23, 2)
        XCTAssertTrue(AppDateFormatter.relativeDate(meeting, now: at(2026, 9, 17, 9, 0)).contains(":"),
                      "yesterday carries a clock time")
        XCTAssertFalse(AppDateFormatter.relativeDate(meeting, now: at(2026, 9, 18, 11, 20)).contains(":"),
                       "two days out drops the clock time")
    }

    /// Past a week, the absolute stamp — which does carry a time, so it is
    /// identified by matching `absoluteMedium` rather than by shape.
    func testBeyondAWeekFallsBackToTheAbsoluteStamp() {
        let meeting = at(2026, 9, 16, 23, 2)
        let label = AppDateFormatter.relativeDate(meeting, now: at(2026, 9, 25, 12, 0))
        XCTAssertEqual(label, AppDateFormatter.absoluteMedium(meeting))
    }

    /// A future date means the clock moved, not that something is scheduled —
    /// there is no sensible relative wording, so it takes the absolute stamp
    /// rather than a negative day count.
    func testAFutureDateFallsBackToTheAbsoluteStamp() {
        let future = at(2026, 9, 20, 10, 0)
        let label = AppDateFormatter.relativeDate(future, now: at(2026, 9, 18, 11, 20))
        XCTAssertEqual(label, AppDateFormatter.absoluteMedium(future))
    }
}
