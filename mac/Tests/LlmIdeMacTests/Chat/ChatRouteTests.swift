import Testing
import Foundation
@testable import LlmIdeMacLib

/// Session router on the Mac (K1 Phase 6b): the chat file's optional route key and its sidecar mirror,
/// the route model's open/restore/refresh/raise behaviour against a scripted API, and the backend's
/// router environment. No network, no server.
@Suite("Chat route (session router)", .serialized)
@MainActor
struct ChatRouteTests {

    // MARK: helpers

    nonisolated static func state(seq: Int = 0, provider: String = "", model: String = "", limit: Int? = nil,
                      billable: Int = 0, cacheRead: Int = 0, enabled: Bool = true,
                      appliesAt: String? = nil, changed: Bool? = nil) throws -> LlmIdeAPIClient.ChatRouteState {
        let limitJSON = limit.map(String.init) ?? "null"
        let extra = (appliesAt.map { ",\"appliesAt\":\"\($0)\"" } ?? "") + (changed.map { ",\"changed\":\($0)" } ?? "")
        let json = """
        {"enabled":\(enabled),"capEnforced":true,"chatSessionId":"c","provider":"\(provider)","model":"\(model)",
         "pinned":\(!provider.isEmpty),"pinnedBy":"user","tokenLimit":\(limitJSON),
         "used":{"in":\(billable),"out":0,"cacheWrite":0,"cacheRead":\(cacheRead),"billable":\(billable)},
         "remaining":null,"stickyUntil":null,"warm":{},"switchSeq":\(seq),"pending":null,"updatedAt":null\(extra)}
        """
        return try JSONDecoder().decode(LlmIdeAPIClient.ChatRouteState.self, from: Data(json.utf8))
    }

    /// Records every call; answers from closures the test sets.
    final class Script: @unchecked Sendable {
        var fetchAnswer: @Sendable (String) async throws -> LlmIdeAPIClient.ChatRouteState = { _ in try ChatRouteTests.state() }
        var putAnswer: @Sendable (LlmIdeAPIClient.ChatRoutePatch) async throws -> LlmIdeAPIClient.ChatRouteState = { _ in try ChatRouteTests.state(seq: 1) }
        private let lock = NSLock()
        private var _puts: [LlmIdeAPIClient.ChatRoutePatch] = []
        private var _fetches = 0
        var puts: [LlmIdeAPIClient.ChatRoutePatch] { lock.lock(); defer { lock.unlock() }; return _puts }
        var fetches: Int { lock.lock(); defer { lock.unlock() }; return _fetches }
        var api: ChatRouteModel.API {
            ChatRouteModel.API(
                fetch: { [self] id in lock.lock(); _fetches += 1; lock.unlock(); return try await fetchAnswer(id) },
                put: { [self] p in lock.lock(); _puts.append(p); lock.unlock(); return try await putAnswer(p) },
                history: { _ in LlmIdeAPIClient.ChatRouteHistory(events: [], degraded: false) })
        }
    }

    func withRouterPref<T>(_ on: Bool, _ body: () async throws -> T) async rethrows -> T {
        let key = ChatRoutePreference.routerKey
        let old = UserDefaults.standard.object(forKey: key)
        UserDefaults.standard.set(on, forKey: key)
        defer { if let old { UserDefaults.standard.set(old, forKey: key) } else { UserDefaults.standard.removeObject(forKey: key) } }
        return try await body()
    }

    func settle() async { for _ in 0..<20 { await Task.yield(); try? await Task.sleep(nanoseconds: 2_000_000) } }

    // MARK: chat file

    @Test func oldFileWithoutRouteDecodesAndRouteRoundTrips() throws {
        let plain = ChatSession(scope: .quick, title: "t")
        let data = try AppJSON.encoder.encode(plain)
        let obj = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(obj["route"] == nil, "an unrouted chat writes no key")
        #expect(try AppJSON.decoder.decode(ChatSession.self, from: data).route == nil)

        var routed = plain
        routed.route = ChatRouteSettings(provider: "anthropic", model: "m", tokenLimit: 9_000, tokensUsed: 120)
        let back = try AppJSON.decoder.decode(ChatSession.self, from: try AppJSON.encoder.encode(routed))
        #expect(back.route == routed.route)
    }

