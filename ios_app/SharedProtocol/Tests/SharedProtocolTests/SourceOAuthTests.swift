import Testing
import Foundation
@testable import SharedProtocol

@MainActor
@Suite("SourceOAuth: PKCE, read-only authorize URLs, callback parsing, token forms")
struct SourceOAuthTests {
    let gl = SourceAppConfig(clientId: String(repeating: "a", count: 64))
    let box = SourceAppConfig(clientId: String(repeating: "b", count: 32), clientSecret: "boxsecret0123456789abcdef")

    @Test("RFC 7636 appendix B vector; verifiers are 43 url-safe characters")
    func pkce() {
        #expect(SourceOAuth.challenge(for: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        #expect(SourceOAuth.randomString().range(of: #"^[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil)
    }

    @Test("authorize URLs: read-only scopes, S256, custom-scheme redirect, no secret")
    func authorize() throws {
        let g = URLComponents(url: SourceOAuth.authorizeURL(.gitlab, gl, state: "st", challenge: "ch"), resolvingAgainstBaseURL: false)!
        func q(_ c: URLComponents, _ n: String) -> String? { c.queryItems?.first { $0.name == n }?.value }
        #expect(g.host == "gitlab.com"); #expect(g.path == "/oauth/authorize")
        #expect(q(g, "scope") == "read_api read_repository")
        #expect(q(g, "code_challenge_method") == "S256")
        #expect(q(g, "redirect_uri") == "llmide-oauth://gitlab/callback")
        let b = URLComponents(url: SourceOAuth.authorizeURL(.box, box, state: "st", challenge: "ch"), resolvingAgainstBaseURL: false)!
        #expect(b.host == "account.box.com"); #expect(q(b, "scope") == "root_readonly"); #expect(q(b, "client_secret") == nil)
        let sp6 = URLComponents(url: SourceOAuth.authorizeURL(.box, box, state: "s", challenge: "c", scope: "root_readwrite"), resolvingAgainstBaseURL: false)!
        #expect(q(sp6, "scope") == "root_readwrite")
        #expect(throws: SourceOAuthError.badClientId) { try SourceOAuth.check(.gitlab, SourceAppConfig(clientId: "x")) }
        #expect(throws: SourceOAuthError.badClientSecret) { try SourceOAuth.check(.box, SourceAppConfig(clientId: box.clientId)) }
        #expect(try SourceOAuth.check(.gitlab, SourceAppConfig(clientId: gl.clientId, clientSecret: "drop")).clientSecret == nil)
    }

    @Test("callback: state must match; access_denied is a cancel; the code is shape-checked")
    func callback() throws {
        #expect(try SourceOAuth.code(fromCallback: URL(string: "llmide-oauth://gitlab/callback?code=good-code-123&state=S")!, state: "S") == "good-code-123")
        #expect(throws: SourceOAuthError.stateMismatch) { try SourceOAuth.code(fromCallback: URL(string: "llmide-oauth://gitlab/callback?code=good-code-123&state=X")!, state: "S") }
        #expect(throws: SourceOAuthError.cancelled) { try SourceOAuth.code(fromCallback: URL(string: "llmide-oauth://box/callback?error=access_denied&state=S")!, state: "S") }
        #expect(throws: SourceOAuthError.failed) { try SourceOAuth.code(fromCallback: URL(string: "llmide-oauth://box/callback?code=%3Cx%3E&state=S")!, state: "S") }
    }

    @Test("tokens: strict parse, wide scopes refused, expiry a minute early")
    func tokens() throws {
        let t = try SourceOAuth.parseTokens(Data(#"{"access_token":"acc-12345678","refresh_token":"r1","expires_in":7200,"scope":"read_api read_repository"}"#.utf8), nowMs: 1000)
        #expect(t == SourceTokens(access: "acc-12345678", refresh: "r1", expiresAtMs: 1000 + 7_200_000 - 60_000))
        #expect(throws: SourceOAuthError.scopeTooWide) { try SourceOAuth.parseTokens(Data(#"{"access_token":"acc-12345678","scope":"api"}"#.utf8), nowMs: 0) }
        #expect(throws: SourceOAuthError.scopeTooWide) { try SourceOAuth.parseTokens(Data(#"{"access_token":"acc-12345678","scope":"read_api read_repository sudo"}"#.utf8), nowMs: 0) }
        #expect(throws: SourceOAuthError.badTokenResponse) { try SourceOAuth.parseTokens(Data(#"{"access_token":1}"#.utf8), nowMs: 0) }
    }

    @Test("exchange and refresh post the right forms; Box adds its secret; errors map")
    func forms() async throws {
        var bodies: [[String: String]] = []
        var status = 200
        let transport: SourceTransport = { req, _ in
            var c = URLComponents(); c.percentEncodedQuery = String(decoding: req.httpBody ?? Data(), as: UTF8.self)
            bodies.append(Dictionary((c.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a }))
            let body = status == 200 ? #"{"access_token":"acc-12345678","refresh_token":"r2","expires_in":3600}"# : #"{"error":"invalid_grant"}"#
            return (Data(body.utf8), HTTPURLResponse(url: req.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, false)
        }
        _ = try await SourceOAuth.exchange(.gitlab, gl, code: "good-code-123", verifier: "v", nowMs: 0, transport: transport)
        #expect(bodies[0] == ["grant_type": "authorization_code", "code": "good-code-123", "client_id": gl.clientId, "redirect_uri": "llmide-oauth://gitlab/callback", "code_verifier": "v"])
        _ = try await SourceOAuth.exchange(.box, box, code: "good-code-123", verifier: "v", nowMs: 0, transport: transport)
        #expect(bodies[1]["client_secret"] == box.clientSecret)
        _ = try await SourceOAuth.refresh(.box, box, refreshToken: "r1", nowMs: 0, transport: transport)
        #expect(bodies[2] == ["grant_type": "refresh_token", "refresh_token": "r1", "client_id": box.clientId, "client_secret": box.clientSecret!])
        status = 400
        await #expect(throws: SourceOAuthError.grantExpired) { _ = try await SourceOAuth.refresh(.gitlab, gl, refreshToken: "r", nowMs: 0, transport: transport) }
        await SourceOAuth.revoke(.gitlab, gl, token: "t", transport: { _, _ in throw URLError(.notConnectedToInternet) })
    }
}
