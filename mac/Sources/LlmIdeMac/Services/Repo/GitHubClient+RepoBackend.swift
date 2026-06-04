// GitHubClient ↔ RepoBackend adapter.
//
// Project-ID convention: GitHub repos are identified by `owner/name`,
// not a numeric ID like GitLab. The neutral RepoBackend uses String
// IDs precisely so this works without an extra mapping layer — we
// pass `owner/name` through wherever GitLab would pass "123".

import Foundation

extension GitHubClient: RepoBackend {
    var kind: RepoBackendKind { .github }

    // Phase 2: issue writes work (create / update / comment). PR
    // creation is still a separate phase — different lifecycle than
    // GitLab MRs (draft state, auto-merge, review requests) so it's
    // not a trivial protocol method.
    var canWriteIssues: Bool { true }
    var canCreateMergeRequests: Bool { false }

    // MARK: - Projects

    /// Returns every saved GitHub repo (from AppConfig). GitHub doesn't
    /// have a single API endpoint matching GitLab's "all projects I can
    /// see" with cheap filtering — the user has already curated their
    /// list in Settings → GitHub, so we surface that directly.
    func listProjects() async throws -> [RepoProject] {
        savedReposBridge().compactMap { saved in
            saved.asRepoProject
        }
    }

    func getProject(id: String) async throws -> RepoProject {
        guard let (owner, name) = Self.ownerAndName(from: id) else {
            throw GitHubError.badURL(id)
        }
        let repo = try await getRepo(owner: owner, name: name)
        return repo.asRepoProject
    }

    // MARK: - Issues

    func listIssues(projectId: String, filter: RepoIssueFilter, page: Int) async throws -> [RepoIssue] {
        guard let (owner, name) = Self.ownerAndName(from: projectId) else {
            throw GitHubError.badURL(projectId)
        }
        let wires = try await listIssuesGitHub(owner: owner, name: name, filter: filter, page: page)
        return wires.map { $0.asRepoIssue(projectFullName: "\(owner)/\(name)") }
    }

    func getIssue(projectId: String, number: Int) async throws -> RepoIssue {
        guard let (owner, name) = Self.ownerAndName(from: projectId) else {
            throw GitHubError.badURL(projectId)
        }
        let wire = try await getIssueGitHub(owner: owner, name: name, number: number)
        return wire.asRepoIssue(projectFullName: "\(owner)/\(name)")
    }

    // MARK: - Labels / milestones / members

    func listLabels(projectId: String) async throws -> [RepoLabel] {
        guard let (owner, name) = Self.ownerAndName(from: projectId) else { return [] }
        let wires = try await listLabelsGitHub(owner: owner, name: name)
        return wires.map { $0.asRepoLabel }
    }

    func listMilestones(projectId: String) async throws -> [RepoMilestone] {
        guard let (owner, name) = Self.ownerAndName(from: projectId) else { return [] }
        let wires = try await listMilestonesGitHub(owner: owner, name: name)
        return wires.map { $0.asRepoMilestone }
    }

    // MARK: - Writes

    func createIssue(projectId: String, payload: RepoIssuePayload) async throws -> RepoIssue {
        guard let (owner, name) = Self.ownerAndName(from: projectId) else {
            throw GitHubError.badURL(projectId)
        }
        let wire = try await createIssueGitHub(owner: owner, name: name,
                                               body: payload.asGitHubBody(isCreate: true))
        return wire.asRepoIssue(projectFullName: "\(owner)/\(name)")
    }

    func updateIssue(projectId: String, number: Int, payload: RepoIssuePayload) async throws -> RepoIssue {
        guard let (owner, name) = Self.ownerAndName(from: projectId) else {
            throw GitHubError.badURL(projectId)
        }
        let wire = try await updateIssueGitHub(owner: owner, name: name, number: number,
                                               body: payload.asGitHubBody(isCreate: false))
        return wire.asRepoIssue(projectFullName: "\(owner)/\(name)")
    }

    func listNotes(projectId: String, number: Int) async throws -> [RepoNote] {
        guard let (owner, name) = Self.ownerAndName(from: projectId) else { return [] }
        let wires = try await listIssueCommentsGitHub(owner: owner, name: name, number: number)
        return wires.map { $0.asRepoNote }
    }

    func createNote(projectId: String, number: Int, body: String) async throws -> RepoNote {
        guard let (owner, name) = Self.ownerAndName(from: projectId) else {
            throw GitHubError.badURL(projectId)
        }
        let wire = try await createIssueCommentGitHub(owner: owner, name: name, number: number, body: body)
        return wire.asRepoNote
    }
}

