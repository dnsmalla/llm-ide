import Foundation

/// The Agent v2 engine's provider policy, transport factory and engine transport. The classic
/// `/code-assist` engine is gone (K1 Phase 6, API 92): every chat runs on `/agent/v2/stream`, either
/// on the Claude Agent SDK (Anthropic, or a custom provider with an Anthropic-compatible endpoint) or,
/// through the session router, on the multi-provider adapter (a provider-catalog connection). What
/// this type decides is which providers can run a chat at all.
public enum AgentV2Selection {

    /// The backend provider id the v2 engine runs on (the built-in Claude
    /// CLI tool's `AICliTool.provider`; the server-side engine always drives
    /// the Claude Agent SDK, so no other provider can take it). Sourced from
    /// the Claude linker so the id has exactly one definition on the Mac.
    static let anthropicProvider = ClaudeCLI.provider

    /// True when `resolvedProvider` is the backend's Anthropic id. Takes the
    /// RESOLVED wire string (`ChatTransportInput.makeProvider(selectedProvider:)`
    /// output: `custom:<uuid>` verbatim for custom providers, otherwise the
    /// built-in tool's `provider`) — not the picker's raw selection — because
    /// that is what the transport actually sees per turn, and a raw "custom"
    /// or a provider name must resolve the same way here as it does on the
    /// wire. Non-anthropic built-ins, every `custom:<uuid>`, and nil (a
    /// turn that never set a provider) all answer false.
    static func providerIsAnthropic(_ resolvedProvider: String?) -> Bool {
        resolvedProvider == anthropicProvider
    }

    /// The provider ids the Agent engine can run: first-party Anthropic plus
    /// every ENABLED custom provider that declares an Anthropic-compatible
    /// endpoint (`CustomProvider.anthropicBaseURL`). The SDK speaks the
    /// Anthropic Messages API and nothing else, so this — not "is it
    /// Anthropic" — is the real capability test; it mirrors the server's
    /// `resolveAgentEngineAuth`, which refuses anything outside this set
    /// before the SDK spawns. Pure over the list so tests pin it without
    /// touching UserDefaults.
    static func agentCapableProviders(customProviders: [CustomProvider],
                                      catalogWireIds: Set<String> = []) -> Set<String> {
        // Catalog connections run through the session router and the adapter, not the SDK; they are
        // capable only while the router is on (CatalogConnectionIndex.capableWireIds).
        var capable: Set<String> = Set([anthropicProvider]).union(catalogWireIds)
        for provider in customProviders where provider.isEnabled && provider.canRunAgentEngine {
            capable.insert(provider.wireId)
        }
        return capable
    }

    /// `agentCapableProviders` over the persisted custom providers — the set
    /// production callers consult (per turn, per mint, per hint).
    static func liveAgentCapableProviders() -> Set<String> {
        agentCapableProviders(customProviders: CustomProvider.loadAll(),
                              catalogWireIds: CatalogConnectionIndex.shared.capableWireIds())
    }

    /// True when `resolvedProvider` (the RESOLVED wire string, as for
    /// `providerIsAnthropic`) is one the Agent engine can run. Nil — a turn
    /// that never set a provider — answers false.
    static func providerCanRunAgentEngine(_ resolvedProvider: String?,
                                          capableProviders: Set<String> = [anthropicProvider]) -> Bool {
        guard let resolvedProvider else { return false }
        return capableProviders.contains(resolvedProvider)
    }

    /// Per-chat engine marker (spec D3 clean cut), stored as
    /// `ChatSession.engine`: a chat stamped with this value at creation runs
    /// on the Agent v2 engine for its lifetime; an unstamped (nil) chat —
    /// including every chat persisted before the marker existed — stays on
    /// the legacy engine forever.
    static let sessionEngineV2 = "agentV2"

    /// Whether `resolvedProvider` can run a chat on this build (see `agentCapableProviders`).
    static func canRunChat(_ resolvedProvider: String?, capableProviders: Set<String>) -> Bool {
        providerCanRunAgentEngine(resolvedProvider, capableProviders: capableProviders)
    }

    /// The engine marker stamped on every NEW chat. Always the Agent engine: nothing else exists any more.
    /// A chat from before (marker nil, written by the classic engine) is continued on the Agent engine
    /// through a fresh session seeded with its recent turns, then re-stamped (`ChatEngine`).
    static func engineForNewChat() -> String? { sessionEngineV2 }

    /// How many of a legacy chat's last turns seed the fresh Agent session when it is continued.
    static let legacyContinuationTurns = 6

    /// True when the composer's provider cannot run a chat on this build: drives the hint near the chips.
    static func providerHintNeeded(resolvedProvider: String?, capableProviders: Set<String>) -> Bool {
        !canRunChat(resolvedProvider, capableProviders: capableProviders)
    }

