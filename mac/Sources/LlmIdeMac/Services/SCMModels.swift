import Foundation

struct FileChange: Identifiable, Hashable {
    enum Status: String { case added, modified, deleted, renamed, untracked, conflicted }
    var path: String          // repo-relative; for renames, the new path
    var status: Status
    var staged: Bool
    /// The pre-rename path, when `status == .renamed`; nil for every other
    /// status. `StatusParser.parse` fills this from the porcelain line's
    /// "old -> new" segment instead of discarding the old side, so the
    /// changes list can show "old → new" rather than just the new name.
    ///
    /// Trailing property WITH a default so the synthesized memberwise init
    /// still accepts the 3-argument `FileChange(path:status:staged:)` form
    /// used across the codebase.
    var renamedFrom: String? = nil
    var displayPath: String { path }
    /// Identity stays keyed on staged+path only. `renamedFrom` is derived
    /// from the same porcelain line as `path`, so it can never distinguish
    /// two rows that `path` doesn't already distinguish — and including it
    /// would make the id change when a rename is staged, breaking
    /// `ForEach`'s row identity mid-animation.
    var id: String { (staged ? "S:" : "U:") + path }
}

struct DiffRow: Hashable {
    enum Kind { case context, insert, delete }
    var kind: Kind
    var oldLine: Int?
    var newLine: Int?
    var text: String
}

struct DiffHunk: Hashable {
    var header: String        // the @@ line
    var rows: [DiffRow]
}

extension DiffHunk {
    /// Line-level diff between two full strings, packaged as the SAME
    /// `[DiffHunk]` model `UnifiedDiffParser.parse` produces from a real
    /// `git diff` — used where there's no git diff to run at all (an
    /// agent's proposed edit that may not be on disk yet). Ports
    /// `UpdateFileSheet`'s pre-existing `CollectionDifference`-based
    /// algorithm (see `UpdateFileSheet.swift`'s prior `diffRows`) onto the
    /// shared model instead of a private one, so every diff consumer in
    /// this app renders from one type. Always produces at most one hunk
    /// (whole-file context, matching the prior `UpdateFileSheet` behavior
    /// exactly — it never showed multiple hunks either); empty `rows`
    /// (both strings identical AND empty) returns `[]`, not a one-hunk
    /// empty-rows result.
    static func fromLineDiff(old: String, new: String) -> [DiffHunk] {
        let oldLines = Self.splitLines(old)
        let newLines = Self.splitLines(new)
        guard !oldLines.isEmpty || !newLines.isEmpty else { return [] }

        let diff = newLines.difference(from: oldLines)
        var removedFromOld = Set<Int>()
        var insertedInNew = Set<Int>()
        for change in diff {
            switch change {
            case .remove(let off, _, _): removedFromOld.insert(off)
            case .insert(let off, _, _): insertedInNew.insert(off)
            }
        }

        var rows: [DiffRow] = []
        var i = 0
        var j = 0
        while i < oldLines.count || j < newLines.count {
            let iRemoved = i < oldLines.count && removedFromOld.contains(i)
            let jInserted = j < newLines.count && insertedInNew.contains(j)
            if iRemoved {
                rows.append(DiffRow(kind: .delete, oldLine: i + 1, newLine: nil, text: oldLines[i]))
                i += 1
            } else if jInserted {
                rows.append(DiffRow(kind: .insert, oldLine: nil, newLine: j + 1, text: newLines[j]))
                j += 1
            } else if i < oldLines.count && j < newLines.count {
                rows.append(DiffRow(kind: .context, oldLine: i + 1, newLine: j + 1, text: newLines[j]))
                i += 1
                j += 1
            } else if j < newLines.count {
                rows.append(DiffRow(kind: .insert, oldLine: nil, newLine: j + 1, text: newLines[j]))
                j += 1
            } else if i < oldLines.count {
                rows.append(DiffRow(kind: .delete, oldLine: i + 1, newLine: nil, text: oldLines[i]))
                i += 1
            }
        }
        return [DiffHunk(header: "", rows: rows)]
    }

    /// Splits `text` into lines for `fromLineDiff`, including CRLF content.
    /// Same technique as `UnifiedDiffParser.parse`'s line split (see the
    /// doc comment above its `split` call in `SCMParsers.swift` for the
    /// full rationale) — the two must agree on what a "line" is, since
    /// `fromLineDiff` exists to produce the exact same `[DiffHunk]` model.
    /// In short: split on `\.isNewline` (a `"\n"`-only split misses CRLF,
    /// which Swift treats as one grapheme cluster) after dropping exactly
    /// one trailing break with `removeLast()` (every real file ends in a
    /// newline; without this, that terminator becomes a phantom empty
    /// final line), keeping `omittingEmptySubsequences: false` so a
    /// genuine blank line mid-file survives.
    private static func splitLines(_ text: String) -> [String] {
        guard !text.isEmpty else { return [] }
        var content = text
        if let last = content.last, last.isNewline { content.removeLast() }
        return content.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline).map(String.init)
    }
}
