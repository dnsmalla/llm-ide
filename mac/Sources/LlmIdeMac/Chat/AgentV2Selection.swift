import Foundation

/// Task 12 — the Agent v2 engine's selection policy, transport factory, and
/// engine-selection transport. Everything here exists so the rest of the
/// system can treat "which engine answers this turn" as one rule with one
/// implementation: the user's beta toggle, resolved against the turn's
/// provider the same way the panel resolves it for the wire.
enum AgentV2Selection {

    /// `@AppStorage`/UserDefaults key for the user's engine toggle. The
    /// Settings row (`CodeAssistantSettingsSection`) writes through
    /// `@AppStorage`, which is backed by the same `UserDefaults.standard`
    /// this type reads — the two can never disagree.
    static let toggleKey = "chat.useAgentV2"

    /// The backend provider id the v2 engine runs on (the built-in Claude
    /// CLI tool's `AICliTool.provider`; the server-side engine always drives
    /// the Claude Agent SDK, so no other provider can take it).
    static let anthropicProvider = "anthropic"

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

    /// The whole selection rule: the Agent engine answers a turn only when
    /// the user opted in AND the turn's provider is Anthropic.
    static func useV2(toggleOn: Bool, resolvedProvider: String?) -> Bool {
        toggleOn && providerIsAnthropic(resolvedProvider)
    }

    /// Current toggle value. Read at ENGINE-CREATION time (the factory) and
    /// at TURN time (the composite), so a flip applies to the next turn of
    /// an already-constructed engine without a relaunch.
    static func toggleEnabled(defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: toggleKey)
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

    /// Visibility rule for the "Save Plan" action on a v2 assistant message:
    /// plan-like mode, v2 selected, and no pending tool (a pending
    /// `save-plan`/`update-file` card means the legacy proposal flow owns
    /// the turn, and the action would be a second way to do the same save).
    static func showsSavePlanAction(mode: String?, v2Selected: Bool, hasPendingTool: Bool) -> Bool {
        guard v2Selected, !hasPendingTool, let mode else { return false }
        return planLikeModes.contains(mode)
    }
}

/// The factory seam every engine construction goes through — the one place
/// that knows the Agent v2 engine exists. `useV2` is the selection at
/// CONSTRUCTION time (normally `AgentV2Selection.toggleEnabled()`); the
/// composite it returns re-checks toggle + provider per turn, so only the
/// "v2 machinery attached at all" decision is baked in here.
@MainActor
enum ChatTransportFactory {

    static func makeTransport(api: LlmIdeAPIClient, useV2: Bool) -> ChatTransport {
        guard useV2 else { return CodeAssistTransport(api: api) }
        return AgentV2EngineTransport(
            v2: AgentV2Transport(streamer: api),
            legacy: CodeAssistTransport(api: api))
    }
}

/// Engine-selection `ChatTransport`: answers each turn on the Agent v2
/// engine when the selection rule says so, on the legacy `/code-assist`
/// transport otherwise — including two in-flight recoveries that are v2's
/// alone:
///
/// - **Stale server** — a v2 turn failing with the client's HTTP 404
///   envelope (the route doesn't exist: the running server predates the
///   engine) fires `onStaleServer` — the engine raises its transient
///   "Server update needed" banner — and completes THIS turn on the legacy
///   transport, so upgrading the server is never a hard dependency for chat.
///   A 404 arrives before the stream starts (the client throws it on the
///   non-200 guard), so no v2 side effects are lost by the re-run.
/// - **Unresumable SDK session** — `AgentV2Error.sessionUnresumable` is
///   retried ONCE through `AgentV2Transport.roundTrip(_:fresh:…)`; the
///   server drops the chat's recorded SDK-session mapping and starts a new
///   session. A progress event carrying `freshSessionNote` rides the normal
///   progress road first, so it lands as a system-style note on the
///   streaming turn (same road the parked-approval note takes — and the
///   phone's live channel on external turns). If the fresh attempt also
///   fails, the error propagates and the turn surfaces as failed.
///
/// Legacy routing (toggle off, or a non-Anthropic provider) delegates
/// verbatim to `legacy`; the v2 streamer is never contacted.
@MainActor
final class AgentV2EngineTransport: ChatTransport, @unchecked Sendable {

    /// In-chat note appended (as a tool-step row on the streaming turn) when
    /// a SESSION_UNRESUMABLE recovery succeeded on a fresh SDK session.
    static let freshSessionNote = "Started a fresh engine session for this chat"

    /// Transient banner text raised through `onStaleServer` when the server
    /// predates the Agent engine (HTTP 404 on the v2 route).
    static let staleServerBannerText = "Server update needed for the Agent engine"

    let v2: AgentV2Transport
    let legacy: ChatTransport
    /// Toggle read at TURN time (injected so tests script it without touching
    /// process-global UserDefaults; production uses the UserDefaults default).
    let isV2Enabled: () -> Bool
    /// Fired when a stale-server 404 forced a legacy fallback — the engine
    /// raises its transient notice banner. Wired by `ChatEngine` itself
    /// (init and `setTransport`), so the panel needs no plumbing.
    var onStaleServer: (() -> Void)?

