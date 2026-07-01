import Testing
import Foundation
@testable import LlmIdeMac

/// Exercises SettingsSync's pull/apply/push cycle through the injectable
/// fetch seam on LlmIdeAPIClient — no real network, no real server.
///
/// Central scenario under test: a repo added locally that never made it to
/// the server (e.g. the app quit inside the 1.5s push debounce) must
/// survive the NEXT launch's bootstrap()->apply(), not be silently deleted
/// by a wholesale replace-with-remote.
@MainActor
struct SettingsSyncTests {

    // MARK: - Harness

    /// Records every PUT body and lets the test script GET responses.
    private actor Recorder {
        private(set) var putBodies: [Data] = []
        private(set) var getCount = 0
        private(set) var putCount = 0
        func recordPut(_ data: Data) { putBodies.append(data); putCount += 1 }
        func recordGet() { getCount += 1 }
    }

    private func makeConfig() -> AppConfig {
        let suite = "settingssync-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return AppConfig(userDefaults: defaults)
    }

    private nonisolated func resp(_ url: URL, _ status: Int = 200) -> URLResponse {
        HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!
    }

    /// A signed-in SessionStore — SettingsSync always calls the API with
    /// `authenticated: true`, which throws `.noSession` without a token.
    private func makeAuthedSessionStore() throws -> SessionStore {
        let store = SessionStore(server: "https://example.test")
        let session = try JSONDecoder().decode(SessionResponse.self, from: Data("""
        {"user":{"id":"u1","email":"a@b.c","displayName":"A","role":"user"},
         "accessToken":"tok","refreshToken":"r1","accessTokenTTLSec":3600}
        """.utf8))
        store.adopt(session: session)
        return store
    }

