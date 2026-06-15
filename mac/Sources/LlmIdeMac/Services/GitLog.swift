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

/// One annotated line from `git blame` (blame gutter).
struct BlameLine: Identifiable, Hashable {
    let line: Int
    let shortSha: String
    let author: String
    var id: Int { line }
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

    /// Parse `git blame --line-porcelain`. Each annotated line is a group that
    /// begins with a header `<40-hex-sha> <orig-line> <final-line>[ <count>]`,
    /// followed by header fields (incl. `author <name>`), and ends with a
    /// content line prefixed by a tab (`\t<code>`). We emit one BlameLine per
    /// content line, using the final-line number, the 7-char sha prefix and
    /// the most-recent `author` field.
    static func parseBlame(_ out: String) -> [BlameLine] {
        var result: [BlameLine] = []
        var sha = ""
        var finalLine = 0
        var author = ""
        for raw in out.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            if line.hasPrefix("\t") {
                // Content line — close out the current group.
                result.append(BlameLine(line: finalLine,
                                         shortSha: String(sha.prefix(7)),
                                         author: author))
                continue
            }
            if line.hasPrefix("author ") {
                author = String(line.dropFirst("author ".count))
                continue
            }
            // A header line starts with a 40-hex sha followed by line numbers.
            let fields = line.split(separator: " ")
            if fields.count >= 3, fields[0].count == 40,
               fields[0].allSatisfy({ $0.isHexDigit }),
               let fin = Int(fields[2]) {
                sha = String(fields[0])
                finalLine = fin
            }
        }
        return result
    }
}
