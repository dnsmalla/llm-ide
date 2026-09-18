import Foundation

enum AppDateFormatter {

    // MARK: - Private static formatters (reused, not recreated per call)

    private static let isoWithFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let isoWithoutFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static let mediumDateTime: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .short
        return f
    }()

    private static let shortMonthDay: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        return f
    }()

    private static let shortMonthDayYear: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d, yyyy"
        return f
    }()

    private static let yyyyMMdd: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()

    private static let yyyyMMddLocal: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = .current
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    private static let yyyyMMddHHmmLocal: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd-HHmm"
        f.timeZone = .current
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    private static let hhmmss: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        f.timeZone = .current
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    private static let dayNumber: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "d"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    private static let weekdayShort: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "EEE"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    private static let monthYear: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM yyyy"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    private static let monthShort: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    private static let yearOnly: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    private static let shortTimeFmt: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "h:mm a"
        return f
    }()

    private static let isoDefault: ISO8601DateFormatter = ISO8601DateFormatter()

    private static let yearMonthPathFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy/MM"
        // Matches MeetingFileStore.monthFolder's Calendar(identifier: .iso8601)
        // component extraction exactly (year/month are calendar-system values,
        // not locale-formatted ones) — a bare DateFormatter() picks up the
        // system region's calendar by default, which can be non-Gregorian
        // (Japanese, Buddhist, …) and would then disagree with the actual
        // on-disk YYYY/MM folder a raw file lives in.
        f.calendar = Calendar(identifier: .iso8601)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        return f
    }()

    // MARK: - Public API

    /// Parses an ISO8601 string, trying fractional seconds then without. Returns nil on failure.
    static func parseISO(_ s: String) -> Date? {
        isoWithFractional.date(from: s) ?? isoWithoutFractional.date(from: s)
    }

    /// "Apr 3, 2024 at 2:15 PM"; falls back to raw string on parse failure.
    static func absoluteMedium(_ iso: String) -> String {
        guard let date = parseISO(iso) else { return iso }
        return mediumDateTime.string(from: date)
    }

    /// "Apr 3, 2024 at 2:15 PM" from a Date directly.
    static func absoluteMedium(_ date: Date) -> String {
        mediumDateTime.string(from: date)
    }

    /// ISO8601 string using default formatter options.
    static func isoString(_ date: Date) -> String {
        isoDefault.string(from: date)
    }

    /// Parses a "yyyy-MM-dd" date string. Returns nil on failure.
    static func parseDateOnly(_ s: String) -> Date? {
        yyyyMMdd.date(from: s)
    }

    /// Formats a Date to "yyyy-MM-dd".
    static func dateOnly(_ date: Date) -> String {
        yyyyMMdd.string(from: date)
    }

    /// Relative string ("3 days ago", …) from an ISO8601 issue/PR timestamp;
    /// falls back to the raw string on parse failure. Unlike `relativeDate`
    /// (Date → "Today at…"/absolute), this always uses the short relative
    /// form — issue/PR lists have no room for an absolute fallback column.
    static func relativeISO(_ iso: String) -> String {
        guard let date = isoWithoutFractional.date(from: iso) else { return iso }
        return RelativeDateTimeFormatter().localizedString(for: date, relativeTo: Date())
    }

    /// Relative string from a Date: "Today at 2:15 PM", "Yesterday at…",
    /// "3 days ago", or an absolute stamp past a week (and for any future
    /// date, which only a clock skew produces).
    ///
    /// Bucketed by CALENDAR DAY, not by elapsed hours. It used to ask
    /// `RelativeDateTimeFormatter` to name a raw interval, which measures in
    /// 24-hour blocks and has no notion of midnight — so the label disagreed
    /// with the calendar at both ends:
    ///
    ///   * 24–48 h back was named "yesterday" whatever the date. A meeting at
    ///     23:02 on the 16th still read "Yesterday at 11:02 PM" all through
    ///     the 18th, two calendar days later — and sat under a "This Week"
    ///     header, because `LibraryViewModel.dateGroup` buckets by
    ///     `isDateInYesterday` and was right. The row and its own section
    ///     header contradicted each other.
    ///   * Under 24 h it never said "today" or "yesterday" at all: the named
    ///     style falls back to hours below a day, so the `at <time>` suffix
    ///     was glued onto a duration — "9 Hours Ago at 11:02 PM". The "Today
    ///     at 2:15 PM" this doc comment has always promised was unreachable.
    ///
    /// The day count is computed from `startOfDay` on both sides and handed
    /// to the formatter as `DateComponents`, so the wording stays localized
    /// (a Japanese locale still gets 昨日) while the bucket is the calendar's.
    ///
    /// `now` is injectable for tests only; production passes today's date.
    static func relativeDate(_ date: Date, now: Date = Date()) -> String {
        let cal = Calendar.current
        let days = cal.dateComponents([.day],
                                      from: cal.startOfDay(for: date),
                                      to: cal.startOfDay(for: now)).day ?? 0
        guard days >= 0, days < 7 else { return mediumDateTime.string(from: date) }
        let rel = RelativeDateTimeFormatter()
        rel.dateTimeStyle = .named
        let named = rel.localizedString(from: DateComponents(day: -days)).capitalized
        // Only today and yesterday get a clock time: at two days out the time
        // of day stops being the thing that identifies the meeting.
        return days <= 1 ? "\(named) at \(shortTimeFmt.string(from: date))" : named
    }

    /// Formats "2024-04-03" to "Apr 3"; falls back to raw string on parse failure.
    static func dueDateDisplay(_ yyyyMMddStr: String) -> String {
        guard let date = yyyyMMdd.date(from: yyyyMMddStr) else { return yyyyMMddStr }
        return shortMonthDay.string(from: date)
    }

    /// Returns true if the date string represents a date before today.
    static func isDuePast(_ yyyyMMddStr: String) -> Bool {
        guard let date = yyyyMMdd.date(from: yyyyMMddStr) else { return false }
        return date < Calendar.current.startOfDay(for: Date())
    }

    /// "yyyy-MM-dd" in current timezone (en_US_POSIX). For local filenames.
    static func dateOnlyLocal(_ date: Date) -> String {
        yyyyMMddLocal.string(from: date)
    }

    /// "yyyy-MM-dd-HHmm" in current timezone (en_US_POSIX). For local filenames.
    static func dateHourMinuteLocal(_ date: Date) -> String {
        yyyyMMddHHmmLocal.string(from: date)
    }

    /// "HH:mm:ss" in current timezone (en_US_POSIX). For caption/transcript timestamps.
    static func hourMinuteSecond(_ date: Date) -> String {
        hhmmss.string(from: date)
    }

    /// "Apr 3" — month abbreviation + day, no year. Use for compact date stamps.
    static func monthDay(_ date: Date) -> String {
        shortMonthDay.string(from: date)
    }

    /// "Apr 3, 2024" — short month/day/year.
    static func monthDayYear(_ date: Date) -> String {
        shortMonthDayYear.string(from: date)
    }

    /// Day-of-month number, e.g. "3".
    static func dayOfMonth(_ date: Date) -> String {
        dayNumber.string(from: date)
    }

    /// Short weekday, e.g. "Mon".
    static func weekdayAbbrev(_ date: Date) -> String {
        weekdayShort.string(from: date)
    }

    /// "Apr 2024".
    static func monthAndYear(_ date: Date) -> String {
        monthYear.string(from: date)
    }

    /// "Apr".
    static func monthAbbrev(_ date: Date) -> String {
        monthShort.string(from: date)
    }

    /// "2024".
    static func yearString(_ date: Date) -> String {
        yearOnly.string(from: date)
    }

    /// "2026/08" — the YYYY/MM path segment a raw meeting/email/Slack file
    /// actually lives under (see `yearMonthPathFormatter`'s doc comment).
    static func yearMonthPath(_ date: Date) -> String {
        yearMonthPathFormatter.string(from: date)
    }
}
