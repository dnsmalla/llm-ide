import Foundation
import SharedProtocol

/// Filename search + @file/@folder resolution under the Mac workspace root.
/// Skips heavy/secret dirs (same spirit as `IgnoreList` + server denylist).
enum MobileWorkspaceSearch {

    static let defaultLimit = 40
    static let maxIndexVisited = 50_000
    static let maxReadBytes = 200_000
    static let maxFolderLines = 400
    /// A phone can name any number of refs; each one is a file read or a directory walk on the main actor.
    static let maxRefs = 20
    /// Total bytes attached across all refs of one message.
    static let maxTotalReadBytes = 1_000_000

    // All lowercase: macOS volumes are case-insensitive by default, so `ID_RSA` and `.ENV` are the same
    // files as `id_rsa` and `.env` and must be denied the same way (callers lowercase before comparing).
    private static let denyBasenames: Set<String> = [
        ".env", ".npmrc", ".netrc", "id_rsa", "id_ed25519", "id_dsa", "id_ecdsa", ".pgpass", ".git-credentials",
        ".pypirc", ".htpasswd", "credentials.json", "service-account.json", "googleservice-info.plist",
    ]
    private static let denyExtensions: Set<String> = [
        ".pem", ".key", ".p12", ".pfx", ".keystore", ".p8", ".jks", ".kdbx", ".gpg", ".ppk", ".tfstate", ".tfvars",
    ]
    /// Directories that hold credentials; nothing under one is ever shown.
    private static let denyDirectories: Set<String> = [".git", ".ssh", ".aws", ".gnupg", ".kube", ".docker"]

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
        var totalBytes = 0
        if refs.count > maxRefs { errors.append("Too many references; only the first \(maxRefs) were used.") }
        for ref in refs.prefix(maxRefs) {
            if totalBytes >= maxTotalReadBytes {
                errors.append("Attachment size limit reached; skipped: \(ref.path)")
                continue
            }
            switch ref.kind {
            case "folder":
                if let att = folderListing(ref.path, workspaceRoot: workspaceRoot) {
                    out.append(att)
                    totalBytes += att.content.utf8.count
                } else {
                    errors.append("Could not list folder: \(ref.path)")
                }
            default:
                if let att = readFile(ref.path, workspaceRoot: workspaceRoot) {
                    out.append(att)
                    totalBytes += att.content.utf8.count
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
              // Regular files only, on the RESOLVED url: opening a FIFO with no writer blocks the main actor forever.
              (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { return nil }
        let name = url.lastPathComponent
        if isDenied(relPath: rel, name: name) { return nil }
        // `cfg -> .git/config` passes the check above (it only sees the phone's spelling), so the
        // symlink-resolved path gets the same visibility test the Files bridge applies.
        if !PhoneFiles.resolvedVisible(url, root: workspaceRoot) { return nil }
        // Bounded read. This used to be `Data(contentsOf:)` and only THEN a
        // size check — so a multi-gigabyte file in the workspace was pulled
        // into memory in full before being rejected, and the oversize branch
        // read the whole thing a SECOND time to take its prefix. A paired
        // phone naming such a file could drive the Mac's memory on its own.
        // `FileHandle` reads at most one byte past the cap, which is all that
        // is needed to know the file was truncated.
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        guard let data = try? handle.read(upToCount: maxReadBytes + 1) else { return nil }
        if data.count > maxReadBytes {
            let text = String(decoding: data.prefix(maxReadBytes), as: UTF8.self)
            return LlmIdeAPIClient.CodeAttachment(
                path: rel,
                content: text + "\n\n[… truncated — file exceeds \(maxReadBytes) bytes on Mac …]")
        }
        guard let text = String(data: data, encoding: .utf8) else { return nil }
        return LlmIdeAPIClient.CodeAttachment(path: rel, content: text)
    }

    private static func folderListing(_ rel: String, workspaceRoot: URL) -> LlmIdeAPIClient.CodeAttachment? {
        guard let url = resolveURL(path: rel, under: workspaceRoot),
              (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true,
              PhoneFiles.resolvedVisible(url, root: workspaceRoot) else { return nil }
        var lines: [String] = []
        collectListing(at: url, relPrefix: rel, root: workspaceRoot, lines: &lines, depth: 0)
        if lines.isEmpty { lines = ["(empty folder)"] }
        let body = lines.prefix(maxFolderLines).joined(separator: "\n")
        return LlmIdeAPIClient.CodeAttachment(path: "\(rel)/", content: "# Folder listing: \(rel)\n\(body)")
    }

    private static func collectListing(at dir: URL, relPrefix: String, root: URL, lines: inout [String], depth: Int) {
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
            // A symlink child can resolve into a hidden/denied location the name doesn't show.
            if !PhoneFiles.resolvedVisible(item, root: root) { continue }
            let isDir = (try? item.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
            lines.append(isDir ? "\(rel)/" : rel)
            if isDir { collectListing(at: item, relPrefix: rel, root: root, lines: &lines, depth: depth + 1) }
        }
    }

    private static func shouldSkip(name: String, isDirectory: Bool) -> Bool {
        if isDirectory, IgnoreList.directories.contains(name) { return true }
        return false
    }

    static func isDenied(relPath: String, name: String) -> Bool {
        let lowerName = name.lowercased()
        if relPath.lowercased().split(separator: "/").contains(where: { denyDirectories.contains(String($0)) }) { return true }
        if denyBasenames.contains(lowerName) || lowerName.hasPrefix(".env.") { return true }
        if let ext = lowerName.split(separator: ".").last.map({ ".\($0)" }), denyExtensions.contains(ext) { return true }
        return false
    }
}
