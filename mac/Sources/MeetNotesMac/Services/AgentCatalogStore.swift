import Foundation
import Observation

/// Holds the skill + subagent catalog fetched from `/kb/agent/catalog`.
///
/// Injected into the SwiftUI environment at the AppShell level so both
/// LibraryView (sidebar) and LibraryDetailView (detail column) share the
/// same catalog without independent network calls or prop-drilling.
///
/// LibraryView calls `load(api:)` when it appears; LibraryDetailView
/// reads `catalog` directly.
@MainActor
@Observable
final class AgentCatalogStore {
    private(set) var catalog: MeetNotesAPIClient.AgentSkillCatalog?
    private(set) var isLoading = false

    /// Fetch (or re-fetch) the catalog.  Errors are swallowed — callers
    /// degrade gracefully when `catalog` is nil.
    func load(api: MeetNotesAPIClient) async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        catalog = try? await api.listAgentSkillCatalog()
    }
}
