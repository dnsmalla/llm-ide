import Foundation

/// Per-`ChatScope` shared `ChatEngine` instances.
///
/// Before Task 12, every `CodeAssistantPanel` built its OWN private
/// `ChatEngine` in `init`, and the iPhone's `explore_chat` bridge
/// (`MobileControlManager`) drove the `.explorer` chat by writing straight to
/// `ChatSessionStore` and posting `.explorerChatTranscriptChanged` so the
/// panel would notice and reload from disk. That worked, but it meant a
/// phone-originated turn only ever reached the Mac UI through a save→notify→
/// reload round trip — exactly the disk-mediated coupling Tasks 9-11 removed
/// for every other engine consumer.
///
/// This registry makes `.explorer` (and, for symmetry, every other scope) a
/// single shared instance: `MobileControlManager.handleExploreChat` and the
/// Explorer `CodeAssistantPanel` now hold the SAME `ChatEngine`, so a
/// phone-driven turn is visible on the Mac panel the instant it mutates
/// `messages` — no disk round trip, no notification, no reload.
///
/// `.conflicts`/`.visual`/`.docGen` gain nothing from sharing today (nothing
/// external drives them), but keeping every scope on one lazily-populated
/// cache means a future mobile bridge for those panels doesn't need a second
/// registry.
@MainActor
@Observable
final class ChatEngineRegistry {
    static let shared = ChatEngineRegistry()

    private var engines: [ChatScope: ChatEngine] = [:]

    /// `private` — always go through `.shared`. A single process-wide
    /// registry is the whole point: two instances would defeat the sharing
    /// this type exists for.
    private init() {}

    /// Returns the shared engine for `scope`, lazily creating it (wired with
    /// the engine's default, no-op hooks) on first call.
    ///
    /// `api` is consulted ONLY on first creation, to build the engine's
    /// transport through `ChatTransportFactory` — v2 (beta toggle on at
    /// creation) or the legacy `CodeAssistTransport`. A later call for the
    /// same scope with a DIFFERENT `api` instance still returns the SAME
    /// cached engine. The transport is no longer strictly fixed for the
    /// engine's lifetime (Task 12's agent-engine toggle): the PANEL swaps it
    /// via `ChatEngine.setTransport` when the setting flips, engine identity
    /// unchanged — which is what keeps this registry's sharing (panel +
    /// mobile bridge on one `.explorer` engine) intact across the swap. In
    /// practice `api` never changes anyway: it is a long-lived singleton
    /// handed out once at app launch (see `LlmIdeMacApp`). A caller whose
    /// environment-dependent behavior (context building, model/provider
    /// resolution, composer hooks) DOES need to track its own current state
    /// re-wires those hooks itself on appear — see
    /// `CodeAssistantPanel.wireEngine()`, which does exactly this and is
    /// safe to call repeatedly (each call just reassigns fresh closures over
    /// the same cached engine).
    func engine(for scope: ChatScope, api: LlmIdeAPIClient) -> ChatEngine {
        if let existing = engines[scope] { return existing }
        let created = ChatEngine(
            scope: scope,
            transport: ChatTransportFactory.makeTransport(
                api: api, useV2: AgentV2Selection.toggleEnabled()))
        engines[scope] = created
        return created
    }
}
