import Foundation
import os.log

/// Seeds the two ingest templates, `templates/meeting-note/template.md` and
/// `templates/email-note/template.md`, for a project.
///
/// These are app machinery, not Doc Gen material. `IngestTemplateRenderer`
/// reads them from disk for auto-generated notes and falls back to the built-in
/// default when a file is missing, so they are seeded eagerly at project create
/// and activation, which is how a user can find and edit them. Doc Gen never
/// offers them in its menus. Doc Gen's own templates and commands are seeded
/// lazily, on first open (`DocGenProvider.seedProjectFiles`).
///
/// Idempotent: only writes files that do not exist yet.
enum IngestTemplateSeeder {

    private static let log = Logger(
        subsystem: "com.llmide.macapp",
        category: "IngestTemplateSeeder")

    static func seedIfNeeded(at projectRoot: URL) {
        let fm = FileManager.default
        let layout = ProjectLayout(root: projectRoot)
        for kind in [IngestTemplateKind.meetingNote, .emailNote] {
            let dir = layout.templateDir(named: kind.folderName)
            do {
                try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            } catch {
                log.error("ingest template dir \(kind.folderName, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
                continue
            }
            let file = dir.appendingPathComponent("template.md")
            guard !fm.fileExists(atPath: file.path) else { continue }
            do {
                try IngestTemplateRenderer.defaultTemplate(kind).write(to: file, atomically: true, encoding: .utf8)
            } catch {
                log.debug("ingest template \(kind.folderName, privacy: .public) write failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }
}
