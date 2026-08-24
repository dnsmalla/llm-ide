import Foundation
import os.log

/// Seeds and maintains `<projectRoot>/templates/<folder-name>/template.md`
/// for Doc Gen. Idempotent — only writes files that don't exist yet.
enum ProjectDocTemplatesSeeder {

    private static let log = Logger(
        subsystem: "com.llmide.macapp",
        category: "ProjectDocTemplatesSeeder")

    /// Create `templates/` and seed default template folders + README.
    static func seedIfNeeded(at projectRoot: URL) {
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

        for def in DocTemplate.seedDefinitions {
            let dir = layout.templateDir(named: def.folderName)
            do {
                try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            } catch {
                log.error("template dir \(def.folderName, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
                continue
            }
            writeIfAbsent(at: dir.appendingPathComponent("template.md"), content: def.markdown())
        }
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

    - **Ingest templates** (`meeting-note`, `email-note`): use `{{title}}`, `{{summary}}`, `{{todos}}`, etc. Rebuild folders or reopen the project to seed missing templates.
    - **Doc Gen templates**: section structure comes from `## Heading` lines.
    - Add a new Doc Gen template: create `templates/my-template/template.md` with at least one `##` section, then reopen the project or use **Rebuild missing folders** in Explorer → Project folders.

    Doc Gen exports go to `data/`. Auto ingest notes go to `llm-doc/`.

    <!-- llmide:doc-template-readme -->
    """
}
