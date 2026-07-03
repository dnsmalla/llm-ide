import Foundation

/// Decorator that enforces the per-provider operation allow-list at the data
/// layer. Reads pass through; each write throws
/// `RepoBackendError.operationNotAllowed` when the op is disabled for this
/// provider, so no UI path can perform a disallowed write. Wrap every backend
/// via `RepoBackendFactory.guarded(_:config:)`.
@MainActor
final class AllowlistedRepoBackend: RepoBackend {
    private let wrapped: RepoBackend
    private let config: AppConfig
    var kind: RepoBackendKind { wrapped.kind }

    init(wrapping wrapped: RepoBackend, config: AppConfig) {
        self.wrapped = wrapped
        self.config = config
    }

    private func require(_ op: RepoOperation) throws {
        guard config.isAllowed(op, provider: wrapped.kind) else {
            throw RepoBackendError.operationNotAllowed(op, provider: wrapped.kind)
        }
    }

    // Capability flags + reads — delegate verbatim.
    var canWriteIssues: Bool { wrapped.canWriteIssues }
    var canCreateMergeRequests: Bool { wrapped.canCreateMergeRequests }
    var supportsWeight: Bool { wrapped.supportsWeight }
    var usesScheduleOverlay: Bool { wrapped.usesScheduleOverlay }
    func listProjects() async throws -> [RepoProject] { try await wrapped.listProjects() }
    func getProject(id: String) async throws -> RepoProject { try await wrapped.getProject(id: id) }
    func listIssues(projectId: String, filter: RepoIssueFilter, page: Int) async throws -> [RepoIssue] { try await wrapped.listIssues(projectId: projectId, filter: filter, page: page) }
    func getIssue(projectId: String, number: Int) async throws -> RepoIssue { try await wrapped.getIssue(projectId: projectId, number: number) }
    func listLabels(projectId: String) async throws -> [RepoLabel] { try await wrapped.listLabels(projectId: projectId) }
    func listMilestones(projectId: String) async throws -> [RepoMilestone] { try await wrapped.listMilestones(projectId: projectId) }
    func listMembers(projectId: String) async throws -> [RepoUser] { try await wrapped.listMembers(projectId: projectId) }
    func listNotes(projectId: String, number: Int) async throws -> [RepoNote] { try await wrapped.listNotes(projectId: projectId, number: number) }
    func listOpenMergeRequests(projectId: String) async throws -> [RepoMergeRequest] { try await wrapped.listOpenMergeRequests(projectId: projectId) }

    // Writes — gated.
    func createIssue(projectId: String, payload: RepoIssuePayload) async throws -> RepoIssue {
        try require(.createIssue)
        return try await wrapped.createIssue(projectId: projectId, payload: payload)
    }
    func updateIssue(projectId: String, number: Int, payload: RepoIssuePayload) async throws -> RepoIssue {
        try require(payload.stateChange != nil ? .closeIssue : .editIssue)
        return try await wrapped.updateIssue(projectId: projectId, number: number, payload: payload)
    }
    func createNote(projectId: String, number: Int, body: String) async throws -> RepoNote {
        try require(.commentIssue)
        return try await wrapped.createNote(projectId: projectId, number: number, body: body)
    }
    @discardableResult
    func createBranch(projectId: String, name: String, ref: String) async throws -> Bool {
        try require(.createBranch)
        return try await wrapped.createBranch(projectId: projectId, name: name, ref: ref)
    }
    func createMergeRequest(projectId: String, payload: RepoMergeRequestPayload) async throws -> RepoMergeRequest {
        try require(.createPR)
        return try await wrapped.createMergeRequest(projectId: projectId, payload: payload)
    }
}
