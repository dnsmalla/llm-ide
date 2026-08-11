import SwiftUI

/// Routes the Library section's detail column.
///
/// - Meeting selected       → MeetingDetailView (summary + transcript)
/// - File selected          → FileDetailView
/// - Plugin selected        → PluginDetailView
/// - Skills source selected → SkillsSourceDetailView
/// - Nothing selected       → placeholder
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

        case .skillsSource(let id):
            SkillsSourceDetailView(api: api, sourceId: id)

        case nil:
            ContentUnavailableView {
                Label("Select an Item", systemImage: "doc.text")
            } description: {
                Text("Choose a meeting, file, plugin, or skills source from the list.")
            }
        }
    }
}
