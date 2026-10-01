import Foundation
import SharedProtocol

/// Read-only project file access for the phone. Containment reuses `LlmDocBrowser.resolve` (no
/// `..`, no absolute paths, symlinks resolved on both sides). On top of that: any dotfile or
/// dot-directory is invisible (`.env`, `.git`, `.ssh`, `.aws`, `.gnupg`, `.kube`…), well-known
/// secret names/extensions are denied, build and dependency folders are skipped, and a file is read
/// as text only, capped, with known token shapes scrubbed.
enum PhoneFiles {
    static let maxEntries = 500
    static let maxReadBytes = 200_000

    /// `true` when `relative` may be listed or read at all.
    static func isVisible(_ relative: String) -> Bool {
        let parts = relative.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        if parts.contains(where: { $0.hasPrefix(".") || IgnoreList.directories.contains($0) }) { return false }
        guard let name = parts.last else { return true }   // the root
        return !MobileWorkspaceSearch.isDenied(relPath: relative, name: name)
    }

    static func list(root: URL, relative: String) -> FilesListing {
        guard isVisible(relative), let dir = LlmDocBrowser.resolve(relative, under: root) else {
            return FilesListing(path: relative, entries: [], error: "That folder isn't available on the phone.")
        }
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: dir.path, isDirectory: &isDir), isDir.boolValue else {
            return FilesListing(path: relative, entries: [], error: "Folder not found.")
        }
        let keys: [URLResourceKey] = [.isDirectoryKey, .fileSizeKey]
        let urls = (try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles])) ?? []
        var entries: [FileEntry] = []
        for url in urls {
            let name = url.lastPathComponent
            let child = relative.isEmpty ? name : relative + "/" + name
            guard isVisible(child), LlmDocBrowser.resolve(child, under: root) != nil else { continue }
            let values = try? url.resourceValues(forKeys: Set(keys))
            let directory = values?.isDirectory ?? false
            entries.append(FileEntry(name: name, isDirectory: directory, size: directory ? 0 : (values?.fileSize ?? 0)))
        }
        entries.sort {
            if $0.isDirectory != $1.isDirectory { return $0.isDirectory }
            return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
        return FilesListing(path: relative, entries: Array(entries.prefix(maxEntries)), truncated: entries.count > maxEntries)
    }

    static func read(root: URL, relative: String) -> FilesFile {
        guard !relative.isEmpty, isVisible(relative), let url = LlmDocBrowser.resolve(relative, under: root) else {
            return FilesFile(path: relative, text: nil, error: "That file isn't available on the phone.")
        }
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir), !isDir.boolValue,
              let handle = try? FileHandle(forReadingFrom: url) else {
            return FilesFile(path: relative, text: nil, error: "File not found.")
        }
        defer { try? handle.close() }
        let data = (try? handle.read(upToCount: maxReadBytes + 1)) ?? Data()
        let cut = data.count > maxReadBytes
        let body = cut ? data.prefix(maxReadBytes) : data
        // A NUL in the first few KB is how text editors tell binary from text.
        if body.prefix(8_000).contains(0) {
            return FilesFile(path: relative, text: nil, error: "Binary file — not shown.")
        }
        let r = PhoneRedaction.code(String(decoding: body, as: UTF8.self), maxChars: maxReadBytes)
        return FilesFile(path: relative, text: r.text, truncated: cut || r.truncated)
    }
}
