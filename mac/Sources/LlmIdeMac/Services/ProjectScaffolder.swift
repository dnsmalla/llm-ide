import Foundation
import os.log

/// Creates and maintains the canonical folder tree inside a LLM IDE project.
///
/// Called on every `ProjectStore.openFolder(at:)` — fully idempotent, so
/// re-opening an existing project only creates whatever is newly missing.
///
/// Expected layout after scaffolding:
///
/// ```
/// <projectFolder>/
/// ├── source/   ← meeting & email transcripts (your Sources)
/// ├── code/     ← code files
/// ├── data/     ← documents, data files, images
/// ├── notes/    ← notes generated from meetings/email
/// └── system/   ← LLM IDE managed: settings, faults, graph, index (most git-ignored)
///     ├── project.json   ← project metadata (written by ProjectStore)
///     ├── sync.json      ← last export info  (git-ignored)
///     ├── index.sqlite   ← full-text index   (git-ignored)
///     ├── faults/        ← fault log entries
///     ├── graph/         ← knowledge graph   (git-ignored)
///     └── cache/         ← runtime cache     (git-ignored)
/// ```
enum ProjectScaffolder {

    private static let log = Logger(
        subsystem: "com.llmide.macapp",
        category:  "ProjectScaffolder"
    )

    // Directories that must exist under every project root.
    static let requiredDirectories = [
        "source", "code", "data", "notes",
        "system", "system/faults", "system/graph", "system/cache",
    ]

    // MARK: - Public entry point

    /// Validate that `folderURL` is a recognised LLM IDE project folder.
    ///
    /// A folder is accepted when it satisfies **any** of the following:
    ///
    /// 1. Already a new-layout LLM IDE project — has `system/project.json`.
    /// 2. Is completely empty — treated as a new project to be scaffolded.
    ///
    /// Anything else (e.g. a Downloads folder, a code repo, an old-layout
    /// project with `meetings/`/`plans/`) throws
    /// `ProjectStoreError.invalidFolderStructure` so the caller can surface
    /// an error before any state is mutated.
    ///
    /// - Throws: `ProjectStoreError.invalidFolderStructure` when none of
    ///   the above conditions are met.
    static func validate(at folderURL: URL) throws {
        let fm = FileManager.default
        // 1. New-layout project marker.
        if fm.fileExists(atPath: folderURL.appendingPathComponent("system/project.json").path) { return }
        // 2. Empty folder — new project to scaffold.
        let contents = (try? fm.contentsOfDirectory(atPath: folderURL.path)) ?? []
        if contents.isEmpty { return }
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

        // 2. Root .gitignore — append managed block once; never clobber user rules
        ensureRootGitignore(at: folderURL)

        // 3. .gitkeep markers so empty directories survive `git add .`
        for dir in ["notes", "data"] {
            writeIfAbsent(
                at: folderURL.appendingPathComponent("\(dir)/.gitkeep"),
                content: "")
        }

        // 4. README.md — refreshed on every open so settings changes (language,
        //    linked repo, display name) are always reflected.  BUT never clobber
        //    a foreign README: when adopting a cloned code repo as a project, the
        //    repo ships its own README.md.  Only (re)write when the file is absent
        //    or already LLM IDE-managed (carries the auto marker).
        let readmeURL = folderURL.appendingPathComponent("README.md")
        let existingReadme = try? String(contentsOf: readmeURL, encoding: .utf8)
        if existingReadme == nil
            || existingReadme!.contains("<!-- llmide:auto")
            || existingReadme!.contains("<!-- meetnotes:auto") {
            writeAlways(
                at: readmeURL,
                content: makeReadme(project: project, folderURL: folderURL))
        } else {
            log.info("preserving existing non-LLM IDE README at \(folderURL.lastPathComponent, privacy: .public)")
        }

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

    private static let managedGitignoreBlock = """
    # >>> LLM IDE managed (auto-generated / ephemeral) — edit your own rules above
    system/cache/
    system/index.sqlite
    system/index.sqlite-shm
    system/index.sqlite-wal
    system/graph/
    system/sync.json
    *.partial.md
    # <<< LLM IDE managed
    """

    /// Ensure the project-root .gitignore contains the managed block. Creates
    /// the file if absent; appends the block once if the marker is missing;
    /// no-ops if already present. Never rewrites the user's own rules.
    private static func ensureRootGitignore(at folderURL: URL) {
        let url = folderURL.appendingPathComponent(".gitignore")
        let existing = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        if existing.contains("# >>> LLM IDE managed") { return }
        let combined: String
        if existing.isEmpty {
            combined = managedGitignoreBlock + "\n"
        } else {
            let sep = existing.hasSuffix("\n") ? "\n" : "\n\n"
            combined = existing + sep + managedGitignoreBlock + "\n"
        }
        do { try combined.write(to: url, atomically: true, encoding: .utf8) }
        catch { log.error("gitignore write failed: \(error.localizedDescription, privacy: .public)") }
    }

    // MARK: - README

    /// Generate the project README.
    ///
    /// The "Auto-generated section" block below the divider is always
    /// refreshed.  Users may add content ABOVE the `<!-- llmide:auto -->`
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

        > Managed by **LLM IDE** — meeting intelligence & project control.

        <!-- llmide:auto — content below is refreshed by LLM IDE on every project open -->

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
        ├── source/   ← meeting & email transcripts (your Sources)
        ├── code/     ← code files
        ├── data/     ← documents, data files, images
        ├── notes/    ← notes generated from meetings/email
        └── system/   ← LLM IDE managed: settings, faults, graph, index (most git-ignored)
        ```

        ## Meetings

        Meeting files land under `source/YYYY/MM/YYYY-MM-DD-<slug>-<id>.md` when
        you close or export the project.  Each file has YAML frontmatter, an action
        items / decisions / blockers summary, and the full transcript (fenced).

        ---
        *Auto-generated by LLM IDE. Add your own notes ABOVE the `<!-- llmide:auto -->` marker.*

        """
    }
}
