import Foundation

/// Thin async/await wrapper around GitLab's REST v4 API.
/// All calls require a Personal Access Token with the `api` scope.
final class GitLabClient {

    enum GitLabError: LocalizedError {
        case notConfigured
        case badURL(String)
        case httpError(Int, String)
        case decodingError(Error)

        var errorDescription: String? {
            switch self {
            case .notConfigured:
                return "GitLab is not configured. Add your Personal Access Token in Settings → GitLab."
            case .badURL(let u):
                return "Invalid URL: \(u)"
            case .httpError(let code, let msg):
                return "GitLab API error \(code): \(msg)"
            case .decodingError(let e):
                return "Response decode failed: \(e.localizedDescription)"
            }
        }
    }

    private let config: AppConfig

    /// Delegate that strips the `PRIVATE-TOKEN` header on cross-host
    /// redirects. Prevents a malicious or compromised GitLab instance
    /// from bouncing us to an attacker-controlled host with our PAT
    /// still attached.
    final class RedirectGuardDelegate: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession,
                        task: URLSessionTask,
                        willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest,
                        completionHandler: @escaping (URLRequest?) -> Void) {
            let originalHost = task.originalRequest?.url?.host?.lowercased()
            let newHost = request.url?.host?.lowercased()
            if originalHost != newHost {
                // Cross-host redirect → drop our auth header before
                // following. We still allow the redirect (some self-hosted
                // GitLabs front their API with a CDN that bounces hosts),
                // we just don't leak the PAT.
                var stripped = request
                stripped.setValue(nil, forHTTPHeaderField: "PRIVATE-TOKEN")
                stripped.setValue(nil, forHTTPHeaderField: "Authorization")
                completionHandler(stripped)
            } else {
                completionHandler(request)
            }
        }
    }

    private static let redirectDelegate = RedirectGuardDelegate()

    /// Shared hardened session: redirect-guarded, up to 10 parallel
    /// connections to the same GitLab host (enables concurrent page
    /// fetching in fetchAllIssues). We rely on the redirect delegate
    /// for security; over-zealous cookie suppression has been seen to
    /// trigger NSURLErrorNetworkConnectionLost on some macOS network
    /// stacks when GitLab attempts a Set-Cookie, so we leave cookie
    /// handling at its default (still scoped to this session, not the
    /// system store).
    static let session: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest  = 30
        cfg.timeoutIntervalForResource = 120
        cfg.httpMaximumConnectionsPerHost = 10
        cfg.waitsForConnectivity = false
        // Isolated, per-session cookie storage so cookies set by GitLab
        // never leak into the system-wide store; we don't bother
        // refusing them outright.
        cfg.httpCookieStorage = HTTPCookieStorage()
        return URLSession(configuration: cfg, delegate: redirectDelegate, delegateQueue: nil)
    }()

    /// True when the base URL is safe to send a PAT to.
    /// Requires `https`, except for explicit loopback hosts where
    /// `http` is allowed (covers self-hosted dev instances).
    static func isSafeBaseURL(_ raw: String) -> Bool {
        guard let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = url.scheme?.lowercased(),
              let host = url.host?.lowercased(), !host.isEmpty else { return false }
        if scheme == "https" { return true }
        if scheme == "http" {
            return host == "localhost" || host == "127.0.0.1" || host == "::1"
        }
        return false
    }

    init(config: AppConfig = .shared) {
        self.config = config
    }

    // MARK: - Projects

    func listProjects(search: String = "", page: Int = 1) async throws -> [GitLabProject] {
        var items: [URLQueryItem] = [
            .init(name: "membership", value: "true"),
            .init(name: "per_page",   value: "50"),
            .init(name: "page",       value: "\(page)"),
            .init(name: "order_by",   value: "last_activity_at"),
        ]
        if !search.isEmpty { items.append(.init(name: "search", value: search)) }
        return try await get("/projects", query: items)
    }

    /// Fetch a single project by its numeric ID.
    func getProject(id: Int) async throws -> GitLabProject {
        return try await get("/projects/\(id)")
    }

    /// Resolves a raw string (full URL, namespace path, or numeric ID) to a GitLabProject.
    /// When a full URL is given, the host is extracted from it directly so the
    /// configured Instance URL does not need to match.
    func resolveProject(rawURL: String) async throws -> GitLabProject {
        let raw = rawURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { throw GitLabError.badURL(raw) }

        if let numId = Int(raw) {
            return try await getProject(id: numId)
        }

        var apiBase = config.gitLabBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        var path = raw

        if raw.hasPrefix("http"), let u = URL(string: raw),
           let scheme = u.scheme, let host = u.host {
            apiBase = "\(scheme)://\(host)"
            path = u.path
        }

        path = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !path.isEmpty else { throw GitLabError.badURL(raw) }

        // SECURITY: `apiBase` may have been derived from an attacker-supplied
        // URL (e.g. an issue/project link). We are about to attach the GitLab
        // PAT as a PRIVATE-TOKEN header — gate the destination through the
        // same https/loopback allowlist used elsewhere so the token can never
        // be sent to an arbitrary host (token exfiltration).
        guard GitLabClient.isSafeBaseURL(apiBase) else { throw GitLabError.badURL(apiBase) }

        let encoded = path
            .components(separatedBy: "/")
            .map { $0.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? $0 }
            .joined(separator: "%2F")

        guard let url = URL(string: "\(apiBase)/api/v4/projects/\(encoded)") else {
            throw GitLabError.badURL(path)
        }
        var req = URLRequest(url: url, timeoutInterval: 15)
        req.httpMethod = "GET"
        req.setValue(try token(), forHTTPHeaderField: "PRIVATE-TOKEN")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return try await execute(req)
    }

    // MARK: - Issues

    /// Fetches ALL issues for a project using concurrent page requests.
    /// 1. Fetches page 1 and reads X-Total-Pages from the response header.
    /// 2. Fires all remaining pages in parallel with withThrowingTaskGroup.
    /// This turns N sequential round-trips into 1 + 1 parallel burst.
    func fetchAllIssues(projectId: Int) async throws -> [GitLabIssue] {
        let baseQuery: [URLQueryItem] = [
            .init(name: "scope",    value: "all"),
            .init(name: "per_page", value: "100"),
            .init(name: "order_by", value: "created_at"),
        ]

        // Page 1 — also gives us X-Total-Pages
        let req1 = try makeRequest("/projects/\(projectId)/issues", method: "GET",
                                   query: baseQuery + [.init(name: "page", value: "1")])
        let (firstBatch, http): ([GitLabIssue], HTTPURLResponse) = try await executeWithHeaders(req1)

        let totalPages = Int(http.value(forHTTPHeaderField: "X-Total-Pages") ?? "1") ?? 1
        guard totalPages > 1 else { return firstBatch }

        // Pages 2…N concurrently
        var all = firstBatch
        try await withThrowingTaskGroup(of: [GitLabIssue].self) { group in
            for page in 2...totalPages {
                group.addTask { [baseQuery] in
                    try await self.get("/projects/\(projectId)/issues",
                                       query: baseQuery + [.init(name: "page", value: "\(page)")])
                }
            }
            for try await batch in group {
                all.append(contentsOf: batch)
            }
        }
        // Re-sort since concurrent pages can arrive out of order
        return all.sorted { $0.iid < $1.iid }
    }

    func listIssues(projectId: Int, filter: IssueFilter, page: Int = 1) async throws -> [GitLabIssue] {
        var query = filter.queryItems
        query.append(.init(name: "page", value: "\(page)"))
        // GitLab's default per_page is 20 — small enough that callers
        // paginating with a "stop when batch < 50" heuristic (see
        // AutoCodeUpdateService.fetchAllIssues) would stop after page
        // one. Cap at 100, GitLab's maximum.
        query.append(.init(name: "per_page", value: "100"))
        return try await get("/projects/\(projectId)/issues", query: query)
    }

    func getIssue(projectId: Int, iid: Int) async throws -> GitLabIssue {
        return try await get("/projects/\(projectId)/issues/\(iid)")
    }

    func createIssue(projectId: Int, payload: GitLabIssuePayload) async throws -> GitLabIssue {
        return try await post("/projects/\(projectId)/issues", body: payload)
    }

    func updateIssue(projectId: Int, iid: Int, payload: GitLabIssuePayload) async throws -> GitLabIssue {
        return try await put("/projects/\(projectId)/issues/\(iid)", body: payload)
    }

    // MARK: - Notes (comments)

    func listNotes(projectId: Int, iid: Int) async throws -> [GitLabNote] {
        return try await get("/projects/\(projectId)/issues/\(iid)/notes",
                             query: [.init(name: "per_page", value: "100"),
                                     .init(name: "sort",     value: "asc")])
    }

    func createNote(projectId: Int, iid: Int, body: String) async throws -> GitLabNote {
        return try await post("/projects/\(projectId)/issues/\(iid)/notes",
                              body: ["body": body])
    }

    // MARK: - Branches

    func createBranch(projectId: Int, name: String, ref: String) async throws -> GitLabBranch {
        return try await post("/projects/\(projectId)/repository/branches",
                              body: ["branch": name, "ref": ref])
    }

    // MARK: - Merge Requests

    func createMergeRequest(projectId: Int, payload: GitLabMergeRequestPayload) async throws -> GitLabMergeRequest {
        return try await post("/projects/\(projectId)/merge_requests", body: payload)
    }

    func listMergeRequests(projectId: Int, state: String = "opened") async throws -> [GitLabMergeRequest] {
        return try await get("/projects/\(projectId)/merge_requests",
                             query: [.init(name: "state",    value: state),
                                     .init(name: "per_page", value: "50")])
    }

    // MARK: - Labels

    func listLabels(projectId: Int) async throws -> [GitLabLabel] {
        return try await get("/projects/\(projectId)/labels",
                             query: [.init(name: "per_page", value: "100")])
    }

    // MARK: - Milestones

    func listMilestones(projectId: Int) async throws -> [GitLabMilestone] {
        return try await get("/projects/\(projectId)/milestones",
                             query: [.init(name: "per_page", value: "100"),
                                     .init(name: "state",    value: "active")])
    }

    // MARK: - Members

    func listMembers(projectId: Int) async throws -> [GitLabUser] {
        return try await get("/projects/\(projectId)/members/all",
                             query: [.init(name: "per_page", value: "100")])
    }

    // MARK: - Low-level HTTP

    private func baseURL() throws -> URL {
        let raw = config.gitLabBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard GitLabClient.isSafeBaseURL(raw), let url = URL(string: raw) else {
            throw GitLabError.badURL(raw)
        }
        return url
    }

    private func token() throws -> String {
        let t = config.gitLabToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { throw GitLabError.notConfigured }
        return t
    }

    private func makeRequest(_ path: String, method: String, query: [URLQueryItem] = []) throws -> URLRequest {
        let base = try baseURL()
        guard var comps = URLComponents(url: base.appendingPathComponent("/api/v4" + path),
                                        resolvingAgainstBaseURL: false) else {
            throw GitLabError.badURL(path)
        }
        if !query.isEmpty { comps.queryItems = query }
        guard let url = comps.url else { throw GitLabError.badURL(path) }
        var req = URLRequest(url: url, timeoutInterval: 30)
        req.httpMethod = method
        req.setValue(try token(), forHTTPHeaderField: "PRIVATE-TOKEN")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return req
    }

    /// Executes a request and returns both the decoded body and the raw HTTP response
    /// (used to read pagination headers like X-Total-Pages).
    private func executeWithHeaders<T: Decodable>(_ req: URLRequest) async throws -> (T, HTTPURLResponse) {
        let (data, response) = try await GitLabClient.session.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw GitLabError.httpError(0, "No HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            let jsonMsg = (try? AppJSON.decoder.decode([String: String].self, from: data))?["message"]
            let bodyPreview = String(data: data.prefix(500), encoding: .utf8)
            let msg = jsonMsg ?? bodyPreview.map { "HTTP \(http.statusCode): \($0)" }
                ?? "HTTP \(http.statusCode): <binary response>"
            throw GitLabError.httpError(http.statusCode, msg)
        }
        do {
            return (try AppJSON.decoder.decode(T.self, from: data), http)
        } catch {
            throw GitLabError.decodingError(error)
        }
    }

    private func execute<T: Decodable>(_ req: URLRequest) async throws -> T {
        let (value, _): (T, HTTPURLResponse) = try await executeWithHeaders(req)
        return value
    }

    private func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        let req = try makeRequest(path, method: "GET", query: query)
        return try await execute(req)
    }

    private func post<T: Decodable, B: Encodable>(_ path: String, body: B) async throws -> T {
        var req = try makeRequest(path, method: "POST")
        req.httpBody = try AppJSON.encoder.encode(body)
        return try await execute(req)
    }

    private func put<T: Decodable, B: Encodable>(_ path: String, body: B) async throws -> T {
        var req = try makeRequest(path, method: "PUT")
        req.httpBody = try AppJSON.encoder.encode(body)
        return try await execute(req)
    }
}