    @Test func aGarbledRouteKeyNeverFailsTheChat() throws {
        let plain = ChatSession(scope: .quick, title: "t")
        var obj = try #require(try JSONSerialization.jsonObject(with: AppJSON.encoder.encode(plain)) as? [String: Any])
        obj["route"] = ["tokenLimit": "not a number"]
        let data = try JSONSerialization.data(withJSONObject: obj)
        let decoded = try AppJSON.decoder.decode(ChatSession.self, from: data)
        #expect(decoded.route == nil)
        #expect(decoded.title == "t")
    }

    @Test func sidecarRestoresARouteAnOldBuildDropped() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("chat-route-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("sessions"), withIntermediateDirectories: true)
        let previous = ChatSessionStore.baseDirectoryOverride
        ChatSessionStore.baseDirectoryOverride = dir
        ChatSessionStore.Tags.resetCache()
        defer { ChatSessionStore.baseDirectoryOverride = previous; ChatSessionStore.Tags.resetCache(); try? FileManager.default.removeItem(at: dir) }

        var s = ChatSession(scope: .quick, title: "routed")
        s.route = ChatRouteSettings(provider: "anthropic", model: "m", tokenLimit: 50_000, tokensUsed: 700)
        ChatSessionStore.save(s)
        #expect(ChatSessionStore.Tags.tag(for: s.id)?.route == s.route, "the sidecar mirrors the route")

        // An old build re-saves the file without the key it does not know.
        let file = dir.appendingPathComponent("sessions/\(s.id.uuidString).json")
        var obj = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        obj.removeValue(forKey: "route")
        try JSONSerialization.data(withJSONObject: obj).write(to: file)
        #expect(ChatSessionStore.load(id: s.id)?.route == s.route, "the tag re-applies the route on load")

        // Clearing the route removes the tag too.
        var cleared = try #require(ChatSessionStore.load(id: s.id))
        cleared.route = nil
        ChatSessionStore.Tags.remove(s.id)
        ChatSessionStore.save(cleared)
        #expect(ChatSessionStore.Tags.tag(for: s.id)?.route == nil)
    }

    // MARK: route model

    @Test func openAfterQuitRestoresTheFileToTheServerWithTokensUsed() async throws {
        try await withRouterPref(true) {
            let script = Script()
            let model = ChatRouteModel()
            model.wire(script.api)
            model.sessionChanged(id: "c", file: ChatRouteSettings(provider: "anthropic", model: "m", tokenLimit: 50_000, tokensUsed: 4_000))
            script.putAnswer = { _ in try Self.state(seq: 1, provider: "anthropic", model: "m", limit: 50_000, billable: 4_000) }
            await settle()
            let put = try #require(script.puts.first)
            #expect(put.provider == "anthropic" && put.model == "m")
            #expect(put.tokensUsed == 4_000, "the cap survives a quit (answer Q-R2)")
            #expect(put.ifSeq == 0)
            #expect(model.server?.switchSeq == 1)
        }
    }

    @Test func aLiveServerRowIsAdoptedIntoTheFile() async throws {
        try await withRouterPref(true) {
            let script = Script()
            script.fetchAnswer = { _ in try Self.state(seq: 5, provider: "anthropic", model: "m", limit: 50_000, billable: 9_000) }
            let model = ChatRouteModel()
            var persisted = 0
            model.onSettingsChanged = { persisted += 1 }
            model.wire(script.api)
            model.sessionChanged(id: "c", file: ChatRouteSettings(provider: "anthropic", model: "m", tokenLimit: 50_000, tokensUsed: 4_000))
            await settle()
            #expect(script.puts.isEmpty)
            #expect(model.fileSettings?.tokensUsed == 9_000)
            #expect(persisted == 1)
        }
    }

    @Test func routerPrefOffMakesNoCalls() async {
        await withRouterPref(false) {
            let script = Script()
            let model = ChatRouteModel()
            model.wire(script.api)
            model.sessionChanged(id: "c", file: ChatRouteSettings(tokenLimit: 5))
            model.turnFinished()
            await settle()
            #expect(script.fetches == 0 && script.puts.isEmpty)
            #expect(model.sendsHistory == false)
        }
    }

