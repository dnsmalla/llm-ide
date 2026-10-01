import Foundation
import SharedProtocol

/// Read-only window onto a project's `llm-doc/` folder for the phone.
///
/// Pure functions over a `root` URL so the containment rule — the whole
/// security story of this feature — is unit-testable without a server. The
/// phone sends `llm-doc`-relative paths; anything that would resolve outside
/// `root` (`..`, an absolute path, a symlink pointing out) is refused, and
/// only directories and text files are ever listed or opened. There is
/// deliberately no write, rename or delete here.
enum LlmDocBrowser {
    /// Largest file the phone may read; a longer file is cut and flagged.
    static let readCap = 1_000_000
    static let textExtensions: Set<String> = ["md", "markdown", "txt"]

    /// The URL for `relative` under `root`, or nil when it is not safely inside.
    /// "" is the root itself.
    static func resolve(_ relative: String, under root: URL) -> URL? {
        if relative.contains("\0") || relative.hasPrefix("/") || relative.hasPrefix("~") { return nil }
        let parts = relative.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        if parts.contains("..") || parts.contains(".") { return nil }
        var url = root
        for part in parts { url.appendPathComponent(part) }
        // Resolve symlinks on BOTH sides before comparing, so a link inside
        // llm-doc/ that points elsewhere cannot be used to read outside it.
        let realRoot = root.resolvingSymlinksInPath().standardizedFileURL.path
        let real = url.resolvingSymlinksInPath().standardizedFileURL.path
        guard real == realRoot || real.hasPrefix(realRoot + "/") else { return nil }
        return url
    }

    static func list(root: URL, relative: String) -> LlmDocListing {
        guard let dir = resolve(relative, under: root) else {
            return LlmDocListing(path: relative, entries: [], error: "That folder isn't inside llm-doc.")
        }
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: dir.path, isDirectory: &isDir), isDir.boolValue else {
            return LlmDocListing(path: relative, entries: [],
                                 error: relative.isEmpty ? "This project has no llm-doc folder yet." : "Folder not found.")
        }
        let keys: [URLResourceKey] = [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey]
        let urls = (try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles])) ?? []
        var entries: [LlmDocEntry] = []
        for url in urls {
            let values = try? url.resourceValues(forKeys: Set(keys))
            let directory = values?.isDirectory ?? false
            if !directory && !textExtensions.contains(url.pathExtension.lowercased()) { continue }
            // A symlink that leaves llm-doc is dropped from the listing, not shown then refused.
            let child = relative.isEmpty ? url.lastPathComponent : relative + "/" + url.lastPathComponent
            guard resolve(child, under: root) != nil else { continue }
            entries.append(LlmDocEntry(name: url.lastPathComponent, isDirectory: directory,
                                       size: directory ? 0 : (values?.fileSize ?? 0),
                                       modified: values?.contentModificationDate?.timeIntervalSince1970 ?? 0))
        }
        // Folders first, then newest file first — "check what was just generated".
        entries.sort {
            if $0.isDirectory != $1.isDirectory { return $0.isDirectory }
            if $0.isDirectory { return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            return $0.modified > $1.modified
        }
        return LlmDocListing(path: relative, entries: entries)
    }

    static func read(root: URL, relative: String) -> LlmDocFile {
        guard !relative.isEmpty, let url = resolve(relative, under: root),
              textExtensions.contains(url.pathExtension.lowercased()) else {
            return LlmDocFile(path: relative, text: nil, error: "That isn't a readable document in llm-doc.")
        }
        // The extension rule must hold for the file actually opened, not just the name the phone used
        // (`x.md -> ../.env`), and only regular files are opened (a FIFO would block the thread).
        let real = url.resolvingSymlinksInPath()
        guard textExtensions.contains(real.pathExtension.lowercased()),
              (try? real.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true,
              let handle = try? FileHandle(forReadingFrom: real) else {
            return LlmDocFile(path: relative, text: nil, error: "File not found.")
        }
        defer { try? handle.close() }
        // One byte over the cap tells us the file was longer without reading it all.
        let data = (try? handle.read(upToCount: readCap + 1)) ?? Data()
        let truncated = data.count > readCap
        let body = truncated ? data.prefix(readCap) : data
        return LlmDocFile(path: relative, text: String(decoding: body, as: UTF8.self), truncated: truncated)
    }
}
