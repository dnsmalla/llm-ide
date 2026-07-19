import Foundation

/// Centralized authentication operations. Single source of truth for:
/// - Bearer token header building
/// - Custom token header (PRIVATE-TOKEN, X-Auth-Token) building
/// - Token validation
/// - Secret redaction
/// - OAuth flow helpers
///
/// Replaces scattered token/header logic across 6+ services.
struct AuthenticationUtilities {
    enum AuthError: LocalizedError {
        case emptyToken
        case invalidToken
        case invalidCredentials
        case tokenExpired
        case insufficientPermissions

        var errorDescription: String? {
            switch self {
            case .emptyToken:
                return "Authentication token is empty"
            case .invalidToken:
                return "Invalid authentication token"
            case .invalidCredentials:
                return "Invalid credentials"
            case .tokenExpired:
                return "Token has expired"
            case .insufficientPermissions:
                return "Insufficient permissions"
            }
        }
    }

    enum TokenType {
        case bearer
        case privateToken
        case xAuthToken
        case custom(headerName: String)
    }

    // MARK: - Token Validation

    /// Validate token is non-empty and reasonable length.
    static func validateToken(_ token: String) throws {
        let trimmed = token.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else {
            throw AuthError.emptyToken
        }
        guard trimmed.count >= 20 else {
            throw AuthError.invalidToken
        }
    }

    // MARK: - Header Building

    static func makeBearerHeader(token: String) throws -> (key: String, value: String) {
        try validateToken(token)
        return ("Authorization", "Bearer \(token)")
    }

    static func makePrivateTokenHeader(token: String) throws -> (key: String, value: String) {
        try validateToken(token)
        return ("PRIVATE-TOKEN", token)
    }

    static func makeXAuthTokenHeader(token: String) throws -> (key: String, value: String) {
        try validateToken(token)
        return ("X-Auth-Token", token)
    }

    static func makeCustomHeader(name: String, token: String) throws -> (key: String, value: String) {
        try validateToken(token)
        return (name, token)
    }

    static func makeAuthHeader(token: String, type: TokenType = .bearer) throws -> (key: String, value: String) {
        switch type {
        case .bearer: return try makeBearerHeader(token: token)
        case .privateToken: return try makePrivateTokenHeader(token: token)
        case .xAuthToken: return try makeXAuthTokenHeader(token: token)
        case .custom(let name): return try makeCustomHeader(name: name, token: token)
        }
    }

    // MARK: - Basic Auth

    /// Build Basic authentication header: "Basic <base64>"
    static func makeBasicAuthHeader(username: String, password: String) throws -> (key: String, value: String) {
        let credentials = "\(username):\(password)"
        guard let data = credentials.data(using: .utf8) else {
            throw AuthError.invalidCredentials
        }
        let encoded = data.base64EncodedString()
        return ("Authorization", "Basic \(encoded)")
    }

    // MARK: - Secret Redaction

    /// Redact token for logging: show first 2 chars and last 2 chars.
    static func redactedForLogging(_ token: String) -> String {
        guard token.count > 4 else { return "***" }
        let prefix = String(token.prefix(2))
        let suffix = String(token.suffix(2))
        return "\(prefix)...\(suffix)"
    }

    /// Remove auth headers from a URL for logging.
    static func sanitizeURLForLogging(_ url: URL) -> String {
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        // Remove query parameters that might contain tokens
        components?.queryItems = nil
        return components?.url?.absoluteString ?? url.absoluteString
    }

    /// Remove sensitive headers from request for logging.
    static func sanitizeHeadersForLogging(_ headers: [String: String]) -> [String: String] {
        var sanitized = headers
        let sensitiveKeys = ["Authorization", "PRIVATE-TOKEN", "X-Auth-Token", "X-API-Key", "Cookie"]
        for key in sensitiveKeys {
            if let value = sanitized[key] {
                sanitized[key] = redactedForLogging(value)
            }
        }
        return sanitized
    }

    // MARK: - OAuth Flow Helpers

    /// Generate OAuth authorization URL.
    static func makeOAuthAuthorizationURL(
        baseURL: URL,
        clientId: String,
        redirectURI: String,
        scopes: [String],
        state: String
    ) -> URL? {
        var components = URLComponents(url: baseURL.appendingPathComponent("/oauth/authorize"), resolvingAgainstBaseURL: true)
        components?.queryItems = [
            URLQueryItem(name: "client_id", value: clientId),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "scope", value: scopes.joined(separator: " ")),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "response_type", value: "code")
        ]
        return components?.url
    }

    /// Extract authorization code from OAuth callback URL.
    static func extractAuthorizationCode(from callbackURL: URL) -> String? {
        guard let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false) else {
            return nil
        }
        return components.queryItems?.first(where: { $0.name == "code" })?.value
    }

    // MARK: - Token Expiration

    /// Check if JWT token is expired (simple check based on exp claim).
    static func isJWTExpired(_ token: String) -> Bool {
        let parts = token.split(separator: ".").map(String.init)
        guard parts.count == 3 else { return false }

        // Decode payload (second part)
        var payload = parts[1]
        // Add padding if needed
        let padding = 4 - (payload.count % 4)
        if padding != 4 {
            payload += String(repeating: "=", count: padding)
        }

        guard let data = Data(base64Encoded: payload) else { return false }

        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return false
        }

        // Check exp claim
        if let exp = json["exp"] as? TimeInterval {
            return Date().timeIntervalSince1970 > exp
        }

        return false
    }

    // MARK: - Error Handling

    /// Check if error is auth-related and extract reason.
    static func isAuthError(_ error: Error) -> (isAuth: Bool, reason: AuthError?) {
        if let authError = error as? AuthError {
            return (true, authError)
        }

        let nsError = error as NSError
        // HTTP 401 Unauthorized
        if nsError.code == 401 {
            return (true, .tokenExpired)
        }
        // HTTP 403 Forbidden
        if nsError.code == 403 {
            return (true, .insufficientPermissions)
        }

        return (false, nil)
    }
}