    /// The plan-like modes whose v2 RESULT turns offer the "Save Plan"
    /// message action (`CodeAssistMode.plan` / `.assistPlan` — see the
    /// server's `PLAN_LIKE_MODES`). A v2 plan turn produces no `save-plan`
    /// pendingTool the way the legacy loop does; the plan IS the reply, so
    /// saving is a client-side action on that reply instead.
    static let planLikeModes: Set<String> = [
        CodeAssistMode.plan.rawValue,
        CodeAssistMode.assistPlan.rawValue,
    ]

    /// Visibility rule for the plan actions (Save / Preview / Refine) on a v2
    /// assistant message: v2 selected, no pending tool (a pending
    /// `save-plan`/`update-file` card means the legacy proposal flow owns
    /// the turn, and the action would be a second way to do the same save),
    /// not already saved — the saved-plan card is a .toolResult message
    /// that doesn't shift lastAssistantTurnId, so without the flag the
    /// button stayed live and re-saved the same plan on every click — and
    /// then TWO things together: this chat is planning, AND this reply is
    /// actually a plan.
    ///
    /// Planning is either signal — the per-turn mode the SERVER resolved, or
    /// the fact that some earlier turn resolved to a plan mode. Neither is
    /// enough alone, because the resolved mode flaps across a planning
    /// conversation: asked in Auto, "can you plan how to remove the dead
    /// code" resolves to `plan`, but the follow-up turns that answer the
    /// planner's questions — and the turn that finally CONTAINS the plan —
    /// resolve to something else.
    ///
    /// The SHAPE half is not optional. Being in plan mode used to be
    /// sufficient on its own, so the planner's very first move — a clarifying
    /// question, which is what both plan skills open with — arrived under a
    /// "Save Plan" button offering to write that question to `llm-doc/plans/`.
    /// The order is question → answer → plan → save, and the row belongs at
    /// the end of it: it appears when there is a plan to save
    /// (`PlanEditPolicy.looksLikePlan`), not when a plan has merely been
    /// asked for.
    ///
    /// Outside a plan mode the row is offered only while the chat has NO plan
    /// file yet (`sessionHasSavedPlan`). That is the flap case it exists for
    /// — the plan arriving on a turn the server resolved to execute — and it
    /// ends the moment a plan is saved: work after that is execution, and
    /// execution narration ("Phase 1 …", numbered deliverables) is exactly
    /// what a shape check cannot tell from a plan. It once produced a plan
    /// file titled "📋 Deliverables Created" whose body was the agent
    /// describing what it had just done.
    /// `public` for the same reason the PlanEditPolicy rules are: this is
    /// asserted by `chat-contract-lab`, a separate target, and this toolchain
    /// has no XCTest (so `@testable import` is not available).
    public static func showsSavePlanAction(mode: String?, v2Selected: Bool, hasPendingTool: Bool,
                                    planSaved: Bool = false,
                                    sessionIsPlanning: Bool = false,
                                    contentLooksLikePlan: Bool = false,
                                    sessionHasSavedPlan: Bool = false) -> Bool {
        guard v2Selected, !hasPendingTool, !planSaved, contentLooksLikePlan else { return false }
        if let mode, planLikeModes.contains(mode) { return true }
        return sessionIsPlanning && !sessionHasSavedPlan
    }

    /// Whether this transcript has ever run a plan-like turn — the session
    /// half of the content signal above. Cheap enough to compute once per
    /// render of the list (one pass over the messages' metadata).
    static func sessionIsPlanning(modes: [String?]) -> Bool {
        modes.contains { mode in
            guard let mode else { return false }
            return planLikeModes.contains(mode)
        }
    }
}

/// The factory seam every engine construction goes through.
@MainActor
enum ChatTransportFactory {
    static func makeTransport(api: LlmIdeAPIClient) -> ChatTransport {
        AgentV2EngineTransport(v2: AgentV2Transport(streamer: api))
    }
}

/// A turn on a provider this build cannot run a chat on (a built-in OpenAI / Google / DeepSeek key, or a
/// custom provider with no Anthropic-compatible endpoint, after the classic engine was removed).
struct ChatProviderUnsupportedError: LocalizedError, Equatable {
    let provider: String
    var errorDescription: String? {
        "Chat on this provider is not supported any more. Connect it in Settings, Providers (the provider catalog) "
            + "and turn on the session router, or pick a Claude model."
    }
}

/// The chat transport: every turn runs on the Agent v2 engine, with the two in-flight recoveries that are
/// v2's alone:
///
/// - **Stale server** — a v2 turn failing with HTTP 404 (the running server predates the engine) raises
///   `onStaleServer`, the engine's transient "Server update needed" banner, and the turn fails.
/// - **Unresumable SDK session** — `AgentV2Error.sessionUnresumable` is retried ONCE through
///   `AgentV2Transport.roundTrip(_:fresh:…)`; the server drops the chat's recorded SDK-session mapping
///   and starts a new session. A progress event carrying `freshSessionNote` lands first as a note.
///
/// A turn whose provider cannot run a chat throws `ChatProviderUnsupportedError` before any request.
@MainActor
final class AgentV2EngineTransport: ChatTransport, @unchecked Sendable {

