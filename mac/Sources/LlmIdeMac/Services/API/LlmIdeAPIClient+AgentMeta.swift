import Foundation

// Chat-input autocomplete + project-memory viewer endpoints.
//   GET    /kb/agent/commands           → enabled slash-commands ("/" menu)
//   GET    /kb/agent/project-memory      → auto-captured facts for a repo
//   DELETE /kb/agent/project-memory      → remove one fact / clear all
//   GET    /kb/agent/tool-approvals      → standing "Always Allow" grants
//   DELETE /kb/agent/tool-approvals      → revoke one grant / all of them
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

    // MARK: Central skills-repo catalog (discovery)

    struct SkillLibraryEntry: Decodable, Identifiable, Equatable {
        let id: String          // "<family>/<dir>"
        let family: String      // "skills" | "runtime"
        let name: String
        let description: String
        let path: String        // absolute SKILL.md path (attached as context on select)
        let sourceId: String
        let sourceName: String

        enum CodingKeys: String, CodingKey {
            case id, family, name, description, path, sourceId, sourceName
        }
        /// `sourceId`/`sourceName` are new fields (multi-source LLM-sources
        /// feature) — decoded with fallbacks so a pre-upgrade server response
        /// still decodes, mirroring `PluginInfo.subagents`'s back-compat pattern.
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.id          = try c.decode(String.self, forKey: .id)
            self.family      = try c.decode(String.self, forKey: .family)
            self.name        = try c.decode(String.self, forKey: .name)
            self.description = try c.decode(String.self, forKey: .description)
            self.path        = try c.decode(String.self, forKey: .path)
            self.sourceId    = try c.decodeIfPresent(String.self, forKey: .sourceId) ?? "builtin"
            self.sourceName  = try c.decodeIfPresent(String.self, forKey: .sourceName) ?? ""
        }
    }
    private struct SkillLibraryResponse: Decodable { let repo: String?; let skills: [SkillLibraryEntry] }

    /// The central skills repo's discovery catalog (the skills the IDE agent
    /// doesn't itself load). Fails gracefully → [].
    func skillLibrary() async throws -> [SkillLibraryEntry] {
        let resp: SkillLibraryResponse = try await get("/kb/agent/skill-library", authenticated: true)
        return resp.skills
    }

    // MARK: Project memory (auto-captured chat facts)

    private struct ProjectMemoryResponse: Decodable { let facts: [String]; let repo: String? }
    private struct DeleteMemoryBody: Encodable { let repo: String; let fact: String?; let all: Bool?; let workspaceRoot: String? }

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
    func projectMemory(repos: [String], workspaceRoot: String? = nil) async throws -> (facts: [String], repo: String?) {
        var parts = repos.map { "repo=\(encodeRepo($0))" }
        if let ws = workspaceRoot, !ws.isEmpty { parts.append("workspaceRoot=\(encodeRepo(ws))") }
        let query = parts.joined(separator: "&")
        let resp: ProjectMemoryResponse = try await get(
            "/kb/agent/project-memory?\(query)", authenticated: true)
        return (resp.facts, resp.repo)
    }

    /// Remove one captured fact; returns the remaining facts. `workspaceRoot`
    /// lets the server re-allow the open folder when memory resolved to it.
    func deleteProjectMemoryFact(repo: String, fact: String, workspaceRoot: String? = nil) async throws -> [String] {
        let resp: ProjectMemoryResponse = try await send(
            path: "/kb/agent/project-memory", method: "DELETE",
            body: DeleteMemoryBody(repo: repo, fact: fact, all: nil, workspaceRoot: workspaceRoot), authenticated: true)
        return resp.facts
    }

    /// Clear all captured facts for a repo; returns [].
    @discardableResult
    func clearProjectMemory(repo: String, workspaceRoot: String? = nil) async throws -> [String] {
        let resp: ProjectMemoryResponse = try await send(
            path: "/kb/agent/project-memory", method: "DELETE",
            body: DeleteMemoryBody(repo: repo, fact: nil, all: true, workspaceRoot: workspaceRoot), authenticated: true)
        return resp.facts
    }

    // MARK: Standing "Always Allow" tool grants

    /// One standing per-(user, tool) grant from the act-tool approval card.
    /// `grantedAt` is kept as the server's raw ISO-8601 string rather than a
    /// `Date`: the display format belongs to the view, and the untouched
    /// string is what a later revoke is matched against server-side.
    struct ToolApproval: Decodable, Identifiable, Equatable {
        let toolName: String
        let grantedAt: String
        /// The grant is keyed per-(user, tool), so the tool name IS the identity.
        var id: String { toolName }
    }
    private struct ToolApprovalsResponse: Decodable { let approvals: [ToolApproval] }
    private struct RevokeToolApprovalBody: Encodable { let toolName: String?; let all: Bool? }

    /// The user's standing "Always Allow" grants, newest first. An empty array
    /// is the expected, healthy case — nothing has been permanently allowed.
    func toolApprovals() async throws -> [ToolApproval] {
        let resp: ToolApprovalsResponse = try await get("/kb/agent/tool-approvals", authenticated: true)
        return resp.approvals
    }

    /// Revoke one standing grant. Returns the remaining grants so the caller
    /// re-renders from the server's own view instead of a follow-up GET (which
    /// could interleave with another surface's revoke and show a stale list).
    func revokeToolApproval(toolName: String) async throws -> [ToolApproval] {
        let resp: ToolApprovalsResponse = try await send(
            path: "/kb/agent/tool-approvals", method: "DELETE",
            body: RevokeToolApprovalBody(toolName: toolName, all: nil), authenticated: true)
        return resp.approvals
    }

    /// Revoke every standing grant; returns [] (the remaining grants).
    @discardableResult
    func revokeAllToolApprovals() async throws -> [ToolApproval] {
        let resp: ToolApprovalsResponse = try await send(
            path: "/kb/agent/tool-approvals", method: "DELETE",
            body: RevokeToolApprovalBody(toolName: nil, all: true), authenticated: true)
        return resp.approvals
    }

    private struct ForgetSessionMemoryBody: Encodable {
        let sessionId: String
    }
    private struct ForgetSessionMemoryResponse: Decodable {
        let removed: Int
    }
    private struct SessionMemoryResponse: Decodable {
        let facts: [String]
    }

    /// What one chat's session memory holds (kb/session-memory.mjs): the
    /// conversation-state sentences captured after each turn plus the project
    /// facts that chat taught. Read-only — session facts are not edited one
    /// by one; they are forgotten together via `forgetSessionMemory`.
    func sessionMemory(sessionId: String) async throws -> [String] {
        let resp: SessionMemoryResponse = try await get(
            "/kb/agent/session-memory?sessionId=\(encodeRepo(sessionId))", authenticated: true)
        return resp.facts
    }

    /// Delete everything session memory captured for one chat session — a
    /// real DB delete (kb/session-memory.mjs), called when that chat is
    /// cleared or deleted so its memory doesn't outlive it. NOT the same
    /// store as project memory (chat-memory.md, above): project memory is
    /// durable and never touched by a session's lifecycle, only its own
    /// explicit per-fact edit/delete. Returns how many facts were dropped.
    ///
    /// Deliberately NOT auto-retried here. `send()` retries GETs only, because
    /// re-issuing a DELETE can double-apply a side effect — and a retry would
    /// not buy anything anyway: this path uses the `llmSession` 2-hour timeout,
    /// so a slow backend never throws (it hangs, and retrying would triple the
    /// stall), while a refused connection is refused again a half-second later.
    /// A lost response after a server-side delete would also make the returned
    /// count a lie. Orphan rows want a durable retry queue, not three fast tries.
    @discardableResult
    func forgetSessionMemory(sessionId: String) async throws -> Int {
        let resp: ForgetSessionMemoryResponse = try await send(
            path: "/kb/agent/session-memory", method: "DELETE",
            body: ForgetSessionMemoryBody(sessionId: sessionId),
            authenticated: true)
        return resp.removed
    }
}
