import Foundation
import os.log

/// Errors mirror the server's stable code envelope so the UI can switch
/// on a known set of values rather than parsing prose.
enum APIError: LocalizedError {
    case http(status: Int, code: String, message: String, details: Any?)
    case network(Error)
    case decoding(Error)
    case invalidURL
    case noSession

    private static let log = Logger(subsystem: "com.meetnotes.macapp", category: "APIError")

    var errorDescription: String? {
        switch self {
        case .http(_, _, let message, _): return message
        case .network(let err):
            // Distinguish "server not reachable" (most common: backend
            // not running, wrong port, ATS blocking) from generic
            // network errors so the user can act on it.
            let ns = err as NSError
            if ns.domain == NSURLErrorDomain {
                switch ns.code {
                case NSURLErrorCannotConnectToHost,
                     NSURLErrorCannotFindHost:
                    return "Could not reach the server. Is `node server.mjs` running on this URL?"
                case NSURLErrorTimedOut:
                    return "Request timed out. The server may still be processing — check the Backend log in Settings."
                case NSURLErrorAppTransportSecurityRequiresSecureConnection:
                    return "macOS App Transport Security blocked the request. Rebuild the app — Info.plist needs NSAppTransportSecurity for plain http://localhost."
                case NSURLErrorNotConnectedToInternet:
                    return "No network connection."
                default:
                    return "Network error: \(err.localizedDescription)"
                }
            }
            return "Network error: \(err.localizedDescription)"
        case .decoding(let err):
            // The raw DecodingError (e.g. "keyNotFound CodingKeys(...)") is
            // gibberish to a user and can leak schema details. Log it for
            // devs and show a generic message in the UI.
            Self.log.error("Decoding error: \(String(describing: err), privacy: .public)")
            return "The server returned an unexpected response."
        case .invalidURL: return "Invalid server URL."
        case .noSession: return "Not signed in."
        }
    }

    var code: String {
        switch self {
        case .http(_, let c, _, _): return c
        case .network: return "NETWORK_ERROR"
        case .decoding: return "DECODING_ERROR"
        case .invalidURL: return "INVALID_URL"
        case .noSession: return "AUTH_REQUIRED"
        }
    }
}

// --- Wire structures ---------------------------------------------------

struct LoginRequest: Encodable {
    let email: String
    let password: String
}

struct RegisterRequest: Encodable {
    let email: String
    let password: String
    let displayName: String?
}

struct SessionResponse: Decodable {
    let user: UserInfo
    let accessToken: String
    let refreshToken: String
    let accessTokenTTLSec: Int
}

struct RefreshRequest: Encodable {
    let refreshToken: String
}

struct UserInfo: Codable, Identifiable, Equatable {
    let id: String
    let email: String
    let displayName: String
    let role: String
    let status: String?
    let createdAt: String?
    let lastLoginAt: String?
}

struct WellKnownResponse: Decodable {
    let issuer: String
    let registrationOpen: Bool
    let vaultKeys: [String]
    let accessTokenTTLSec: Int
}

// --- Standard error envelope from the server --------------------------

private struct ErrorEnvelope: Decodable {
    let error: ErrorBody?
    struct ErrorBody: Decodable {
        let code: String?
        let message: String?
    }
}

/// Some legacy routes return a flat `{ "error": "message" }` instead
/// of the structured envelope above. This shape parses both so the
/// real error message reaches the user instead of "HTTP 500".
private struct FlatErrorEnvelope: Decodable {
    let error: String?
}

/// Single-tenant client paired with the `SessionStore`.  Reads its
/// access token from the store on every call so token rotation
/// (background refresh) is transparent to call sites.
final class MeetNotesAPIClient {
    let baseURL: String
    /// Short-timeout session for `/auth/*` — login, refresh, register,
    /// prefs, secrets. These are cheap server-side; a 240 s timeout
    /// here meant a hung backend kept the login spinner alive for the
    /// full 4 minutes on relaunch.
    private let authSession: URLSession
    /// Long-timeout session for LLM-backed endpoints (/code-assist,
    /// /chat, /generate-*, /agent/*). 240 s matches the server's
    /// Claude CLI ceiling plus headroom.
    private let llmSession: URLSession
    /// Test seam: when set, every request is routed here instead of the real
    /// URLSessions. Production code never sets this (defaults to nil).
    typealias DataFetcher = @Sendable (URLRequest) async throws -> (Data, URLResponse)
    private let fetchOverride: DataFetcher?
    private let log = Logger(subsystem: "com.meetnotes.macapp", category: "API")
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder
    private weak var sessionStore: SessionStore?
    /// Optional reference to ProjectStore so write endpoints can stamp
    /// the active project's id onto outgoing payloads (server-side
    /// scoping for per-project search).  Held weakly; nil means "no
    /// active project context" and writes go through untagged — that
    /// matches existing rows and the server treats absence as such.
    private weak var projectStore: ProjectStore?