    /// In-chat note appended (as a tool-step row on the streaming turn) when
    /// a SESSION_UNRESUMABLE recovery succeeded on a fresh SDK session.
    static let freshSessionNote = "Started a fresh engine session for this chat"

    /// Transient banner text raised through `onStaleServer` when the server
    /// predates the Agent engine (HTTP 404 on the v2 route).
    static let staleServerBannerText = "Server update needed for the Agent engine"

    let v2: AgentV2Transport
    /// Provider ids a chat can run on, read at TURN time (a custom provider may gain or lose its
    /// Anthropic-compatible URL, or the router may be switched, between turns).
    let capableProviders: () -> Set<String>
    /// Fired when a 404 says the running server predates the Agent engine.
    var onStaleServer: (() -> Void)?
    var onLiveTasks: (@MainActor ([AgentTask]) -> Void)? {
        get { v2.onLiveTasks }
        set { v2.onLiveTasks = newValue }
    }
    var onModeResolved: (@MainActor (String) -> Void)? {
        get { v2.onModeResolved }
        set { v2.onModeResolved = newValue }
    }
    /// Session router notices.
    var onRouteSwitch: (@MainActor (ChatRouteSwitchNotice) -> Void)? {
        get { v2.onRouteSwitch }
        set { v2.onRouteSwitch = newValue }
    }
    var onSessionBudget: (@MainActor (ChatSessionBudgetNotice) -> Void)? {
        get { v2.onSessionBudget }
        set { v2.onSessionBudget = newValue }
    }
    var onWorkspaceTrust: (@MainActor (ChatWorkspaceTrustNotice) -> Void)? {
        get { v2.onWorkspaceTrust }
        set { v2.onWorkspaceTrust = newValue }
    }

    init(v2: AgentV2Transport,
         capableProviders: @escaping () -> Set<String> = { AgentV2Selection.liveAgentCapableProviders() }) {
        self.v2 = v2
        self.capableProviders = capableProviders
    }

    /// SDK-session forwarding so `ChatEngine.agentV2SessionId` and the session-swap reset keep working.
    var sdkSessionId: String? { v2.sdkSessionId }
    func resetSdkSessionId() { v2.resetSdkSessionId() }

    // MARK: - ChatTransport

    /// 3-callback requirement. Production callers all use the 4-callback form; here the attempt goes
    /// through the v2 transport's OWN 3-callback entry so an unanswerable approval still fails fast
    /// (`APPROVAL_UNHANDLED`) rather than parking forever.
    func roundTrip(
        _ input: ChatTransportInput,
        onProgress: @escaping @MainActor (LlmIdeAPIClient.AgentProgress) -> Void,
        onChunk: @escaping @MainActor (String) -> Void
    ) async throws -> ChatTransportResult {
        try requireCapable(input)
        do {
            return try await v2.roundTrip(input, onProgress: onProgress, onChunk: onChunk)
        } catch {
            if Self.isStaleServer404(error) { onStaleServer?() }
            throw error
        }
    }

    func roundTrip(
        _ input: ChatTransportInput,
        onProgress: @escaping @MainActor (LlmIdeAPIClient.AgentProgress) -> Void,
        onChunk: @escaping @MainActor (String) -> Void,
        onApproval: @escaping @MainActor (AgentV2Approval) -> Void
    ) async throws -> ChatTransportResult {
        try requireCapable(input)
        do {
            // A legacy chat's first turn on this engine starts a fresh SDK session seeded with its recent turns.
            return try await v2.roundTrip(input, fresh: input.continuesLegacyChat,
                                          onProgress: onProgress, onChunk: onChunk,
                                          onApproval: onApproval)
        } catch let error as AgentV2Error where error == .sessionUnresumable {
            // The note rides the progress road BEFORE the retry: it lands as a system-style row on the
            // streaming turn even if the retry fails, because the SDK session it names is gone either way.
            onProgress(LlmIdeAPIClient.AgentProgress(
                label: Self.freshSessionNote, phase: "tool", tool: nil, detail: nil))
            do {
                return try await v2.roundTrip(input, fresh: true,
                                              onProgress: onProgress, onChunk: onChunk,
                                              onApproval: onApproval)
            } catch {
                if Self.isStaleServer404(error) { onStaleServer?() }
                throw error
            }
        } catch {
            if Self.isStaleServer404(error) { onStaleServer?() }
            throw error
        }
    }

    // MARK: - Policy

    private func requireCapable(_ input: ChatTransportInput) throws {
        guard AgentV2Selection.canRunChat(input.provider, capableProviders: capableProviders()) else {
            throw ChatProviderUnsupportedError(provider: input.provider ?? "")
        }
    }

    /// The stale-server shape: `LlmIdeAPIClient.agentV2Stream` throws its `APIError.http` envelope on any
    /// non-200 before the stream starts — 404 means the route isn't there.
    static func isStaleServer404(_ error: Error) -> Bool {
        if case let APIError.http(status, _, _, _) = error { return status == 404 }
        return false
    }
}
