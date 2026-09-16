import Foundation
import SharedProtocol

/// Filename search + @file/@folder resolution under the Mac workspace root.
/// Skips heavy/secret dirs (same spirit as `IgnoreList` + server denylist).
enum MobileWorkspaceSearch {

    static let defaultLimit = 40
    static let maxIndexVisited = 50_000
    static let maxReadBytes = 200_000
    static let maxFolderLines = 400

    private static let denyBasenames: Set<String> = [
        ".env", ".npmrc", ".netrc", "id_rsa", "id_ed25519", "id_dsa", ".pgpass"
    ]
    private static let denyExtensions: Set<String> = [".pem", ".key", ".p12", ".pfx", ".keystore"]

    // MARK: - Search

    /// Build a full workspace index for persistence (no query filter).
    static func buildIndex(in root: URL, limit: Int = 25_000) -> [ExploreWorkspaceEntry] {
        var matches: [ExploreWorkspaceEntry] = []
        var visited = 0
        var stack: [(URL, String)] = [(root, "")]
        let fm = FileManager.default

        while !stack.isEmpty, matches.count < limit, visited < maxIndexVisited {
            let (dirURL, relPrefix) = stack.removeLast()
            visited += 1
            guard let items = try? fm.contentsOfDirectory(
                at: dirURL,
                includingPropertiesForKeys: [.isDirectoryKey],
                options: [.skipsHiddenFiles]
            ) else { continue }

            for item in items.sorted(by: { $0.lastPathComponent.localizedCaseInsensitiveCompare($1.lastPathComponent) == .orderedAscending }) {
                if matches.count >= limit { break }
                let name = item.lastPathComponent
                if shouldSkip(name: name, isDirectory: (try? item.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false) {
                    continue
                }
                let rel = relPrefix.isEmpty ? name : "\(relPrefix)/\(name)"
                if isDenied(relPath: rel, name: name) { continue }

                let isDir = (try? item.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
                matches.append(ExploreWorkspaceEntry(path: rel, name: name, isDirectory: isDir))
                if isDir {
                    stack.append((item, rel))
                }
            }
        }
        return matches
    }

    // MARK: - Resolve refs → code-assist attachments

    static func attachments(
        from refs: [ExploreWorkspaceRef],
        workspaceRoot: URL
    ) -> ([LlmIdeAPIClient.CodeAttachment], [String]) {
        var out: [LlmIdeAPIClient.CodeAttachment] = []
        var errors: [String] = []
        for ref in refs {
            switch ref.kind {
            case "folder":
                if let att = folderListing(ref.path, workspaceRoot: workspaceRoot) {
                    out.append(att)
                } else {
                    errors.append("Could not list folder: \(ref.path)")
                }
            default:
                if let att = readFile(ref.path, workspaceRoot: workspaceRoot) {
                    out.append(att)
                } else {
                    errors.append("Could not read file: \(ref.path)")
                }
            }
        }
        return (out, errors)
    }

    static func promptWithRefs(_ text: String, refs: [ExploreWorkspaceRef]) -> String {
        guard !refs.isEmpty else { return text }
        let lines = refs.map { $0.displayLabel }.joined(separator: "\n")
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if body.isEmpty {
            return "Explore the following Mac workspace paths:\n\(lines)"
        }
        return "Referenced Mac workspace paths:\n\(lines)\n\n\(body)"
    }

    // MARK: - Path safety

    private static func resolveURL(path: String, under root: URL) -> URL? {
        let cleaned = path.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !cleaned.isEmpty, !cleaned.contains("..") else { return nil }
        let candidate = root.appendingPathComponent(cleaned)
        guard let realRoot = Optional(root.resolvingSymlinksInPath()),
              let real = Optional(candidate.resolvingSymlinksInPath()) else { return nil }
        let rootPath = realRoot.path.hasSuffix("/") ? realRoot.path : realRoot.path + "/"
        guard real.path.hasPrefix(rootPath) || real.path == realRoot.path else { return nil }
        return real
    }

    // MARK: - Private

    private static func readFile(_ rel: String, workspaceRoot: URL) -> LlmIdeAPIClient.CodeAttachment? {
        guard let url = resolveURL(path: rel, under: workspaceRoot),
              !((try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false) else { return nil }
        let name = url.lastPathComponent
        if isDenied(relPath: rel, name: name) { return nil }
        guard let data = try? Data(contentsOf: url), data.count <= maxReadBytes else {
            if let data = try? Data(contentsOf: url), data.count > maxReadBytes {
                let prefix = data.prefix(maxReadBytes)
                let text = String(decoding: prefix, as: UTF8.self)
                return LlmIdeAPIClient.CodeAttachment(
                    path: rel,
                    content: text + "\n\n[… truncated — file exceeds \(maxReadBytes) bytes on Mac …]")
            }
            return nil
        }
        guard let text = String(data: data, encoding: .utf8) else { return nil }
        return LlmIdeAPIClient.CodeAttachment(path: rel, content: text)
    }

    private static func folderListing(_ rel: String, workspaceRoot: URL) -> LlmIdeAPIClient.CodeAttachment? {
        guard let url = resolveURL(path: rel, under: workspaceRoot),
              (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else { return nil }
        var lines: [String] = []
        collectListing(at: url, relPrefix: rel, lines: &lines, depth: 0)
        if lines.isEmpty { lines = ["(empty folder)"] }
        let body = lines.prefix(maxFolderLines).joined(separator: "\n")
        return LlmIdeAPIClient.CodeAttachment(path: "\(rel)/", content: "# Folder listing: \(rel)\n\(body)")
    }

    private static func collectListing(at dir: URL, relPrefix: String, lines: inout [String], depth: Int) {
        guard lines.count < maxFolderLines, depth < 6 else { return }
        guard let items = try? FileManager.default.contentsOfDirectory(
            at: dir,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else { return }
        for item in items.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            if lines.count >= maxFolderLines { break }
            let name = item.lastPathComponent
            let rel = "\(relPrefix)/\(name)"
            if shouldSkip(name: name, isDirectory: (try? item.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false) {
                continue
            }
            if isDenied(relPath: rel, name: name) { continue }
            let isDir = (try? item.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
            lines.append(isDir ? "\(rel)/" : rel)
            if isDir { collectListing(at: item, relPrefix: rel, lines: &lines, depth: depth + 1) }
        }
    }

    private static func shouldSkip(name: String, isDirectory: Bool) -> Bool {
        if isDirectory, IgnoreList.directories.contains(name) { return true }
        return false
    }

    private static func isDenied(relPath: String, name: String) -> Bool {
        if relPath.split(separator: "/").contains(where: { $0 == ".git" || $0 == ".ssh" }) { return true }
        if denyBasenames.contains(name) || name.hasPrefix(".env.") { return true }
        if let ext = name.split(separator: ".").last.map({ ".\($0.lowercased())" }),
           denyExtensions.contains(ext) { return true }
        return false
    }
}
