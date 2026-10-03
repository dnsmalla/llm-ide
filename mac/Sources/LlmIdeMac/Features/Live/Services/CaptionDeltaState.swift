import Foundation

/// One change the orchestrator must apply to its caption list.  Every row
/// has a stable `row` id so a later change targets exactly that row.
enum CaptionDelta: Equatable {
    /// A new utterance (row ids are never reused within one state).
    case append(row: Int, speaker: String, text: String)
    /// The utterance in `row` grew in place; replace its text.
    case replace(row: Int, speaker: String, oldText: String, newText: String)
    /// The row left the screen (or the panel stayed empty long enough) and
    /// will never grow again; it is safe to persist.
    case closed(row: Int)
}

/// Pure "snapshot -> deltas" policy for AX-scraped captions.
///
/// AX scrapers return everything currently on screen on every poll.  Each
/// snapshot is an ORDERED list; it is aligned with the previous snapshot as
/// an in-order multiset of `(speaker, text)` (longest common subsequence),
/// never as a set, so the same text reappearing after another line
/// intervened, or twice at once from different speakers, is not dropped.
///
/// - A line aligned with a previous line is unchanged (no delta).
/// - A line is GROWTH only if a previous line from the same speaker is a
///   prefix of it ending at a word boundary AND that old text is no longer
///   on screen (it grew in place).
/// - Anything else is a NEW utterance.
///
/// NOTE: kept separate from `LiveSessionMirror.mergeCaptionInPlace` on
/// purpose; that one works on server-sequenced rows, this one on raw screen
/// snapshots with no sequence numbers.
struct CaptionDeltaState {
    private struct Entry {
        let row: Int
        let speaker: String
        let text: String
    }

    /// Consecutive empty snapshots tolerated before the on-screen rows are
    /// closed and forgotten (panel closed rather than flicker).
    static let maxEmptyTicks = 40

    private var previous: [Entry] = []
    private var nextRow = 0
    private var emptyStreak = 0

    /// Computes the deltas for `snapshot` and updates internal state.
    ///
    /// Precondition: lines are in on-screen (chronological) order.
    /// Postcondition: unchanged lines yield no delta; an empty snapshot
    /// yields no delta (flicker) until `maxEmptyTicks` in a row, after which
    /// all remembered rows are reported `closed`.
    mutating func ingest(_ snapshot: [(speaker: String, text: String)]) -> [CaptionDelta] {
        guard !snapshot.isEmpty else {
            emptyStreak += 1
            guard emptyStreak >= Self.maxEmptyTicks, !previous.isEmpty else { return [] }
            let closed = previous.map { CaptionDelta.closed(row: $0.row) }
            previous = []
            return closed
        }
        emptyStreak = 0

        let snapshotKeys = snapshot.map { LineKey(speaker: $0.speaker, text: $0.text) }
        let aligned = Self.align(previous: previous.map { LineKey(speaker: $0.speaker, text: $0.text) },
                                 snapshot: snapshotKeys)
        let matchedPrevious = Set(aligned.compactMap { $0 })
        // Candidates for "grew from": unmatched previous lines whose exact
        // text is gone from the screen.  Computed once per tick, not per line.
        let onScreen = Set(snapshotKeys)
        let growthCandidates = previous.indices.filter {
            !matchedPrevious.contains($0)
                && !onScreen.contains(LineKey(speaker: previous[$0].speaker, text: previous[$0].text))
        }
        var claimed = Set<Int>()
        var deltas: [CaptionDelta] = []
        var current: [Entry] = []

        for (j, line) in snapshot.enumerated() {
            if let i = aligned[j] {
                current.append(previous[i])
                continue
            }
            if let i = growthSource(for: line, at: j, candidates: growthCandidates,
                                    excluding: claimed) {
                claimed.insert(i)
                let old = previous[i]
                deltas.append(.replace(row: old.row, speaker: line.speaker,
                                       oldText: old.text, newText: line.text))
                current.append(Entry(row: old.row, speaker: line.speaker, text: line.text))
            } else {
                let row = nextRow
                nextRow += 1
                deltas.append(.append(row: row, speaker: line.speaker, text: line.text))
                current.append(Entry(row: row, speaker: line.speaker, text: line.text))
            }
        }
        for (i, old) in previous.enumerated()
        where !matchedPrevious.contains(i) && !claimed.contains(i) {
            deltas.append(.closed(row: old.row))
        }
        previous = current
        return deltas
    }

