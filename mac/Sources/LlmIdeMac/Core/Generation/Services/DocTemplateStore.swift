import Foundation
import os.log

private let logger = Logger(subsystem: "com.llmide.macapp", category: "DocTemplateStore")

@MainActor
final class DocTemplateStore: ObservableObject {
    @Published private(set) var customTemplates: [DocTemplate] = []
    @Published private(set) var projectTemplates: [DocTemplate] = []

    /// Project `templates/` when a project is open; otherwise the kit's
    /// defaults + app-support customs.
    ///
    /// With no project there is no `templates/` folder to scan, so the
    /// fallback comes straight from `GenerationLibraryStore` — the same kit
    /// entries a project would have been seeded with, served from its disk
    /// cache when the backend is not up. `DocTemplate.builtins` used to fill
    /// this and is now empty: keeping an app-local copy of the kit's defaults
    /// is the duplication that moving them to the kit removes.
    var templates: [DocTemplate] {
        if currentProjectRoot != nil { return projectTemplates }
        return kitTemplates + customTemplates
    }

    /// The kit's templates as `DocTemplate`s, for the no-project surface.
    private var kitTemplates: [DocTemplate] {
        GenerationLibraryStore.shared.templates.compactMap { entry in
            let folder = entry.folderName
            guard !folder.isEmpty else { return nil }
            let markdown = ProjectDocTemplatesSeeder.projectMarkdown(for: entry)
            return DocTemplate(
                id: DocTemplate.stableID(forFolder: folder),
                name: DocTemplate.displayName(from: markdown, folderName: folder),
                sections: DocTemplate.sections(from: markdown),
                rawContent: markdown,
                isBuiltin: true,
                folderName: folder,
                surface: entry.templateSurface)
        }
    }

    var hasProjectTemplates: Bool { currentProjectRoot != nil }

    /// Templates belonging to one generation menu.
    ///
    /// Doc Gen and Visual share this store and the project's one `templates/`
    /// folder, so before surfaces existed each menu listed everything the
    /// other had — Visual offered "Sprint Review", Doc Gen would have offered
    /// "Screenshot Review". Filtering happens here rather than in the view so
    /// both menus and the manager sheet read one rule.
    func templates(for surface: TemplateSurface) -> [DocTemplate] {
        templates.filter { $0.surface == surface }
    }

    private var currentProjectRoot: URL?

    /// The server path (docGenUseServerStore), attached by `FeatureCatalog`.
    /// `server.backend(for:)` is nil unless the preference is on and `root` is
    /// the active project, so every method below takes its local path then.
    private var server: ServerDocFiles?

    /// Attaches the server path. Nothing changes until the preference is on
    /// and a project is open.
    func attachServer(_ server: ServerDocFiles) {
        self.server = server
    }

    /// Test seam: lets a test point the app-support store at a temp file.
    /// Production passes nothing and gets the Application Support path.
    private let storeURLOverride: URL?

