import Foundation
import Observation

struct SearchOptions: Equatable { var caseSensitive = false; var wholeWord = false; var regex = false }
struct Match: Hashable { let nsRange: NSRange; let fileIndex: Int }   // utf16 range within lineText
/// One matching line. `lineText` is a PREVIEW: for a long line (a minified
/// bundle is one 900 KB line) it is a window around the first match, not the
/// whole line — see `SearchEngine.maxPreviewUTF16`. `previewOffset` is where
/// that window starts in the real line, so `rangeInLine(_:)` recovers the
/// position replace needs.
struct LineMatch: Hashable {
    let line: Int
    let lineText: String
    let matches: [Match]
    var previewOffset: Int = 0
    /// `m`'s UTF-16 range within the FULL line (what replace locates by).
    func rangeInLine(_ m: Match) -> NSRange {
        NSRange(location: m.nsRange.location + previewOffset, length: m.nsRange.length)
    }
}
struct FileMatch: Identifiable, Hashable { let url: URL; let displayPath: String; let lineMatches: [LineMatch]; var id: String { url.path } }
struct SearchResults: Equatable {
    var files: [FileMatch] = []
    var totalMatches = 0
    var fileCount = 0
    var invalidPattern = false
    /// The run stopped at `SearchEngine.maxMatches`; `files` is a prefix of
    /// the truth and the UI must say so.
    var truncated = false
}

/// One event from a streaming search.
///
/// Design §6.5 asks for "an `AsyncStream<FileMatch>` (or a callback-per-file
/// API)". This is that, plus the two out-of-band signals the P4 UI needs: a
/// truncation warning and the final totals are facts about the RUN, not about
/// any one file, so they cannot ride inside a `FileMatch`.
///
/// There is deliberately no `.invalidPattern` case: that condition can only
/// ever be known BEFORE the first event, so the caller checks it with
/// `SearchService.makeRegex` and never starts a stream at all.
enum SearchEvent: Equatable {
    case file(FileMatch)
    /// The run stopped at the match cap. Always yielded before `.finished`.
    case truncated(cap: Int)
    /// The run finished normally. NEVER yielded for a cancelled run — the
    /// consumer is gone and a partial total would be a lie.
    case finished(totalMatches: Int, fileCount: Int)
}