    init(baseURL: String, sessionStore: SessionStore? = nil,
         fetchOverride: DataFetcher? = nil) {
        self.baseURL = baseURL.hasSuffix("/") ? String(baseURL.dropLast()) : baseURL
        self.fetchOverride = fetchOverride

        let authCfg = URLSessionConfiguration.default
        authCfg.timeoutIntervalForRequest = 10
        authCfg.timeoutIntervalForResource = 15
        self.authSession = URLSession(configuration: authCfg)

        let llmCfg = URLSessionConfiguration.default
        llmCfg.timeoutIntervalForRequest = 240
        llmCfg.timeoutIntervalForResource = 10 * 60
        self.llmSession = URLSession(configuration: llmCfg)

        self.sessionStore = sessionStore

        let d = JSONDecoder()
        d.keyDecodingStrategy = .useDefaultKeys
        self.decoder = d
        self.encoder = JSONEncoder()
    }

    // --- Public surface -----------------------------------------------

    func wellKnown() async throws -> WellKnownResponse {
        try await get("/auth/well-known", authenticated: false)
    }

    // --- Internals -----------------------------------------------------

    func get<T: Decodable>(_ path: String, authenticated: Bool) async throws -> T {
        try await send(path: path, method: "GET", body: Optional<EmptyBody>.none, authenticated: authenticated)
    }

    func post<B: Encodable, T: Decodable>(_ path: String, body: B, authenticated: Bool) async throws -> T {
        try await send(path: path, method: "POST", body: body, authenticated: authenticated)
    }

    func put<B: Encodable, T: Decodable>(_ path: String, body: B, authenticated: Bool) async throws -> T {
        try await send(path: path, method: "PUT", body: body, authenticated: authenticated)
    }

    func delete<T: Decodable>(_ path: String, authenticated: Bool) async throws -> T {
        try await send(path: path, method: "DELETE", body: Optional<EmptyBody>.none, authenticated: authenticated)
    }

