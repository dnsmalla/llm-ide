// GitLabClient ↔ RepoBackend adapter. Wraps the existing methods (kept
// as-is so call sites still using GitLab-typed APIs keep working) and
// translates the responses into the neutral RepoBackend models.

import Foundation
import RepoKit

extension GitLabClient: RepoBackend {
    var kind: RepoBackendKind { .gitlab }

    // GitLab is the original backend; it supports the full write surface.
    var canWriteIssues: Bool { true }
    var canCreateMergeRequests: Bool { true }
    var supportsWeight: Bool { true }
    var usesScheduleOverlay: Bool { false }

    // MARK: - Projects

    func listProjects() async throws -> [RepoProject] {
        // Only the projects the user explicitly added in Settings → GitLab —
        // NOT every project the token can access (the membership search
        // returned dozens, flooding the picker). Mirrors
        // GitHubClient.listProjects(), which lists saved repos only.
        savedProjectsBridge().compactMap { $0.asRepoProject }
    }

    func getProject(id: String) async throws -> RepoProject {
        guard let intId = Int(id) else {
            throw GitLabError.badURL("project id \(id) isn't numeric")
        }
        let raw = try await self.getProject(id: intId)
        return raw.asRepoProject
    }

    // MARK: - Issues

    func listIssues(projectId: String, filter: RepoIssueFilter, page: Int) async throws -> [RepoIssue] {
        guard let intId = Int(projectId) else {
            throw GitLabError.badURL("project id \(projectId) isn't numeric")
        }
        let gitLabFilter = IssueFilter(
            state: filter.state.asGitLab,
            search: filter.search,
            labelName: filter.labelName,
            milestoneId: filter.milestoneId.flatMap(Int.init),
            assigneeId: filter.assigneeId.flatMap(Int.init)
        )
        let raw = try await self.listIssues(projectId: intId, filter: gitLabFilter, page: page)
        return raw.map { $0.asRepoIssue }
    }

    func getIssue(projectId: String, number: Int) async throws -> RepoIssue {
        guard let intId = Int(projectId) else {
            throw GitLabError.badURL("project id \(projectId) isn't numeric")
        }
        let raw = try await self.getIssue(projectId: intId, iid: number)
        return raw.asRepoIssue
    }

    // MARK: - Labels / milestones / members

    func listLabels(projectId: String) async throws -> [RepoLabel] {
        guard let intId = Int(projectId) else { return [] }
        let raw = try await self.listLabels(projectId: intId)
        return raw.map { $0.asRepoLabel }
    }

    func listMilestones(projectId: String) async throws -> [RepoMilestone] {
        guard let intId = Int(projectId) else { return [] }
        let raw = try await self.listMilestones(projectId: intId)
        return raw.map { $0.asRepoMilestone }
    }

    func listMembers(projectId: String) async throws -> [RepoUser] {
        guard let intId = Int(projectId) else { return [] }
        // GitLab assigns by numeric user id — asRepoUser carries that as the id.
        return try await self.listMembers(projectId: intId).map { $0.asRepoUser }
    }

    // MARK: - Writes

    func createIssue(projectId: String, payload: RepoIssuePayload) async throws -> RepoIssue {
        guard let intId = Int(projectId) else {
            throw GitLabError.badURL("project id \(projectId) isn't numeric")
        }
        // Title is required on create; reject up-front rather than POSTing a
        // blank title (the payload now omits nil titles to protect updates).
        guard let t = payload.title, !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw GitLabError.badURL("issue title is required to create an issue")
        }
        let glPayload = payload.asGitLabPayload(currentState: nil)
        let raw = try await self.createIssue(projectId: intId, payload: glPayload)
        return raw.asRepoIssue
    }

    func updateIssue(projectId: String, number: Int, payload: RepoIssuePayload) async throws -> RepoIssue {
        guard let intId = Int(projectId) else {
            throw GitLabError.badURL("project id \(projectId) isn't numeric")
        }
        let glPayload = payload.asGitLabPayload(currentState: nil)
        let raw = try await self.updateIssue(projectId: intId, iid: number, payload: glPayload)
        return raw.asRepoIssue
    }

    func listNotes(projectId: String, number: Int) async throws -> [RepoNote] {
        guard let intId = Int(projectId) else { return [] }
        let raw = try await self.listNotes(projectId: intId, iid: number)
        return raw.map { $0.asRepoNote }
    }

    func createNote(projectId: String, number: Int, body: String) async throws -> RepoNote {
        guard let intId = Int(projectId) else {
            throw GitLabError.badURL("project id \(projectId) isn't numeric")
        }
        let raw = try await self.createNote(projectId: intId, iid: number, body: body)
        return raw.asRepoNote
    }

    func createBranch(projectId: String, name: String, ref: String) async throws -> Bool {
        guard let intId = Int(projectId) else {
            throw GitLabError.badURL("project id \(projectId) isn't numeric")
        }
        do {
            _ = try await self.createBranch(projectId: intId, name: name, ref: ref)
            return true
        } catch let err as GitLabError {
            // GitLab returns 400 "Branch already exists" when re-running the
            // workflow on the same issue — treat as reuse, not failure.
            if case .httpError(400, let msg) = err,
               msg.range(of: "already exists", options: .caseInsensitive) != nil {
                return false
            }
            throw err
        }
    }

    func createMergeRequest(projectId: String, payload: RepoMergeRequestPayload) async throws -> RepoMergeRequest {
        guard let intId = Int(projectId) else {
            throw GitLabError.badURL("project id \(projectId) isn't numeric")
        }
        // GitLab's draft mechanism is a "Draft:" title prefix (no API flag).
        let title = (payload.draft && !payload.title.lowercased().hasPrefix("draft:"))
            ? "Draft: \(payload.title)" : payload.title
        let gl = GitLabMergeRequestPayload(
            title: title,
            description: payload.description,
            sourceBranch: payload.sourceBranch,
            targetBranch: payload.targetBranch)
        let mr = try await self.createMergeRequest(projectId: intId, payload: gl)
        return mr.asRepoMergeRequest
    }

    func listOpenMergeRequests(projectId: String) async throws -> [RepoMergeRequest] {
        guard let intId = Int(projectId) else {
            throw GitLabError.badURL("project id \(projectId) isn't numeric")
        }
        return try await self.listMergeRequests(projectId: intId, state: "opened")
            .map { $0.asRepoMergeRequest }
    }
}

