import Foundation
import CryptoKit

/// Device OAuth for direct reads (design §9, Q11, Q12): authorization code + PKCE S256, read-only scopes by default.
/// Owned by SP7; SP6 (Box sync on devices) passes its own `scope`. The app presents `authorizeURL` with
/// ASWebAuthenticationSession and a `llmide-oauth://<provider>/callback` redirect (iOS 16; https callbacks need 17.4).
public enum SourceProvider: String, Codable, Sendable, CaseIterable { case gitlab, box }

public struct SourceAppConfig: Codable, Equatable, Sendable {
    public var clientId: String
    public var clientSecret: String?
    public init(clientId: String, clientSecret: String? = nil) { self.clientId = clientId; self.clientSecret = clientSecret }
}

public struct SourceTokens: Codable, Equatable, Sendable {
    public var access: String
    public var refresh: String?
    public var expiresAtMs: Int
    public init(access: String, refresh: String?, expiresAtMs: Int) { self.access = access; self.refresh = refresh; self.expiresAtMs = expiresAtMs }
}

public enum SourceOAuthError: Error, Equatable, Sendable {
    case badClientId, badClientSecret, badTokenResponse, scopeTooWide, grantExpired, clientRefused, providerError, unreachable, cancelled, stateMismatch, failed
}

public enum SourceOAuth {
    public static let callbackScheme = "llmide-oauth"
    public static func redirectURI(_ p: SourceProvider) -> String { "\(callbackScheme)://\(p.rawValue)/callback" }

    struct Endpoints { let authorize: URL; let token: URL; let revoke: URL; let scope: String }
    static func endpoints(_ p: SourceProvider) -> Endpoints {
        switch p {
        case .gitlab: return Endpoints(authorize: URL(string: "https://gitlab.com/oauth/authorize")!, token: URL(string: "https://gitlab.com/oauth/token")!,
                                       revoke: URL(string: "https://gitlab.com/oauth/revoke")!, scope: "read_api read_repository")
        case .box: return Endpoints(authorize: URL(string: "https://account.box.com/api/oauth2/authorize")!, token: URL(string: "https://api.box.com/oauth2/token")!,
                                    revoke: URL(string: "https://api.box.com/oauth2/revoke")!, scope: "root_readonly")
        }
    }

