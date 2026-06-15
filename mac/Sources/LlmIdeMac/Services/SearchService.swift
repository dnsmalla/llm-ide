import Foundation
import Observation

@MainActor
@Observable
final class SearchService {
    struct LineMatch: Hashable { let line: Int; let text: String }
    struct FileMatch: Identifiable, Hashable {
        let url: URL
        let displayPath: String
        let nameMatched: Bool
        let lines: [LineMatch]
        var id: String { url.path }
    }

    private static let maxFileBytes = 1_000_000
    private static let maxLineMatches = 1000
    private static let noiseNames = FileSystemTree.noiseNames

    /// Walk `root`, matching the query against file names and text-file
    /// contents (case-insensitive). Runs the blocking walk off the main
    /// actor. Empty/whitespace query → no results.
    func search(query rawQuery: String, root: URL) async -> [FileMatch] {
        let query = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return [] }
        let needle = query.lowercased()
        let rootPath = root.standardizedFileURL.path
        return await Task.detached(priority: .userInitiated) {
            Self.walk(root: root, rootPath: rootPath, needle: needle)
        }.value
    }

    nonisolated private static func walk(root: URL, rootPath: String, needle: String) -> [FileMatch] {
        let fm = FileManager.default
        guard let en = fm.enumerator(at: root,
            includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey],
            options: [.skipsHiddenFiles]) else { return [] }
        var out: [FileMatch] = []
        var lineBudget = maxLineMatches
        for case let url as URL in en {
            if noiseNames.contains(url.lastPathComponent) { en.skipDescendants(); continue }
            guard (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { continue }
            if lineBudget <= 0 { break }
            let display = url.path.hasPrefix(rootPath + "/") ? String(url.path.dropFirst(rootPath.count + 1)) : url.path
            let nameMatched = display.lowercased().contains(needle)

            var lines: [LineMatch] = []
            let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            if size <= maxFileBytes, let data = try? Data(contentsOf: url),
               !isBinary(data), let text = String(data: data, encoding: .utf8) {
                var n = 0
                for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
                    n += 1
                    if line.lowercased().contains(needle) {
                        lines.append(LineMatch(line: n, text: String(line.prefix(400))))
                        lineBudget -= 1
                        if lineBudget <= 0 { break }
                    }
                }
            }
            if nameMatched || !lines.isEmpty {
                out.append(FileMatch(url: url, displayPath: display, nameMatched: nameMatched, lines: lines))
            }
        }
        return out.sorted { $0.displayPath.localizedCaseInsensitiveCompare($1.displayPath) == .orderedAscending }
    }

    nonisolated private static func isBinary(_ data: Data) -> Bool {
        data.prefix(4096).contains(0)
    }
}
