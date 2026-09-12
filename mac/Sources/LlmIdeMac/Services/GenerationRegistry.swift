import Foundation

/// Owns the `GenerationViewModel` for each generation surface, so a running
/// generation outlives the view that started it.
///
/// The bug this fixes: `DocGenView` and `VisualView` each held their view model
/// with `@StateObject private var vm = GenerationViewModel()`. Section switching
/// destroys those views — `AppShell` renders sections from a `switch`, and
/// `FeatureCatalog.docGenPane` hands back a fresh `AnyView(DocGenView(...))`
/// every time — so the model went with them.
///
/// The generation itself did NOT stop. `generate(api:)`'s `Task` captures `self`
/// strongly and nothing cancels it on disappear (there is no `deinit`, no
/// `.onDisappear`, and `cancelGeneration()` is wired only to the Cancel
/// button), so the work ran to completion and wrote its result into a view
/// model nobody was watching any more. Returning to the section then built a
/// BRAND NEW `GenerationViewModel` whose `generationState` was back at its
/// initial value — which is why it read as "generation stopped" while the
/// server had happily finished the job.
///
/// This is the same problem `ChatEngineRegistry` already solves for chat, and
/// the same answer: a registry owns the long-lived object and the view
/// *resolves* it instead of constructing it. See that type's `park` — "Move a
/// mid-turn engine off-screen, still running."
///
/// Holding one model per scope for the life of the app is deliberate, not a
/// leak: there are exactly two, they are the state the user expects to come
/// back to, and dropping an idle one would reintroduce the bug the moment a
/// user switched away mid-generation.
@MainActor
final class GenerationRegistry {
    static let shared = GenerationRegistry()

    /// The surfaces that run a generation. Each keeps its own model, so Doc Gen
    /// and Visual can generate at the same time without sharing state.
    enum Scope: String, CaseIterable, Sendable {
        case docGen
        case visual

        /// The template/command surface this scope's menus show.
        var surface: TemplateSurface {
            switch self {
            case .docGen: return .doc
            case .visual: return .visual
            }
        }
    }

    private var models: [Scope: GenerationViewModel] = [:]

    private init() {}

    /// The model for `scope`, created on first use and returned unchanged
    /// afterwards — including across a view being torn down and rebuilt.
    func model(for scope: Scope) -> GenerationViewModel {
        if let existing = models[scope] { return existing }
        let created = GenerationViewModel(surface: scope.surface)
        models[scope] = created
        return created
    }

    /// Whether a model has been created for `scope` yet. For assertions; no
    /// production caller should need to ask.
    func hasModel(for scope: Scope) -> Bool { models[scope] != nil }

    /// Drops every model. Sign-out only: the next `model(for:)` starts clean,
    /// exactly as a fresh launch would.
    func reset() { models.removeAll() }
}