// MARK: - Write payload bridge

private extension RepoIssuePayload {
    /// Translate to a JSON-serializable dictionary GitHub's REST API
    /// accepts. Only includes keys for non-nil fields so PATCH leaves
    /// untouched fields alone. `stateChange` collapses to `state`
    /// (GitHub uses "open" / "closed"). `dueDate` is silently dropped
    /// — GitHub has no per-issue due date.
    func asGitHubBody(isCreate: Bool) -> [String: Any] {
        var body: [String: Any] = [:]
        if let title { body["title"] = title }
        if let bodyText = self.body { body["body"] = bodyText }
        if let labels { body["labels"] = labels }
        if let assigneeIds {
            // GitHub takes username strings, GitLab takes numeric IDs.
            // assigneeIds in our payload is already stringified — for
            // GitHub the caller should pass usernames.
            body["assignees"] = assigneeIds
        }
        if let milestoneId {
            // GitHub's milestone POST/PATCH takes the milestone number
            // (Int) — accept either form here.
            if let n = Int(milestoneId) { body["milestone"] = n }
        }
        switch stateChange {
        case .close:  body["state"] = "closed"
        case .reopen: body["state"] = "open"
        case .none:   break
        }
        _ = isCreate    // GitHub create + update use the same shape
        return body
    }
}

private extension GitHubCommentWire {
    var asRepoNote: RepoNote {
        RepoNote(
            id: String(id),
            body: body,
            author: RepoUser(
                id: String(user.id),
                username: user.login,
                displayName: user.name?.isEmpty == false ? user.name! : user.login,
                avatarUrl: user.avatarUrl
            ),
            createdAt: createdAt,
            // GitHub doesn't flag system comments distinctly.
            isSystem: false
        )
    }
}

// MARK: - Wire → neutral bridges

private extension GitHubRepo {
    var asRepoProject: RepoProject {
        RepoProject(
            id: fullName,                 // "owner/name" — see header
            name: name,
            fullName: fullName,
            webUrl: htmlUrl,
            avatarUrl: nil,
            description: description,
            openIssuesCount: openIssuesCount,
            backend: .github
        )
    }
}

private extension SavedGitHubRepo {
    /// Use the persisted display name + URL when available; falls back
    /// to the user-typed URL form when the repo hasn't been resolved
    /// yet so the project picker isn't blank.
    var asRepoProject: RepoProject? {
        guard let (owner, name) = GitHubClient.ownerAndName(from: url) else { return nil }
        let full = "\(owner)/\(name)"
        return RepoProject(
            id: full,
            name: displayName.isEmpty ? name : displayName,
            fullName: full,
            webUrl: "https://github.com/\(full)",
            avatarUrl: nil,
            description: nil,
            openIssuesCount: nil,
            backend: .github
        )
    }
}

private extension GitHubUserWire {
    var asRepoUser: RepoUser {
        RepoUser(
            id: String(id),
            username: login,
            displayName: name?.isEmpty == false ? name! : login,
            avatarUrl: avatarUrl
        )
    }
}

private extension GitHubLabelWire {
    var asRepoLabel: RepoLabel {
        RepoLabel(
            id: String(id),
            name: name,
            // GitHub returns hex without leading '#'; normalise.
            color: "#" + color,
            description: description
        )
    }
}

private extension GitHubMilestoneWire {
    var asRepoMilestone: RepoMilestone {
        RepoMilestone(
            id: String(id),
            title: title,
            // Translate GitHub's "open" to GitLab's "active" so any
            // UI using the existing strings keeps working.
            state: state == "open" ? "active" : state,
            dueDate: dueOn,
            startDate: nil,                 // GitHub doesn't carry start date
            description: description
        )
    }
}

private extension GitHubIssueWire {
    func asRepoIssue(projectFullName: String) -> RepoIssue {
        RepoIssue(
            id: String(id),
            number: number,
            title: title,
            body: body,
            // GitHub uses "open" / "closed"; map to GitLab's "opened"
            // so IssueFilter values & UI strings can stay shared.
            state: state == "open" ? "opened" : state,
            labels: labels.map(\.name),
            milestone: milestone?.asRepoMilestone,
            assignees: assignees.map { $0.asRepoUser },
            author: user.asRepoUser,
            createdAt: createdAt,
            updatedAt: updatedAt,
            closedAt: closedAt,
            webUrl: htmlUrl,
            commentCount: comments,
            // GitHub issues don't carry a per-issue due date; the
            // milestone's due date is the closest semantic equivalent.
            dueDate: milestone?.dueOn
        )
    }
}
