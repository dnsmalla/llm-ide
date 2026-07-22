import Foundation
import os.log

/// Seeds and maintains `<projectRoot>/templates/<folder-name>/template.md`
/// for Doc Gen. Idempotent — only writes files that don't exist yet.
enum ProjectDocTemplatesSeeder {

    private static let log = Logger(
        subsystem: "com.llmide.macapp",
        category: "ProjectDocTemplatesSeeder")

    /// Slugs written under `templates/` for every new project.
    static func defaultActiveSlugs() -> [String] {
        DocTemplate.seedDefinitions.map(\.folderName)
    }

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

    Each subfolder is one document template for **Doc Gen** in LLM IDE.

    ## Layout

    ```
    templates/
    ├── meeting-summary/
    │   └── template.md    ← `##` headings define sections
    ├── sprint-review/
    │   └── template.md
    └── …
    ```

    ## Editing

    - Open any `template.md` in your editor, or use **Doc Gen → Sources → Manage**.
    - Section structure comes from `## Heading` lines.
    - Add a new template: create `templates/my-template/template.md` with at least one `##` section, then reopen the project or use **Rebuild missing folders** in Settings → Paths.

    Generated documents export as Markdown (`.md`) into the project's `data/` folder.

    <!-- llmide:doc-template-readme -->
    """
}
