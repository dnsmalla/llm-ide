import Foundation

/// Decides which `ChatEngine` a phone-driven `.explorer` turn
/// (`MobileControlManager.handleExploreChat`) should actually run on.
///
/// Fixes a real bug in Task 12's first pass: `ChatEngineRegistry` gives the
/// Mac `CodeAssistantPanel` and the mobile bridge the SAME shared `.explorer`
/// engine, which is exactly what lets a phone-driven turn appear on the Mac
/// screen instantly with no reload. But that sharing cuts both ways — if the
/// phone asks for a DIFFERENT session than the one the shared engine
/// currently has loaded, blindly calling `switchSession(to:)` on it would
/// silently:
///   1. cancel the Mac user's in-flight turn (`resetActiveTurnState()`
///      force-finalizes it as `.stopped`, no warning shown), and
///   2. replace `messages` — the SAME `@Observable` array the Mac panel
///      renders — with the OTHER session's history, yanking the Mac user's
///      screen to a conversation they didn't choose.
///
/// This resolver keeps that from ever happening: the shared engine's visible
/// state is only touched when it's already safe to (already showing the
/// requested session, or genuinely idle/unclaimed — no Mac panel has
/// appeared yet this run, so there is nothing to hijack). Every other case
/// gets a private, OFF-SCREEN engine instead — same session data and its own
/// `runExternalTurn` busy-guard, cached per session id so two phone-driven
/// turns against the same background session share one instance rather than
/// racing two independent writers to the same session file, but never
/// aliasing what is rendered on the Mac.
@MainActor
final class ExplorerMobileEngineResolver {
    private var offScreen: [UUID: ChatEngine] = [:]

    /// Resolve the engine to drive a turn for `sessionID` on.
    ///
    /// - If `sharedExplorerEngine` (the `ChatEngineRegistry`-cached
    ///   `.explorer` engine — the same one `CodeAssistantPanel` renders when
    ///   the Explorer tab is open) is idle and has never picked a session,
    ///   it is safely claimed for `sessionID` via the normal
    ///   `switchSession(to:)` path (correct pointer bookkeeping, exactly as
    ///   if the Mac user had picked this chat first) and returned directly.
    /// - If it is ALREADY showing `sessionID`, it is returned directly — this
    ///   is the common case: phone and Mac collaborating on the same chat.
    /// - Otherwise the shared engine is already showing a DIFFERENT
    ///   session — touching it would hijack the Mac's screen — so a private,
    ///   off-screen engine (cached per `sessionID`) is used instead.
    ///
    /// Returns `nil` if `sessionID` doesn't resolve to a real `.explorer`
    /// session on disk.
    func engine(for sessionID: UUID, sharedExplorerEngine: ChatEngine, api: LlmIdeAPIClient) -> ChatEngine? {
        if sharedExplorerEngine.currentSessionIDString.isEmpty {
            sharedExplorerEngine.switchSession(to: sessionID)
            return sharedExplorerEngine.currentSessionIDString == sessionID.uuidString
                ? sharedExplorerEngine : nil
        }
        if sharedExplorerEngine.currentSessionIDString == sessionID.uuidString {
            return sharedExplorerEngine
        }
        if let cached = offScreen[sessionID] {
            return cached
        }
        let engine = ChatEngine(scope: .explorer, transport: CodeAssistTransport(api: api))
        guard engine.loadSessionForBackgroundUse(id: sessionID) else { return nil }
        offScreen[sessionID] = engine
        return engine
    }

    /// Drop a cached off-screen engine — called when the session it was
    /// backing is deleted (`explore_delete_session`), so a later phone
    /// request for the same (now-gone) id can't resolve to a stale instance.
    func forget(sessionID: UUID) {
        offScreen.removeValue(forKey: sessionID)
    }
}
