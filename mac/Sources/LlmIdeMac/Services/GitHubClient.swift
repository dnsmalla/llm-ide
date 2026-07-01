import Foundation

/// Thin async/await wrapper around GitHub's REST API (api.github.com).
/// All calls authenticate via Bearer token (PAT or fine-grained token).
/// Scope: minimum surface needed by the GitHub settings panel — verify
/// the token and resolve a repo URL to a `GitHubRepo`. Issues/PRs/etc.
/// are intentionally out of scope until a `RepoBackend` abstraction
/// across GitLab and GitHub lands.
@MainActor
final class GitHubClient {

    enum GitHubError: LocalizedError {
        case notConfigured
        case badURL(String)
        case httpError(Int, String)
        case decodingError(Error)

        var errorDescription: String? {
            switch self {
            case .notConfigured:
                return "GitHub is not configured. Add a Personal Access Token in Settings → GitHub."
            case .badURL(let u):
                return "Invalid URL: \(u)"
            case .httpError(let code, let msg):
                // A 403 "Resource not accessible by personal access token" means
                // the token authenticates but lacks the permission for this
                // action (almost always Issues write). Translate GitHub's
                // cryptic message into something actionable.
                if code == 403 && msg.localizedCaseInsensitiveContains("not accessible") {
                    return "GitHub denied this action (403): your token lacks permission. "
                        + "Give the token write access to this repo — fine-grained: "
                        + "Issues → Read and write (+ Contents → Read and write for branches/PRs) "
                        + "and include this repository; classic: the `repo` scope. "
                        + "Update it in Settings → GitHub."
                }
                return "GitHub API error \(code): \(msg)"
            case .decodingError(let e):
                return "Response decode failed: \(e.localizedDescription)"
            }
        }
    }

    /// Strips the `Authorization` header on cross-host redirects so a
    /// 3xx bounce from api.github.com can't leak the PAT to a third
    /// party. Mirrors GitLabClient.RedirectGuardDelegate.
    final class RedirectGuardDelegate: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession,
                        task: URLSessionTask,
                        willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest,
                        completionHandler: @escaping (URLRequest?) -> Void) {
            let originalHost = task.originalRequest?.url?.host?.lowercased()
            let newHost = request.url?.host?.lowercased()
            // Same host → follow the redirect with auth intact. GitHub
            // legitimately bounces /user → /users/<login> and similar.
            if originalHost == newHost {
                completionHandler(request)
                return
            }
            // Cross-host redirect: strip Authorization so the PAT can't
            // leak off api.github.com, then let the redirect proceed.
            var redirected = request
            redirected.setValue(nil, forHTTPHeaderField: "Authorization")
            completionHandler(redirected)
        }
    }

    static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15
        return URLSession(configuration: config,
                          delegate: RedirectGuardDelegate(),
                          delegateQueue: nil)
    }()

    static let apiBase = URL(string: "https://api.github.com")!

    private let config: AppConfig

    init(config: AppConfig) {
        self.config = config
    }

    /// Bridges for the RepoBackend extension to reach `config` fields
    /// without exposing the property itself. Keeps the rest of the API
    /// surface free of incidental accessors.
    func tokenBridge() -> String { config.gitHubToken }
    func savedReposBridge() -> [SavedGitHubRepo] { config.gitHubSavedRepos }

    // MARK: - Verify token

    /// Static variant that takes the token directly. Use this from the
    /// settings panel's "Save & verify" flow so we can probe a token
    /// without first writing it to the Keychain (and avoiding leaving
    /// an invalid token there on failure).
    static func verifyToken(_ token: String) async throws -> GitHubUser {
        guard !token.isEmpty else { throw GitHubError.notConfigured }
        let url = apiBase.appendingPathComponent("/user")
        var req = URLRequest(url: url, timeoutInterval: 15)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        let (data, http) = try await send(req)
        guard http.statusCode == 200 else {
            let message = extractMessage(data, fallback: "HTTP \(http.statusCode)")
            throw GitHubError.httpError(http.statusCode, message)
        }
        do {
            return try AppJSON.decoder.decode(GitHubUser.self, from: data)
        } catch {
            throw GitHubError.decodingError(error)
        }
    }

    // MARK: - Resolve repo

    /// Accepts a full URL (`https://github.com/owner/name`) or a
    /// shorthand (`owner/name`) and returns the resolved repo.
    func resolveRepo(rawURL: String) async throws -> GitHubRepo {
        let trimmed = rawURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let (owner, name) = Self.ownerAndName(from: trimmed) else {
            throw GitHubError.badURL(trimmed)
        }
        return try await getRepo(owner: owner, name: name)
    }

    func getRepo(owner: String, name: String) async throws -> GitHubRepo {
        let safeOwner = owner.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? owner
        let safeName  = name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)  ?? name
        let req = try authedRequest(path: "/repos/\(safeOwner)/\(safeName)")
        let (data, http) = try await Self.send(req)
        guard http.statusCode == 200 else {
            let message = Self.extractMessage(data, fallback: "HTTP \(http.statusCode)")
            throw GitHubError.httpError(http.statusCode, message)
        }
        do {
            return try AppJSON.decoder.decode(GitHubRepo.self, from: data)
        } catch {
            throw GitHubError.decodingError(error)
        }
    }

    // MARK: - URL parsing

    /// Returns (owner, name) for `https://github.com/<owner>/<name>(.git)?`
    /// or shorthand `<owner>/<name>`. Strips a trailing `.git` if present.
    nonisolated static func ownerAndName(from raw: String) -> (String, String)? {
        var path = raw

        // If it's a URL, only accept github.com — fail closed on enterprise
        // hosts since this v1 doesn't model alternate GHES base URLs.
        if path.hasPrefix("http") {
            guard let u = URL(string: path),
                  let host = u.host?.lowercased(),
                  host == "github.com" else { return nil }
            path = u.path
        }

        path = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let parts = path.split(separator: "/").map(String.init)
        guard parts.count >= 2 else { return nil }
        let owner = parts[0]
        var name = parts[1]
        if name.hasSuffix(".git") { name = String(name.dropLast(4)) }
        guard !owner.isEmpty, !name.isEmpty else { return nil }
        return (owner, name)
    }

    // MARK: - Internals

    private func authedRequest(path: String) throws -> URLRequest {
        guard !config.gitHubToken.isEmpty else { throw GitHubError.notConfigured }
        let url = Self.apiBase.appendingPathComponent(path)
        var req = URLRequest(url: url, timeoutInterval: 15)
        req.setValue("Bearer \(config.gitHubToken)", forHTTPHeaderField: "Authorization")
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        return req
    }

    private static func send(_ req: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw GitHubError.httpError(-1, "No HTTP response")
        }
        return (data, http)
    }

    /// GitHub error responses are `{"message": "...", "documentation_url": "..."}`.
    /// Redact the surfaced message — a 401/403 body can echo the token — to match
    /// GitLabClient/LlmIdeAPIClient, which run the same extraction through
    /// `SecretRedactor.redact`.
    private static func extractMessage(_ data: Data, fallback: String) -> String {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let msg = json["message"] as? String else { return fallback }
        return SecretRedactor.redact(msg)
    }
}
