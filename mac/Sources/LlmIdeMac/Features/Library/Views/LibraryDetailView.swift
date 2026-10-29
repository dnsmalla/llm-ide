import SwiftUI

/// Routes the Library section's detail column.
///
/// - Meeting selected     → MeetingDetailView (summary + transcript)
/// - File selected        → FileDetailView
/// - Plugin / LLM source / MCP plugin selected → Extensions' detail pane
///   (`ExtensionsDetailView`)
/// - Connector selected   → ConnectorDetailView
/// - Nothing selected     → placeholder
struct LibraryDetailView: View {
    let api: LlmIdeAPIClient
    @Environment(ShellState.self) private var shell

    var body: some View {
        switch shell.librarySelection {
        case .meeting:
            MeetingDetailView(api: api)

        case .file(let url):
            FileDetailView(url: url) {
                shell.librarySelection = nil
            }

        case .plugin, .llmSource, .mcpPlugin:
            // Plugins, LLM sources and MCP servers are Extensions' screens,
            // reached through its detail seam (it applies the per-item `.id`).
            if let selection = shell.librarySelection {
                ExtensionsDetailView(selection: selection, api: api)
            }

        case .connector(let id):
            ConnectorDetailView(api: api, connectorId: id)
                .id(id)

        case nil:
            ContentUnavailableView {
                Label("Select an Item", systemImage: "doc.text")
            } description: {
                Text("Choose a meeting, file, plugin, or LLM source from the list.")
            }
        }
    }
}
