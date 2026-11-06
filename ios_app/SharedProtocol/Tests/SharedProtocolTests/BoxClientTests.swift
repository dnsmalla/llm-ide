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
    }

    @Test func redirectsDropTheBearerOffHostAndRefuseHttp() {
        var api = URLRequest(url: URL(string: "https://api.box.com/2.0/files/1/content")!)
        api.setValue("Bearer x", forHTTPHeaderField: "Authorization")
        var hop = URLRequest(url: URL(string: "https://dl.boxcloud.com/d/1/abc")!)
        hop.setValue("Bearer x", forHTTPHeaderField: "Authorization")
        #expect(BoxClient.redirected(hop, from: api)?.value(forHTTPHeaderField: "Authorization") == nil)
        #expect(BoxClient.redirected(URLRequest(url: URL(string: "http://dl.boxcloud.com/x")!), from: api) == nil)
    }
}