    /// Applies `deltas` to `rows`. Shared by tests; `replace` falls back to
    /// an append when the row is gone, `closed` is a no-op here.
    static func apply(_ deltas: [CaptionDelta],
                      to rows: inout [(row: Int, speaker: String, text: String)]) {
        for delta in deltas {
            switch delta {
            case let .append(row, speaker, text):
                rows.append((row, speaker, text))
            case let .replace(row, speaker, _, newText):
                if let idx = rows.firstIndex(where: { $0.row == row }) {
                    rows[idx] = (row, speaker, newText)
                } else {
                    rows.append((row, speaker, newText))
                }
            case .closed:
                break
            }
        }
    }

    // MARK: - Private

    /// Exact `(speaker, text)` identity of one line.
    struct LineKey: Hashable {
        let speaker: String
        let text: String
    }

    /// For each snapshot index, the previous index it is aligned with
    /// (in-order multiset match on exact key), or nil.  The result is a
    /// maximum-size in-order matching (an LCS).
    ///
    /// Cost control (runs every tick on the main actor): lines present on
    /// only one side can never match and are filtered out, then the common
    /// head and tail are matched directly, so an unchanged or scrolled
    /// snapshot is O(n) and the quadratic table only covers the changed
    /// middle.  When several maximum matchings exist the tie-break may pick
    /// a different (equally large) one than a plain full-table LCS.
    static func align(previous prevKeys: [LineKey], snapshot curKeys: [LineKey]) -> [Int?] {
        var result = [Int?](repeating: nil, count: curKeys.count)
        guard !prevKeys.isEmpty, !curKeys.isEmpty else { return result }
        let prevSet = Set(prevKeys)
        let curSet = Set(curKeys)
        let pIdx = prevKeys.indices.filter { curSet.contains(prevKeys[$0]) }
        let cIdx = curKeys.indices.filter { prevSet.contains(curKeys[$0]) }
        let pCount = pIdx.count
        let cCount = cIdx.count
        let limit = min(pCount, cCount)

        var head = 0
        while head < limit && prevKeys[pIdx[head]] == curKeys[cIdx[head]] {
            result[cIdx[head]] = pIdx[head]
            head += 1
        }
        var tail = 0
        while tail < limit - head
            && prevKeys[pIdx[pCount - 1 - tail]] == curKeys[cIdx[cCount - 1 - tail]] {
            result[cIdx[cCount - 1 - tail]] = pIdx[pCount - 1 - tail]
            tail += 1
        }
        let rowCount = pCount - head - tail
        let colCount = cCount - head - tail
        guard rowCount > 0, colCount > 0 else { return result }

        func isEqual(_ i: Int, _ j: Int) -> Bool {
            prevKeys[pIdx[head + i]] == curKeys[cIdx[head + j]]
        }
        let width = colCount + 1
        var table = [Int32](repeating: 0, count: (rowCount + 1) * width)
        for i in stride(from: rowCount - 1, through: 0, by: -1) {
            for j in stride(from: colCount - 1, through: 0, by: -1) {
                table[i * width + j] = isEqual(i, j)
                    ? table[(i + 1) * width + j + 1] + 1
                    : max(table[(i + 1) * width + j], table[i * width + j + 1])
            }
        }
        var i = 0
        var j = 0
        while i < rowCount && j < colCount {
            if isEqual(i, j) {
                result[cIdx[head + j]] = pIdx[head + i]
                i += 1
                j += 1
            } else if table[(i + 1) * width + j] >= table[i * width + j + 1] {
                i += 1
            } else {
                j += 1
            }
        }
        return result
    }

    /// The candidate previous line (same speaker, nearest position) that
    /// `line` grew from, if any.  `candidates` are ascending previous
    /// indices whose old text is already known to be gone from the screen.
    private func growthSource(for line: (speaker: String, text: String), at j: Int,
                              candidates: [Int],
                              excluding taken: Set<Int>) -> Int? {
        var best: Int?
        var bestDistance = Int.max
        for i in candidates where !taken.contains(i) {
            let old = previous[i]
            guard old.speaker == line.speaker,
                  Self.isGrowth(from: old.text, to: line.text) else { continue }
            let distance = abs(i - j)
            if distance < bestDistance {
                best = i
                bestDistance = distance
            }
        }
        return best
    }

    /// True when `new` strictly extends `old` and the extension starts at a
    /// word/punctuation boundary ("No" -> "Nothing" is not growth).
    private static func isGrowth(from old: String, to new: String) -> Bool {
        guard !old.isEmpty, new.count > old.count, new.hasPrefix(old),
              let last = old.last, let first = new.dropFirst(old.count).first else {
            return false
        }
        return !(isLatinWordCharacter(last) && isLatinWordCharacter(first))
    }

    /// NOTE: only ASCII letters/digits count; CJK has no spaces so growth
    /// there is legitimately mid-"word".
    private static func isLatinWordCharacter(_ char: Character) -> Bool {
        char.isASCII && (char.isLetter || char.isNumber)
    }
}
