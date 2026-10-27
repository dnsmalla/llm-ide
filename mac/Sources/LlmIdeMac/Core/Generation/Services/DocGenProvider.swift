import Foundation

/// The app's `GenerationProviding`. It answers from the Doc Gen stores and
/// `GenerationRegistry`, and Shell builds it once at boot, when the stores are
/// created (`FeatureCatalog.provideGenerationStores`).
@MainActor
final class DocGenProvider: GenerationProviding {
    private let templates: DocTemplateStore
    private let commands: DocCommandStore

    init(templates: DocTemplateStore, commands: DocCommandStore) {
        self.templates = templates
        self.commands = commands
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
