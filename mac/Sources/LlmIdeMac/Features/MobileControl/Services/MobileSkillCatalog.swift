import Foundation
import SharedProtocol

/// Loads and searches the Mac agent skill catalog for iPhone Explore (`/skill`).
@MainActor
enum MobileSkillCatalog {

    nonisolated static let defaultLimit = 40

    /// Fetch the full skill catalog from the Mac backend (for index persistence).
    static func buildEntries(api: LlmIdeAPIClient) async -> [ExploreSkillEntry] {
        async let libraryTask = try? api.skillLibrary()
        async let catalogTask = try? api.listAgentSkillCatalog()
        let library = await libraryTask ?? []
        let catalog = await catalogTask
        var entries: [ExploreSkillEntry] = []

        for s in library {
            entries.append(ExploreSkillEntry(
                id: s.id, name: s.name,
                description: "\(s.family) · \(s.description)",
                kind: "library", directive: nil))
        }
        if let catalog {
            let groups = catalog.skills.global + catalog.skills.internal
            for s in groups {
                entries.append(ExploreSkillEntry(
                    id: "skill:\(s.name)", name: s.name, description: s.description,
                    kind: "builtin", directive: "Use the \(s.name) skill:"))
            }
            for g in catalog.skills.plugins {
                for s in g.skills {
                    entries.append(ExploreSkillEntry(
                        id: "skill:\(g.pluginName):\(s.name)", name: s.name,
                        description: s.description, kind: "builtin",
                        directive: "Use the \(s.name) skill:"))
                }
            }
            for g in catalog.subagents.plugins {
                for s in g.subagents {
                    entries.append(ExploreSkillEntry(
                        id: "sub:\(g.pluginName):\(s.name)", name: s.name,
                        description: s.description, kind: "subagent",
                        directive: "Use the \(s.name) subagent:"))
                }
            }
        }
        entries.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        return entries
    }

    /// Split selected skills into library ids (server channel) and directive prefixes.
    static func resolveMessage(_ text: String, skills: [ExploreSkillRef]) -> (message: String, skillIds: [String]) {
        let directives = skills.filter { $0.kind == "directive" }.compactMap(\.directive)
        let skillIds = skills.filter { $0.kind == "library" }.map(\.id)
        var message = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !directives.isEmpty {
            let prefix = directives.joined(separator: "\n")
            message = message.isEmpty ? prefix : prefix + "\n\n" + message
        }
        return (message, skillIds)
    }
}
