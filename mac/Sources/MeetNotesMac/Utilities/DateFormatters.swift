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

    // MARK: - Public API

    /// Parses an ISO8601 string, trying fractional seconds then without. Returns nil on failure.
    static func parseISO(_ s: String) -> Date? {
        isoWithFractional.date(from: s) ?? isoWithoutFractional.date(from: s)
    }

    /// Short relative form for list rows: "just now", "5m", "3h", "2d", "Apr 3"
    static func relative(_ iso: String) -> String {
        guard let date = parseISO(iso) else { return "" }
        let secs = Date().timeIntervalSince(date)
        if secs < 60 { return "just now" }
        if secs < 3600 { return "\(Int(secs / 60))m" }
        if secs < 86400 { return "\(Int(secs / 3600))h" }
        if secs < 7 * 86400 { return "\(Int(secs / 86400))d" }
        return shortMonthDay.string(from: date)
    }

    /// Long relative form for detail panels: "5m ago", "3h ago", "2d ago", "Apr 3, 2024"
    static func relativeVerbose(_ iso: String) -> String {
        guard let date = parseISO(iso) else { return "" }
        let secs = Date().timeIntervalSince(date)
        if secs < 60 { return "just now" }
        if secs < 3600 { return "\(Int(secs / 60))m ago" }
        if secs < 86400 { return "\(Int(secs / 3600))h ago" }
        if secs < 7 * 86400 { return "\(Int(secs / 86400))d ago" }
        return shortMonthDayYear.string(from: date)
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

    /// Relative string from a Date: "Today at 2:15 PM", "Yesterday at…", "3 days ago", or absolute.
    static func relativeDate(_ date: Date) -> String {
        let ago = Date().timeIntervalSince(date)
        let rel = RelativeDateTimeFormatter()
        if ago < 7 * 24 * 3600 {
            rel.dateTimeStyle = .named
            let s = rel.localizedString(for: date, relativeTo: .now)
            if ago < 2 * 24 * 3600 {
                return "\(s.capitalized) at \(shortTimeFmt.string(from: date))"
            }
            return s.capitalized
        }
        let abs = DateFormatter()
        abs.dateStyle = .medium
        abs.timeStyle = .short
        return abs.string(from: date)
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
}
