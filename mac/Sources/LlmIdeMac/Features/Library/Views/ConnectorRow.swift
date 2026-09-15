import SwiftUI

/// Sidebar row for one selected connector in the Library's Connectors
/// section. Mirrors `McpPluginRow`'s shape minus the inline toggles: a
/// connector has no per-user gates to flip here — selection *is* the state,
/// and Remove lives in the section's context menu like `LlmSourceRow`'s does.
///
/// `pipelineReady == false` means the fetch→folder→llm-doc pipeline for this
/// connector doesn't exist yet (phase 1: gdrive/gcal/miro), so the row says so
/// rather than letting a selected-but-inert connector look fully wired.
struct ConnectorRow: View {
    @EnvironmentObject private var theme: ThemeStore
    let entry: ConnectorCatalogEntry

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: entry.icon)
                .foregroundStyle(entry.pipelineReady ? theme.current.info : Color.secondary)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                Text(entry.name).font(.callout).lineLimit(1)
                Text(entry.pipelineReady ? entry.authKind : "Pipeline coming soon")
                    .font(.caption2)
                    .foregroundStyle(entry.pipelineReady ? Color.secondary : theme.current.warning)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
    }
}
