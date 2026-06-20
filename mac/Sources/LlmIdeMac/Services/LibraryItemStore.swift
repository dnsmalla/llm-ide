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

    /// The live index now comes from `rescan()` against the bound project
    /// and never persists.  `storeURL`/`StoreFile` are retained ONLY to
    /// DECODE the legacy `library_items.json` during the one-time migration
    /// (see `migrateLegacyIndexIfNeeded`).
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
        let deduped = Self.dedupePreservingOrder(paths).filter { !isInsideProject($0) }
        guard deduped != externalCodeFolders else { return }
        externalCodeFolders = deduped
        rescan()
    }

    /// True when `path` resolves to a location inside the bound project root.
    /// Used to keep in-project folders OUT of `externalCodeFolders`: the
    /// canonical-subfolder scan already covers them, and a second reference
    /// would emit the same file twice (matching ids → broken SwiftUI ForEach).
    /// False when no project is bound (nothing to be "inside").
    private func isInsideProject(_ path: String) -> Bool {
        guard let root = projectRoot else { return false }
        return ProjectPaths.isInside(URL(fileURLWithPath: path), root: root)
    }

    // MARK: - Scan-as-index

    /// Canonical subfolders scanned into the index, mirroring the Library
    /// sections.  Captured transcripts live in `source/`; images fold into
    /// `data/`.
    nonisolated private static let scanFolders: [(subfolder: String, category: LibraryItem.Category)] = [
        ("source", .meetings),
        ("code",   .code),
        ("data",   .data),
        ("notes",  .notes),
    ]

    /// Classify a `source/` file as a captured meeting or ingested mail by
    /// reading the `platform` field from its `.md` frontmatter. Best-effort:
    /// reads only the file head and defaults to `.meeting` for non-`.md`
    /// files, missing frontmatter, or an absent `platform` line — robust to
    /// frontmatter schema drift since it never decodes the whole struct.
    /// `platform` is the third frontmatter key, so a small head read covers it.
    /// `nonisolated` (pure function) so it can run off the main actor and be
    /// unit-tested directly.
    nonisolated static func sourceKind(for url: URL) -> LibraryItem.SourceKind {
        guard url.pathExtension.lowercased() == "md",
              let handle = try? FileHandle(forReadingFrom: url) else { return .meeting }
        defer { try? handle.close() }
        let head = (try? handle.read(upToCount: 2048))
            .flatMap { String(data: $0, encoding: .utf8) } ?? ""
        guard head.hasPrefix("---") else { return .meeting }
        // Walk the frontmatter block (between the opening and closing "---").
        for raw in head.split(separator: "\n").dropFirst() {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line == "---" { break }                 // end of frontmatter
            if line.hasPrefix("platform:") {
                let value = line.dropFirst("platform:".count)
                    .trimmingCharacters(in: CharacterSet(charactersIn: " \"'"))
                return LibraryItem.SourceKind(platform: value)
            }
        }
        return .meeting
    }

    /// Rebuild `items` from the bound project folder.  Authoritative for
    /// the bound-project case: enumerates each canonical subfolder, applies
    /// the same noise/relevance filters as the old `addFolder`, then appends
    /// external referenced-folder items.  With no project bound, `items` is
    /// emptied.
    func rescan() {
        items = Self.performScan(root: projectRoot, externalFolders: externalCodeFolders)
    }

    /// Off-main variant for the hot paths (project bind, `meetingIndexChanged`
    /// fan-out) where the directory walk + per-meeting frontmatter reads would
    /// otherwise hitch the UI. Runs the same pure scan on a background task,
    /// then assigns `items` back on the main actor. The synchronous `rescan()`
    /// stays for the copy-on-add/remove/move paths whose callers read `items`
    /// immediately after.
    func rescanAsync() async {
        let root = projectRoot
        let external = externalCodeFolders
        let scanned = await Task.detached(priority: .utility) {
            Self.performScan(root: root, externalFolders: external)
        }.value
        items = scanned
    }

    /// Pure, off-main-safe scan: enumerate the project's canonical subfolders
    /// + external code-folder references, apply the noise/relevance filters,
    /// classify meeting vs mail, and dedup by path. No instance/main-actor
    /// state — everything it needs is passed in — so it runs on any thread.
    nonisolated static func performScan(root: URL?, externalFolders: [String]) -> [LibraryItem] {
        guard let root else { return [] }
        let fm = FileManager.default
        var scanned: [LibraryItem] = []
        for (subfolder, category) in scanFolders {
            let folderURL = root.appendingPathComponent(subfolder, isDirectory: true)
            guard let enumerator = fm.enumerator(
                at: folderURL,
                includingPropertiesForKeys: [.isRegularFileKey, .isDirectoryKey],
                options: [.skipsHiddenFiles]
            ) else { continue }
            for case let fileURL as URL in enumerator {
                let name = fileURL.lastPathComponent
                if noiseDirectoryNames.contains(name),
                   (try? fileURL.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
                    enumerator.skipDescendants()
                    continue
                }
                guard (try? fileURL.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
                else { continue }
                if category == .code, !isCodeRelevant(url: fileURL) { continue }
                // Skip partial-draft notes/transcripts and the reference template.
                if name.hasSuffix(".partial.md") || name == "template.md" { continue }
                var item = LibraryItem(name: name, path: fileURL.path, category: category)
                // folderOrigin == nil when the file sits directly in the
                // canonical subfolder; otherwise it's the immediate parent
                // dir name so the sidebar groups it in a DisclosureGroup.
                let parentName = fileURL.deletingLastPathComponent().lastPathComponent
                item.folderOrigin = (parentName == subfolder) ? nil : parentName
                // Code renders as a nested tree: record the directory path
                // relative to the project's code/ folder (files at its top
                // level get an empty path).
                if category == .code {
                    item.treePath = relativeDirComponents(of: fileURL, under: folderURL)
                }
                // Meetings and ingested email share the source/ folder;
                // classify by frontmatter platform so the SOURCES section can
                // split them into Meetings / Mail sub-groups.
                if category == .meetings {
                    item.sourceKind = sourceKind(for: fileURL)
                }
                scanned.append(item)
            }
        }
        scanned.append(contentsOf: externalFolderItems(externalFolders))
        // Dedup by path (preserving order) so an external code folder that
        // overlaps with a scanned canonical subfolder can't produce two items
        // with the same path — which would share an id and break SwiftUI ForEach.
        var seenPaths = Set<String>()
        return scanned.filter { seenPaths.insert($0.path).inserted }
    }

    /// Index files from each external code-folder reference (folders are
    /// referenced in place, never copied).  Each file becomes a `.code`
    /// item with `folderOrigin` = the folder's name so the sidebar groups
    /// it.  Applies the same noise-dir + code-relevance filters as the scan.
    nonisolated private static func externalFolderItems(_ externalFolders: [String]) -> [LibraryItem] {
        let fm = FileManager.default
        var result: [LibraryItem] = []
        for path in externalFolders {
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
                if noiseDirectoryNames.contains(name),
                   (try? fileURL.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
                    enumerator.skipDescendants()
                    continue
                }
                guard (try? fileURL.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
                else { continue }
                if !isCodeRelevant(url: fileURL) { continue }
                var item = LibraryItem(name: name, path: fileURL.path, category: .code)
                item.folderOrigin = folderName
                // Nest the whole repo under a single node named after the
                // folder, then its real subdirectory structure beneath that.
                item.treePath = [folderName]
                    + relativeDirComponents(of: fileURL, under: folderURL)
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
        let path = Self.standardize(url.path)
        // A folder inside the active project is already covered by the
        // canonical-subfolder scan; referencing it externally would emit each
        // file twice (duplicate path → duplicate id). Re-index instead.
        if isInsideProject(path) {
            rescan()
            return
        }
        guard !externalCodeFolders.contains(path) else { return }
        externalCodeFolders.append(path)
        onExternalCodeFoldersChanged?(externalCodeFolders)
        rescan()
    }

    /// The single place external-folder paths are normalized.  Standardizes
    /// each path (resolves `..`, `~`, trailing slash) so membership checks and
    /// dedup compare standardized-vs-standardized — avoiding duplicate refs
    /// that differ only by a trailing slash or unresolved component.
    static func standardize(_ path: String) -> String {
        URL(fileURLWithPath: path).standardizedFileURL.path
    }

    /// Directory components between `root` and `fileURL`, excluding the
    /// filename — the file's position within `root` for the nested code tree.
    /// Returns `[]` when the file sits directly in `root`, and `[]` (not a
    /// crash) when `fileURL` isn't actually under `root`.
    nonisolated static func relativeDirComponents(of fileURL: URL, under root: URL) -> [String] {
        let rootComps = root.standardizedFileURL.pathComponents
        let fileComps = fileURL.standardizedFileURL.pathComponents
        guard fileComps.count > rootComps.count,
              Array(fileComps.prefix(rootComps.count)) == rootComps else { return [] }
        // Drop the filename (last component); keep the dirs in between.
        return Array(fileComps[rootComps.count..<(fileComps.count - 1)])
    }

    private static func dedupePreservingOrder(_ paths: [String]) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for raw in paths {
            let p = standardize(raw)
            if seen.insert(p).inserted { out.append(p) }
        }
        return out
    }

    /// Dirs we never want to walk into when indexing a code repo.
    /// Thin alias for the canonical `IgnoreList.directories`.
    nonisolated static let noiseDirectoryNames: Set<String> = IgnoreList.directories

    /// True when `url` is a file the app can meaningfully preview as
    /// code/text/docs/config. The check is on the extension; files
    /// with NO extension (LICENSE, VERSION, Makefile, Dockerfile,
    /// NOTICE) are kept because they're almost always plain text
    /// and high-signal in a repo root.
    nonisolated static func isCodeRelevant(url: URL) -> Bool {
        let ext = url.pathExtension.lowercased()
        if ext.isEmpty { return true }
        return codeRelevantExtensions.contains(ext)
    }

    /// Allow-list of file extensions we'll index under `.code`.
    /// Programming languages + markup + config — everything the
    /// FileDetailView pipeline can render meaningfully. Images
    /// (.png, .jpg, …) and binaries (.dmg, .pkg, .zip) are
    /// deliberately omitted; they're noise in a code graph.
    nonisolated static let codeRelevantExtensions: Set<String> = [
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

    /// Delete a single indexed item under the single-source model.  Since
    /// `items` is a derived scan, mutating it in memory is futile (the next
    /// `rescan()` resurrects the file) — the deletion has to happen on disk.
    ///
    ///   - Item INSIDE the bound project → delete the backing file from disk,
    ///     then `rescan()` so `items` reflects the removal.
    ///   - Item in an EXTERNAL referenced folder (not inside the project) →
    ///     NO-OP.  We never delete the user's external files; deleting an
    ///     individual file out of a referenced code repo isn't supported.
    ///     Whole-folder un-linking goes through `removeFolder(...)`.
    func remove(id: String) {
        guard let root = projectRoot,
              let item = items.first(where: { $0.id == id }) else { return }
        // External (out-of-project) files are referenced in place — never
        // delete the user's file. Single-file delete is unsupported for them.
        guard ProjectPaths.isInside(item.url, root: root) else { return }
        do {
            try FileManager.default.removeItem(at: item.url)
        } catch {
            os_log(.error, "LibraryItemStore: failed to delete %{public}@: %{public}@",
                   item.path, "\(error)")
            return
        }
        rescan()
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

    /// On-disk envelope used ONLY to DECODE the legacy `library_items.json`
    /// during the one-time migration (see `decodeLegacyItems`).  The live
    /// index no longer persists, so nothing encodes this anymore.
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
    /// Meeting items are skipped — the `source/` scan is authoritative.
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
}
