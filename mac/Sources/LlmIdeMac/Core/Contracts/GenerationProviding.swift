import Foundation

/// What Core and the other kits need from Doc Gen and Visual, expressed without
/// naming docs-kit types. Callers are the session and project lifecycle
/// (`SessionStore`, `AppShell`), the project folders panel (`ProjectPathsPanel`)
/// and the phone bridge (`MobileGenerationBridge`).
///
/// Shell installs the concrete `DocGenProvider` at boot
/// (`FeatureCatalog.provideGenerationStores`). Core/Generation is always
/// compiled, so the provider is installed in every build; only the views and
/// the phone bridge are build-excludable.
@MainActor
protocol GenerationProviding: AnyObject {
    /// Sign-out or account change: drop every in-memory generation model.
    /// A running generation is cancelled, not left writing into a dead model.
    func resetForSignOut()

    /// Project switch or close: drop generation state that belongs to the
    /// previous project (its document, sources and template selection).
    func resetForProjectChange()

    /// Re-read the active project's template and command folders. `nil` clears
    /// them (no project open).
    func reloadProjectFiles(at projectRoot: URL?)

    /// Templates offered for `surface` to the phone.
    func templateRefs(surface: TemplateSurface) -> [GenerationTemplateRef]

    /// Commands offered for `surface` to the phone.
    func commandRefs(surface: TemplateSurface) -> [GenerationCommandRef]

    /// The template with this id (as its `uuidString`) on `surface`, if any.
    func templateRef(id: String, surface: TemplateSurface) -> GenerationTemplateRef?

    /// The command with this id (as its `uuidString`) on `surface`, if any.
    func commandRef(id: String, surface: TemplateSurface) -> GenerationCommandRef?

    /// The "the server could not fit every source" line for a finished
    /// generation, or `nil` when everything fit.
    func sourceFitNotice(for result: LlmIdeAPIClient.GeneratedDoc, sentCount: Int) -> String?
}

/// A template as the generation flow needs it: its name and section headings.
struct GenerationTemplateRef: Sendable, Equatable {
    let id: UUID
    let name: String
    let sections: [String]

    init(id: UUID, name: String, sections: [String]) {
        self.id = id
        self.name = name
        self.sections = sections
    }
}

/// A command as the generation flow needs it: its name and instruction text.
struct GenerationCommandRef: Sendable, Equatable {
    let id: UUID
    let name: String
    let instruction: String

    init(id: UUID, name: String, instruction: String) {
        self.id = id
        self.name = name
        self.instruction = instruction
    }
}

/// Holds the installed `GenerationProviding`. Core callers ask it; they never
/// name the Doc Gen types. `provider` is `nil` until Shell installs one, and
/// stays `nil` after `uninstall()`, so every caller must treat it as optional.
@MainActor
final class GenerationProviderRegistry {
    static let shared = GenerationProviderRegistry()

    private(set) var provider: (any GenerationProviding)?

    init() {}

    /// Makes `provider` the active one, replacing any earlier install.
    func install(_ provider: any GenerationProviding) {
        self.provider = provider
    }

    /// Removes the active provider. Used by tests and by teardown.
    func uninstall() {
        provider = nil
    }
}
