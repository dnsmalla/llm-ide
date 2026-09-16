// Shared ISO-8601 formatter — every memory/feedback feature
// emits timestamps in the same shape (`2026-05-24T10:00:00Z`).
// One source of truth so frontmatter, log lines, file names,
// and the regression diff sheet can't drift.

import Foundation

extension Date {
    static let iso8601Formatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
}
