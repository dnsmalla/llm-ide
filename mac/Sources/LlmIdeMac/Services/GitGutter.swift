import Foundation

enum GitGutter {
    /// `: Equatable` is required (not synthesized for a plain no-raw-value
    /// enum without it) — `GitGutterTests` compares `[Int: Mark]` dictionaries
    /// via `XCTAssertEqual`, which needs `Mark: Equatable`.
    enum Mark: Equatable { case added, modified, deleted }

    /// New-side line number -> change mark, derived from a unified diff.
    ///
    /// - A run of inserts adjacent to deletes is "modified".
    /// - Pure inserts are "added".
    /// - A pure deletion (no adjacent insert) has no new-side line of its
    ///   own — VS Code and most diff UIs render it as a thin marker attached
    ///   to the line immediately after the deleted content, so that's the
    ///   anchor used here: `lastNewLine + 1`, where `lastNewLine` is the most
    ///   recent context/insert row's new-line number (0 if the deletion is
    ///   the very first row of the hunk, anchoring it at line 1).
    static func changedLines(fromDiff diff: String) -> [Int: Mark] {
        var marks: [Int: Mark] = [:]
        for hunk in UnifiedDiffParser.parse(diff) {
            var sawDeleteInRun = false
            var lastNewLine = 0
            var deleteAnchor: Int?
            for row in hunk.rows {
                switch row.kind {
                case .delete:
                    if !sawDeleteInRun { deleteAnchor = lastNewLine + 1 }
                    sawDeleteInRun = true
                case .insert:
                    if let n = row.newLine {
                        marks[n] = sawDeleteInRun ? .modified : .added
                        lastNewLine = n
                    }
                    sawDeleteInRun = false
                    deleteAnchor = nil
                case .context:
                    if sawDeleteInRun, let anchor = deleteAnchor, marks[anchor] == nil {
                        marks[anchor] = .deleted
                    }
                    sawDeleteInRun = false
                    deleteAnchor = nil
                    if let n = row.newLine { lastNewLine = n }
                }
            }
            // A deletion as the LAST row(s) of a hunk never sees a trailing
            // context/insert row to trigger the branch above.
            if sawDeleteInRun, let anchor = deleteAnchor, marks[anchor] == nil {
                marks[anchor] = .deleted
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
