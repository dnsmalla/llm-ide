import Foundation
import Observation
import os.log

@MainActor
@Observable
final class LibraryItemStore {
    private(set) var items: [LibraryItem] = []

    /// The active project's root.  When non-nil the store's `items` are a
    /// SCAN of the project's canonical subfolders plus any external
    /// referenced code folders (`externalCodeFolders`) — the project folder
    /// is the single source of truth.  Nil = no project open; `items` is
    /// empty.  Set via `bindProject(root:)`.
    private(set) var projectRoot: URL?

    /// Absolute paths to code folders referenced *in place* (not copied
    /// into the project) — e.g. a checked-out repo elsewhere on disk.
    /// Durable persistence lives in `AppConfig.localCodeFolders`; the
    /// owner (AppShell) seeds this via `setExternalCodeFolders(_:)` and
    /// writes mutations back through `onExternalCodeFoldersChanged`.  The
    /// store stays free of an AppConfig dependency this way, matching the
    /// existing pattern where AppShell mediates config ↔ store.
    private(set) var externalCodeFolders: [String] = []

    /// Invoked when `addFolder(.code)` mutates `externalCodeFolders` so the
    /// owner can persist the new list (into `AppConfig.localCodeFolders`).
    var onExternalCodeFoldersChanged: (([String]) -> Void)?

    private var storeURL: URL? {
        FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent("LLM IDE/library_items.json")
    }

    /// The live index now comes from `rescan()` against the bound project.
    /// `load()`/`save()`/`StoreFile` are retained ONLY for the one-time
    /// legacy migration (see `migrateLegacyIndexIfNeeded`).
    init() {}

    func items(for category: LibraryItem.Category) -> [LibraryItem] {
        items.filter { $0.category == category }
    }

    // MARK: - Project binding (single source of truth)

    /// Bind the store to `root` (the active project's folder).  No-op when
    /// the root is unchanged.  On a new non-nil root, runs the one-time
    /// legacy migration before the first scan.  Always finishes with a
    /// `rescan()` so `items` reflects the freshly-bound project.
    func bindProject(root: URL?) {
        let normalized = root?.standardizedFileURL
        if normalized?.path == projectRoot?.path { return }
        projectRoot = normalized
        if let root = normalized {
            migrateLegacyIndexIfNeeded(root: root)
        }
        rescan()
    }

    /// Replace the external code-folder reference list (e.g. seeded from
    /// `AppConfig.localCodeFolders` alongside `bindProject`).  Does NOT fire
    /// `onExternalCodeFoldersChanged` — this is an inbound sync, not a
    /// store-originated mutation.  Triggers a rescan when the set changes.
    func setExternalCodeFolders(_ paths: [String]) {
        let deduped = Self.dedupePreservingOrder(paths)
        guard deduped != externalCodeFolders else { return }
        externalCodeFolders = deduped
        rescan()
    }

    // MARK: - Scan-as-index

    /// Canonical subfolders scanned into the index, paired with their
    /// category.  `assets/` (images, non-code attachments) folds into
    /// `.data` alongside `data/`; `plans/` is intentionally omitted (it is
    /// handled by the Plans/ReviewView pipeline, not the Library index).
    private static let scanFolders: [(subfolder: String, category: LibraryItem.Category)] = [
        ("notes", .notes),
        ("data", .data),
        ("assets", .data),
        ("code", .code),
        ("meetings", .meetings),
    ]

