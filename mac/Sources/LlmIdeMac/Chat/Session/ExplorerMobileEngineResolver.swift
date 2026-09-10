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
///
/// Second bug, found by spec re-review: a cached off-screen engine that is
/// never touched again would go STALE the moment the Mac later takes
/// ownership of that same session — e.g. the phone opens session B while the
/// Mac is on A (caching an off-screen engine for B), the Mac user then
/// switches the SHARED engine to B and appends turns there (persisted
/// through the shared engine, invisible to the cached off-screen instance),
/// the Mac switches away to C, and the phone messages B again. Serving the
/// stale cached engine at that point would mean `runExternalTurn` appends
/// onto — and then `persistCurrentChat()` overwrites the session file with —
/// an out-of-date copy that is MISSING the Mac's newer turns: silent data
/// loss. `engine(for:sharedExplorerEngine:api:)` below closes this by
/// refreshing a cached (non-busy) off-screen engine from disk on every
/// lookup before handing it back, rather than trusting the cache
/// unconditionally.
@MainActor
final class ExplorerMobileEngineResolver {
    /// Upper bound on cached off-screen engines. Phone usage flips between
    /// a handful of sessions, and each cached engine pins that session's
    /// transcript in memory for the process lifetime — unbounded growth
    /// would accumulate one per session the phone ever touched. Oldest
    /// non-busy entries are evicted on insert; a mid-turn engine is never
    /// evicted (dropping it would orphan the running turn's writes), so an
    /// all-busy overflow past the cap is allowed rather than racing a turn.
    static let offScreenCacheLimit = 6

    private var offScreen: [UUID: ChatEngine] = [:]
    /// Use order for eviction, oldest first — same membership as `offScreen`.
    private var offScreenOrder: [UUID] = []

    /// Mark `id` as most-recently used.
    private func touch(_ id: UUID) {
        offScreenOrder.removeAll { $0 == id }
        offScreenOrder.append(id)
    }

    /// Evict oldest non-busy entries while the cache exceeds its limit.
    private func evictOverflow() {
        while offScreen.count > Self.offScreenCacheLimit {
            guard let victim = offScreenOrder.first(where: { offScreen[$0]?.busy != true }) else {
                return // everything is mid-turn; overflow stands
            }
            offScreenOrder.removeAll { $0 == victim }
            offScreen.removeValue(forKey: victim)
        }
    }

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
    ///   off-screen engine (cached per `sessionID`) is used instead. A
    ///   cached entry that isn't currently mid-turn is ALWAYS refreshed from
    ///   disk first (a cheap load+decode) so a newer write from the shared
    ///   engine — the Mac having since owned and chatted in this same
    ///   session — is never silently discarded. A cached entry that IS
    ///   mid-turn (`busy`) is returned as-is, untouched: refreshing its
    ///   `messages` out from under an in-flight round trip would corrupt it,
    ///   and `runExternalTurn`'s own busy-guard is what the caller relies on
    ///   for that case anyway.
    ///
    /// Returns `nil` if `sessionID` doesn't resolve to a real `.explorer`
    /// session on disk — including when a previously-cached session was
    /// since deleted, in which case the stale cache entry is also evicted.
    func engine(for sessionID: UUID, sharedExplorerEngine: ChatEngine, api: LlmIdeAPIClient) -> ChatEngine? {
        if sharedExplorerEngine.currentSessionIDString.isEmpty {
            sharedExplorerEngine.switchSession(to: sessionID)
            return sharedExplorerEngine.currentSessionIDString == sessionID.uuidString
                ? sharedExplorerEngine : nil
        }
        if sharedExplorerEngine.currentSessionIDString == sessionID.uuidString {
            return sharedExplorerEngine
        }
        // A session the Mac user switched away from MID-TURN is still live in
        // `ChatEngineRegistry`'s background lot, holding the real transcript
        // in memory and about to persist it. Standing up a second engine for
        // it here would make two writers for one session file, and whichever
        // persisted last would erase the other's turns. The registry's live
        // engine wins over anything this resolver could build or has cached.
        if let live = ChatEngineRegistry.shared.liveEngine(for: sessionID) {
            // Drop our own copy if we had one: from here on that session has
            // exactly one writer again, and it is not this cache.
            forget(sessionID: sessionID)
            return live
        }
        if let cached = offScreen[sessionID] {
            guard !cached.busy else {
                touch(sessionID)  // mid-turn lookups count as use too
                return cached
            }
            guard cached.loadSessionForBackgroundUse(id: sessionID) else {
                // Deleted (or re-scoped) since it was cached — don't keep
                // serving orphaned data for an id that no longer resolves.
                offScreen.removeValue(forKey: sessionID)
                offScreenOrder.removeAll { $0 == sessionID }
                return nil
            }
            touch(sessionID)
            return cached
        }
        // Deliberately the LEGACY transport, not the v2 factory: a v2 turn
        // can park on an AskUserQuestion approval, and an OFF-SCREEN engine
        // has no panel to render the card or post the decision — the turn
        // would hang until the server's park timeout denies it. Off-screen
        // phone turns stay on /code-assist; the shared (visible) engine is
        // where the Agent engine beta applies.
        let engine = ChatEngine(scope: .explorer, transport: CodeAssistTransport(api: api))
        guard engine.loadSessionForBackgroundUse(id: sessionID) else { return nil }
        offScreen[sessionID] = engine
        touch(sessionID)
        evictOverflow()
        return engine
    }

    /// The cached off-screen engine for `sessionID`, if one exists — WITHOUT
    /// creating or refreshing anything. Exists so `explore_delete_session`
    /// can route the delete through the engine that actually holds the
    /// session (cancelling any in-flight phone turn and re-pointing the
    /// engine, so its next `persistCurrentChat` can't resurrect the file)
    /// while leaving the lookup itself side-effect free. Returns nil when no
    /// engine has this session loaded off-screen.
    func cachedEngine(for sessionID: UUID) -> ChatEngine? {
        offScreen[sessionID]
    }

    /// Drop a cached off-screen engine — called when the session it was
    /// backing is deleted (`explore_delete_session`), so a later phone
    /// request for the same (now-gone) id can't resolve to a stale instance.
    func forget(sessionID: UUID) {
        offScreen.removeValue(forKey: sessionID)
        offScreenOrder.removeAll { $0 == sessionID }
    }
}
