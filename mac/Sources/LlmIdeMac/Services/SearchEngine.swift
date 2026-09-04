import Foundation

/// The pure match core behind `SearchService`. No actor, no `AsyncStream`, no
/// filesystem walk — it takes text (or an already-decided list of candidate
/// files plus a reader closure) and produces matches, so every behaviour here
/// is unit-testable without a live repo or a Task.
enum SearchEngine {
    /// Global match cap for one run. Reached → the run stops and the UI shows
    /// a truncation warning rather than silently presenting a partial list as
    /// if it were complete.
    static let maxMatches = 1000
    /// Files larger than this are skipped: a 1 MB source file is already
    /// pathological, and reading a huge blob into memory to grep it is not
    /// acceptable in an interactive panel.
    static let maxFileBytes = 1_000_000

    /// One file the walk decided is worth reading.
    struct Candidate: Equatable {
        let url: URL
        /// Path relative to the search root, as shown in the results list.
        let displayPath: String
    }

    /// How a `scan` ended.
    enum Outcome: Equatable {
        case completed(totalMatches: Int, fileCount: Int)
        /// `maxMatches` was hit; results are a prefix of the truth.
        case truncated(totalMatches: Int, fileCount: Int)
        /// `isCancelled` returned true. Results are partial AND the consumer
        /// is gone, so callers must not report a total for this run.
        case cancelled
    }

    /// Split `text` into lines and match `regex` against each. Line numbers
    /// are 1-BASED, matching what an editor shows.
    ///
    /// Splits on `\.isNewline`, NEVER on the literal `"\n"`: Swift treats
    /// `"\r\n"` as ONE `Character`, so `split(separator: "\n")` returns a CRLF
    /// file as a single line and reports every match on line 1 — the bug that
    /// made search-result line numbers useless in CRLF files, and which would
    /// have silently broken this phase's line-jump.
    ///
    /// `budget` caps how many matches may be produced (the run-wide
    /// `maxMatches` remainder); `used` is how many actually were, so the
    /// caller can tell whether the cap was reached.
    static func lineMatches(in text: String,
                            regex: NSRegularExpression,
                            budget: Int) -> (lines: [LineMatch], used: Int) {
        guard budget > 0 else { return ([], 0) }
        var lines: [LineMatch] = []
        var fileIndex = 0        // monotonic per file, in document order
        var used = 0
        var lineNo = 0
        for sub in text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline) {
            lineNo += 1
            if used >= budget { break }
            let lineText = String(sub)
            let nsLine = lineText as NSString
            let hits = regex.matches(in: lineText, options: [],
                                     range: NSRange(location: 0, length: nsLine.length))
            if hits.isEmpty { continue }
            var matches: [Match] = []
            for hit in hits {
                if used >= budget { break }
                matches.append(Match(nsRange: hit.range, fileIndex: fileIndex))
                fileIndex += 1
                used += 1
            }
            if !matches.isEmpty {
                lines.append(LineMatch(line: lineNo, lineText: lineText, matches: matches))
            }
        }
        return (lines, used)
    }

    /// A file whose first 4 KB contains a NUL byte is treated as binary.
    static func isBinary(_ data: Data) -> Bool { data.prefix(4096).contains(0) }

    /// Read a candidate as UTF-8 text, or nil when it is too big, unreadable,
    /// binary, or not valid UTF-8. This is `scan`'s default reader; tests pass
    /// their own closure instead of touching disk.
    static func fileText(at url: URL) -> String? {
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard size <= maxFileBytes,
              let data = try? Data(contentsOf: url),
              !isBinary(data) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Match every candidate in order, handing each non-empty `FileMatch` to
    /// `emit` the moment it is complete — this is what lets results appear
    /// incrementally instead of all at the end.
    ///
    /// Cancellation is an INJECTED `() -> Bool`, not a direct
    /// `Task.isCancelled` read, so a test can drive it deterministically
    /// without spawning a Task; the real caller passes `{ Task.isCancelled }`.
    /// It is consulted before every file, which is the granularity that
    /// matters: reading and matching one file is the unit of work.
    static func scan(candidates: [Candidate],
                     regex: NSRegularExpression,
                     readText: (URL) -> String? = { SearchEngine.fileText(at: $0) },
                     isCancelled: () -> Bool,
                     emit: (FileMatch) -> Void) -> Outcome {
        var total = 0
        var fileCount = 0
        for candidate in candidates {
            if isCancelled() { return .cancelled }
            if total >= maxMatches { return .truncated(totalMatches: total, fileCount: fileCount) }
            guard let text = readText(candidate.url) else { continue }
            let (lines, used) = lineMatches(in: text, regex: regex, budget: maxMatches - total)
            total += used
            guard !lines.isEmpty else { continue }
            fileCount += 1
            emit(FileMatch(url: candidate.url,
                           displayPath: candidate.displayPath,
                           lineMatches: lines))
        }
        if isCancelled() { return .cancelled }
        if total >= maxMatches { return .truncated(totalMatches: total, fileCount: fileCount) }
        return .completed(totalMatches: total, fileCount: fileCount)
    }
}