    public static func base64url(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    public static func randomString(bytes: Int = 32, random: (Int) -> Data = SyncCrypto.randomBytes) -> String { base64url(random(bytes)) }
    public static func challenge(for verifier: String) -> String { base64url(Data(SHA256.hash(data: Data(verifier.utf8)))) }

    public static func check(_ p: SourceProvider, _ c: SourceAppConfig) throws -> SourceAppConfig {
        guard c.clientId.range(of: #"^[A-Za-z0-9_-]{8,128}$"#, options: .regularExpression) != nil else { throw SourceOAuthError.badClientId }
        if p == .gitlab { return SourceAppConfig(clientId: c.clientId) }
        guard let s = c.clientSecret, s.range(of: #"^[A-Za-z0-9]{16,128}$"#, options: .regularExpression) != nil else { throw SourceOAuthError.badClientSecret }
        return SourceAppConfig(clientId: c.clientId, clientSecret: s)
    }

    public static func authorizeURL(_ p: SourceProvider, _ c: SourceAppConfig, state: String, challenge: String, scope: String? = nil) -> URL {
        var u = URLComponents(url: endpoints(p).authorize, resolvingAgainstBaseURL: false)!
        u.queryItems = [URLQueryItem(name: "client_id", value: c.clientId), URLQueryItem(name: "redirect_uri", value: redirectURI(p)),
                        URLQueryItem(name: "response_type", value: "code"), URLQueryItem(name: "state", value: state),
                        URLQueryItem(name: "scope", value: scope ?? endpoints(p).scope), URLQueryItem(name: "code_challenge", value: challenge),
                        URLQueryItem(name: "code_challenge_method", value: "S256")]
        return u.url!
    }

    public static func code(fromCallback url: URL, state: String) throws -> String {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func v(_ n: String) -> String? { items.first { $0.name == n }?.value }
        guard v("state") == state else { throw SourceOAuthError.stateMismatch }
        if v("error") == "access_denied" { throw SourceOAuthError.cancelled }
        guard let c = v("code"), c.range(of: #"^[A-Za-z0-9._~-]{8,2048}$"#, options: .regularExpression) != nil else { throw SourceOAuthError.failed }
        return c
    }

    public static func parseTokens(_ data: Data, nowMs: Int) throws -> SourceTokens {
        guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let access = o["access_token"] as? String,
              (8...4096).contains(access.count) else { throw SourceOAuthError.badTokenResponse }
        let refresh = o["refresh_token"] as? String
        if let r = refresh, r.count > 4096 { throw SourceOAuthError.badTokenResponse }
        if let scope = o["scope"] as? String, scope.range(of: #"(^|\s)(api|write_repository|root_readwrite)(\s|$)"#, options: .regularExpression) != nil {
            throw SourceOAuthError.scopeTooWide
        }
        let ttl = min(max((o["expires_in"] as? Int) ?? 3600, 1), 86_400)
        return SourceTokens(access: access, refresh: refresh, expiresAtMs: nowMs + ttl * 1000 - 60_000)
    }

    static func post(_ url: URL, _ form: [(String, String)], transport: SourceTransport) async throws -> Data {
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data(form.map { "\($0.0)=\(SourceHTTP.enc($0.1))" }.joined(separator: "&").utf8)
        let data: Data, resp: HTTPURLResponse
        do { (data, resp, _) = try await transport(req, 65_536) } catch { throw SourceOAuthError.unreachable }
        guard (200..<300).contains(resp.statusCode) else {
            let err = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["error"] as? String
            if resp.statusCode == 400 || resp.statusCode == 401 { throw err == "invalid_grant" ? SourceOAuthError.grantExpired : SourceOAuthError.clientRefused }
            throw SourceOAuthError.providerError
        }
        return data
    }

    public static func exchange(_ p: SourceProvider, _ c: SourceAppConfig, code: String, verifier: String, nowMs: Int,
                                transport: SourceTransport = SourceHTTP.urlSessionTransport) async throws -> SourceTokens {
        var form = [("grant_type", "authorization_code"), ("code", code), ("client_id", c.clientId), ("redirect_uri", redirectURI(p)), ("code_verifier", verifier)]
        // Box documents no PKCE and requires its secret (spec §8.2); the verifier is sent anyway and is harmless.
        if p == .box { form.append(("client_secret", c.clientSecret ?? "")) }
        return try parseTokens(try await post(endpoints(p).token, form, transport: transport), nowMs: nowMs)
    }

    public static func refresh(_ p: SourceProvider, _ c: SourceAppConfig, refreshToken: String, nowMs: Int,
                               transport: SourceTransport = SourceHTTP.urlSessionTransport) async throws -> SourceTokens {
        var form = [("grant_type", "refresh_token"), ("refresh_token", refreshToken), ("client_id", c.clientId)]
        if p == .gitlab { form.append(("redirect_uri", redirectURI(p))) } else { form.append(("client_secret", c.clientSecret ?? "")) }
        return try parseTokens(try await post(endpoints(p).token, form, transport: transport), nowMs: nowMs)
    }

    /// Best effort: a failed revoke still ends the session here, and the token expires on its own.
    public static func revoke(_ p: SourceProvider, _ c: SourceAppConfig, token: String, transport: SourceTransport = SourceHTTP.urlSessionTransport) async {
        var form = [("client_id", c.clientId), ("token", token)]
        if p == .box { form.append(("client_secret", c.clientSecret ?? "")) }
        _ = try? await post(endpoints(p).revoke, form, transport: transport)
    }
}
