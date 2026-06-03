import Foundation
import os.log

private let logger = Logger(subsystem: "com.meetnotes.macapp", category: "DocTemplateStore")

@MainActor
final class DocTemplateStore: ObservableObject {
    @Published private(set) var customTemplates: [DocTemplate] = []

    var templates: [DocTemplate] { customTemplates }

    private var storeURL: URL {
        guard let support = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            return URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("com.meetnotes.macapp/doc-templates.json")
        }
        return support.appendingPathComponent("com.meetnotes.macapp/doc-templates.json")
    }

    init() {
        // Disk read deferred until `bootstrap()` is called from the
        // AppShell's first `.task` tick so MeetNotesMacApp.init stays
        // cheap and the first SwiftUI frame isn't blocked on JSON
        // decoding.
    }

    private var hasBootstrapped = false

    /// Load user-customized templates from disk. Idempotent.
    func bootstrap() {
        guard !hasBootstrapped else { return }
        hasBootstrapped = true
        load()
    }

    /// Import an .md file as a template. Parses `## ` headings as sections.
    /// Returns the new template, or nil if the file can't be read.
    @discardableResult
    func importMarkdownFile(at url: URL) -> DocTemplate? {
        guard let content = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let name = url.deletingPathExtension().lastPathComponent
        let sections = DocTemplate.sections(from: content)
        let template = DocTemplate(
            id: UUID(),
            name: name,
            sections: sections,
            rawContent: content,
            isBuiltin: false)
        add(template)
        return template
    }

    func add(_ template: DocTemplate) {
        customTemplates.append(template)
        save()
    }

    func update(_ template: DocTemplate) {
        guard let idx = customTemplates.firstIndex(where: { $0.id == template.id }) else { return }
        customTemplates[idx] = template
        save()
    }

    func delete(id: UUID) {
        customTemplates.removeAll { $0.id == id }
        save()
    }

    @discardableResult
    func duplicate(_ template: DocTemplate) -> DocTemplate {
        let copy = DocTemplate(
            id: UUID(),
            name: "\(template.name) (copy)",
            sections: template.sections,
            isBuiltin: false)
        add(copy)
        return copy
    }

    /// On-disk envelope. New writes always use this shape; legacy
    /// bare-array files still decode through the fallback in `load()`.
    /// See `docs/reference/persistence.md`.
    private struct StoreFile: Codable {
        var storeVersion: Int = 1
        var templates: [DocTemplate]
    }

    private func load() {
        guard let data = try? Data(contentsOf: storeURL) else { return }
        if let file = try? AppJSON.decoder.decode(StoreFile.self, from: data) {
            customTemplates = file.templates
            return
        }
        do {
            customTemplates = try AppJSON.decoder.decode([DocTemplate].self, from: data)
        } catch {
            // Preserve the corrupt file so the next save() won't clobber
            // the user's templates; a manual recovery is then possible.
            let ts = Int(Date().timeIntervalSince1970)
            let backup = storeURL.deletingLastPathComponent()
                .appendingPathComponent("doc-templates.json.corrupt-\(ts)")
            do {
                try FileManager.default.moveItem(at: storeURL, to: backup)
                logger.warning("Corrupt store renamed to \(backup.path): \(error.localizedDescription)")
            } catch {
                logger.error("Failed to rename corrupt store: \(error.localizedDescription)")
            }
            customTemplates = []
        }
    }

    private func save() {
        let dir = storeURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = StoreFile(templates: customTemplates)
        guard let data = try? AppJSON.encoder.encode(file) else { return }
        try? data.write(to: storeURL, options: .atomic)
    }
}
