import Foundation
import Observation
import os

private let routeLog = Logger(subsystem: "com.llmide.macapp", category: "chat-route")

/// One chat's session-router state on the Mac: the server's route row, what the chat file mirrors,
/// the switch history and the control's actions (K1 Phase 6b, docs/spec/session-router.md).
///
/// The pure decisions live in `ChatRouteLogic` (Core/Contracts); this class only sequences them with
/// the network. It never blocks or fails a turn: every network error is a banner line in the control,
/// and with the router off on the server (`enabled == false`) nothing here is shown.
@MainActor
@Observable
final class ChatRouteModel {
    /// The three calls, injected so a test scripts them and the engine wires the real client.
    struct API: Sendable {
        var fetch: @Sendable (String) async throws -> LlmIdeAPIClient.ChatRouteState
        var put: @Sendable (LlmIdeAPIClient.ChatRoutePatch) async throws -> LlmIdeAPIClient.ChatRouteState
        var history: @Sendable (String) async throws -> LlmIdeAPIClient.ChatRouteHistory
    }

    private(set) var api: API?
    /// Attach the network calls. A chat that was opened before the client existed reconciles now.
    func wire(_ api: API) {
        self.api = api
        guard routerPref, !chatSessionId.isEmpty, server == nil else { return }
        let mine = epoch
        reconciling = true
        Task { await reconcileOnOpen(epoch: mine) }
    }
    /// Fired when `settings` changed, so the engine persists the chat file (and the tags sidecar).
    var onSettingsChanged: (() -> Void)?

    private(set) var chatSessionId = ""
    /// What the chat file keeps (nil = nothing worth keeping).
    private(set) var settings: ChatRouteSettings?
    /// The server's latest row for this chat.
    private(set) var server: LlmIdeAPIClient.ChatRouteState?
    private(set) var history: [LlmIdeAPIClient.ChatRouteEvent] = []
    private(set) var historyDegraded = false
    /// The last switch notice of a turn (shown once in the control).
    private(set) var lastSwitch: ChatRouteSwitchNotice?
    /// The last budget notice (`warn80` / `reached`).
    private(set) var lastBudget: ChatSessionBudgetNotice?
    /// A line for the control: a refused change, a lost race, an unreachable server.
    var errorText: String?
    /// True from a change until the next turn finishes: that turn must carry the history.
    private(set) var changedSinceLastTurn = false
    /// A turn was refused at the cap (402 SESSION_TOKEN_LIMIT): the control offers the one-click raise.
    private(set) var refusedAtCap = false

    /// Epoch guards a late network answer against a chat switch.
    private var epoch = 0
    /// True while the open-time reconcile (and so a possible restore PUT) is in flight.
    private(set) var reconciling = false

    /// The chat file's copy of its route, for the next turn's `routeSeed`: nil with the router pref off or nothing to say.
    var seedForTurn: ChatRouteSettings? {
        guard routerPref, let settings, !settings.isEmpty else { return nil }
        return settings
    }

    /// Hold the first send of a reopened chat until the restore resolves, but never longer than `timeout`
    /// (the turn then goes out carrying `seedForTurn`, so the server still caps it).
    func awaitReady(timeout: TimeInterval = 3) async {
        let deadline = Date().addingTimeInterval(timeout)
        while reconciling, Date() < deadline { try? await Task.sleep(nanoseconds: 40_000_000) }
    }

    var routerPref: Bool { ChatRoutePreference.routerEnabled() }
    var serverEnabled: Bool { server?.enabled == true }
    var capEnforced: Bool { server?.capEnforced == true }

    /// Billable tokens used, from the server when known, else from the file's mirror.
    var billableUsed: Int { server?.used.billable ?? settings?.tokensUsed ?? 0 }
    var tokenLimit: Int? { server?.tokenLimit ?? settings?.tokenLimit }
    var cacheRead: Int { server?.used.cacheRead ?? 0 }
    var level: ChatRouteLogic.Level { ChatRouteLogic.level(used: billableUsed, limit: tokenLimit) }
    var atCap: Bool { refusedAtCap || level == .reached }
    var meter: String { ChatRouteLogic.meterText(used: billableUsed, limit: tokenLimit, cacheRead: cacheRead) }
    var pinnedLabel: String? {
        guard let s = settings, s.isPinned, let model = s.model else { return nil }
        return model
    }
    var pendingLabel: String? { server?.pending.map(\.model) }

    /// Whether the next turn should carry the packed history (`ChatTransportInput.routeSendsHistory`).
    var sendsHistory: Bool {
        guard serverEnabled else { return false }
        return ChatRouteLogic.sendsHistory(settings: settings, changedSinceLastTurn: changedSinceLastTurn)
    }

    // MARK: - Chat lifecycle

    /// A chat was opened (or created). Resets everything, then reconciles the file with the server.
    func sessionChanged(id: String, file: ChatRouteSettings?) {
        epoch += 1
        chatSessionId = id
        settings = file
        server = nil
        history = []
        historyDegraded = false
        lastSwitch = nil
        lastBudget = nil
        errorText = nil
        changedSinceLastTurn = false
        refusedAtCap = false
        reconciling = false
        guard routerPref, !id.isEmpty, api != nil else { return }
        let mine = epoch
        reconciling = true
        Task { await reconcileOnOpen(epoch: mine) }
    }

