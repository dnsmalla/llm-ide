import Foundation
import os.log

private let logger = Logger(subsystem: "com.llmide.macapp", category: "DocGenProvider")

/// The app's `GenerationProviding`. It answers from the Doc Gen stores and
/// `GenerationRegistry`, and Shell builds it once at boot, when the stores are
/// created (`FeatureCatalog.provideGenerationStores`).
@MainActor
final class DocGenProvider: GenerationProviding {
    private let templates: DocTemplateStore
    private let commands: DocCommandStore
    /// The server path (docGenUseServerStore), or nil when the app has none.
    private let server: ServerDocFiles?

    init(templates: DocTemplateStore, commands: DocCommandStore, server: ServerDocFiles? = nil) {
        self.templates = templates
        self.commands = commands
        self.server = server
    }

    /// Records the open project for the server path and registers it ahead of
    /// its first call. With the preference off this makes no request.
    func activateProject(id: String, root: URL) {
        guard let server else { return }
        server.activate(projectId: id, root: root)
        server.enqueue { await server.prepare(root) }
    }

    func resetForSignOut() {
        GenerationRegistry.shared.reset()
    }

    func resetForProjectChange() {
        GenerationRegistry.shared.reset()
    }

    func reloadProjectFiles(at projectRoot: URL?) {
        templates.reloadProjectTemplates(at: projectRoot)
        commands.reloadProjectCommands(at: projectRoot)
    }

    func seedProjectFiles(at projectRoot: URL?) {
        guard let root = projectRoot else {
            reloadProjectFiles(at: nil)
            return
        }
        let kit = GenerationLibraryStore.shared
        if let server, let backend = server.backend(for: root) {
            // Ingest templates stay local (app machinery). The Doc Gen files
            // are seeded by the server, queued so the reload that follows
            // sees them.
            IngestTemplateSeeder.seedIfNeeded(at: root)
            server.enqueue {
                do {
                    try await backend.seed(root: root, templateKit: kit.templates, commandKit: kit.commands)
                } catch {
                    logger.error("doc files seed failed: \(error.localizedDescription, privacy: .public)")
                }
            }
        } else {
            Self.seedProjectFiles(at: root, templateKit: kit.templates, commandKit: kit.commands)
        }
        reloadProjectFiles(at: root)
    }

    /// The first-open seeding, with the kit passed in so tests can supply
    /// fixtures. Ingest templates first (app machinery, same as project
    /// activation), then Doc Gen templates and commands. Every write is
    /// `writeIfAbsent`, so a second run changes nothing.
    static func seedProjectFiles(at root: URL,
                                 templateKit: [LlmIdeAPIClient.GenerationLibraryEntry],
                                 commandKit: [LlmIdeAPIClient.GenerationLibraryEntry]) {
        IngestTemplateSeeder.seedIfNeeded(at: root)
        ProjectDocTemplatesSeeder.seedIfNeeded(at: root, kit: templateKit)
        ProjectDocCommandsSeeder.seedIfNeeded(at: root, kit: commandKit)
    }

    func templateRefs(surface: TemplateSurface) -> [GenerationTemplateRef] {
        templates.templates(for: surface).map {
            GenerationTemplateRef(id: $0.id, name: $0.name, sections: $0.sections)
        }
    }

    func commandRefs(surface: TemplateSurface) -> [GenerationCommandRef] {
        commands.commands(for: surface).map {
            GenerationCommandRef(id: $0.id, name: $0.name, instruction: $0.instruction)
        }
    }

    func templateRef(id: String, surface: TemplateSurface) -> GenerationTemplateRef? {
        templateRefs(surface: surface).first { $0.id.uuidString == id }
    }

    func commandRef(id: String, surface: TemplateSurface) -> GenerationCommandRef? {
        commandRefs(surface: surface).first { $0.id.uuidString == id }
    }

    func sourceFitNotice(for result: LlmIdeAPIClient.GeneratedDoc, sentCount: Int) -> String? {
        GenerationViewModel.sourceFitNotice(for: result, sentCount: sentCount)
    }
}
