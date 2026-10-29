import SwiftUI

/// What Library hands Extensions to build its host: the API client plus the two
/// app-session objects the plugin / MCP / LLM-source loaders read
/// (`ShellState` to clear a selection and bump the dirty token, `BackendManager`
/// for the server API version that gates the one-click update paths).
struct ExtensionsLibraryRequest {
    let api: LlmIdeAPIClient
    let shell: ShellState
    let backend: BackendManager
}

/// The three sidebar sections Extensions contributes to the Library list.
enum ExtensionsLibrarySectionKind: String, CaseIterable {
    case plugins
    case llmSources
    case mcpPlugins
}

/// What Library asks of Extensions' per-sidebar state object. Everything else
/// (loaders, sheets, alerts) stays inside Extensions.
@MainActor
protocol ExtensionsLibraryHost: AnyObject {
    /// Re-run every Extensions loader (the search bar's refresh button).
    func refresh() async
}

/// One sidebar section for the host Library holds. `isExpanded` is the
/// persisted collapse binding Library keeps for every section id, so the
/// chevron and the saved state behave like the sections Library draws itself.
struct ExtensionsLibrarySectionRequest {
    let host: any ExtensionsLibraryHost
    let kind: ExtensionsLibrarySectionKind
    let isExpanded: Binding<Bool>
}

/// Hands Library the plugin / MCP server / LLM source UI without it naming
/// Extensions. Shell installs the makers once at boot
/// (`FeatureCatalog.installFeatureSeams`).
///
/// Contract:
/// - `install(...)`
///   - Pre: main actor.
///   - Post: replaces any previous makers (last install wins); publishes a
///     change so already-mounted `ExtensionsLibrary*View`s re-render.
/// - `makeHost` is nil, `section`/`lifecycle`/`detail` are `EmptyView`s, when
///   nothing is installed — Library then shows no Extensions sections.
@MainActor
final class ExtensionsLibraryRegistry: ObservableObject {
    static let shared = ExtensionsLibraryRegistry()

    @Published private var hostMaker: (@MainActor (ExtensionsLibraryRequest) -> any ExtensionsLibraryHost)?
    @Published private var sectionMaker: (@MainActor (ExtensionsLibrarySectionRequest) -> AnyView)?
    @Published private var lifecycleMaker: (@MainActor (any ExtensionsLibraryHost) -> AnyView)?
    @Published private var detailMaker: (@MainActor (LibrarySelection, LlmIdeAPIClient) -> AnyView?)?

    /// Internal (not private) so tests can use an isolated instance instead
    /// of mutating `shared`, which the running app also reads.
    init() {}

    var isInstalled: Bool { hostMaker != nil }

    func install(host: @escaping @MainActor (ExtensionsLibraryRequest) -> any ExtensionsLibraryHost,
                 section: @escaping @MainActor (ExtensionsLibrarySectionRequest) -> AnyView,
                 lifecycle: @escaping @MainActor (any ExtensionsLibraryHost) -> AnyView,
                 detail: @escaping @MainActor (LibrarySelection, LlmIdeAPIClient) -> AnyView?) {
        hostMaker = host
        sectionMaker = section
        lifecycleMaker = lifecycle
        detailMaker = detail
    }

    func makeHost(_ request: ExtensionsLibraryRequest) -> (any ExtensionsLibraryHost)? {
        hostMaker?(request)
    }

    func section(_ request: ExtensionsLibrarySectionRequest) -> AnyView {
        sectionMaker?(request) ?? AnyView(EmptyView())
    }

    func lifecycle(_ host: any ExtensionsLibraryHost) -> AnyView {
        lifecycleMaker?(host) ?? AnyView(EmptyView())
    }

    /// The detail pane for an Extensions selection (`.plugin`, `.llmSource`,
    /// `.mcpPlugin`), or nil when `selection` is not one of theirs.
    func detail(for selection: LibrarySelection, api: LlmIdeAPIClient) -> AnyView? {
        detailMaker?(selection, api)
    }
}

/// One Extensions sidebar section for a host, as a single view expression so
/// the List keeps its selection tags and `.environmentObject` flows through.
struct ExtensionsLibrarySectionView: View {
    let request: ExtensionsLibrarySectionRequest
    @ObservedObject var registry: ExtensionsLibraryRegistry = .shared

    var body: some View {
        registry.section(request)
    }
}

/// The non-visual half of the Extensions sidebar: first-appearance loads and
/// the reloads the dirty token / update center / server version trigger. Mount
/// it once (`.background`) for the host Library holds.
struct ExtensionsLibraryLifecycleView: View {
    let host: any ExtensionsLibraryHost
    @ObservedObject var registry: ExtensionsLibraryRegistry = .shared

    var body: some View {
        registry.lifecycle(host)
    }
}

/// The detail pane for an Extensions selection; empty when nothing is
/// installed or the selection is not Extensions'.
struct ExtensionsDetailView: View {
    let selection: LibrarySelection
    let api: LlmIdeAPIClient
    @ObservedObject var registry: ExtensionsLibraryRegistry = .shared

    var body: some View {
        if let view = registry.detail(for: selection, api: api) {
            view
        } else {
            EmptyView()
        }
    }
}
