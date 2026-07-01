import Foundation
import Observation

struct SearchOptions: Equatable { var caseSensitive = false; var wholeWord = false; var regex = false }
struct Match: Hashable { let nsRange: NSRange; let fileIndex: Int }   // utf16 range within lineText
struct LineMatch: Hashable { let line: Int; let lineText: String; let matches: [Match] }
struct FileMatch: Identifiable, Hashable { let url: URL; let displayPath: String; let lineMatches: [LineMatch]; var id: String { url.path } }
struct SearchResults: Equatable { var files: [FileMatch] = []; var totalMatches = 0; var fileCount = 0; var invalidPattern = false }

@MainActor
@Observable
final class SearchService {
    nonisolated private static let maxFileBytes = 1_000_000
    nonisolated private static let maxMatches = 1000
    nonisolated private static let noiseNames = IgnoreList.directories

    /// Build the regex driving both find and replace. Plain queries are escaped;
    /// `wholeWord` wraps `\b…\b`; `regex` is taken verbatim. Case-insensitive
    /// unless `caseSensitive`. Returns nil for an invalid regex pattern.
    func makeRegex(query: String, options: SearchOptions) -> NSRegularExpression? {
        Self.makeRegex(query: query, options: options)
    }

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

    /// Walk `root`, matching the query against text-file contents. Runs the
    /// blocking walk off the main actor. Empty/whitespace query → empty.
    /// An invalid regex pattern → `invalidPattern = true`. `include`/`exclude`
    /// are comma-separated globs over the repo-relative path; empty `include`
    /// matches all, empty `exclude` excludes nothing.
    func search(query rawQuery: String, root: URL, options: SearchOptions, include: String, exclude: String) async -> SearchResults {
        let query = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return SearchResults() }
        guard let regex = Self.makeRegex(query: query, options: options) else {
            return SearchResults(invalidPattern: true)
        }
        let rootPath = root.standardizedFileURL.path
        return await Task.detached(priority: .userInitiated) {
            Self.walk(root: root, rootPath: rootPath, regex: regex, include: include, exclude: exclude)
        }.value
    }

    nonisolated private static func walk(root: URL, rootPath: String, regex: NSRegularExpression, include: String, exclude: String) -> SearchResults {
        let fm = FileManager.default
        guard let en = fm.enumerator(at: root,
            includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey],
            options: [.skipsHiddenFiles]) else { return SearchResults() }
        var files: [FileMatch] = []
        var total = 0
        let excludeActive = exclude.split(separator: ",").contains { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        for case let url as URL in en {
            if noiseNames.contains(url.lastPathComponent) { en.skipDescendants(); continue }
            guard (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { continue }
            if total >= maxMatches { break }
            // Standardize the enumerated path before stripping the root: on
            // macOS the enumerator yields `/private/var/…` while `rootPath`
            // (also standardized) is `/var/…`, so a raw-path prefix check fails
            // and the include/exclude globs would match against the full path.
            // No-op for ordinary roots; fixes any symlinked/firmlinked root.
            let filePath = url.standardizedFileURL.path
            let display = filePath.hasPrefix(rootPath + "/") ? String(filePath.dropFirst(rootPath.count + 1)) : filePath

            // Glob filter on the repo-relative path.
            guard GlobMatch.matchesAny(path: display, patterns: include) else { continue }
            if excludeActive && GlobMatch.matchesAny(path: display, patterns: exclude) { continue }

            let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            guard size <= maxFileBytes, let data = try? Data(contentsOf: url),
                  !isBinary(data), let text = String(data: data, encoding: .utf8) else { continue }

            var lineMatches: [LineMatch] = []
            var fileIndex = 0   // monotonic per file, in document order
            var lineNo = 0
            for sub in text.split(separator: "\n", omittingEmptySubsequences: false) {
                lineNo += 1
                if total >= maxMatches { break }
                let lineText = String(sub)
                let nsLine = lineText as NSString
                let hits = regex.matches(in: lineText, options: [], range: NSRange(location: 0, length: nsLine.length))
                if hits.isEmpty { continue }
                var matches: [Match] = []
                for h in hits {
                    if total >= maxMatches { break }
                    matches.append(Match(nsRange: h.range, fileIndex: fileIndex))
                    fileIndex += 1
                    total += 1
                }
                if !matches.isEmpty {
                    lineMatches.append(LineMatch(line: lineNo, lineText: lineText, matches: matches))
                }
            }
            if !lineMatches.isEmpty {
                files.append(FileMatch(url: url, displayPath: display, lineMatches: lineMatches))
            }
        }
        files.sort { $0.displayPath.localizedCaseInsensitiveCompare($1.displayPath) == .orderedAscending }
        return SearchResults(files: files, totalMatches: total, fileCount: files.count, invalidPattern: false)
    }

    nonisolated private static func isBinary(_ data: Data) -> Bool {
        data.prefix(4096).contains(0)
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
