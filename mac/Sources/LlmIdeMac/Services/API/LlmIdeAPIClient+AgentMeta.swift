import Foundation

// Chat-input autocomplete + project-memory viewer endpoints.
//   GET    /kb/agent/commands           → enabled slash-commands ("/" menu)
//   GET    /kb/agent/project-memory      → auto-captured facts for a repo
//   DELETE /kb/agent/project-memory      → remove one fact / clear all
// (Skills for the "/" menu reuse the existing /kb/agent/catalog →
//  listAgentSkillCatalog in LlmIdeAPIClient+Agent.swift.)
extension LlmIdeAPIClient {

    // MARK: Slash-command catalog

    struct AgentCommand: Decodable, Identifiable, Equatable {
        struct Arg: Decodable, Equatable { let name: String; let required: Bool }
        let trigger: String
        let description: String
        let args: [Arg]
        let pluginName: String?
        var id: String { trigger }
    }
    private struct AgentCommandsResponse: Decodable { let commands: [AgentCommand] }

    /// Enabled slash-commands for the current user. Fails gracefully — the
    /// caller treats an error as "no commands" rather than surfacing it.
    func listAgentCommands() async throws -> [AgentCommand] {
        let resp: AgentCommandsResponse = try await get("/kb/agent/commands", authenticated: true)
        return resp.commands
    }

    // MARK: Project memory (auto-captured chat facts)

    private struct ProjectMemoryResponse: Decodable { let facts: [String]; let repo: String? }
    private struct DeleteMemoryBody: Encodable { let repo: String; let fact: String?; let all: Bool? }

    /// Percent-encode a repo path for a query value without letting `&`/`=`/`#`
    /// leak through and corrupt the query string.
    private func encodeRepo(_ repo: String) -> String {
        let allowed = CharacterSet.urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+?#"))
        return repo.addingPercentEncoding(withAllowedCharacters: allowed) ?? repo
    }

    /// Auto-captured chat-memory facts for the active project. Sends the
    /// client's indexedRepos candidate paths; the server resolves the first
    /// allow-listed one (matching the agent's write target) and returns its
    /// facts plus the resolved absolute root to target subsequent deletes.
    func projectMemory(repos: [String]) async throws -> (facts: [String], repo: String?) {
        let query = repos.map { "repo=\(encodeRepo($0))" }.joined(separator: "&")
        let resp: ProjectMemoryResponse = try await get(
            "/kb/agent/project-memory?\(query)", authenticated: true)
        return (resp.facts, resp.repo)
    }

    /// Remove one captured fact; returns the remaining facts.
    func deleteProjectMemoryFact(repo: String, fact: String) async throws -> [String] {
        let resp: ProjectMemoryResponse = try await send(
            path: "/kb/agent/project-memory", method: "DELETE",
            body: DeleteMemoryBody(repo: repo, fact: fact, all: nil), authenticated: true)
        return resp.facts
    }

    /// Clear all captured facts for a repo; returns [].
    @discardableResult
    func clearProjectMemory(repo: String) async throws -> [String] {
        let resp: ProjectMemoryResponse = try await send(
            path: "/kb/agent/project-memory", method: "DELETE",
            body: DeleteMemoryBody(repo: repo, fact: nil, all: true), authenticated: true)
        return resp.facts
    }
}
