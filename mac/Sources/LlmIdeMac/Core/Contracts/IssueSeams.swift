import SwiftUI

/// What a feature passes to open Issues' "run against an existing issue"
/// picker (Chat's Quick Fix and guided code-change sheets).
///
/// Lives in Core because Chat may not name Issues, and Issues is
/// build-excludable (`gantt_issues`). The fields mirror the picker's own
/// initializer one-for-one, so a request behaves exactly like constructing
/// the picker at the call site.
struct ExistingIssuePickerRequest {
    let backend: RepoBackend
    let projectId: String
    let displayName: String
    /// False when the backend project isn't resolved yet.
    let isResolved: Bool
    let onSelect: (RepoIssue) -> Void
    let onCancel: () -> Void
}

/// The open issues an agent turn is grounded in (`## Recent open issues`).
/// Issues owns the fetch and its cache; Chat and Mobile Control only read the
/// result, so they go through this protocol instead of naming the resolver.
///
/// Contract:
/// - Pre: main actor (the resolver reads `@MainActor` project state).
/// - `contextIssues`: cache-first — may return what an earlier fetch for the
///   same project already holds. Never throws; an unreachable tracker is `[]`.
/// - `fetch`: ignores the cache and refetches (the Mac panel's own refresh
///   trigger). Never throws; an unreachable tracker is `[]`.
@MainActor
protocol RecentIssuesProviding {
    func contextIssues(config: AppConfig, projectStore: ProjectStore) async -> [AgentContext.RecentIssue]
    func fetch(config: AppConfig, projectStore: ProjectStore) async -> [AgentContext.RecentIssue]
}

/// Hands features Issues' picker view and recent-issues data without them
/// naming Issues. Shell installs both once at boot
/// (`FeatureCatalog.installFeatureSeams`) — only when Issues is compiled in.
///
/// Contract:
/// - `installPicker(_:)` / `installRecentIssues(_:)`
///   - Pre: main actor.
///   - Post: replaces any previous install (last install wins, so a boot path
///     that runs twice cannot stack them); the picker install publishes a
///     change so an already-mounted `ExistingIssuePickerView` re-renders.
/// - `makePicker(_:)`
///   - Post: the installed maker's view for exactly this request, or an
///     `EmptyView` when nothing is installed. Empty — not a visible
///     placeholder — because that is exactly what the picker seam returned
///     when Issues is compiled out, and "not installed" means the same thing.
/// - `recentIssuesContext(…)` / `refreshRecentIssues(…)`
///   - Post: the provider's issues, or `[]` when none is installed — again
///     the compiled-out answer, so a build without Issues grounds turns in no
///     issues rather than failing.
@MainActor
final class IssueSeamRegistry: ObservableObject {
    static let shared = IssueSeamRegistry()

    @Published private var pickerMaker: (@MainActor (ExistingIssuePickerRequest) -> AnyView)?
    // Not @Published: no view renders from the provider; readers call it per turn.
    private var recentIssuesProvider: (any RecentIssuesProviding)?

    /// Internal (not private) so tests can use an isolated instance instead
    /// of mutating `shared`, which the running app also reads.
    init() {}

    var isPickerInstalled: Bool { pickerMaker != nil }
    var isRecentIssuesInstalled: Bool { recentIssuesProvider != nil }

    func installPicker(_ make: @escaping @MainActor (ExistingIssuePickerRequest) -> AnyView) {
        pickerMaker = make
    }

    func installRecentIssues(_ provider: any RecentIssuesProviding) {
        recentIssuesProvider = provider
    }

    func makePicker(_ request: ExistingIssuePickerRequest) -> AnyView {
        guard let pickerMaker else { return AnyView(EmptyView()) }
        return pickerMaker(request)
    }

    func recentIssuesContext(config: AppConfig, projectStore: ProjectStore) async
        -> [AgentContext.RecentIssue]
    {
        guard let recentIssuesProvider else { return [] }
        return await recentIssuesProvider.contextIssues(config: config, projectStore: projectStore)
    }

    @discardableResult
    func refreshRecentIssues(config: AppConfig, projectStore: ProjectStore) async
        -> [AgentContext.RecentIssue]
    {
        guard let recentIssuesProvider else { return [] }
        return await recentIssuesProvider.fetch(config: config, projectStore: projectStore)
    }
}

/// Issues' existing-issue picker for one request, for use inside
/// `.sheet { … }`. Observes the registry so a sheet mounted before Shell's
/// install (never expected, but harmless) picks the real picker up.
struct ExistingIssuePickerView: View {
    let request: ExistingIssuePickerRequest
    @ObservedObject var registry: IssueSeamRegistry = .shared

    var body: some View {
        registry.makePicker(request)
    }
}
