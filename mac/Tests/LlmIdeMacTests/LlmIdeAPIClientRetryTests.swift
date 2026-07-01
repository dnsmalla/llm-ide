import Testing
import Foundation
@testable import LlmIdeMac

/// Exercises LlmIdeAPIClient.send()'s retry/error behavior through the
/// injectable fetch seam — no real network.
struct LlmIdeAPIClientRetryTests {

    private struct Ping: Decodable, Equatable { let ok: Bool }

    /// Thread-safe attempt counter for the @Sendable fetch closure.
    private actor Counter {
        private(set) var count = 0
        func bump() -> Int { count += 1; return count }
    }

    private func resp(_ url: URL, _ status: Int, _ headers: [String: String]? = nil) -> URLResponse {
        HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: headers)!
    }
    private var okJSON: Data { #"{"ok":true}"#.data(using: .utf8)! }

    @Test func getRetriesTransientStatusThenSucceeds() async throws {
        let counter = Counter()
        let client = LlmIdeAPIClient(baseURL: "https://example.test") { req in
            let n = await counter.bump()
            // First attempt 503, second 200.
            return n == 1
                ? (Data("{}".utf8), self.resp(req.url!, 503))
                : (self.okJSON, self.resp(req.url!, 200))
        }
        let ping: Ping = try await client.get("/x", authenticated: false)
        #expect(ping == Ping(ok: true))
        #expect(await counter.count == 2)   // retried exactly once
    }

    @Test func getRetriesTransientNetworkErrorThenSucceeds() async throws {
        let counter = Counter()
        let client = LlmIdeAPIClient(baseURL: "https://example.test") { req in
            let n = await counter.bump()
            if n == 1 { throw URLError(.timedOut) }
            return (self.okJSON, self.resp(req.url!, 200))
        }
        let ping: Ping = try await client.get("/x", authenticated: false)
        #expect(ping == Ping(ok: true))
        #expect(await counter.count == 2)
    }

    @Test func postIsNotRetried() async throws {
        let counter = Counter()
        let client = LlmIdeAPIClient(baseURL: "https://example.test") { req in
            _ = await counter.bump()
            return (Data("{}".utf8), self.resp(req.url!, 503))
        }
        await #expect(throws: APIError.self) {
            let _: Ping = try await client.post("/x", body: ["a": 1], authenticated: false)
        }
        // POST must fire exactly once — re-issuing could double-apply a write.
        #expect(await counter.count == 1)
    }

    @Test func nonTransientStatusIsNotRetried() async throws {
        let counter = Counter()
        let client = LlmIdeAPIClient(baseURL: "https://example.test") { req in
            _ = await counter.bump()
            return (Data("{}".utf8), self.resp(req.url!, 404))
        }
        await #expect(throws: APIError.self) {
            let _: Ping = try await client.get("/x", authenticated: false)
        }
        #expect(await counter.count == 1)
    }

    // MARK: - 401 → refresh → retry

    private func sessionJSON(access: String, refresh: String) -> Data {
        Data("""
        {"user":{"id":"u1","email":"a@b.c","displayName":"A","role":"user"},
         "accessToken":"\(access)","refreshToken":"\(refresh)","accessTokenTTLSec":3600}
        """.utf8)
    }

    @MainActor @Test func unauthorizedRefreshesTokenThenRetries() async throws {
        let store = SessionStore(server: "https://example.test")
        // Seed an expired access token + a valid refresh token.
        store.adopt(session: try JSONDecoder().decode(
            SessionResponse.self, from: sessionJSON(access: "old", refresh: "r1")))

        let counter = Counter()
        let client = LlmIdeAPIClient(baseURL: "https://example.test",
                                     sessionStore: store) { [self] req in
            let path = req.url!.path
            if path.hasSuffix("/auth/refresh") {
                // Refresh succeeds with rotated tokens.
                return (sessionJSON(access: "new", refresh: "r2"), resp(req.url!, 200))
            }
            // Protected endpoint: 401 first, 200 after the token is refreshed.
            let n = await counter.bump()
            return n == 1
                ? (Data("{}".utf8), resp(req.url!, 401))
                : (okJSON, resp(req.url!, 200))
        }

        let ping: Ping = try await client.get("/protected", authenticated: true)
        #expect(ping == Ping(ok: true))
        #expect(store.accessToken == "new")   // token was rotated
        #expect(await counter.count == 2)     // original 401 + one retry
    }

    @MainActor @Test func unauthorizedWithFailedRefreshThrowsNoSession() async throws {
        let store = SessionStore(server: "https://example.test")
        store.adopt(session: try JSONDecoder().decode(
            SessionResponse.self, from: sessionJSON(access: "old", refresh: "r1")))

        let client = LlmIdeAPIClient(baseURL: "https://example.test",
                                     sessionStore: store) { [self] req in
            let path = req.url!.path
            if path.hasSuffix("/auth/refresh") {
                return (Data("{}".utf8), resp(req.url!, 401))   // refresh rejected
            }
            return (Data("{}".utf8), resp(req.url!, 401))       // protected stays 401
        }

        await #expect(throws: APIError.self) {
            let _: Ping = try await client.get("/protected", authenticated: true)
        }
        // Failed refresh clears the session.
        #expect(store.accessToken == nil)
    }
}
