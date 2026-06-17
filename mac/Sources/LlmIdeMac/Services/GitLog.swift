import Foundation

/// One commit row from `git log` (history view).
struct Commit: Identifiable, Hashable {
    let sha: String
    let shortSha: String
    let author: String
    let relativeDate: String
    let subject: String
    var id: String { sha }
}

/// Pure parser for the US-delimited `git log` format used by the history view.
enum GitLog {
    /// Parse `git log --pretty=%H%x1f%h%x1f%an%x1f%ar%x1f%s` (US-delimited
    /// fields, newline-delimited records).
    static func parse(_ out: String) -> [Commit] {
        out.split(separator: "\n", omittingEmptySubsequences: true).compactMap { line in
            let f = line.components(separatedBy: "\u{1f}")
            guard f.count == 5 else { return nil }
            return Commit(sha: f[0], shortSha: f[1], author: f[2], relativeDate: f[3], subject: f[4])
        }
    }

}