    @Test func aLateAnswerForAnotherChatIsIgnored() async throws {
        try await withRouterPref(true) {
            let script = Script()
            script.fetchAnswer = { id in
                if id == "slow" { try await Task.sleep(nanoseconds: 60_000_000) }
                return try Self.state(seq: 2, provider: "anthropic", model: id == "slow" ? "from-slow" : "from-fast", billable: 1)
            }
            let model = ChatRouteModel()
            model.wire(script.api)
            model.sessionChanged(id: "slow", file: nil)
            model.sessionChanged(id: "fast", file: nil)
            try await Task.sleep(nanoseconds: 150_000_000)
            #expect(model.server?.model == "from-fast")
        }
    }

    @Test func turnFinishedMirrorsTheServersCounters() async throws {
        try await withRouterPref(true) {
            let script = Script()
            script.fetchAnswer = { _ in try Self.state(seq: 1, provider: "anthropic", model: "m", limit: 1_000, billable: 100, cacheRead: 90_000) }
            let model = ChatRouteModel()
            model.wire(script.api)
            model.sessionChanged(id: "c", file: nil)
            await settle()
            script.fetchAnswer = { _ in try Self.state(seq: 1, provider: "anthropic", model: "m", limit: 1_000, billable: 850, cacheRead: 95_000) }
            model.turnFinished()
            await settle()
            #expect(model.billableUsed == 850)
            #expect(model.level == .warn)
            #expect(model.meter == "850 / 1k (+95k cached reads)")
            #expect(model.fileSettings?.tokensUsed == 850)
        }
    }

    @Test func pinningMarksTheNextTurnAsCarryingHistoryUntilItFinishes() async throws {
        try await withRouterPref(true) {
            let script = Script()
            script.fetchAnswer = { _ in try Self.state(seq: 1, provider: "anthropic", model: "a") }
            script.putAnswer = { _ in try Self.state(seq: 2, provider: "custom:cat-groq", model: "g", appliesAt: "now", changed: true) }
            let model = ChatRouteModel()
            model.wire(script.api)
            model.sessionChanged(id: "c", file: nil)
            await settle()
            await model.pin(provider: "custom:cat-groq", model: "g")
            #expect(script.puts.last?.provider == "custom:cat-groq" && script.puts.last?.ifSeq == 1)
            #expect(model.sendsHistory)
            script.fetchAnswer = { _ in try Self.state(seq: 2, provider: "custom:cat-groq", model: "g") }
            model.turnFinished()
            await settle()
            #expect(model.sendsHistory, "a pinned adapter chat keeps sending history (no server session)")
        }
    }

    @Test func raiseAtTheCapPutsTheRaisedLimitAndClearsTheRefusal() async throws {
        try await withRouterPref(true) {
            let script = Script()
            script.fetchAnswer = { _ in try Self.state(seq: 1, provider: "anthropic", model: "m", limit: 200_000, billable: 200_100) }
            script.putAnswer = { p in try Self.state(seq: 2, provider: "anthropic", model: "m", limit: p.tokenLimit.flatMap { $0 }, billable: 200_100) }
            let model = ChatRouteModel()
            model.wire(script.api)
            model.sessionChanged(id: "c", file: nil)
            await settle()
            #expect(model.atCap)
            await model.raiseLimit()
            #expect(script.puts.last?.tokenLimit == .some(300_000))
            #expect(model.atCap == false)
        }
    }

    @Test func aRefusalAtTheCapOffersTheRaiseEvenBeforeTheCountersRefresh() {
        let model = ChatRouteModel()
        model.sessionChanged(id: "c", file: ChatRouteSettings(tokenLimit: 100, tokensUsed: 10))
        model.noteRefusedAtCap(used: 120, limit: 100)
        #expect(model.atCap)
        #expect(model.fileSettings?.tokensUsed == 120)
    }

    @Test func aLostRaceRefetchesAndSaysSo() async throws {
        try await withRouterPref(true) {
            let script = Script()
            script.fetchAnswer = { _ in try Self.state(seq: 4, limit: 10) }
            script.putAnswer = { _ in throw APIError.http(status: 409, code: "ROUTE_CONFLICT", message: "changed", details: nil) }
            let model = ChatRouteModel()
            model.wire(script.api)
            model.sessionChanged(id: "c", file: nil)
            await settle()
            let before = script.fetches
            await model.setLimit(99)
            #expect(script.fetches > before)
            #expect(model.errorText?.contains("another window") == true)
        }
    }

