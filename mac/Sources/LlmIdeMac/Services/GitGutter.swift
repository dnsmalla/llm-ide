import Foundation

enum GitGutter {
    enum Mark { case added, modified }

    /// New-side line number → change mark, derived from a unified diff.
    /// A run of inserts adjacent to deletes is "modified"; pure inserts are "added".
    static func changedLines(fromDiff diff: String) -> [Int: Mark] {
        var marks: [Int: Mark] = [:]
        for hunk in UnifiedDiffParser.parse(diff) {
            var sawDeleteInRun = false
            for row in hunk.rows {
                switch row.kind {
                case .delete: sawDeleteInRun = true
                case .insert:
                    if let n = row.newLine { marks[n] = sawDeleteInRun ? .modified : .added }
                case .context: sawDeleteInRun = false
                }
            }
        }
        return marks
    }

    /// Compute marks for a file inside a repo (async; empty when not a repo / clean).
    static func changedLines(repo: URL, filePath: String, runGit: ([String], URL) async throws -> String) async -> [Int: Mark] {
        guard let raw = try? await runGit(["diff", "--", filePath], repo), !raw.isEmpty else { return [:] }
        return changedLines(fromDiff: raw)
    }
}