    private func reconcileOnOpen(epoch mine: Int) async {
        guard let api else { if mine == epoch { reconciling = false }; return }
        defer { if mine == epoch { reconciling = false } }
        do {
            let fetched = try await api.fetch(chatSessionId)
            guard mine == epoch else { return }
            server = fetched
            guard fetched.enabled else { return }
            switch ChatRouteLogic.onOpen(file: settings, server: fetched.snapshot) {
            case .none:
                break
            case .adoptServer(let adopted):
                setSettings(adopted)
            case .restoreToServer(let file):
                // Q-R2: the server's row was purged at quit; the file re-creates it, tokens used included.
                let patch = LlmIdeAPIClient.ChatRoutePatch(
                    chatSessionId: chatSessionId,
                    provider: file.isPinned ? file.provider : nil, model: file.isPinned ? file.model : nil,
                    tokenLimit: file.tokenLimit.map { Optional($0) },
                    tokensUsed: file.tokensUsed > 0 ? file.tokensUsed : nil, ifSeq: 0)
                let restored = try await api.put(patch)
                guard mine == epoch else { return }
                server = restored
            }
        } catch {
            guard mine == epoch else { return }
            // A server older than API 91 answers 404; anything else is a hiccup. Never loud.
            routeLog.notice("route open failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// A turn finished (any outcome): the server's counters moved, so read them and mirror them.
    func turnFinished() {
        changedSinceLastTurn = false
        guard serverEnabled, api != nil else { return }
        let mine = epoch
        Task { await refresh(epoch: mine) }
    }

    func refresh() async { await refresh(epoch: epoch) }

    private func refresh(epoch mine: Int) async {
        guard let api, !chatSessionId.isEmpty else { return }
        do {
            let fetched = try await api.fetch(chatSessionId)
            guard mine == epoch else { return }
            applyServer(fetched)
        } catch {
            routeLog.notice("route refresh failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - Notices from the stream

    func apply(_ notice: ChatRouteSwitchNotice) { lastSwitch = notice }

    func apply(_ notice: ChatSessionBudgetNotice) {
        lastBudget = notice
        if notice.level == "reached" { refusedAtCap = true }
    }

    /// The turn was refused before any model call (402 SESSION_TOKEN_LIMIT).
    func noteRefusedAtCap(used: Int?, limit: Int?) {
        refusedAtCap = true
        if let limit, var s = settings { s.tokenLimit = limit; if let used { s.tokensUsed = used }; setSettings(s) }
    }

    // MARK: - Actions (the control)

    /// Pin the chat to a provider and model, or unpin with nil. Applies at the next turn start when a
    /// turn is running (the server says so in `appliesAt`).
    func pin(provider: String?, model: String?) async {
        let pinned = (provider ?? "").isEmpty ? nil : provider
        await put(LlmIdeAPIClient.ChatRoutePatch(
            chatSessionId: chatSessionId, provider: pinned ?? "", model: pinned == nil ? "" : (model ?? ""),
            ifSeq: server?.switchSeq), switching: true)
    }

    /// Set the cap in billable tokens, or nil for none.
    func setLimit(_ limit: Int?) async {
        await put(LlmIdeAPIClient.ChatRoutePatch(
            chatSessionId: chatSessionId, tokenLimit: .some(limit), ifSeq: server?.switchSeq), switching: false)
    }

    /// The one-click raise at the cap (answer Q-R5).
    func raiseLimit() async {
        let current = tokenLimit ?? billableUsed
        await setLimit(ChatRouteLogic.raisedLimit(current: current, used: billableUsed))
        refusedAtCap = false
    }

    private func put(_ patch: LlmIdeAPIClient.ChatRoutePatch, switching: Bool) async {
        guard let api, !chatSessionId.isEmpty else { return }
        let mine = epoch
        errorText = nil
        do {
            let state = try await api.put(patch)
            guard mine == epoch else { return }
            applyServer(state)
            if switching, state.changed == true { changedSinceLastTurn = true }
            if state.appliesAt == "next_turn" { errorText = nil }
        } catch let APIError.http(status, code, message, _) where status == 409 && code == "ROUTE_CONFLICT" {
            // Another window changed the route first: show the truth, ask again.
            routeLog.notice("route conflict: \(message, privacy: .public)")
            await refresh(epoch: mine)
            if mine == epoch { errorText = "This chat's route was changed in another window. Check it and try again." }
        } catch {
            if mine == epoch { errorText = error.localizedDescription }
        }
    }

    func loadHistory() async {
        guard let api, !chatSessionId.isEmpty else { return }
        let mine = epoch
        if let h = try? await api.history(chatSessionId), mine == epoch {
            history = h.events
            historyDegraded = h.degraded
        }
    }

    // MARK: - Mirroring

    private func applyServer(_ state: LlmIdeAPIClient.ChatRouteState) {
        server = state
        guard state.enabled else { return }
        refusedAtCap = refusedAtCap && ChatRouteLogic.level(used: state.used.billable, limit: state.tokenLimit) == .reached
        setSettings(ChatRouteSettings(
            provider: state.provider.isEmpty ? nil : state.provider,
            model: state.model.isEmpty ? nil : state.model,
            tokenLimit: state.tokenLimit, tokensUsed: state.used.billable))
    }

    private func setSettings(_ new: ChatRouteSettings) {
        let stored: ChatRouteSettings? = new.isEmpty ? nil : new
        guard stored != settings else { return }
        settings = stored
        onSettingsChanged?()
    }

    /// Test hook: what a chat file would hold right now.
    var fileSettings: ChatRouteSettings? { settings }
}
