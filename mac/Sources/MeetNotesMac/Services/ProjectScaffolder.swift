import Foundation
import os.log

/// Creates and maintains the canonical folder tree inside a MeetNotes project.
///
/// Called on every `ProjectStore.openFolder(at:)` — fully idempotent, so
/// re-opening an existing project only creates whatever is newly missing.
///
/// Expected layout after scaffolding:
///
/// ```
/// <projectFolder>/
/// ├── .meetnotes/
/// │   ├── project.json      ← project metadata (written by ProjectStore)
/// │   ├── sync.json         ← last export info  (written by ProjectExporter)
/// │   ├── index.sqlite      ← meeting full-text index (written by AppEnvironment)
/// │   ├── cache/            ← runtime cache, git-ignored
/// │   └── .gitignore        ← ignores sync.json, cache/, index.sqlite, *.partial.md
/// ├── meetings/             ← live captures + YYYY/MM/date-slug-<id>.md on export
/// ├── plans/                ← date-slug-<id>.md + .json on export
/// ├── notes/                ← free-form notes, user-managed
/// ├── assets/               ← screenshots / diagrams, user-managed
/// └── README.md             ← refreshed on every open
/// ```
enum ProjectScaffolder {

    private static let log = Logger(
        subsystem: "com.meetnotes.macapp",
        category:  "ProjectScaffolder"
    )

    // Directories that must exist under every project root.
    static let requiredDirectories = [
        ".meetnotes",
        ".meetnotes/cache",   // runtime cache; gitignored
        "meetings",
        "plans",
        "notes",
        "assets",
    ]

    // MARK: - Public entry point

    /// Validate that `folderURL` is a recognised MeetNotes project folder.
    ///
    /// A folder is accepted when it satisfies **any** of the following:
    ///
    /// 1. Already a MeetNotes project — has `.meetnotes/project.json`.
    /// 2. Has the required top-level sub-folders (`meetings/`, `notes/`,
    ///    `plans/`) — handles manually created or migrated project trees
    ///    that pre-date the `.meetnotes/` marker.
    /// 3. Is completely empty — treated as a new project to be scaffolded.
    ///
    /// Anything else (e.g. a Downloads folder, a code repo, a random
    /// directory) throws `ProjectStoreError.invalidFolderStructure` so the
    /// caller can surface an error before any state is mutated.
    ///
    /// - Throws: `ProjectStoreError.invalidFolderStructure` when none of
    ///   the above conditions are met.
    static func validate(at folderURL: URL) throws {
        let fm = FileManager.default

        // 1. Existing MeetNotes project.
        let projectJSON = folderURL.appendingPathComponent(".meetnotes/project.json")
        if fm.fileExists(atPath: projectJSON.path) { return }

        // 2. Has all required top-level dirs (migrated / manually created).
        let topLevelRequired = ["meetings", "notes", "plans"]
        let allPresent = topLevelRequired.allSatisfy { dir in
            var isDir: ObjCBool = false
            let exists = fm.fileExists(
                atPath: folderURL.appendingPathComponent(dir).path,
                isDirectory: &isDir)
            return exists && isDir.boolValue
        }
        if allPresent { return }

        // 3. Empty folder — new project.
        let contents = (try? fm.contentsOfDirectory(atPath: folderURL.path)) ?? []
        if contents.isEmpty { return }

        // None of the above — reject.
        throw ProjectStoreError.invalidFolderStructure(folderURL.lastPathComponent)
    }

