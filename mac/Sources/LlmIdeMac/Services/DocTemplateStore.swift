import Foundation
import os.log

private let logger = Logger(subsystem: "com.llmide.macapp", category: "DocTemplateStore")

@MainActor
final class DocTemplateStore: ObservableObject {
    @Published private(set) var customTemplates: [DocTemplate] = []
    @Published private(set) var projectTemplates: [DocTemplate] = []

    /// Project `templates/` when a project is open; otherwise built-ins + app-support customs.
    var templates: [DocTemplate] {
        if currentProjectRoot != nil { return projectTemplates }
        return DocTemplate.builtins + customTemplates
    }

    var hasProjectTemplates: Bool { currentProjectRoot != nil }

    private var currentProjectRoot: URL?

    private var storeURL: URL {
        guard let support = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            return URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("com.llmide.macapp/doc-templates.json")
        }
        return support.appendingPathComponent("com.llmide.macapp/doc-templates.json")
    }

    init() {
        // Disk read deferred until `bootstrap()` is called from the
        // AppShell's first `.task` tick so LlmIdeMacApp.init stays
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

    /// Scan `<project>/templates/*/template.md` and publish project templates.
    func reloadProjectTemplates(at projectRoot: URL?) {
        currentProjectRoot = projectRoot
        guard let root = projectRoot else {
            projectTemplates = []
            return
        }
        projectTemplates = scanProjectTemplates(at: root)
    }

    /// Import an `.md` file as a template. Parses `## ` headings as sections.
    /// When a project is open, writes into `templates/<slug>/template.md`.
    @discardableResult
    func importMarkdownFile(at url: URL) -> DocTemplate? {
        guard let content = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let name = DocTemplate.displayName(
            from: content,
            folderName: url.deletingPathExtension().lastPathComponent)
        if let root = currentProjectRoot {
            let slug = uniqueFolderSlug(base: DocTemplate.slug(for: name), root: root)
            writeProjectTemplate(
                DocTemplate(
                    id: DocTemplate.stableID(forFolder: slug),
                    name: name,
                    sections: DocTemplate.sections(from: content),
                    rawContent: content,
                    folderName: slug,
                    isProjectTemplate: true),
                at: root,
                folderName: slug)
            reloadProjectTemplates(at: root)
            return projectTemplates.first { $0.folderName == slug }
        }
        let template = DocTemplate(
            id: UUID(),
            name: name,
            sections: DocTemplate.sections(from: content),
            rawContent: content,
            isBuiltin: false)
        add(template)
        return template
    }

    @discardableResult
    func add(_ template: DocTemplate) -> DocTemplate {
        if let root = currentProjectRoot {
            let slug = uniqueFolderSlug(
                base: template.folderName ?? DocTemplate.slug(for: template.name),
                root: root)
            writeProjectTemplate(
                DocTemplate(
                    id: DocTemplate.stableID(forFolder: slug),
                    name: template.name,
                    sections: template.sections,
                    rawContent: template.rawContent,
                    folderName: slug,
                    isProjectTemplate: true),
                at: root,
                folderName: slug)
            reloadProjectTemplates(at: root)
            return projectTemplates.first { $0.folderName == slug }
                ?? template
        }
        customTemplates.append(template)
        save()
        return template
    }

    func update(_ template: DocTemplate) {
        if template.isProjectTemplate, let root = currentProjectRoot, let folder = template.folderName {
            writeProjectTemplate(template, at: root, folderName: folder)
            reloadProjectTemplates(at: root)
            return
        }
        guard !template.isBuiltin else { return }
        guard let idx = customTemplates.firstIndex(where: { $0.id == template.id }) else { return }
        customTemplates[idx] = template
        save()
    }

    func delete(id: UUID) {
        if let root = currentProjectRoot,
           let template = projectTemplates.first(where: { $0.id == id }),
           let folder = template.folderName {
            let dir = ProjectLayout(root: root).templateDir(named: folder)
            try? FileManager.default.removeItem(at: dir)
            reloadProjectTemplates(at: root)
            return
        }
        guard !DocTemplate.builtins.contains(where: { $0.id == id }) else { return }
        customTemplates.removeAll { $0.id == id }
        save()
    }

    @discardableResult
    func duplicate(_ template: DocTemplate) -> DocTemplate {
        let copyName = "\(template.name) (copy)"
        if let root = currentProjectRoot {
            let slug = uniqueFolderSlug(base: DocTemplate.slug(for: copyName), root: root)
            let copy = DocTemplate(
                id: DocTemplate.stableID(forFolder: slug),
                name: copyName,
                sections: template.sections,
                rawContent: template.renderedMarkdown(),
                folderName: slug,
                isProjectTemplate: true)
            writeProjectTemplate(copy, at: root, folderName: slug)
            reloadProjectTemplates(at: root)
            return projectTemplates.first { $0.folderName == slug } ?? copy
        }
        let copy = DocTemplate(
            id: UUID(),
            name: copyName,
            sections: template.sections,
            isBuiltin: false)
        add(copy)
        return copy
    }

    // MARK: - Project disk I/O

    private func scanProjectTemplates(at root: URL) -> [DocTemplate] {
        let layout = ProjectLayout(root: root)
        let fm = FileManager.default
        guard fm.fileExists(atPath: layout.templatesDir.path),
              let entries = try? fm.contentsOfDirectory(
                at: layout.templatesDir,
                includingPropertiesForKeys: [.isDirectoryKey],
                options: [.skipsHiddenFiles]) else {
            return []
        }

        var templates: [DocTemplate] = []
        for entry in entries {
            guard (try? entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else {
                continue
            }
            let folderName = entry.lastPathComponent
            guard let mdURL = templateMarkdownURL(in: entry),
                  let content = try? String(contentsOf: mdURL, encoding: .utf8) else {
                continue
            }
            templates.append(DocTemplate(
                id: DocTemplate.stableID(forFolder: folderName),
                name: DocTemplate.displayName(from: content, folderName: folderName),
                sections: DocTemplate.sections(from: content),
                rawContent: content,
                folderName: folderName,
                isProjectTemplate: true))
        }
        return templates.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    private func templateMarkdownURL(in folder: URL) -> URL? {
        let preferred = folder.appendingPathComponent("template.md")
        if FileManager.default.fileExists(atPath: preferred.path) { return preferred }
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: folder,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]) else { return nil }
        return files.first { $0.pathExtension.lowercased() == "md" }
    }

    private func writeProjectTemplate(_ template: DocTemplate, at root: URL, folderName: String) {
        let layout = ProjectLayout(root: root)
        let dir = layout.templateDir(named: folderName)
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            let url = dir.appendingPathComponent("template.md")
            try template.renderedMarkdown().write(to: url, atomically: true, encoding: .utf8)
        } catch {
            logger.error("failed to write project template \(folderName, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
    }

    private func uniqueFolderSlug(base: String, root: URL) -> String {
        let layout = ProjectLayout(root: root)
        let fm = FileManager.default
        var slug = base
        var n = 2
        while fm.fileExists(atPath: layout.templateDir(named: slug).path) {
            slug = "\(base)-\(n)"
            n += 1
        }
        return slug
    }

    // MARK: - App-support persistence (no project open)

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
        do {
            let data = try AppJSON.encoder.encode(file)
            try data.write(to: storeURL, options: .atomic)
        } catch {
            logger.error("failed to save doc templates: \(error.localizedDescription, privacy: .public)")
        }
    }
}