@MainActor
@Observable
final class SearchService {
    /// The query as the search actually sees it: surrounding whitespace is not
    /// a search term. `nil` means "there is nothing to search for" — the caller
    /// must clear its results and start NO walk, rather than scanning the whole
    /// repo for a pattern that matches every position in every file.
    ///
    /// Pure and separated for tests, mirroring `MonacoRevealGate` and
    /// `MonacoEditorMessageHandler.effect(for:)`. It lives here rather than in
    /// `SearchView` because the deleted batch `search(...)` wrapper used to own
    /// this rule, and `Views/Search` is excluded from the lite/min builds.
    nonisolated static func normalizedQuery(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// Build the regex driving both find and replace. Plain queries are escaped;
    /// `wholeWord` wraps `\b…\b`; `regex` is taken verbatim. Case-insensitive
    /// unless `caseSensitive`. Returns nil for an invalid regex pattern.
    nonisolated static func makeRegex(query: String, options: SearchOptions) -> NSRegularExpression? {
        var pattern = options.regex ? query : NSRegularExpression.escapedPattern(for: query)
        // Group before adding word boundaries so alternation in a regex query
        // (e.g. `foo|bar`) binds inside the \b…\b, not as `\bfoo|bar\b`.
        if options.wholeWord { pattern = "\\b(?:" + pattern + ")\\b" }
        // Search and replace both match one line at a time, so ^/$ are line
        // anchors either way; `.anchorsMatchLines` keeps them so for any
        // caller that hands this regex a multi-line string.
        var opts: NSRegularExpression.Options = [.anchorsMatchLines]
        if !options.caseSensitive { opts.insert(.caseInsensitive) }
        return try? NSRegularExpression(pattern: pattern, options: opts)
    }

    /// Streaming, cancellable search. Returns immediately; the walk runs on a
    /// detached task and yields `.file` as each matching file completes, in
    /// `displayPath` order (`collectCandidates` sorts, so no re-sort is needed
    /// downstream and the truncation cutoff is the same on every run).
    ///
    /// CANCELLATION (design §3 finding #8, §9): stop iterating — or cancel the
    /// task that iterates — and `AsyncStream`'s termination handler cancels the
    /// walk. `SearchEngine.scan` checks `Task.isCancelled` before every file, so
    /// a superseded search stops within one file instead of running the whole
    /// repo to completion in the background, which is exactly what the old
    /// `Task.detached`-with-no-checks `search(...)` did. A cancelled run yields
    /// NOTHING further — no `.truncated`, no `.finished`.
    ///
    /// TRUNCATION IS DELIBERATELY CONSERVATIVE. `SearchEngine.scan` reports
    /// `.truncated` whenever the run ends with `total >= maxMatches`, including
    /// a run that consumed every candidate and dropped nothing. This does NOT
    /// suppress that warning when the candidate list was exhausted, because
    /// exhaustion does not prove nothing was dropped: `lineMatches` also stops
    /// at the remaining budget, so the LAST file can have unreported matches
    /// while the walk still finishes. A false "there may be more" is safe; a
    /// false "this is complete" is not. Distinguishing the two would need
    /// `lineMatches` to report that it hit its budget — an engine change, not a
    /// stream change.
    ///
    /// The caller MUST validate the pattern first with `makeRegex` — passing a
    /// compiled regex in is what keeps an impossible error case out of
    /// `SearchEvent`. `readText` is an injection seam mirroring
    /// `SearchEngine.scan`'s: production uses the default, a test drives file
    /// reads deterministically (and can observe how many candidates the walk
    /// actually pulled after a consumer walks away).
    nonisolated static func stream(regex: NSRegularExpression,
                                   root: URL,
                                   include: String,
                                   exclude: String,
                                   respectGitignore: Bool = true,
                                   readText: @escaping @Sendable (URL) -> String? = { SearchEngine.fileText(at: $0) })
        -> AsyncStream<SearchEvent> {
        AsyncStream { continuation in
            let task = Task.detached(priority: .userInitiated) {
                let candidates = SearchEngine.collectCandidates(
                    root: root, include: include, exclude: exclude,
                    respectGitignore: respectGitignore,
                    isCancelled: { Task.isCancelled })
                if Task.isCancelled { continuation.finish(); return }

                let outcome = SearchEngine.scan(
                    candidates: candidates,
                    regex: regex,
                    readText: readText,
                    isCancelled: { Task.isCancelled },
                    emit: { continuation.yield(.file($0)) })

                switch outcome {
                case .completed(let total, let files):
                    continuation.yield(.finished(totalMatches: total, fileCount: files))
                case .truncated(let total, let files):
                    continuation.yield(.truncated(cap: SearchEngine.maxMatches))
                    continuation.yield(.finished(totalMatches: total, fileCount: files))
                case .cancelled:
                    break   // no `.finished`: the consumer is gone
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: - Replace

    /// Case-preserving transform for a single replacement. If the matched text
    /// is all-uppercase (and contains letters) → uppercase the replacement;
    /// else if it's Capitalized (first letter uppercase, not all-caps) →
    /// uppercase the first character of the replacement, rest verbatim;
    /// otherwise the replacement is returned unchanged. Pure + tested.
    nonisolated static func preserveCaseReplacement(matched: String, replacement: String) -> String {
        let hasLetters = matched.contains { $0.isLetter }
        if hasLetters && matched == matched.uppercased() {
            return replacement.uppercased()
        }
        if let first = matched.first, first.isUppercase, matched != matched.uppercased() {
            return replacement.prefix(1).uppercased() + replacement.dropFirst()
        }
        return replacement
    }

    // Every replace entry point below does its file IO and regex work on a
    // DETACHED task, like `stream` does, never on the main actor: a Replace
    // All over hundreds of files (or one 1 MB file with a slow regex) used to
    // freeze the whole app until it finished.

    /// Replace every match of `query` in `file` with `replacement`, writing the
    /// file back as UTF-8. Returns false if the file can't be read, the regex
    /// is invalid, or nothing matched. Matching is per line, exactly as the
    /// search matches (see `SearchEngine.replacingAll`). In non-regex mode the
    /// replacement is literal (`$`/`\` included); in regex mode it is a
    /// template (so `$1` etc. work); `preserveCase` applies to non-regex only.
    func replaceInFile(file: URL, query: String, options: SearchOptions, replacement: String, preserveCase: Bool) async -> Bool {
        await Task.detached(priority: .userInitiated) {
            Self.replaceAllOnDisk(file: file, query: query, options: options,
                                  replacement: replacement, preserveCase: preserveCase)
        }.value
    }

    /// Replace only the match the results list showed at 1-based `line`,
    /// UTF-16 `rangeInLine` within that line (see `SearchEngine.replacingOne`
    /// for why it is located by position, not by ordinal). Returns false if
    /// the file can't be read, the regex is invalid, or that match is gone.
    func replaceOne(file: URL, line: Int, rangeInLine: NSRange, query: String, options: SearchOptions, replacement: String, preserveCase: Bool) async -> Bool {
        await Task.detached(priority: .userInitiated) {
            guard let text = Self.readText(file),
                  let regex = Self.makeRegex(query: query, options: options),
                  let out = SearchEngine.replacingOne(in: text, line: line, rangeInLine: rangeInLine,
                                                      regex: regex, replacement: replacement,
                                                      options: options, preserveCase: preserveCase)
            else { return false }
            return Self.writeAtomically(out, to: file)
        }.value
    }

    /// Replace all matches in each file. Returns the count of files changed.
    /// One detached task walks every file, rather than one hop per file.
    func replaceAll(in files: [FileMatch], query: String, options: SearchOptions, replacement: String, preserveCase: Bool) async -> Int {
        let urls = files.map(\.url)
        return await Task.detached(priority: .userInitiated) {
            urls.reduce(0) { changed, url in
                Self.replaceAllOnDisk(file: url, query: query, options: options,
                                      replacement: replacement, preserveCase: preserveCase)
                    ? changed + 1 : changed
            }
        }.value
    }

    nonisolated private static func replaceAllOnDisk(file: URL, query: String, options: SearchOptions,
                                                     replacement: String, preserveCase: Bool) -> Bool {
        guard let text = readText(file),
              let regex = makeRegex(query: query, options: options),
              let out = SearchEngine.replacingAll(in: text, regex: regex, replacement: replacement,
                                                  options: options, preserveCase: preserveCase)
        else { return false }
        return writeAtomically(out.text, to: file)
    }

    nonisolated private static func readText(_ url: URL) -> String? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Write `text` as UTF-8 via a temp file + rename, so a crash, a full
    /// disk or a concurrent reader never sees a half-written source file —
    /// the old plain `Data.write` truncated in place first.
    ///
    /// A rename replaces the inode, so two things a plain in-place write kept
    /// for free are kept explicitly: a symlink is written THROUGH (its target
    /// is replaced, the link survives), and the file's POSIX permissions are
    /// restored (a replaced script must stay executable).
    nonisolated static func writeAtomically(_ text: String, to url: URL) -> Bool {
        guard let data = text.data(using: .utf8) else { return false }
        let target = url.resolvingSymlinksInPath()
        let fm = FileManager.default
        let permissions = (try? fm.attributesOfItem(atPath: target.path))?[.posixPermissions]
        do {
            try data.write(to: target, options: .atomic)
        } catch {
            return false
        }
        if let permissions {
            try? fm.setAttributes([.posixPermissions: permissions], ofItemAtPath: target.path)
        }
        return true
    }
}