private extension GitLabMergeRequest {
    var asRepoMergeRequest: RepoMergeRequest {
        let lower = title.lowercased()
        return RepoMergeRequest(
            id: String(id), number: iid, title: title, state: state,
            sourceBranch: sourceBranch, targetBranch: targetBranch, webUrl: webUrl,
            isDraft: lower.hasPrefix("draft:") || lower.hasPrefix("wip:"))
    }
}

// MARK: - Write payload bridge

private extension RepoIssuePayload {
    /// Translate to GitLab's payload shape. `assigneeIds` and
    /// `milestoneId` parse as Int (GitLab uses numeric IDs).
    /// `stateChange` maps to GitLab's `state_event` verb.
    func asGitLabPayload(currentState _: String?) -> GitLabIssuePayload {
        let assigneeInts = assigneeIds?.compactMap(Int.init)
        let milestoneInt = milestoneId.flatMap(Int.init)
        let stateEvent: String?
        switch stateChange {
        case .close:  stateEvent = "close"
        case .reopen: stateEvent = "reopen"
        case .none:   stateEvent = nil
        }
        return GitLabIssuePayload(
            title: title,            // nil → omitted (never wipes the title on partial update)
            description: body,
            labels: labels?.joined(separator: ","),
            milestoneId: milestoneInt,
            assigneeIds: assigneeInts,
            dueDate: dueDate,
            stateEvent: stateEvent,
            weight: weight
        )
    }
}

private extension GitLabNote {
    var asRepoNote: RepoNote {
        RepoNote(
            id: String(id),
            body: body,
            author: RepoUser(
                id: String(author.id),
                username: author.username,
                displayName: author.name,
                avatarUrl: author.avatarUrl
            ),
            createdAt: createdAt,
            isSystem: system
        )
    }
}

// MARK: - Bridges

private extension GitLabProject {
    var asRepoProject: RepoProject {
        RepoProject(
            id: String(id),
            name: name,
            fullName: nameWithNamespace,
            webUrl: webUrl,
            avatarUrl: avatarUrl,
            description: description,
            openIssuesCount: openIssuesCount,
            backend: .gitlab
        )
    }
}

private extension SavedGitLabProject {
    /// Map a Settings-saved project to the neutral RepoProject for the picker.
    /// Requires a resolved numeric id — GitLab issue/note/label calls all parse
    /// `projectId` as Int — so a not-yet-resolved project is dropped (compactMap)
    /// rather than listed as a project that would fail to load issues.
    var asRepoProject: RepoProject? {
        guard let rid = resolvedId else { return nil }
        let fallbackName = (url as NSString).lastPathComponent
        let label = displayName.isEmpty ? fallbackName : displayName
        return RepoProject(
            id: String(rid),
            name: label,
            fullName: label,
            webUrl: url,
            avatarUrl: nil,
            description: nil,
            openIssuesCount: nil,
            backend: .gitlab
        )
    }
}

private extension GitLabUser {
    var asRepoUser: RepoUser {
        RepoUser(id: String(id), username: username, displayName: name, avatarUrl: avatarUrl)
    }
}

private extension GitLabLabel {
    var asRepoLabel: RepoLabel {
        RepoLabel(
            id: String(id),
            name: name,
            // GitLab returns "#rrggbb" already; defensive in case the
            // server omits the hash on some endpoints.
            color: color.hasPrefix("#") ? color : "#" + color,
            description: description
        )
    }
}

private extension GitLabMilestone {
    var asRepoMilestone: RepoMilestone {
        RepoMilestone(
            id: String(id),
            title: title,
            // GitLab states are already "active" / "closed".
            state: state,
            dueDate: dueDate,
            startDate: startDate,
            description: description
        )
    }
}

private extension GitLabIssue {
    var asRepoIssue: RepoIssue {
        RepoIssue(
            id: String(id),
            number: iid,
            title: title,
            body: description,
            state: state,
            labels: labels,
            milestone: milestone?.asRepoMilestone,
            assignees: assignees.map { $0.asRepoUser },
            author: author.asRepoUser,
            createdAt: createdAt,
            updatedAt: updatedAt,
            closedAt: closedAt,
            webUrl: webUrl,
            commentCount: userNotesCount,
            dueDate: dueDate,
            weight: weight
        )
    }
}

private extension RepoIssueFilter.IssueState {
    var asGitLab: IssueFilter.IssueState {
        switch self {
        case .opened: return .opened
        case .closed: return .closed
        case .all:    return .all
        }
    }
}
