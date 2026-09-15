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

    // MARK: - Candidate walk

    /// Walk `root` pre-order and return, sorted by `displayPath`, the files a
    /// search should read.
    ///
    /// Filters in order: `IgnoreList.directories` noise dirs (skipped whole),
    /// `.gitignore` (repo root + `.git/info/exclude`, plus every nested
    /// `.gitignore` added as its directory is ENTERED — pre-order guarantees a
    /// nested rule lands after the rules it may override), then the
    /// include/exclude globs on the repo-relative path.
    ///
    /// An ignored DIRECTORY is pruned with `skipDescendants()`, not merely
    /// filtered: testing every file under `node_modules/` against the rule set
    /// individually is the difference between milliseconds and seconds.
    ///
    /// Collecting up front rather than lazily is deliberate: enumeration only
    /// touches directory metadata (no file is read here), so it costs
    /// milliseconds even on a large repo, and it lets the ignore state be a
    /// plain local `var` instead of `inout` state threaded through a lazy
    /// sequence. Sorting here also means `scan` emits in display order, so the
    /// UI can append instead of insert — and the truncation cutoff becomes
    /// deterministic across runs.
    ///
    /// `respectGitignore: false` skips the `.gitignore` layer entirely (noise
    /// dirs and the globs still apply), for a caller that wants to search
    /// build output.
    static func collectCandidates(root: URL,
                                  include: String,
                                  exclude: String,
                                  respectGitignore: Bool = true,
                                  isCancelled: () -> Bool) -> [Candidate] {
        let fm = FileManager.default
        // Two prefixes, because the cheap one usually works: the enumerator
        // yields URLs built by appending to `root`, so their RAW paths carry
        // the root's own spelling. Only when that fails (a symlinked/firmlinked
        // root — the enumerator can yield `/private/var/…` where the caller
        // passed `/var/…`) do we pay for `standardizedFileURL`, which hits the
        // filesystem for Foundation's `/private` special case and measurably
        // inflates a walk when called per entry.
        let rawPrefix = root.path == "/" ? "/" : root.path + "/"
        let stdRoot = root.standardizedFileURL.path
        let stdPrefix = stdRoot == "/" ? "/" : stdRoot + "/"
        // Optional rather than an empty `GitIgnoreRules`: nil is the honest
        // representation of "this run does not consult .gitignore at all".
        var ignore: GitIgnoreRules? = respectGitignore ? GitIgnoreRules.repoRoot(root) : nil

        guard let en = fm.enumerator(
            at: root,
            includingPropertiesForKeys: [.isRegularFileKey, .isDirectoryKey],
            options: [.skipsHiddenFiles]) else { return [] }

        var out: [Candidate] = []
        let excludeActive = exclude.split(separator: ",").contains {
            !$0.trimmingCharacters(in: .whitespaces).isEmpty
        }
        for case let url as URL in en {
            if isCancelled() { return [] }
            if IgnoreList.directories.contains(url.lastPathComponent) {
                en.skipDescendants()
                continue
            }
            guard let display = relativePath(of: url, rawPrefix: rawPrefix, stdPrefix: stdPrefix) else { continue }
            let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isDirectoryKey])
            let isDir = values?.isDirectory ?? false
            if let ignore, isIgnoredHere(display, isDirectory: isDir, rules: ignore) {
                if isDir { en.skipDescendants() }
                continue
            }
            if isDir {
                // Pre-order: this directory's own .gitignore must be in the
                // rule list before any of its children are tested.
                ignore?.addFile(at: url.appendingPathComponent(".gitignore"), base: display)
                continue
            }
            guard values?.isRegularFile == true else { continue }
            guard GlobMatch.matchesAny(path: display, patterns: include) else { continue }
            if excludeActive && GlobMatch.matchesAny(path: display, patterns: exclude) { continue }
            out.append(Candidate(url: url, displayPath: display))
        }
        return out.sorted {
            $0.displayPath.localizedCaseInsensitiveCompare($1.displayPath) == .orderedAscending
        }
    }

    /// Is `path` ignored BY ITS OWN NAME, ignoring its ancestors?
    ///
    /// `GitIgnoreRules.isIgnored(relativePath:isDirectory:)` also tests every
    /// ancestor component, which is what a caller holding a bare path needs.
    /// Inside this pre-order walk that work is pure waste: an ancestor
    /// directory was evaluated when the enumerator entered it, and an ignored
    /// one was pruned with `skipDescendants()`, so no path reaching this line
    /// has an ignored ancestor. Measured on this repo's own `.gitignore` the
    /// ancestor loop is the dominant cost — see the P4 T3 report.
    ///
    /// THIS MAKES `skipDescendants()` LOAD-BEARING FOR CORRECTNESS, not just
    /// speed. Drop the pruning and files under an ignored directory start
    /// coming back. (git's own rule — a file under an excluded directory can
    /// never be re-included — is preserved either way: pruning and the
    /// ancestor loop reach the same answer.)
    ///
    /// Last matching rule wins, mirroring `GitIgnoreRules.decide(path:isDirectory:)`,
    /// which is private. Exposing it (or a `isIgnoredExact(...)`) would let this
    /// duplication go away; see the T3 report's note to the reviewer.
    private static func isIgnoredHere(_ path: String,
                                      isDirectory: Bool,
                                      rules: GitIgnoreRules) -> Bool {
        var ignored = false
        for rule in rules.rules where rule.matches(path: path, isDirectory: isDirectory) {
            ignored = !rule.isNegated
        }
        return ignored
    }

    /// `url`'s path relative to the root the two prefixes describe, or nil when
    /// it is outside. See `collectCandidates` for why there are two.
    private static func relativePath(of url: URL, rawPrefix: String, stdPrefix: String) -> String? {
        let raw = url.path
        if raw.hasPrefix(rawPrefix) { return String(raw.dropFirst(rawPrefix.count)) }
        let std = url.standardizedFileURL.path
        guard std.hasPrefix(stdPrefix) else { return nil }
        return String(std.dropFirst(stdPrefix.count))
    }
}
