import Foundation

/// A parsed 5-field cron expression: `minute hour day-of-month month day-of-week`.
/// Pure value type — the only time dependency is the `now:` parameter on `nextFire`,
/// which is injectable so callers (and tests) control the clock.
struct CronExpression: Sendable, Equatable {
    private let minute: Field
    private let hour: Field
    private let dayOfMonth: Field
    private let month: Field
    private let dayOfWeek: Field   // 0..7 (0 and 7 are both Sunday)

    /// Parse `"m h dom mon dow"`. Returns nil on any malformed field / wrong arity.
    static func parse(_ s: String) -> CronExpression? {
        let parts = s.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
        guard parts.count == 5 else { return nil }
        guard let m = Field.parse(parts[0], min: 0, max: 59),
              let h = Field.parse(parts[1], min: 0, max: 23),
              let dom = Field.parse(parts[2], min: 1, max: 31),
              let mon = Field.parse(parts[3], min: 1, max: 12),
              let dow = Field.parse(parts[4], min: 0, max: 7) else { return nil }
        return CronExpression(minute: m, hour: h, dayOfMonth: dom, month: mon, dayOfWeek: dow)
    }

    /// Next whole-minute match strictly after `after`. `now` bounds the search
    /// (we scan forward up to ~5 years; nil if no match in that window — i.e. an
    /// impossible cron like Feb 30).
    func nextFire(after: Date, now: Date) -> Date? {
        var cal = Calendar.current
        cal.timeZone = TimeZone.current
        let limit = now.addingTimeInterval(60 * 60 * 24 * 366 * 5) // ~5 years
        let dc = cal.dateComponents([.year, .month, .day, .hour, .minute], from: after)
        var y = dc.year ?? 0, mo = dc.month ?? 0, d = dc.day ?? 0
        var h = dc.hour ?? 0, mi = dc.minute ?? 0
        // Start one minute after `after`.
        mi += 1
        func flush() -> Date? { cal.date(from: DateComponents(year: y, month: mo, day: d, hour: h, minute: mi)) }

        while true {
            let probe = flush() ?? Date.distantPast
            if probe > limit { return nil }
            if !month.contains(mo) { mo += 1; h = 0; mi = 0; d = 1; if mo > 12 { mo = 1; y += 1 }; continue }
            // Days-in-month must be derived from a guaranteed-valid date in the
            // scanned month (day 1). `probe` itself may have overflowed — e.g.
            // DateComponents(year:2027, month:2, day:30) normalizes to March 2,
            // which would wrongly report March's 31 days and mask impossible
            // cron dates like Feb 30.
            let firstOfMonth = cal.date(from: DateComponents(year: y, month: mo, day: 1)) ?? probe
            let dim = cal.range(of: .day, in: .month, for: firstOfMonth)?.count ?? 28
            if d < 1 || d > dim || !dayOfMonth.contains(d) { d += 1; h = 0; mi = 0; if d > dim { d = 1; mo += 1; if mo > 12 { mo = 1; y += 1 } }; continue }
            if !hour.contains(h) { h += 1; mi = 0; if h > 23 { h = 0; d += 1 }; continue }
            if !minute.contains(mi) { mi += 1; if mi > 59 { mi = 0; h += 1; if h > 23 { h = 0; d += 1 } }; continue }
            // Day-of-week: Calendar weekday is 1=Sun..7=Sat; cron DOW is 0=Sun..6=Sat
            // (with 7 also meaning Sun). Match if the cron field contains cronDOW,
            // or (cronDOW==0 and the field contains 7).
            let calWeekday = cal.component(.weekday, from: probe)   // 1..7
            let cronDOW = (calWeekday - 1) % 7                      // Sun=0..Sat=6
            let dowMatch = dayOfWeek.contains(cronDOW) || (cronDOW == 0 && dayOfWeek.contains(7))
            if !dowMatch { d += 1; h = 0; mi = 0; continue }
            return probe
        }
    }

    var describe: String {
        if minute.isStep && hour.all && dayOfMonth.all && month.all && dayOfWeek.all {
            return "Every \(minute.step!) min"
        }
        if minute.containsExactlyOne, hour.containsExactlyOne, dayOfMonth.all, month.all, dayOfWeek.all {
            return String(format: "At %02d:%02d", hour.single!, minute.single!)
        }
        return rawDescription
    }

    private var rawDescription: String {
        "\(minute.raw) \(hour.raw) \(dayOfMonth.raw) \(month.raw) \(dayOfWeek.raw)"
    }

    private struct Field: Sendable, Equatable {
        let values: Set<Int>      // the literal values this field matches (already expanded)
        let raw: String           // original text, for describe
        var all: Bool { raw == "*" }
        var isStep: Bool { raw.hasPrefix("*/") }
        var step: Int? { isStep ? Int(raw.dropFirst(2)) : nil }
        var containsExactlyOne: Bool { values.count == 1 }
        var single: Int? { values.sorted().first }

        func contains(_ v: Int) -> Bool { values.contains(v) }

        static func parse(_ s: String, min: Int, max: Int) -> Field? {
            var out: Set<Int> = []
            for term in s.split(separator: ",") {
                let part = String(term)
                if part == "*" { out.formUnion(Array(min...max)) }
                else if part.hasPrefix("*/") {
                    guard let step = Int(part.dropFirst(2)), step > 0 else { return nil }
                    out.formUnion(stride(from: min, through: max, by: step))
                } else if let dash = part.range(of: "/") {
                    let range = String(part[..<dash.lowerBound])
                    let step = Int(part[dash.upperBound...]) ?? 1
                    guard step > 0 else { return nil }
                    let (lo, hi) = bounds(range, min: min, max: max) ?? (min, max)
                    if lo > hi || lo < min || hi > max { return nil }
                    out.formUnion(stride(from: lo, through: hi, by: step))
                } else {
                    let (lo, hi) = bounds(part, min: min, max: max) ?? (Int(part) ?? -1, Int(part) ?? -1)
                    if part.contains("-") {
                        guard lo...hi ~= lo, lo >= min, hi <= max, lo <= hi else { return nil }
                        out.formUnion(Array(lo...hi))
                    } else {
                        guard lo >= min, lo <= max, lo == hi else { return nil }
                        out.insert(lo)
                    }
                }
            }
            return out.isEmpty ? nil : Field(values: out, raw: s)
        }

        private static func bounds(_ s: String, min: Int, max: Int) -> (Int, Int)? {
            guard let dash = s.range(of: "-") else { return nil }
            let lo = Int(s[..<dash.lowerBound])
            let hi = Int(s[dash.upperBound...])
            guard let lo, let hi else { return nil }
            return (lo, hi)
        }
    }
}
