import SwiftUI

/// Routes the Library section's detail column.
///
/// - Meeting selected       → MeetingDetailView (summary + transcript)
/// - File selected          → FileDetailView
/// - Agent (persona)        → AgentDetailView  (editable)
/// - Built-in agent         → BuiltinAgentDetailView (read-only, locked)
/// - Skill selected         → SkillDetailView (read-only, locked)
/// - Plugin selected        → PluginDetailView
/// - Nothing selected       → placeholder
struct LibraryDetailView: View {
    let api: MeetNotesAPIClient
    @Environment(ShellState.self)      private var shell
    @Environment(AgentCatalogStore.self) private var catalogStore

    var body: some View {
        switch shell.librarySelection {
        case .meeting:
            MeetingDetailView(api: api)

        case .file(let url):
            FileDetailView(url: url)

        case .agent(let id):
            AgentDetailView(api: api, personaId: id)

        case .builtinAgent(let id):
            BuiltinAgentDetailView(agentId: id)

        case .skill(let name):
            skillDetailView(name: name)

        case .plugin(let name):
            PluginDetailView(api: api, pluginName: name)

        case nil:
            ContentUnavailableView {
                Label("Select an Item", systemImage: "doc.text")
            } description: {
                Text("Choose a meeting, file, agent, skill or plugin from the list.")
            }
        }
    }

    // MARK: - Skill routing

    @ViewBuilder
    private func skillDetailView(name: String) -> some View {
        let cat = catalogStore.catalog
        if let cat {
            if let entry = cat.skills.global.first(where: { $0.name == name }) {
                SkillDetailView(skill: entry, pluginName: nil, sourceName: "Global Tool")
            } else if let entry = cat.skills.internal.first(where: { $0.name == name }) {
                SkillDetailView(skill: entry, pluginName: nil, sourceName: "Core Skill")
            } else if let (group, entry) = pluginSkill(name: name, catalog: cat) {
                SkillDetailView(skill: entry,
                                pluginName: group.pluginName,
                                sourceName: group.pluginDisplayName)
            } else {
                unknownSkillView(name: name)
            }
        } else {
            unknownSkillView(name: name)
        }
    }

    private func pluginSkill(
        name: String,
        catalog: MeetNotesAPIClient.AgentSkillCatalog
    ) -> (MeetNotesAPIClient.PluginSkillGroup, MeetNotesAPIClient.SkillEntry)? {
        for group in catalog.skills.plugins {
            if let entry = group.skills.first(where: { $0.name == name }) {
                return (group, entry)
            }
        }
        return nil
    }

    private func unknownSkillView(name: String) -> some View {
        ContentUnavailableView {
            Label("Skill not found", systemImage: "questionmark.circle")
        } description: {
            Text("\"\(name)\" could not be located in the skill catalog.")
        }
    }
}