    @Test func aServerWithTheRouterOffShowsNothingAndSendsNoHistory() async throws {
        try await withRouterPref(true) {
            let script = Script()
            script.fetchAnswer = { _ in try Self.state(enabled: false) }
            let model = ChatRouteModel()
            model.wire(script.api)
            model.sessionChanged(id: "c", file: ChatRouteSettings(provider: "anthropic", model: "m"))
            await settle()
            #expect(model.serverEnabled == false)
            #expect(model.sendsHistory == false)
            #expect(script.puts.isEmpty)
        }
    }

    // MARK: backend environment

    @Test func inheritedRouterSwitchesAreDroppedAndOnlyTheAppsOwnAreWritten() {
        let base = ["PATH": "/usr/bin", "LLMIDE_ROUTER": "on", "LLMIDE_ROUTER_CAP": "on", "LLMIDE_ROUTER_COMPRESS": "on", "LLMIDE_ROUTER_LEARN": "on"]
        let off = BackendManager.childEnvironment(base: base, featureKeys: nil)
        for k in BackendManager.routerEnvKeys { #expect(off[k] == nil, "\(k) must not pass through") }
        let on = BackendManager.childEnvironment(base: base, featureKeys: nil, routerEnv: ["LLMIDE_ROUTER": "on", "EVIL": "x"])
        #expect(on["LLMIDE_ROUTER"] == "on" && on["LLMIDE_ROUTER_CAP"] == nil && on["EVIL"] == nil)
    }

    @Test func theTurnCarriesTheFilesRouteWhenThePrefIsOnAndNothingOtherwise() async {
        await withRouterPref(true) {
            let model = ChatRouteModel()
            model.sessionChanged(id: "c", file: ChatRouteSettings(tokenLimit: 100, tokensUsed: 40))
            #expect(model.seedForTurn == ChatRouteSettings(tokenLimit: 100, tokensUsed: 40))
            model.sessionChanged(id: "d", file: nil)
            #expect(model.seedForTurn == nil)
        }
        await withRouterPref(false) {
            let model = ChatRouteModel()
            model.sessionChanged(id: "c", file: ChatRouteSettings(tokenLimit: 100))
            #expect(model.seedForTurn == nil)
        }
    }

    @Test func theFirstSendWaitsForARestoreButNeverLongerThanTheTimeout() async throws {
        try await withRouterPref(true) {
            let script = Script()
            script.fetchAnswer = { _ in try await Task.sleep(nanoseconds: 200_000_000); return try Self.state(seq: 0) }
            script.putAnswer = { _ in try Self.state(seq: 1, provider: "anthropic", model: "m", limit: 100, billable: 40) }
            let model = ChatRouteModel()
            model.wire(script.api)
            model.sessionChanged(id: "c", file: ChatRouteSettings(provider: "anthropic", model: "m", tokenLimit: 100, tokensUsed: 40))
            #expect(model.reconciling)
            await model.awaitReady(timeout: 3)
            #expect(model.reconciling == false)
            #expect(script.puts.count == 1, "the restore landed before the send")

            // A restore that hangs: the send goes after the timeout, still carrying the seed.
            let slow = Script()
            slow.fetchAnswer = { _ in try await Task.sleep(nanoseconds: 2_000_000_000); return try Self.state() }
            let m2 = ChatRouteModel()
            m2.wire(slow.api)
            m2.sessionChanged(id: "c", file: ChatRouteSettings(tokenLimit: 100, tokensUsed: 40))
            let started = Date()
            await m2.awaitReady(timeout: 0.15)
            #expect(Date().timeIntervalSince(started) < 1.0)
            #expect(m2.seedForTurn?.tokensUsed == 40)
        }
    }

    @Test func aFailedRestoreStillLeavesTheSeedForTheTurn() async {
        await withRouterPref(true) {
            let script = Script()
            script.fetchAnswer = { _ in throw APIError.http(status: 503, code: "ROUTE_UNAVAILABLE", message: "down", details: nil) }
            let model = ChatRouteModel()
            model.wire(script.api)
            model.sessionChanged(id: "c", file: ChatRouteSettings(tokenLimit: 100, tokensUsed: 100))
            await model.awaitReady(timeout: 2)
            #expect(model.reconciling == false)
            #expect(model.seedForTurn?.tokenLimit == 100 && model.seedForTurn?.tokensUsed == 100)
        }
    }
}