    /// Builds a client whose GET /kb/settings always returns `getSettingsJSON`
    /// and whose PUT /kb/settings records the body and acks `{"ok":true}`.
    private func makeClient(
        sessionStore: SessionStore,
        getSettingsJSON: @escaping @Sendable () async -> String,
        recorder: Recorder
    ) -> LlmIdeAPIClient {
        LlmIdeAPIClient(baseURL: "https://example.test", sessionStore: sessionStore) { req in
            let path = req.url!.path
            if path.hasSuffix("/kb/settings") && req.httpMethod == "GET" {
                await recorder.recordGet()
                let json = await getSettingsJSON()
                return (Data(json.utf8), self.resp(req.url!))
            }
            if path.hasSuffix("/kb/settings") && req.httpMethod == "PUT" {
                if let body = req.httpBody {
                    await recorder.recordPut(body)
                }
                return (Data(#"{"ok":true}"#.utf8), self.resp(req.url!))
            }
            return (Data("{}".utf8), self.resp(req.url!, 404))
        }
    }

    /// Decode a PUT body's `.settings.gitHubSavedRepos` ids for assertions.
    private func githubIds(inPutBody data: Data) -> [String] {
        struct Wrapper: Decodable { let settings: SettingsSync.Snapshot }
        guard let wrapper = try? JSONDecoder().decode(Wrapper.self, from: data) else { return [] }
        return wrapper.settings.gitHubSavedRepos.map { $0.id }
    }

    // MARK: - Bug fix: local-only repo survives bootstrap()

    /// The scenario from the audit: repoA is known to both machines/server.
    /// repoB was added locally but the debounced push never fired before
    /// quit, so the server has never heard of it. On relaunch, bootstrap()
    /// must not let repoB vanish just because the remote snapshot lacks it.
    @Test func bootstrapPreservesLocalOnlyRepoMissingFromRemote() async throws {
        let config = makeConfig()
        var repoA = SavedGitHubRepo(url: "https://github.com/acme/repoA", displayName: "repoA")
        repoA.localPath = "/Users/me/Code/repoA"
        var repoB = SavedGitHubRepo(url: "https://github.com/acme/repoB", displayName: "repoB")
        repoB.localPath = "/Users/me/Code/repoB"
        config.gitHubSavedRepos = [repoA, repoB]

        // Server only knows about repoA — repoB's push never went out.
        let remoteJSON = """
        {"settings":{"schemaVersion":1,"gitHubSavedRepos":[\
        {"id":"\(repoA.id)","url":"\(repoA.url)","displayName":"repoA","isActive":false}\
        ],"gitLabSavedProjects":[]}}
        """
        let recorder = Recorder()
        let sessionStore = try makeAuthedSessionStore()
        let client = makeClient(sessionStore: sessionStore, getSettingsJSON: { remoteJSON }, recorder: recorder)
        let sync = SettingsSync(api: client, config: config)

        await sync.bootstrap()

        let ids = Set(config.gitHubSavedRepos.map { $0.id })
        #expect(ids.contains(repoA.id), "server-known repo must survive")
        #expect(ids.contains(repoB.id), "local-only repo must NOT be silently dropped")
        #expect(config.gitHubSavedRepos.count == 2)

        // repoA's localPath is preserved via the id-match merge.
        #expect(config.gitHubSavedRepos.first(where: { $0.id == repoA.id })?.localPath == repoA.localPath)
        // repoB's localPath (never stripped, since it never left this machine) survives too.
        #expect(config.gitHubSavedRepos.first(where: { $0.id == repoB.id })?.localPath == repoB.localPath)
    }

    /// Recovering a local-only repo must trigger a push so the server
    /// catches up — otherwise the SAME repo would be at risk of being
    /// dropped again on a later launch before another local edit re-arms
    /// the debounce.
    @Test func recoveringLocalOnlyRepoTriggersAPush() async throws {
        let config = makeConfig()
        var repoA = SavedGitHubRepo(url: "https://github.com/acme/repoA", displayName: "repoA")
        repoA.localPath = "/Users/me/Code/repoA"
        let repoB = SavedGitHubRepo(url: "https://github.com/acme/repoB", displayName: "repoB")
        config.gitHubSavedRepos = [repoA, repoB]

        let remoteJSON = """
        {"settings":{"schemaVersion":1,"gitHubSavedRepos":[\
        {"id":"\(repoA.id)","url":"\(repoA.url)","displayName":"repoA","isActive":false}\
        ],"gitLabSavedProjects":[]}}
        """
        let recorder = Recorder()
        let sessionStore = try makeAuthedSessionStore()
        let client = makeClient(sessionStore: sessionStore, getSettingsJSON: { remoteJSON }, recorder: recorder)
        let sync = SettingsSync(api: client, config: config)

        await sync.bootstrap()

        let putCount = await recorder.putCount
        #expect(putCount >= 1, "recovering a local-only repo must push the merged state back")
        let bodies = await recorder.putBodies
        if let last = bodies.last {
            let ids = Set(githubIds(inPutBody: last))
            #expect(ids.contains(repoB.id), "the recovered repo must be in the pushed payload")
        }
    }

    /// When remote already has everything local has, apply() must not
    /// spuriously report a recovery, and bootstrap() must not fire an
    /// extra push — otherwise every launch would perform a needless write.
    @Test func noPushWhenRemoteAlreadyHasEverything() async throws {
        let config = makeConfig()
        var repoA = SavedGitHubRepo(url: "https://github.com/acme/repoA", displayName: "repoA")
        repoA.localPath = "/Users/me/Code/repoA"
        config.gitHubSavedRepos = [repoA]

        let remoteJSON = """
        {"settings":{"schemaVersion":1,"gitHubSavedRepos":[\
        {"id":"\(repoA.id)","url":"\(repoA.url)","displayName":"repoA","isActive":false}\
        ],"gitLabSavedProjects":[]}}
        """
        let recorder = Recorder()
        let sessionStore = try makeAuthedSessionStore()
        let client = makeClient(sessionStore: sessionStore, getSettingsJSON: { remoteJSON }, recorder: recorder)
        let sync = SettingsSync(api: client, config: config)

        await sync.bootstrap()

        let putCount = await recorder.putCount
        #expect(putCount == 0, "nothing new to report — bootstrap should not push")
    }

    // MARK: - mergeLocalPaths matching semantics (via apply through bootstrap)

    /// A repo present on both sides, matched by URL rather than id (e.g. the
    /// id was regenerated on another machine), must still receive its local
    /// checkout path and must NOT be duplicated as a "local-only" addition.
    @Test func urlMatchPreventsDuplicateWhenIdsDiffer() async throws {
        let config = makeConfig()
        var local = SavedGitHubRepo(url: "https://github.com/acme/repoA", displayName: "repoA")
        local.localPath = "/Users/me/Code/repoA"
        config.gitHubSavedRepos = [local]

        // Same URL, different id (as if resaved on another machine).
        let remoteJSON = """
        {"settings":{"schemaVersion":1,"gitHubSavedRepos":[\
        {"id":"different-id","url":"\(local.url)","displayName":"repoA","isActive":false}\
        ],"gitLabSavedProjects":[]}}
        """
        let recorder = Recorder()
        let sessionStore = try makeAuthedSessionStore()
        let client = makeClient(sessionStore: sessionStore, getSettingsJSON: { remoteJSON }, recorder: recorder)
        let sync = SettingsSync(api: client, config: config)

        await sync.bootstrap()

        #expect(config.gitHubSavedRepos.count == 1, "URL match must prevent a duplicate entry")
        #expect(config.gitHubSavedRepos.first?.localPath == local.localPath)
        #expect(config.gitHubSavedRepos.first?.id == "different-id", "server's id wins for a known repo")
    }

    // MARK: - Seeding an empty server

    @Test func bootstrapSeedsEmptyServerFromLocalState() async throws {
        let config = makeConfig()
        var repo = SavedGitHubRepo(url: "https://github.com/acme/repoA", displayName: "repoA")
        repo.localPath = "/Users/me/Code/repoA"
        config.gitHubSavedRepos = [repo]

        let recorder = Recorder()
        let sessionStore = try makeAuthedSessionStore()
        // Server has no settings yet.
        let client = makeClient(sessionStore: sessionStore, getSettingsJSON: { #"{"settings":{}}"# }, recorder: recorder)
        let sync = SettingsSync(api: client, config: config)

        await sync.bootstrap()

        let putCount = await recorder.putCount
        #expect(putCount == 1, "an empty server must be seeded from local state")
        let bodies = await recorder.putBodies
        if let body = bodies.first {
            #expect(githubIds(inPutBody: body).contains(repo.id))
        }
    }
}
