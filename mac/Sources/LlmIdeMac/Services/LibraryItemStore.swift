import Foundation
import Observation
import os.log

@MainActor
@Observable
final class LibraryItemStore {
    private(set) var items: [LibraryItem] = []

    private var storeURL: URL? {
        FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent("LLM IDE/library_items.json")
    }

    init() { load() }

    func items(for category: LibraryItem.Category) -> [LibraryItem] {
        items.filter { $0.category == category }
    }

    func add(url: URL, category: LibraryItem.Category) {
        guard !items.contains(where: { $0.path == url.path }) else { return }
        let item = LibraryItem(name: url.lastPathComponent, path: url.path, category: category)
        items.append(item)
        save()
    }

    func addFolder(url: URL, category: LibraryItem.Category) {
        let folderName = url.lastPathComponent
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(
            at: url,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else { return }
        for case let fileURL as URL in enumerator {
            // Skip walking into well-known build / cache / VCS dirs
            // — .understand-anything, node_modules, .build, etc. Otherwise
            // the Library tree balloons with derived files the user
            // never wants to open. enumerator.skipDescendants() is
            // the API to short-circuit further traversal here.
            let name = fileURL.lastPathComponent
            if Self.noiseDirectoryNames.contains(name),
               (try? fileURL.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
                enumerator.skipDescendants()
                continue
            }
            guard (try? fileURL.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
            else { continue }
            // For code repos, drop file types that aren't useful in
            // a code-graph context (images, binaries, archives).
            // Other categories (.data, .notes) still index everything.
            if category == .code, !Self.isCodeRelevant(url: fileURL) { continue }
            guard !items.contains(where: { $0.path == fileURL.path }) else { continue }
            var item = LibraryItem(
                name: fileURL.lastPathComponent,
                path: fileURL.path,
                category: category)
            item.folderOrigin = folderName
            items.append(item)
        }
        save()
    }

    /// Dirs we never want to walk into when indexing a code repo.
    /// Same shape as RepoFileTreeRow.defaultIgnoreNames; kept here
    /// independently so the store doesn't depend on a view file.
    static let noiseDirectoryNames: Set<String> = [
        ".git", "node_modules", ".understand-anything", ".build", "DerivedData",
        ".swiftpm", "Pods", "build", "dist", ".next", ".venv", "__pycache__",
        "target", "vendor", ".gradle", ".idea", ".vscode"
    ]

    /// True when `url` is a file the app can meaningfully preview as
    /// code/text/docs/config. The check is on the extension; files
    /// with NO extension (LICENSE, VERSION, Makefile, Dockerfile,
    /// NOTICE) are kept because they're almost always plain text
    /// and high-signal in a repo root.
    static func isCodeRelevant(url: URL) -> Bool {
        let ext = url.pathExtension.lowercased()
        if ext.isEmpty { return true }
        return codeRelevantExtensions.contains(ext)
    }

    /// Allow-list of file extensions we'll index under `.code`.
    /// Programming languages + markup + config — everything the
    /// FileDetailView pipeline can render meaningfully. Images
    /// (.png, .jpg, …) and binaries (.dmg, .pkg, .zip) are
    /// deliberately omitted; they're noise in a code graph.
    static let codeRelevantExtensions: Set<String> = [
        // Programming languages
        "swift", "py", "js", "ts", "jsx", "tsx", "mjs", "cjs",
        "rb", "go", "rs", "kt", "kts", "java", "scala", "clj", "cljs",
        "c", "cc", "cpp", "cxx", "h", "hpp", "hh", "m", "mm",
        "cs", "fs", "fsi", "ex", "exs", "erl", "elm", "hs",
        "lua", "php", "pl", "pm", "r", "jl",
        "sh", "bash", "zsh", "fish", "ps1",
        // Web / styles
        "html", "htm", "css", "scss", "sass", "less", "vue", "svelte",
        // Markup / docs
        "md", "markdown", "mdx", "rst", "txt", "tex", "adoc",
        // Config / data
        "json", "yaml", "yml", "toml", "xml", "plist", "ini", "conf", "cfg",
        "env", "properties", "lock",
        "gitignore", "gitattributes", "editorconfig", "dockerfile", "makefile",
        // Tabular
        "csv", "tsv"
    ]

    func remove(id: String) {
        items.removeAll { $0.id == id }
        save()
    }

    /// Removes every item that was imported as part of the named folder group.
    /// Use when un-linking a code repository or any folder import as a unit.
    func removeFolder(folderOrigin: String) {
        items.removeAll { $0.folderOrigin == folderOrigin }
        save()
    }

    /// Drops stale code items whose folder group is tracked by a
    /// saved GitLab/GitHub project but whose on-disk path no longer
    /// matches the active clone location.
    ///
    /// Decision per item (code category only — other categories
    /// untouched):
    ///   1. Path starts with an active clone path → KEEP. Strong
    ///      signal; always wins.
    ///   2. folderOrigin matches a tracked clone name AND we have
    ///      active clones → DROP. The item belonged to an earlier
    ///      clone at a different path; the Library tree would mix
    ///      old + new and widen its commonAncestor up to `~/`.
    ///   3. Otherwise → KEEP. User added this via Library "+", not
    ///      a clone — we have no clone-path to compare against.
    func pruneCodeItems(allowedFolders: Set<String>, allowedPathPrefixes: Set<String>) {
        let before = items.count
        items.removeAll { item in
            guard item.category == .code else { return false }
            // Drop items that aren't code-relevant (images, binaries,
            // files inside build / cache dirs). Catches items added
            // before the addFolder filter existed.
            let itemURL = URL(fileURLWithPath: item.path)
            if itemURL.pathComponents.contains(where: Self.noiseDirectoryNames.contains) {
                return true
            }
            if !Self.isCodeRelevant(url: itemURL) { return true }
            if allowedPathPrefixes.contains(where: { !$0.isEmpty && item.path.hasPrefix($0) }) {
                return false
            }
            if let origin = item.folderOrigin,
               allowedFolders.contains(origin),
               !allowedPathPrefixes.isEmpty {
                return true
            }
            return false
        }
        if items.count != before { save() }
    }

    /// Sync the NOTES section from `folder`.
    ///
    /// Files are added with `folderOrigin` set to the folder's name so
    /// they appear inside a DisclosureGroup in the sidebar that is
    /// **collapsed by default** — users expand it to browse their notes.
    ///
    /// This is a full clear-and-resync: stale entries (deleted files)
    /// are removed and the current folder contents replace them.
    func syncMeetingNotes(from folder: URL) {
        let fm = FileManager.default
        var newItems: [LibraryItem] = []
        let folderName = folder.lastPathComponent   // e.g. "notes"
        if let enumerator = fm.enumerator(
            at: folder,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles, .skipsSubdirectoryDescendants]
        ) {
            for case let url as URL in enumerator {
                let ext  = url.pathExtension.lowercased()
                let name = url.lastPathComponent
                // Accept .docx (template-generated) and .md (manual/fallback).
                // Skip .partial.md drafts and the reference template.md itself.
                let isNote = ext == "docx"
                    || (ext == "md"
                        && !name.hasSuffix(".partial.md")
                        && name != "template.md")
                guard isNote,
                      (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
                else { continue }

                var item = LibraryItem(name: name, path: url.path, category: .notes)
                item.folderOrigin = folderName   // folderOrigin != nil → collapsed DisclosureGroup
                newItems.append(item)
            }
        }
        // Skip the rebuild + JSON write when the file set is unchanged (the common
        // case — a live transcript's content grows but its path doesn't).
        guard Set(newItems.map(\.path)) != Set(items.filter { $0.category == .notes }.map(\.path))
        else { return }
        items.removeAll { $0.category == .notes }
        items.append(contentsOf: newItems)
        save()
    }

    /// Sync the MEETINGS section from `folder` (the `meetings/` directory).
    ///
    /// Enumerates recursively so files inside month sub-directories
    /// (e.g. `2026-05/`) are captured.  Each sub-directory becomes a
    /// collapsed `folderOrigin` group in the sidebar tree.
    /// `.partial.md` drafts and `template.md` are excluded.
    ///
    /// Full clear-and-resync: stale entries are pruned automatically.
    func syncMeetingTranscripts(from folder: URL) {
        let fm = FileManager.default
        var newItems: [LibraryItem] = []
        if let enumerator = fm.enumerator(
            at: folder,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) {
        for case let url as URL in enumerator {
            let name = url.lastPathComponent
            let ext  = url.pathExtension.lowercased()
            guard ext == "md",
                  !name.hasSuffix(".partial.md"),
                  name != "template.md",
                  (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
            else { continue }

            // Build a human-readable group name from the path relative to
            // the meetings root.  The canonical layout is:
            //   meetings/2026/05/file.md  → group "2026-05"
            //   meetings/file.md          → no group (nil)
            //   meetings/other/file.md    → group "other"
            let parent      = url.deletingLastPathComponent()
            let grandparent = parent.deletingLastPathComponent()
            let folderOrigin: String?
            if parent.path == folder.path {
                // Direct child of meetings/ — no grouping.
                folderOrigin = nil
            } else if grandparent.path == folder.path {
                // One level deep — use the folder name as-is.
                folderOrigin = parent.lastPathComponent
            } else {
                // Two levels deep (year/month) — combine into "YYYY-MM".
                folderOrigin = "\(grandparent.lastPathComponent)-\(parent.lastPathComponent)"
            }

            var item = LibraryItem(name: name, path: url.path, category: .meetings)
            item.folderOrigin = folderOrigin
            newItems.append(item)
        }
        }
        // Skip the rebuild + JSON write when the file set is unchanged.
        guard Set(newItems.map(\.path)) != Set(items.filter { $0.category == .meetings }.map(\.path))
        else { return }
        items.removeAll { $0.category == .meetings }
        items.append(contentsOf: newItems)
        save()
    }

    /// On-disk envelope. New writes always use this shape; legacy
    /// bare-array files still decode through the fallback in `load()`.
    /// See `docs/reference/persistence.md` for the migration policy.
    private struct StoreFile: Codable {
        var storeVersion: Int = 1
        var items: [LibraryItem]
    }

    private func load() {
        guard let url = storeURL else { return }
        guard let data = try? Data(contentsOf: url) else { return }
        // Try the versioned envelope first; fall back to the legacy
        // bare-array layout for files written before `storeVersion`
        // existed.
        if let file = try? AppJSON.decoder.decode(StoreFile.self, from: data) {
            items = file.items
            return
        }
        do {
            items = try AppJSON.decoder.decode([LibraryItem].self, from: data)
        } catch {
            // Decode failed: the file is corrupt or from an incompatible
            // schema. Rename it aside before returning empty so the next
            // save() doesn't silently overwrite the user's recovery copy.
            let ts = Int(Date().timeIntervalSince1970)
            let backup = url.deletingLastPathComponent()
                .appendingPathComponent("library_items.json.corrupt-\(ts)")
            do {
                try FileManager.default.moveItem(at: url, to: backup)
                os_log(.error,
                       "LibraryItemStore: corrupt store at %{public}@ renamed to %{public}@ (%{public}@)",
                       url.path, backup.path, "\(error)")
            } catch {
                os_log(.error,
                       "LibraryItemStore: failed to rename corrupt store at %{public}@: %{public}@",
                       url.path, "\(error)")
            }
        }
    }

    private func save() {
        guard let url = storeURL else {
            os_log(.error, "LibraryItemStore: applicationSupportDirectory unavailable, skipping save")
            return
        }
        let dir = url.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = StoreFile(items: items)
        if let data = try? AppJSON.encoder.encode(file) {
            try? data.write(to: url)
        }
    }
}