    /// Upload raw bytes (Content-Type controlled by caller). Used for
    /// plugin install where the body is a zip archive. Bypasses the
    /// JSON encoder. Mirrors `send()`'s 401 → refresh-and-retry path.
    func postRawBytes<T: Decodable>(_ path: String, bytes: Data, contentType: String, authenticated: Bool, isRetry: Bool = false) async throws -> T {
        guard let url = URL(string: baseURL + path) else { throw APIError.invalidURL }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue(contentType, forHTTPHeaderField: "Content-Type")
        if authenticated {
            let token: String? = await MainActor.run { sessionStore?.accessToken }
            guard let token else { throw APIError.noSession }
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        req.httpBody = bytes
        let (data, response): (Data, URLResponse)
        do { (data, response) = try await fetch(req, path: path) }
        catch { throw APIError.network(error) }
        guard let http = response as? HTTPURLResponse else {
            throw APIError.network(URLError(.badServerResponse))
        }
        if http.statusCode == 401 && authenticated && !isRetry, let store = sessionStore {
            let hasRefresh = await MainActor.run { store.refreshToken != nil }
            if hasRefresh {
                let ok = await store.attemptRefresh(via: self)
                if ok {
                    return try await postRawBytes(path, bytes: bytes, contentType: contentType, authenticated: authenticated, isRetry: true)
                }
            }
        }
        if !(200..<300).contains(http.statusCode) {
            let env = try? decoder.decode(ErrorEnvelope.self, from: data)
            throw APIError.http(
                status: http.statusCode,
                code: env?.error?.code ?? "HTTP_ERROR",
                message: env?.error?.message ?? "Request failed",
                details: nil
            )
        }
        return try decoder.decode(T.self, from: data)
    }

    /// Empty-body marker so the generic POST/GET share one implementation.
    struct EmptyBody: Encodable {}

    func send<B: Encodable, T: Decodable>(
        path: String, method: String, body: B?, authenticated: Bool, isRetry: Bool = false
    ) async throws -> T {
        guard let url = URL(string: baseURL + path) else { throw APIError.invalidURL }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")

        if authenticated {
            // SessionStore is @MainActor — hop over to read the token.
            // Synchronous reads from a non-isolated context could race
            // with concurrent rotation in `adopt(session:)`.
            let token: String? = await MainActor.run { sessionStore?.accessToken }
            guard let token else { throw APIError.noSession }
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body = body {
            req.httpBody = try encoder.encode(body)
        }

        // Only GETs are safe to auto-retry — re-issuing a POST/PUT/DELETE could
        // double-apply a side effect. Transient connectivity blips and transient
        // server statuses (429/502/503/504) get a bounded backoff.
        let isGET = method == "GET"
        let maxAttempts = 3
        var attempt = 0
        while true {
            attempt += 1
            let data: Data
            let response: URLResponse
            do {
                (data, response) = try await fetch(req, path: path)
            } catch {
                if isGET, attempt < maxAttempts, Self.isTransient(error) {
                    try? await Task.sleep(nanoseconds: Self.backoffNanos(attempt))
                    continue
                }
                throw APIError.network(error)
            }

            guard let http = response as? HTTPURLResponse else {
                throw APIError.network(URLError(.badServerResponse))
            }

            // 401 retry path — refresh the access token once, then re-issue.
            if http.statusCode == 401 && authenticated && !isRetry, let store = sessionStore {
                let hasRefresh = await MainActor.run { store.refreshToken != nil }
                if hasRefresh {
                    let ok = await store.attemptRefresh(via: self)
                    if ok {
                        return try await send(path: path, method: method, body: body, authenticated: authenticated, isRetry: true)
                    }
                }
            }

            // Transient server status → backoff + retry (GET only), honoring
            // a server-supplied Retry-After.
            if isGET, attempt < maxAttempts, [429, 502, 503, 504].contains(http.statusCode) {
                let delay = Self.retryAfterNanos(http) ?? Self.backoffNanos(attempt)
                try? await Task.sleep(nanoseconds: delay)
                continue
            }

            // An unrecoverable 401 means the session is gone — surface a clear
            // "signed out" signal instead of a generic HTTP 401 so the UI can
            // prompt re-login rather than showing an opaque error.
            if http.statusCode == 401 && authenticated {
                throw APIError.noSession
            }

            if !(200..<300).contains(http.statusCode) {
                let env = try? decoder.decode(ErrorEnvelope.self, from: data)
                let flat = try? decoder.decode(FlatErrorEnvelope.self, from: data)
                let raw = String(data: data, encoding: .utf8)?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                let code = env?.error?.code ?? "UPSTREAM_ERROR"
                let msg = env?.error?.message
                    ?? flat?.error
                    ?? (raw?.isEmpty == false ? raw! : "HTTP \(http.statusCode)")
                throw APIError.http(status: http.statusCode, code: code, message: msg, details: nil)
            }

            do {
                return try decoder.decode(T.self, from: data)
            } catch {
                throw APIError.decoding(error)
            }
        }
    }

    // MARK: - Retry helpers

    /// True for connectivity blips that are worth a short retry (GET only).
    static func isTransient(_ error: Error) -> Bool {
        let ns = error as NSError
        guard ns.domain == NSURLErrorDomain else { return false }
        switch ns.code {
        case NSURLErrorTimedOut, NSURLErrorCannotConnectToHost,
             NSURLErrorNetworkConnectionLost, NSURLErrorDNSLookupFailed:
            return true
        default:
            return false
        }
    }

    /// Exponential backoff: 0.4s, 0.8s, … capped at 5s.
    static func backoffNanos(_ attempt: Int) -> UInt64 {
        let base = 0.4 * pow(2.0, Double(max(0, attempt - 1)))
        return UInt64(min(base, 5.0) * 1_000_000_000)
    }

    /// Parse a `Retry-After` header (delta-seconds form), capped at 10s.
    static func retryAfterNanos(_ http: HTTPURLResponse) -> UInt64? {
        guard let v = http.value(forHTTPHeaderField: "Retry-After"),
              let secs = Double(v.trimmingCharacters(in: .whitespaces)),
              secs >= 0 else { return nil }
        return UInt64(min(secs, 10.0) * 1_000_000_000)
    }

    /// Percent-encode a single path *segment* (not a full path).
    /// Uses `.urlPathAllowed` minus `/` so a value like `foo/bar` becomes
    /// `foo%2Fbar` and can never silently inject extra path components into
    /// the URL.  Applies to IDs, slugs, and any other single-segment value
    /// inserted into a URL path.
    func percentEncoded(_ s: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
    }

    // sessionStore accessor used by extension files
    var _sessionStore: SessionStore? { sessionStore }
    // projectStore accessor used by extension files (KB write paths).
    var _projectStore: ProjectStore? {
        get { projectStore }
        set { projectStore = newValue }
    }
    /// Extension files (streaming export, etc.) need a session with the
    /// long timeout — those are LLM/IO heavy, never `/auth/*`.
    var _session: URLSession { llmSession }

    /// Pick the URLSession that fits the endpoint. `/auth/*` and the
    /// `/auth/me/*` family use the short-timeout session so a hung
    /// backend can't keep the login UI spinning. Everything else falls
    /// through to the long-timeout LLM session.
    func session(for path: String) -> URLSession {
        path.hasPrefix("/auth/") ? authSession : llmSession
    }

    /// Single fetch entry point — honors the test override, else picks the
    /// right URLSession for the path.
    func fetch(_ req: URLRequest, path: String) async throws -> (Data, URLResponse) {
        if let fetchOverride { return try await fetchOverride(req) }
        return try await session(for: path).data(for: req)
    }
}