    /// Rebuild `items` from the bound project folder.  Authoritative for
    /// the bound-project case: enumerates each canonical subfolder, applies
    /// the same noise/relevance filters as the old `addFolder`, then appends
    /// external referenced-folder items.  With no project bound, `items` is
    /// emptied.
    func rescan() {
        guard let root = projectRoot else {
            items = []
            return
        }
        let fm = FileManager.default
        var scanned: [LibraryItem] = []
        for (subfolder, category) in Self.scanFolders {
            let folderURL = root.appendingPathComponent(subfolder, isDirectory: true)
            guard let enumerator = fm.enumerator(
                at: folderURL,
                includingPropertiesForKeys: [.isRegularFileKey, .isDirectoryKey],
                options: [.skipsHiddenFiles]
            ) else { continue }
            for case let fileURL as URL in enumerator {
                let name = fileURL.lastPathComponent
                if Self.noiseDirectoryNames.contains(name),
                   (try? fileURL.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
                    enumerator.skipDescendants()
                    continue
                }
                guard (try? fileURL.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
                else { continue }
                if category == .code, !Self.isCodeRelevant(url: fileURL) { continue }
                // Skip partial-draft notes/transcripts and the reference template.
                if name.hasSuffix(".partial.md") || name == "template.md" { continue }
                var item = LibraryItem(name: name, path: fileURL.path, category: category)
                // folderOrigin == nil when the file sits directly in the
                // canonical subfolder; otherwise it's the immediate parent
                // dir name so the sidebar groups it in a DisclosureGroup.
                let parentName = fileURL.deletingLastPathComponent().lastPathComponent
                item.folderOrigin = (parentName == subfolder) ? nil : parentName
                scanned.append(item)
            }
        }
        scanned.append(contentsOf: externalFolderItems())
        items = scanned
    }

    /// Index files from each external code-folder reference (folders are
    /// referenced in place, never copied).  Each file becomes a `.code`
    /// item with `folderOrigin` = the folder's name so the sidebar groups
    /// it.  Applies the same noise-dir + code-relevance filters as the scan.
    func externalFolderItems() -> [LibraryItem] {
        let fm = FileManager.default
        var result: [LibraryItem] = []
        for path in externalCodeFolders {
            let folderURL = URL(fileURLWithPath: path)
            let folderName = folderURL.lastPathComponent
            guard fm.fileExists(atPath: path),
                  let enumerator = fm.enumerator(
                    at: folderURL,
                    includingPropertiesForKeys: [.isRegularFileKey, .isDirectoryKey],
                    options: [.skipsHiddenFiles]
                  ) else { continue }
            for case let fileURL as URL in enumerator {
                let name = fileURL.lastPathComponent
                if Self.noiseDirectoryNames.contains(name),
                   (try? fileURL.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
                    enumerator.skipDescendants()
                    continue
                }
                guard (try? fileURL.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
                else { continue }
                if !Self.isCodeRelevant(url: fileURL) { continue }
                var item = LibraryItem(name: name, path: fileURL.path, category: .code)
                item.folderOrigin = folderName
                result.append(item)
            }
        }
        return result
    }

    // MARK: - Copy-on-add routing

    /// Add an external file to the project.  Files already inside the
    /// project are simply re-indexed; external files are COPIED once into
    /// the canonical subfolder for their category (replacing any same-name
    /// file already there).  A rescan picks up the result either way.
    func add(url: URL, category: LibraryItem.Category) {
        guard let root = projectRoot else { return }
        if ProjectPaths.isInside(url, root: root) {
            rescan()
            return
        }
        let dest = ProjectPaths.destinationURL(
            root: root, category: category, fileName: url.lastPathComponent)
        let fm = FileManager.default
        do {
            try fm.createDirectory(
                at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
            // REPLACE on same-name conflict — the new file wins.
            if fm.fileExists(atPath: dest.path) {
                try fm.removeItem(at: dest)
            }
            try fm.copyItem(at: url, to: dest)
        } catch {
            os_log(.error, "LibraryItemStore: failed to copy %{public}@ into project: %{public}@",
                   url.path, "\(error)")
            return
        }
        rescan()
    }

    /// Reference a code folder in place (folders are never copied).  Only
    /// `.code` is supported — other categories add files via `add(url:)`.
    /// Appends the path to `externalCodeFolders` if absent, asks the owner
    /// to persist it, then rescans.
    func addFolder(url: URL, category: LibraryItem.Category) {
        guard category == .code else { return }
        let path = url.standardizedFileURL.path
        guard !externalCodeFolders.contains(path) else { return }
        externalCodeFolders.append(path)
        onExternalCodeFoldersChanged?(externalCodeFolders)
        rescan()
    }

    private static func dedupePreservingOrder(_ paths: [String]) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for p in paths where seen.insert(p).inserted { out.append(p) }
        return out
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

    /// Un-link the external code folder(s) whose basename matches
    /// `folderOrigin` (the sidebar group name).  Authoritative under the
    /// single-source model: drop the matching `externalCodeFolders`
    /// reference(s), notify the owner so the durable list is rewritten,
    /// then rescan so `items` reflects the removal — instead of mutating
    /// `items` directly (which the next rescan would resurrect).
    func removeFolder(folderOrigin: String) {
        let remaining = externalCodeFolders.filter {
            URL(fileURLWithPath: $0).lastPathComponent != folderOrigin
        }
        guard remaining.count != externalCodeFolders.count else { return }
        externalCodeFolders = remaining
        onExternalCodeFoldersChanged?(externalCodeFolders)
        rescan()
    }

    /// Un-link the external code folder(s) at (or under) a specific
    /// directory path.  Keyed on the absolute path — not the basename —
    /// so two distinct folders sharing a name (`/a/proj`, `/b/proj`) are
    /// removed independently.  Like `removeFolder(folderOrigin:)` this is
    /// authoritative: it clears the matching `externalCodeFolders`
    /// reference(s), notifies the owner, then rescans.
    func removeFolder(underPath path: String) {
        let prefix = path.hasSuffix("/") ? path : path + "/"
        let remaining = externalCodeFolders.filter {
            $0 != path && !$0.hasPrefix(prefix)
        }
        guard remaining.count != externalCodeFolders.count else { return }
        externalCodeFolders = remaining
        onExternalCodeFoldersChanged?(externalCodeFolders)
        rescan()
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
            // Match on a directory boundary (trailing "/") so an allowed
            // "/a/proj" doesn't also shield "/a/proj-2/…".
            if allowedPathPrefixes.contains(where: { prefix in
                guard !prefix.isEmpty else { return false }
                let dir = prefix.hasSuffix("/") ? prefix : prefix + "/"
                return item.path == prefix || item.path.hasPrefix(dir)
            }) {
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

    /// On-disk envelope. New writes always use this shape; legacy
    /// bare-array files still decode through the fallback in `load()`.
    /// See `docs/reference/persistence.md` for the migration policy.
    private struct StoreFile: Codable {
        var storeVersion: Int = 1
        var items: [LibraryItem]
    }

    /// One-time import of the legacy `library_items.json` into the new
    /// single-source layout.  If the legacy file exists, each surviving
    /// (still-on-disk) non-meeting item is re-homed: directories become
    /// external `.code` references; files outside the project are COPIED in
    /// via `add(url:category:)`; files already inside the project are
    /// ignored (the subsequent scan picks them up).  The legacy file is then
    /// renamed to `library_items.migrated.json` so this runs exactly once.
    /// Meeting items are skipped — the `meetings/` scan is authoritative.
    private func migrateLegacyIndexIfNeeded(root: URL) {
        guard let url = storeURL else { return }
        let fm = FileManager.default
        // Sentinel: once migration has run we leave `library_items.migrated.json`
        // behind.  Its presence means "already migrated" — never run again,
        // even if a later `save()` recreates `library_items.json`.
        let migrated = url.deletingLastPathComponent()
            .appendingPathComponent("library_items.migrated.json")
        if fm.fileExists(atPath: migrated.path) { return }
        guard fm.fileExists(atPath: url.path),
              let legacy = decodeLegacyItems(at: url) else { return }
        for item in legacy where item.category != .meetings {
            let itemURL = URL(fileURLWithPath: item.path)
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: item.path, isDirectory: &isDir) else { continue }
            if isDir.boolValue {
                addFolder(url: itemURL, category: .code)
            } else if !ProjectPaths.isInside(itemURL, root: root) {
                add(url: itemURL, category: item.category)
            }
            // Files already inside the project need no action — rescan() finds them.
        }
        // Rename aside so the migration never runs again (sentinel above).
        do {
            try fm.moveItem(at: url, to: migrated)
        } catch {
            os_log(.error,
                   "LibraryItemStore: failed to rename legacy store at %{public}@: %{public}@",
                   url.path, "\(error)")
        }
    }

    /// Decode the legacy on-disk index without mutating live state.  Tries
    /// the versioned envelope first, then the bare-array fallback.  Returns
    /// nil (and renames a corrupt file aside) on failure.
    private func decodeLegacyItems(at url: URL) -> [LibraryItem]? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        if let file = try? AppJSON.decoder.decode(StoreFile.self, from: data) {
            return file.items
        }
        do {
            return try AppJSON.decoder.decode([LibraryItem].self, from: data)
        } catch {
            // Decode failed: the file is corrupt or from an incompatible
            // schema. Rename it aside so the next write doesn't clobber the
            // user's recovery copy.
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
            return nil
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
        do {
            let data = try AppJSON.encoder.encode(file)
            try data.write(to: url)
        } catch {
            os_log(.error, "LibraryItemStore: failed to save index: %{public}@",
                   error.localizedDescription)
        }
    }
}
