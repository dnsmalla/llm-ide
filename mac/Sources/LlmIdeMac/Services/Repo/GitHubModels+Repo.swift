// GitHub wire types for the issue / label / milestone endpoints, plus
// the GitHubClient ↔ RepoBackend adapter that translates them into the
// neutral RepoBackend models.
//
// Scope: read-only. POST / PATCH paths (create-issue, comment, close)
// are intentionally not implemented in v1 — call sites check the
// `canWriteIssues` flag to disable those affordances when GitHub is
// the active backend.

import Foundation

// MARK: - Wire types

struct GitHubIssueWire: Decodable {
    let id: Int
    let number: Int
    let title: String
    let body: String?
    let state: String          // "open" | "closed"
    let labels: [GitHubLabelWire]
    let milestone: GitHubMilestoneWire?
    let assignees: [GitHubUserWire]
    let user: GitHubUserWire   // author
    let createdAt: String
    let updatedAt: String
    let closedAt: String?
    let htmlUrl: String
    let comments: Int
    /// GitHub doesn't have a per-issue due date — milestones own due
    /// dates instead. Keep nil to match the neutral model shape.
    let pullRequest: PullRequestStub?   // present ⇢ this "issue" is a PR

    struct PullRequestStub: Decodable { let url: String }

    enum CodingKeys: String, CodingKey {
        case id, number, title, body, state, labels, milestone, assignees, user
        case createdAt   = "created_at"
        case updatedAt   = "updated_at"
        case closedAt    = "closed_at"
        case htmlUrl     = "html_url"
        case comments
        case pullRequest = "pull_request"
    }
}

struct GitHubLabelWire: Decodable {
    let id: Int
    let name: String
    let color: String          // hex without leading "#"
    let description: String?
}

struct GitHubMilestoneWire: Decodable {
    let id: Int
    let number: Int
    let title: String
    let state: String          // "open" | "closed"
    let description: String?
    let dueOn: String?
    let createdAt: String?

    enum CodingKeys: String, CodingKey {
        case id, number, title, state, description
        case dueOn      = "due_on"
        case createdAt  = "created_at"
    }
}

struct GitHubUserWire: Decodable {
    let id: Int
    let login: String
    let name: String?          // not returned by /issues; nil there, fetched separately if needed
    let avatarUrl: String?

    enum CodingKeys: String, CodingKey {
        case id, login, name
        case avatarUrl = "avatar_url"
    }
}

// MARK: - Endpoints

extension GitHubClient {
    /// `GET /repos/{o}/{n}/issues`. GitHub returns PRs through the same
    /// endpoint; we filter them out by `pull_request != nil` so the
    /// list matches users' "Issues" mental model (matching GitLab's
    /// behaviour where MRs live under a separate endpoint).
    func listIssuesGitHub(owner: String, name: String, filter: RepoIssueFilter, page: Int) async throws -> [GitHubIssueWire] {
        var items: [URLQueryItem] = [
            .init(name: "state", value: filter.state == .all ? "all" : (filter.state == .closed ? "closed" : "open")),
            .init(name: "per_page", value: "50"),
            .init(name: "sort", value: "updated"),
            .init(name: "direction", value: "desc"),
            .init(name: "page", value: "\(page)"),
        ]
        if !filter.labelName.isEmpty {
            items.append(.init(name: "labels", value: filter.labelName))
        }
        if let mid = filter.milestoneId { items.append(.init(name: "milestone", value: mid)) }
        if let aid = filter.assigneeId  { items.append(.init(name: "assignee",  value: aid)) }
        let issues: [GitHubIssueWire] = try await get("/repos/\(owner)/\(name)/issues", query: items)
        // Drop pull requests — GitHub's /issues endpoint mixes them in.
        return issues.filter { $0.pullRequest == nil }
    }

    func getIssueGitHub(owner: String, name: String, number: Int) async throws -> GitHubIssueWire {
        try await get("/repos/\(owner)/\(name)/issues/\(number)")
    }

    func listLabelsGitHub(owner: String, name: String) async throws -> [GitHubLabelWire] {
        try await get("/repos/\(owner)/\(name)/labels", query: [.init(name: "per_page", value: "100")])
    }

    func listMilestonesGitHub(owner: String, name: String) async throws -> [GitHubMilestoneWire] {
        try await get("/repos/\(owner)/\(name)/milestones",
                      query: [.init(name: "state", value: "all"), .init(name: "per_page", value: "100")])
    }

    // MARK: - Issue writes

    func createIssueGitHub(owner: String, name: String, body: [String: Any]) async throws -> GitHubIssueWire {
        try await post("/repos/\(owner)/\(name)/issues", body: body)
    }

    func updateIssueGitHub(owner: String, name: String, number: Int, body: [String: Any]) async throws -> GitHubIssueWire {
        try await patch("/repos/\(owner)/\(name)/issues/\(number)", body: body)
    }