    private var storeURL: URL {
        if let override = storeURLOverride { return override }
        guard let support = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            return URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("com.llmide.macapp/doc-templates.json")
        }
        return support.appendingPathComponent("com.llmide.macapp/doc-templates.json")
    }

    /// Set when a damaged store file could not be moved aside. The file is
    /// then the only copy of the user's templates, so `save()` is blocked for
    /// the rest of this run rather than overwriting it.
    private var saveBlocked = false

    /// Clock for the quarantine file name. Tests inject a fixed date.
    private let now: () -> Date

    init(storeURL: URL? = nil, now: @escaping () -> Date = { Date() }) {
        self.storeURLOverride = storeURL
        self.now = now
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
        refreshFromServer(at: root)
    }

    /// Import an `.md` file as a template. Parses `## ` headings as sections.
    /// When a project is open, writes into `templates/<slug>/template.md`.
    @discardableResult
    func importMarkdownFile(at url: URL, surface: TemplateSurface = .default) -> DocTemplate? {
        guard let raw = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        // Stamp the surface into the file being imported. The raw content is
        // what gets written, so without this an import into the Visual menu
        // would come back as a Doc Gen template on the next rescan and vanish
        // from the menu it was imported into.
        let content = TemplateSurfaceMarker.ensure(
            in: raw, base: DocTemplate.markerComment, surface: surface)
        let name = DocTemplate.displayName(
            from: content,
            folderName: url.deletingPathExtension().lastPathComponent)
        if let root = currentProjectRoot {
            let slug = uniqueFolderSlug(base: DocTemplate.slug(for: name), root: root)
            persistProjectTemplate(
                DocTemplate(
                    id: DocTemplate.stableID(forFolder: slug),
                    name: name,
                    sections: DocTemplate.sections(from: content),
                    rawContent: content,
                    folderName: slug,
                    isProjectTemplate: true,
                    surface: surface),
                at: root,
                folderName: slug)
            return projectTemplates.first { $0.folderName == slug }
        }
        let template = DocTemplate(
            id: UUID(),
            name: name,
            sections: DocTemplate.sections(from: content),
            rawContent: content,
            isBuiltin: false,
            surface: surface)
        add(template)
        return template
    }

    @discardableResult
    func add(_ template: DocTemplate) -> DocTemplate {
        if let root = currentProjectRoot {
            let slug = uniqueFolderSlug(
                base: template.folderName ?? DocTemplate.slug(for: template.name),
                root: root)
            persistProjectTemplate(
                DocTemplate(
                    id: DocTemplate.stableID(forFolder: slug),
                    name: template.name,
                    sections: template.sections,
                    rawContent: template.rawContent,
                    folderName: slug,
                    isProjectTemplate: true,
                    surface: template.surface),
                at: root,
                folderName: slug)
            return projectTemplates.first { $0.folderName == slug }
                ?? template
        }
        customTemplates.append(template)
        save()
        return template
    }

    func update(_ template: DocTemplate) {
        if template.isProjectTemplate, let root = currentProjectRoot, let folder = template.folderName {
            persistProjectTemplate(template, at: root, folderName: folder)
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
            if let server, let backend = server.backend(for: root) {
                projectTemplates.removeAll { $0.id == id }
                enqueueServerWrite(root, server: server) {
                    try await backend.deleteTemplate(folderName: folder, root: root)
                }
                return
            }
            let dir = ProjectLayout(root: root).templateDir(named: folder)
            try? FileManager.default.removeItem(at: dir)
            reloadProjectTemplates(at: root)
            return
        }
        guard !DocTemplate.builtins.contains(where: { $0.id == id }) else { return }
        customTemplates.removeAll { $0.id == id }
        save()
    }

    // MARK: - Project disk I/O

    private func scanProjectTemplates(at root: URL) -> [DocTemplate] {
        LocalDocFiles.scanTemplates(at: root)
    }

    private func writeProjectTemplate(_ template: DocTemplate, at root: URL, folderName: String) {
        do {
            try LocalDocFiles.writeTemplate(template, at: root, folderName: folderName)
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

    // MARK: - Server path (docGenUseServerStore)

    /// Writes one project template. With the server serving the root, the list
    /// is updated at once and the write is queued; otherwise the local write
    /// and rescan run as they always have.
    private func persistProjectTemplate(_ template: DocTemplate, at root: URL, folderName: String) {
        guard let server, let backend = server.backend(for: root) else {
            writeProjectTemplate(template, at: root, folderName: folderName)
            reloadProjectTemplates(at: root)
            return
        }
        upsertProjectTemplate(template)
        enqueueServerWrite(root, server: server) {
            try await backend.saveTemplate(template, folderName: folderName, root: root)
        }
    }

    private func upsertProjectTemplate(_ template: DocTemplate) {
        var next = projectTemplates.filter { $0.folderName != template.folderName }
        next.append(template)
        projectTemplates = next.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    /// Queues one server write and then a list, so the published templates end
    /// up as the server holds them. A write that the server cannot take is
    /// written locally by the fallback inside `DocFilesWithFallback`.
    private func enqueueServerWrite(_ root: URL, server: ServerDocFiles,
                                    _ write: @escaping @MainActor () async throws -> Void) {
        server.enqueue { [weak self] in
            do {
                try await write()
            } catch {
                logger.error("doc template write failed: \(error.localizedDescription, privacy: .public)")
            }
            self?.refreshFromServer(at: root)
        }
    }

    /// Replaces the published templates with the server's list for `root`,
    /// unless the project has changed in the meantime.
    private func refreshFromServer(at root: URL) {
        guard let server, let backend = server.backend(for: root) else { return }
        server.enqueue { [weak self] in
            guard let list = try? await backend.listTemplates(root: root) else { return }
            guard let self, self.currentProjectRoot?.path == root.path else { return }
            self.projectTemplates = list
        }
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
            do {
                let aside = try DamagedFileQuarantine.setAside(storeURL, now: now())
                logger.warning("Corrupt store moved to \(aside.lastPathComponent, privacy: .public): \(error.localizedDescription, privacy: .public)")
            } catch let moveError {
                saveBlocked = true
                logger.error("Corrupt store could not be moved aside, so saving is blocked: \(moveError.localizedDescription, privacy: .public)")
            }
            customTemplates = []
        }
    }

    private func save() {
        guard !saveBlocked else {
            logger.error("doc templates not saved: the damaged store file is still in place")
            return
        }
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
