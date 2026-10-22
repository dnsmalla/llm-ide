import SwiftUI

/// What Chat's Code Assistant panel passes to show Explorer's project memory
/// viewer as a sheet.
///
/// Lives in Core because Chat may not name Explorer, and Explorer is
/// build-excludable (`file_explorer`). The fields mirror the viewer's own
/// initializer one-for-one.
struct ProjectMemoryRequest {
    let api: LlmIdeAPIClient
    /// Candidate repo paths ("~/…"); empty = no project.
    let repos: [String]
    /// The open Explorer folder ("~/…"), if any.
    let workspaceRoot: String?
    /// The chat the viewer was opened from (its session-store UUID), if any.
    let sessionId: String?
}

/// Hands features Explorer's project memory viewer without them naming
/// Explorer. Shell installs the maker once at boot
/// (`FeatureCatalog.installFeatureSeams`) — only when Explorer is compiled in.
///
/// Contract:
/// - `install(_:)`
///   - Pre: main actor.
///   - Post: replaces any previous maker (last install wins); publishes a
///     change so an already-mounted `ProjectMemorySectionView` re-renders.
/// - `make(_:)`
///   - Post: the installed maker's view for exactly this request, or an
///     `EmptyView` when nothing is installed — the same empty sheet the panel
///     showed when Explorer is compiled out.
@MainActor
final class ProjectMemoryRegistry: ObservableObject {
    static let shared = ProjectMemoryRegistry()

    @Published private var maker: (@MainActor (ProjectMemoryRequest) -> AnyView)?

    /// Internal (not private) so tests can use an isolated instance instead
    /// of mutating `shared`, which the running app also reads.
    init() {}

    var isInstalled: Bool { maker != nil }

    func install(_ make: @escaping @MainActor (ProjectMemoryRequest) -> AnyView) {
        maker = make
    }

    func make(_ request: ProjectMemoryRequest) -> AnyView {
        guard let maker else { return AnyView(EmptyView()) }
        return maker(request)
    }
}

/// Explorer's project memory viewer for one request, as a single view
/// expression so the caller keeps its modifiers (`.environmentObject`).
struct ProjectMemorySectionView: View {
    let request: ProjectMemoryRequest
    @ObservedObject var registry: ProjectMemoryRegistry = .shared

    var body: some View {
        registry.make(request)
    }
}
