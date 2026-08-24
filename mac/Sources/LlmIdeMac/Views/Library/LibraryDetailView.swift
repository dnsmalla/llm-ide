import SwiftUI

/// Routes the Library section's detail column.
///
/// - Meeting selected     → MeetingDetailView (summary + transcript)
/// - File selected        → FileDetailView
/// - Plugin selected      → PluginDetailView
/// - LLM source selected  → LlmSourceDetailView
/// - MCP plugin selected  → McpPluginDetailView
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
            FileDetailView(url: url)

        case .plugin(let name):
            PluginDetailView(api: api, pluginName: name)

        case .llmSource(let id):
            LlmSourceDetailView(api: api, sourceId: id)

        case .mcpPlugin(let id):
            McpPluginDetailView(api: api, pluginId: id)

        case .connector(let id):
            ConnectorDetailView(api: api, connectorId: id)

        case .emailTodos:
            EmailTodosView()

        case nil:
            ContentUnavailableView {
                Label("Select an Item", systemImage: "doc.text")
            } description: {
                Text("Choose a meeting, file, plugin, or LLM source from the list.")
            }
        }
    }
}
