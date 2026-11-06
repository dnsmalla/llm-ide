import Foundation
import Testing
@testable import SharedProtocol

@MainActor
struct BoxClientTests {
    func client(_ s: FakeBoxServer, folder: String = "llmide-sync") -> BoxClient {
        BoxClient(folder: folder, app: s.app, tokens: s.grant(), transport: s.transport)
    }

    @Test func readsWhatTheDesktopWroteAndAbsentIsNil() async throws {
        let s = FakeBoxServer()
        s.seed("llmide-sync/S/d/D/manifest.bin", Data("m".utf8))
        let c = client(s)
        #expect(try await c.get("S/d/D/manifest.bin") == Data("m".utf8))
        #expect(try await c.get("S/d/D/none.bin") == nil)
        #expect(try await c.get("S/x/y.bin") == nil)
        #expect(!s.bearerAtDownload)
    }

    @Test func writesAreWriteOnceAndNeverCreateTheSyncFolder() async throws {
        let s = FakeBoxServer()
        await #expect(throws: BoxClient.Failure.missing) { try await client(s).put("S/e/X/c.bin", Data("c".utf8), createFolders: 1) }
        s.mkdirs("llmide-sync/S")
        let c = client(s)
        try await c.put("S/e/X/c.bin", Data("c".utf8), createFolders: 1)
        try await c.put("S/e/X/c.bin", Data("again".utf8), createFolders: 1)
        #expect(s.uploads == 1)
        await #expect(throws: BoxClient.Failure.missing) { try await c.put("S/nope/in/x.bin", Data(), createFolders: 3) }
    }

    @Test func a401RefreshesOnceAndReportsTheRotatedTokens() async throws {
        let s = FakeBoxServer()
        s.seed("llmide-sync/S/x.bin", Data("1".utf8))
        let c = client(s)
        var seen: [BoxClient.Tokens] = []
        c.onTokens = { seen.append($0) }
        s.access.removeAll()
        #expect(try await c.get("S/x.bin") == Data("1".utf8))
        #expect(seen.count == 1 && seen[0] == c.tokens)
        s.access.removeAll(); s.refresh.removeAll()
        await #expect(throws: BoxClient.Failure.authFailed) { _ = try await c.get("S/x.bin") }
    }

    @Test func rateLimitAndRevoke() async throws {
        let s = FakeBoxServer()
        s.mkdirs("llmide-sync")
        let c = client(s)
        s.failNext["GET /2.0/folders/0/items"] = 429
        await #expect(throws: BoxClient.Failure.rateLimited) { _ = try await c.get("S/x.bin") }
        await c.revoke()
        #expect(s.revoked == [c.tokens.refresh])
    }

    @Test func codeExchangeSendsTheSecretAndVerifierAndRefusesAWrongClient() async throws {
        let s = FakeBoxServer()
        let (verifier, challenge) = BoxClient.pkce()
        #expect(challenge == SyncB64.encode(SyncCrypto.sha256(Data(verifier.utf8))))
        let t = try await BoxClient.exchange(code: s.issueCode(), verifier: verifier, app: s.app, transport: s.transport)
        #expect(s.access.contains(t.access))
        let wrong = BoxClient.App(clientId: s.app.clientId, clientSecret: String(repeating: "w", count: 32))
        await #expect(throws: BoxClient.Failure.badClient) { _ = try await BoxClient.exchange(code: s.issueCode(), verifier: verifier, app: wrong, transport: s.transport) }
        let url = BoxClient.authorizeURL(app: s.app, state: "i.abc", challenge: challenge)
        #expect(url.absoluteString.hasPrefix("https://account.box.com/api/oauth2/authorize?"))
        #expect(url.absoluteString.contains("redirect_uri=llmide-box"))
        #expect(url.absoluteString.contains("scope=root_readwrite"))
    }

    @Test func onlyBoxHostsOverHttpsAreAllowedAndAnOffHostLandingIsRefused() async throws {
        for ok in ["https://api.box.com/2.0/x", "https://upload.box.com/api/2.0/files/content", "https://dl.boxcloud.com/d/1/a", "https://public.boxcloud.com/a"] {
            #expect(BoxClient.isAllowed(URL(string: ok)!), "\(ok)")
        }
        for bad in ["http://dl.boxcloud.com/x", "https://evil.example/x", "https://gitlab.com/x", "https://dl.boxcloud.com:8443/x", "https://u@api.box.com/x"] {
            #expect(!BoxClient.isAllowed(URL(string: bad)!), "\(bad)")
        }
        let s = FakeBoxServer()
        s.mkdirs("llmide-sync")
        let evil: BoxClient.Transport = { _ in (Data("{}".utf8), HTTPURLResponse(url: URL(string: "https://evil.example/x")!, statusCode: 200, httpVersion: nil, headerFields: nil)!) }
        let c = BoxClient(folder: "llmide-sync", app: s.app, tokens: s.grant(), transport: evil)
        await #expect(throws: BoxClient.Failure.badResponse) { _ = try await c.get("S/x.bin") }
    }

    @Test func concurrent401sShareOneRefresh() async throws {
        let s = FakeBoxServer()
        s.seed("llmide-sync/S/a.bin", Data("a".utf8)); s.seed("llmide-sync/S/b.bin", Data("b".utf8))
        let c = client(s)
        var seen = 0
        c.onTokens = { _ in seen += 1 }
        s.access.removeAll()
        async let a = c.get("S/a.bin")
        async let b = c.get("S/b.bin")
        let (x, y) = try await (a, b)
        #expect(x == Data("a".utf8) && y == Data("b".utf8))
        #expect(s.refreshCalls == 1 && seen == 1, "Box refresh tokens are single use: one refresh for both")
    }

    @Test func aRefreshThatLandsAfterRevokeIsRevokedAndNeverReported() async throws {
        let s = FakeBoxServer()
        s.seed("llmide-sync/S/x.bin", Data("1".utf8))
        let c = client(s)
        var seen = 0
        c.onTokens = { _ in seen += 1 }
        s.access.removeAll()
        var revokedDuring = false
        s.tokenGate = { [unowned s] in s.tokenGate = nil; await c.revoke(); revokedDuring = true }
        await #expect(throws: BoxClient.Failure.authFailed) { _ = try await c.get("S/x.bin") }
        #expect(revokedDuring && seen == 0, "a sign-out is never undone by a late rotation")
        #expect(s.revoked.count == 2, "the old refresh token, then the one the late refresh returned")
        await #expect(throws: BoxClient.Failure.authFailed) { _ = try await c.get("S/x.bin") }
    }
}
