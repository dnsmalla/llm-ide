import Foundation
import os.log

/// Seeds and maintains `<projectRoot>/templates/<folder-name>/template.md`
/// for Doc Gen. Idempotent — only writes files that don't exist yet.
enum ProjectDocTemplatesSeeder {

    private static let log = Logger(
        subsystem: "com.llmide.macapp",
        category: "ProjectDocTemplatesSeeder")

    /// Create `templates/` and seed default template folders + README.
    ///
    /// `kit` is the default set from `dnsmalla/agent-kit`
    /// (`GenerationLibraryStore`). It used to be a Swift constant list, so
    /// adding a template meant an app release; now it is a file in the kit.
    /// An empty `kit` (server down, older server, kit not checked out) seeds
    /// only the ingest templates below — which are app machinery, not kit
    /// content — and the next open tops the project up, because every write
    /// here is `writeIfAbsent`.
    static func seedIfNeeded(at projectRoot: URL,
                             kit: [LlmIdeAPIClient.GenerationLibraryEntry] = []) {
        let layout = ProjectLayout(root: projectRoot)
        let fm = FileManager.default

        do {
            try fm.createDirectory(at: layout.templatesDir, withIntermediateDirectories: true)
        } catch {
            log.error("templates dir failed: \(error.localizedDescription, privacy: .public)")
            return
        }

        writeIfAbsent(
            at: layout.templatesDir.appendingPathComponent("README.md"),
            content: templatesReadme)

        // Ingest templates (meeting-note / email-note) stay in the app: they
        // are {{placeholder}} layouts rendered by IngestTemplateRenderer for
        // auto-generated notes, not Doc Gen material a user picks from a menu.
        for def in DocTemplate.seedDefinitions {
            write(folderName: def.folderName, content: def.markdown(), layout: layout, fm: fm)
        }
        // Everything a user actually picks comes from the kit.
        for entry in kit where !entry.folderName.isEmpty {
            write(folderName: entry.folderName,
                  content: Self.projectMarkdown(for: entry),
                  layout: layout, fm: fm)
        }
    }

    /// A kit entry as a project template file: its body with the surface
    /// marker stamped in, which is what the project scanner reads to decide
    /// whether this belongs in the Doc Gen or the Visual menu.
    static func projectMarkdown(for entry: LlmIdeAPIClient.GenerationLibraryEntry) -> String {
        TemplateSurfaceMarker.ensure(
            in: entry.body, base: DocTemplate.markerComment, surface: entry.templateSurface)
    }

    private static func write(folderName: String, content: String,
                              layout: ProjectLayout, fm: FileManager) {
        let dir = layout.templateDir(named: folderName)
        do {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            log.error("template dir \(folderName, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
            return
        }
        writeIfAbsent(at: dir.appendingPathComponent("template.md"), content: content)
    }

    // MARK: - Private

    private static func writeIfAbsent(at url: URL, content: String) {
        guard !FileManager.default.fileExists(atPath: url.path) else { return }
        do {
            try content.write(to: url, atomically: true, encoding: .utf8)
        } catch {
            log.debug("writeIfAbsent failed at \(url.lastPathComponent, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
    }

    private static let templatesReadme = """
    # Doc Gen Templates

    Each subfolder is one document template for **Doc Gen** in LLM-IDE.

    ## Layout

    ```
    templates/
    ├── meeting-note/     ← auto llm-doc notes from meetings ({{placeholders}})
    ├── email-note/       ← auto llm-doc notes from email
    ├── meeting-summary/  ← Doc Gen manual export
    │   └── template.md
    └── …
    ```

    ## Editing

    - **Ingest templates** (`meeting-note`, `email-note`): summary + action items only (`{{gist}}`/`{{summary}}`, `{{actions}}`/`{{todos}}`). Full transcript and original email stay in `source/` via `rawFile`. Rebuild folders or reopen the project to seed missing templates.
    - **Doc Gen templates**: section structure comes from `## Heading` lines.
    - Add a new Doc Gen template: create `templates/my-template/template.md` with at least one `##` section, then reopen the project or use **Rebuild missing folders** in Explorer → Project folders.

    Doc Gen exports go to `data/`. Auto ingest notes go to `llm-doc/`.

    <!-- llmide:doc-template-readme -->
    """
}
