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
        if options.wholeWord { pattern = "\\b" + pattern + "\\b" }
        let opts: NSRegularExpression.Options = options.caseSensitive ? [] : [.caseInsensitive]
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
            let display = url.path.hasPrefix(rootPath + "/") ? String(url.path.dropFirst(rootPath.count + 1)) : url.path

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
}
