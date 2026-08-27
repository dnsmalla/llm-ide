import Foundation

extension Date {
    /// `2026-05-24T10:00:00Z` — RFC-3339-ish internet date time.
    var iso8601String: String { Self.iso8601Formatter.string(from: self) }

    static let iso8601Formatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
}
