import Testing
import Foundation
@testable import LlmIdeMacLib

/// A rotated refresh token the Keychain refuses to store must be retried, not
/// dropped: the server has already retired the old one, so a lost write ends
/// in reuse detection and a logout on every device.
@MainActor
@Suite("SessionStore refresh-token persistence", .serialized)
struct SessionStoreTokenPersistTests {
    private func session(token: String) throws -> SessionResponse {
        let json = #"{"accessToken":"a","refreshToken":"\#(token)","accessTokenTTLSec":900}"#
        return try JSONDecoder().decode(SessionResponse.self, from: Data(json.utf8))
    }

    private func store(attempts: @escaping (String) -> Bool) -> SessionStore {
        let store = SessionStore(server: "http://127.0.0.1:3456")
        store.tokenPersistRetryDelays = [.milliseconds(10), .milliseconds(10), .milliseconds(10)]
        store.persistRefreshToken = { token, _ in attempts(token) }
        return store
    }

    @Test func retriesUntilKeychainAccepts() async throws {
        var calls = 0
        let store = store { _ in calls += 1; return calls >= 3 }
        store.adopt(session: try session(token: "rt-1"))
        try await Task.sleep(for: .milliseconds(200))
        #expect(calls == 3)
    }

    @Test func stopsRetryingAfterSignOut() async throws {
        var calls = 0
        let store = store { _ in calls += 1; return false }
        store.adopt(session: try session(token: "rt-1"))
        store.clear()
        try await Task.sleep(for: .milliseconds(200))
        #expect(calls == 1)
    }

    @Test func staleTokenIsNotRetriedAfterRotation() async throws {
        var seen: [String] = []
        let store = store { token in seen.append(token); return token == "rt-2" }
        store.adopt(session: try session(token: "rt-1"))
        store.adopt(session: try session(token: "rt-2"))
        try await Task.sleep(for: .milliseconds(200))
        #expect(seen == ["rt-1", "rt-2"])
    }
}