    /// Scaffold the project folder.  Safe to call on an existing project.
    ///
    /// - Throws: `CocoaError` when a required directory cannot be created
    ///   (e.g. read-only volume, permissions issue). `.gitignore` / `.gitkeep`
    ///   / README write failures are logged but do not propagate — they are
    ///   non-critical and will succeed on the next open.
    static func scaffold(at folderURL: URL, project: Project) throws {
        let fm = FileManager.default

        // 1. Core directories
        for dir in requiredDirectories {
            try fm.createDirectory(
                at: folderURL.appendingPathComponent(dir),
                withIntermediateDirectories: true)
        }

        // 2. .gitignore — only create if absent so user edits are preserved
        writeIfAbsent(
            at: folderURL.appendingPathComponent(".meetnotes/.gitignore"),
            content: gitignoreContent)

        // 3. .gitkeep markers so empty directories survive `git add .`
        for dir in ["notes", "assets"] {
            writeIfAbsent(
                at: folderURL.appendingPathComponent("\(dir)/.gitkeep"),
                content: "")
        }

        // 4. README.md — refreshed on every open so settings changes (language,
        //    linked repo, display name) are always reflected.  We overwrite
        //    unconditionally and document in the README that edits are preserved
        //    only outside the auto-generated section.
        writeAlways(
            at: folderURL.appendingPathComponent("README.md"),
            content: makeReadme(project: project, folderURL: folderURL))

        log.info("scaffold complete: \(folderURL.lastPathComponent, privacy: .public)")
    }

    // MARK: - Private helpers

    /// Write `content` to `url` only if the file does not yet exist.
    /// Logs but does not propagate write errors (these files are non-critical).
    private static func writeIfAbsent(at url: URL, content: String) {
        guard !FileManager.default.fileExists(atPath: url.path) else { return }
        do {
            try content.write(to: url, atomically: true, encoding: .utf8)
        } catch {
            log.debug("writeIfAbsent failed at \(url.lastPathComponent, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Overwrite `url` unconditionally.
    /// Logs but does not propagate write errors.
    private static func writeAlways(at url: URL, content: String) {
        do {
            try content.write(to: url, atomically: true, encoding: .utf8)
        } catch {
            log.debug("writeAlways failed at \(url.lastPathComponent, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - .gitignore

    private static let gitignoreContent = """
    # MeetNotes — auto-generated / ephemeral files
    .meetnotes/sync.json
    .meetnotes/cache/
    .meetnotes/index.sqlite
    .meetnotes/index.sqlite-shm
    .meetnotes/index.sqlite-wal
    *.partial.md

    """

    // MARK: - README

    /// Generate the project README.
    ///
    /// The "Auto-generated section" block below the divider is always
    /// refreshed.  Users may add content ABOVE the `<!-- meetnotes:auto -->`
    /// marker; that content is preserved across refreshes.
    private static func makeReadme(project: Project, folderURL: URL) -> String {
        let isoDate = AppDateFormatter.isoString(project.createdAt)
        let lang    = project.settings.language.uppercased()
        let name    = project.displayName
        let repoLine: String = {
            guard let repo = project.settings.linkedRepo else { return "(none)" }
            return "\(repo.kind.rawValue) — [\(repo.remoteId)](\(repo.url))"
        }()

        return """
        # \(name)

        > Managed by **MeetNotes** — meeting intelligence & project control.

        <!-- meetnotes:auto — content below is refreshed by MeetNotes on every project open -->

        ## Project Info

        | Field       | Value          |
        |-------------|----------------|
        | ID          | `\(project.id)` |
        | Language    | \(lang)        |
        | Created     | \(isoDate)     |
        | Linked repo | \(repoLine)    |

        ## Folder Structure

        ```
        \(name)/
        ├── .meetnotes/   ← project metadata & sync state (managed by MeetNotes)
        │   └── cache/    ← runtime cache (git-ignored)
        ├── meetings/     ← exported meeting transcripts & summaries (YYYY/MM/)
        ├── plans/        ← exported project plans (Markdown + JSON)
        ├── notes/        ← free-form notes (yours to use)
        └── assets/       ← screenshots, diagrams, attachments (yours to use)
        ```

        ## Meetings

        Meeting files land under `meetings/YYYY/MM/YYYY-MM-DD-<slug>-<id>.md` when
        you close or export the project.  Each file has YAML frontmatter, an action
        items / decisions / blockers summary, and the full transcript (fenced).

        ## Plans

        | Format | Description |
        |--------|-------------|
        | `.md`  | Human-readable milestone-grouped task list |
        | `.json`| Full Codable dump with all fields |

        `_index.json` in each directory is updated automatically on export.

        ---
        *Auto-generated by MeetNotes. Add your own notes ABOVE the `<!-- meetnotes:auto -->` marker.*

        """
    }
}