    init(v2: AgentV2Transport,
         legacy: ChatTransport,
         isV2Enabled: @escaping () -> Bool = { AgentV2Selection.toggleEnabled() }) {
        self.v2 = v2
        self.legacy = legacy
        self.isV2Enabled = isV2Enabled
    }

    /// SDK-session forwarding so `ChatEngine.agentV2SessionId` and the
    /// session-swap reset keep working through the composite (they cast for
    /// `AgentV2Transport` and would otherwise miss it).
    var sdkSessionId: String? { v2.sdkSessionId }
    func resetSdkSessionId() { v2.resetSdkSessionId() }

    // MARK: - ChatTransport

    /// 3-callback requirement. Production v2 callers all use the 4-callback
    /// form; when v2 is selected here anyway, the attempt goes through the
    /// v2 transport's OWN 3-callback entry so an unanswerable approval still
    /// fails fast (`APPROVAL_UNHANDLED`) rather than parking forever. The
    /// stale-server 404 fallback still applies; the sessionUnresumable
    /// fresh-retry does not (the fresh entry point requires an approval
    /// handler this form doesn't have).
    func roundTrip(
        _ input: ChatTransportInput,
        onProgress: @escaping @MainActor (LlmIdeAPIClient.AgentProgress) -> Void,
        onChunk: @escaping @MainActor (String) -> Void
    ) async throws -> ChatTransportResult {
        guard selectsV2(input) else {
            return try await legacy.roundTrip(input, onProgress: onProgress, onChunk: onChunk)
        }
        do {
            return try await v2.roundTrip(input, onProgress: onProgress, onChunk: onChunk)
        } catch {
            if Self.isStaleServer404(error) {
                onStaleServer?()
                return try await legacy.roundTrip(input, onProgress: onProgress, onChunk: onChunk)
            }
            throw error
        }
    }

    func roundTrip(
        _ input: ChatTransportInput,
        onProgress: @escaping @MainActor (LlmIdeAPIClient.AgentProgress) -> Void,
        onChunk: @escaping @MainActor (String) -> Void,
        onApproval: @escaping @MainActor (AgentV2Approval) -> Void
    ) async throws -> ChatTransportResult {
        guard selectsV2(input) else {
            // Legacy engines never park a question — dropping `onApproval`
            // matches the protocol's own default-forwarding semantics.
            return try await legacy.roundTrip(input, onProgress: onProgress, onChunk: onChunk)
        }
        do {
            return try await v2.roundTrip(input, fresh: false,
                                          onProgress: onProgress, onChunk: onChunk,
                                          onApproval: onApproval)
        } catch let error as AgentV2Error where error == .sessionUnresumable {
            // The note rides the progress road BEFORE the retry: it lands as
            // a system-style row on the streaming turn even if this call is
            // about to fail, because the SDK session it names is gone either
            // way. The engine's final reply-overwrite keeps the visible text
            // correct even if the failed first attempt streamed some deltas
            // before its `error` event.
            onProgress(LlmIdeAPIClient.AgentProgress(
                label: Self.freshSessionNote, phase: "tool", tool: nil, detail: nil))
            do {
                return try await v2.roundTrip(input, fresh: true,
                                              onProgress: onProgress, onChunk: onChunk,
                                              onApproval: onApproval)
            } catch {
                if Self.isStaleServer404(error) {
                    return try await fallbackToLegacy(input, onProgress: onProgress, onChunk: onChunk)
                }
                throw error
            }
        } catch {
            if Self.isStaleServer404(error) {
                return try await fallbackToLegacy(input, onProgress: onProgress, onChunk: onChunk)
            }
            throw error
        }
    }

    /// Banner + one legacy round-trip — the shared tail of both stale-server
    /// branches above.
    private func fallbackToLegacy(
        _ input: ChatTransportInput,
        onProgress: @escaping @MainActor (LlmIdeAPIClient.AgentProgress) -> Void,
        onChunk: @escaping @MainActor (String) -> Void
    ) async throws -> ChatTransportResult {
        onStaleServer?()
        return try await legacy.roundTrip(input, onProgress: onProgress, onChunk: onChunk)
    }

    // MARK: - Policy

    private func selectsV2(_ input: ChatTransportInput) -> Bool {
        AgentV2Selection.useV2(toggleOn: isV2Enabled(), resolvedProvider: input.provider)
    }

    /// The stale-server shape: `LlmIdeAPIClient.agentV2Stream` throws its
    /// `APIError.http` envelope on any non-200 before the stream starts —
    /// 404 means the route isn't there, i.e. the running server predates the
    /// Agent engine. Anything else (stream-carried errors, cancellations,
    /// other statuses) propagates untouched.
    static func isStaleServer404(_ error: Error) -> Bool {
        if case let APIError.http(status, _, _, _) = error { return status == 404 }
        return false
    }
}