    func listIssueCommentsGitHub(owner: String, name: String, number: Int) async throws -> [GitHubCommentWire] {
        try await get("/repos/\(owner)/\(name)/issues/\(number)/comments",
                      query: [.init(name: "per_page", value: "100")])
    }

    func createIssueCommentGitHub(owner: String, name: String, number: Int, body: String) async throws -> GitHubCommentWire {
        try await post("/repos/\(owner)/\(name)/issues/\(number)/comments", body: ["body": body])
    }

    // MARK: - Pull requests

    func createPullRequestGitHub(owner: String, name: String, body: [String: Any]) async throws -> GitHubPullRequestWire {
        try await post("/repos/\(owner)/\(name)/pulls", body: body)
    }

    func listOpenPullRequestsGitHub(owner: String, name: String) async throws -> [GitHubPullRequestWire] {
        try await get("/repos/\(owner)/\(name)/pulls",
                      query: [.init(name: "state", value: "open"), .init(name: "per_page", value: "100")])
    }

    // MARK: - Branches

    /// Create branch `branch` pointing at the head of `fromRef` (an existing
    /// branch). GitHub needs the base ref's commit sha first, then a new ref.
    func createBranchGitHub(owner: String, name: String, branch: String, fromRef: String) async throws {
        struct RefWire: Decodable { struct Obj: Decodable { let sha: String }; let object: Obj }
        let base: RefWire = try await get("/repos/\(owner)/\(name)/git/ref/heads/\(fromRef)")
        struct CreatedRef: Decodable { let ref: String }
        let _: CreatedRef = try await post("/repos/\(owner)/\(name)/git/refs",
                                           body: ["ref": "refs/heads/\(branch)", "sha": base.object.sha])
    }

    // MARK: - Generic POST / PATCH helpers

    private func post<T: Decodable>(_ path: String, body: [String: Any]) async throws -> T {
        try await send(method: "POST", path: path, body: body, successCodes: [200, 201])
    }

    private func patch<T: Decodable>(_ path: String, body: [String: Any]) async throws -> T {
        try await send(method: "PATCH", path: path, body: body, successCodes: [200])
    }

    private func send<T: Decodable>(method: String, path: String,
                                    body: [String: Any], successCodes: Set<Int>) async throws -> T {
        let url = Self.apiBase.appendingPathComponent(path)
        var req = URLRequest(url: url, timeoutInterval: 20)
        req.httpMethod = method
        req.setValue("Bearer \(tokenFromConfig)", forHTTPHeaderField: "Authorization")
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        req.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])
        let (data, resp) = try await Self.session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw GitHubError.httpError(-1, "no response") }
        guard successCodes.contains(http.statusCode) else {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["message"] as? String
                ?? "HTTP \(http.statusCode)"
            throw GitHubError.httpError(http.statusCode, msg)
        }
        do {
            return try AppJSON.decoder.decode(T.self, from: data)
        } catch {
            throw GitHubError.decodingError(error)
        }
    }
}

// MARK: - Pull request wire type

struct GitHubPullRequestWire: Decodable {
    let id: Int
    let number: Int
    let title: String
    let state: String          // "open" | "closed"
    let htmlUrl: String
    let draft: Bool?
    let head: Ref
    let base: Ref

    struct Ref: Decodable { let ref: String }

    enum CodingKeys: String, CodingKey {
        case id, number, title, state, draft, head, base
        case htmlUrl = "html_url"
    }
}

// MARK: - Comment wire type

struct GitHubCommentWire: Decodable {
    let id: Int
    let body: String
    let user: GitHubUserWire
    let createdAt: String
    let updatedAt: String

    enum CodingKeys: String, CodingKey {
        case id, body, user
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

// MARK: - HTTP plumbing
//
// The GET helper that lives on GitHubClient. POST/PATCH are above
// inside the main extension; keeping GET here at module scope so all
// the per-endpoint methods in this file can reach it.

extension GitHubClient {
    /// Authed GET against `apiBase` returning a JSON-decoded body.
    /// Adds query items, surfaces non-200 as `httpError`.
    fileprivate func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        var comps = URLComponents(url: Self.apiBase.appendingPathComponent(path),
                                  resolvingAgainstBaseURL: false)
        comps?.queryItems = query.isEmpty ? nil : query
        guard let url = comps?.url else { throw GitHubError.badURL(path) }
        var req = URLRequest(url: url, timeoutInterval: 15)
        req.setValue("Bearer \(tokenFromConfig)", forHTTPHeaderField: "Authorization")
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        let (data, resp) = try await Self.session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw GitHubError.httpError(-1, "no response") }
        guard http.statusCode == 200 else {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["message"] as? String
                ?? "HTTP \(http.statusCode)"
            throw GitHubError.httpError(http.statusCode, msg)
        }
        do {
            return try AppJSON.decoder.decode(T.self, from: data)
        } catch {
            throw GitHubError.decodingError(error)
        }
    }

    /// Read-only accessor so the extension can fetch the token without
    /// reaching into the private `config` directly.
    fileprivate var tokenFromConfig: String { tokenBridge() }
}
