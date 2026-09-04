import Foundation
import Observation

struct SearchOptions: Equatable { var caseSensitive = false; var wholeWord = false; var regex = false }
struct Match: Hashable { let nsRange: NSRange; let fileIndex: Int }   // utf16 range within lineText
struct LineMatch: Hashable { let line: Int; let lineText: String; let matches: [Match] }
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
    /// Build the regex driving both find and replace. Plain queries are escaped;
    /// `wholeWord` wraps `\b…\b`; `regex` is taken verbatim. Case-insensitive
    /// unless `caseSensitive`. Returns nil for an invalid regex pattern.
    nonisolated static func makeRegex(query: String, options: SearchOptions) -> NSRegularExpression? {
        var pattern = options.regex ? query : NSRegularExpression.escapedPattern(for: query)
        // Group before adding word boundaries so alternation in a regex query
        // (e.g. `foo|bar`) binds inside the \b…\b, not as `\bfoo|bar\b`.
        if options.wholeWord { pattern = "\\b(?:" + pattern + ")\\b" }
        // `.anchorsMatchLines` makes ^/$ match at every line boundary. This is
        // required for consistency: search matches per-line (so ^/$ are line
        // anchors), but replace matches the full file string — without this,
        // anchored regex would diverge and replaceOne could hit the wrong
        // occurrence. With it, both sides see the same match ordering.
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

    /// Walk `root`, matching the query against text-file contents. Empty/
    /// whitespace query → empty. An invalid regex pattern → `invalidPattern =
    /// true`. `include`/`exclude` are comma-separated globs over the
    /// repo-relative path; empty `include` matches all, empty `exclude`
    /// excludes nothing.
    ///
    /// TODO(P4 T5): delete once SearchView consumes `stream` directly. This is
    /// now a thin drain of `stream` kept only so the existing call site
    /// compiles unchanged; it throws away the incremental delivery that is the
    /// whole point of the stream.
    ///
    /// A cancelled run returns an EMPTY `SearchResults` rather than a partial
    /// one: without `.finished` there are no trustworthy totals, and the caller
    /// (which cancelled) discards the value anyway.
    func search(query rawQuery: String, root: URL, options: SearchOptions, include: String, exclude: String) async -> SearchResults {
        let query = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return SearchResults() }
        guard let regex = Self.makeRegex(query: query, options: options) else {
            return SearchResults(invalidPattern: true)
        }
        var out = SearchResults()
        var finished = false
        for await event in Self.stream(regex: regex, root: root, include: include, exclude: exclude) {
            switch event {
            case .file(let match):
                out.files.append(match)
            case .truncated:
                out.truncated = true
            case .finished(let total, let fileCount):
                out.totalMatches = total
                out.fileCount = fileCount
                finished = true
            }
        }
        guard finished else { return SearchResults() }
        return out
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

    /// Replace every match of `query` in `file` with `replacement`, writing the
    /// file back as UTF-8. Returns false if the file can't be read or the regex
    /// is invalid. With `preserveCase` (non-regex only) each match is spliced
    /// individually — in REVERSE order so earlier NSRanges stay valid — applying
    /// `preserveCaseReplacement`. Otherwise a single
    /// `stringByReplacingMatches` pass is used: in non-regex mode the replacement
    /// is escaped as a literal template (so `$`/`\` are literal); in regex mode it
    /// is passed through as a template (so `$1` etc. work).
    func replaceInFile(file: URL, query: String, options: SearchOptions, replacement: String, preserveCase: Bool) async -> Bool {
        guard let text = readText(file), let regex = Self.makeRegex(query: query, options: options) else { return false }
        let ns = text as NSString
        let full = NSRange(location: 0, length: ns.length)
        let out: String
        if preserveCase && !options.regex {
            let matches = regex.matches(in: text, options: [], range: full)
            let mutable = NSMutableString(string: ns)
            for h in matches.reversed() {
                let matched = ns.substring(with: h.range)
                mutable.replaceCharacters(in: h.range, with: Self.preserveCaseReplacement(matched: matched, replacement: replacement))
            }
            out = mutable as String
        } else {
            let template = options.regex ? replacement : NSRegularExpression.escapedTemplate(for: replacement)
            out = regex.stringByReplacingMatches(in: text, options: [], range: full, withTemplate: template)
        }
        return write(out, to: file)
    }

    /// Replace only the `fileIndex`-th match (0-based, document order) of `query`
    /// in `file`. A single splice, so ordering is moot. Returns false if the file
    /// can't be read, the regex is invalid, or there's no such match.
    func replaceOne(file: URL, fileIndex: Int, query: String, options: SearchOptions, replacement: String, preserveCase: Bool) async -> Bool {
        guard let text = readText(file), let regex = Self.makeRegex(query: query, options: options) else { return false }
        let ns = text as NSString
        let full = NSRange(location: 0, length: ns.length)
        let matches = regex.matches(in: text, options: [], range: full)
        guard fileIndex >= 0, fileIndex < matches.count else { return false }
        let h = matches[fileIndex]
        let replText: String
        if preserveCase && !options.regex {
            replText = Self.preserveCaseReplacement(matched: ns.substring(with: h.range), replacement: replacement)
        } else if options.regex {
            replText = regex.replacementString(for: h, in: text, offset: 0, template: replacement)
        } else {
            replText = replacement
        }
        let out = ns.replacingCharacters(in: h.range, with: replText)
        return write(out, to: file)
    }

    /// Replace all matches in each file. Returns the count of files changed.
    func replaceAll(in files: [FileMatch], query: String, options: SearchOptions, replacement: String, preserveCase: Bool) async -> Int {
        var changed = 0
        for fm in files {
            if await replaceInFile(file: fm.url, query: query, options: options, replacement: replacement, preserveCase: preserveCase) {
                changed += 1
            }
        }
        return changed
    }

    private func readText(_ url: URL) -> String? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func write(_ text: String, to url: URL) -> Bool {
        guard let data = text.data(using: .utf8) else { return false }
        do { try data.write(to: url); return true } catch { return false }
    }
}
