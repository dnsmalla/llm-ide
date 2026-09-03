import Foundation

/// Per-`ChatScope` shared `ChatEngine` instances, plus the background lot of
/// engines whose session is still working after the user switched away.
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
/// single shared DISPLAYED instance: `MobileControlManager.handleExploreChat`
/// and the Explorer `CodeAssistantPanel` hold the SAME `ChatEngine`, so a
/// phone-driven turn is visible on the Mac panel the instant it mutates
/// `messages` — no disk round trip, no notification, no reload.
///
/// ## Background sessions
///
/// One engine per scope also meant one RUNNING TURN per scope: switching
/// chats called `ChatEngine.switchSession(to:)`, whose first act is
/// `resetActiveTurnState()` — cancelling the in-flight turn and finalizing
/// its reply as `.stopped`. That is unavoidable for a single engine (its
/// `messages` array is about to be replaced with another chat's history, so
/// a still-running stream would write into the wrong conversation), but it
/// made "let me check the other chat" silently kill work that was minutes in.
///
/// So a switch away from a BUSY engine now parks it here instead. The parked
/// engine keeps its session, its stream and its `runTask`; the panel gets a
/// different engine for the chat being switched to, and the parked one is
/// handed back — still running, or with its finished reply already in
/// `messages` — when the user returns to that session. An IDLE engine is
/// never parked: with nothing in flight there is nothing to preserve, so
/// those switches still reuse the one displayed engine exactly as before,
/// and a user who never runs concurrent chats never pays for this.
@MainActor
@Observable
final class ChatEngineRegistry {
    static let shared = ChatEngineRegistry()

    /// The engine each scope's panel currently renders.
    private var displayed: [ChatScope: ChatEngine] = [:]
    /// Engines kept alive off-screen, keyed by the session they hold.
    /// Populated only by a switch away from a mid-turn engine.
    private var background: [UUID: ChatEngine] = [:]
    /// Use order for eviction, oldest first — same membership as `background`.
    private var backgroundOrder: [UUID] = []

    /// Upper bound on parked engines. Each pins its session's transcript in
    /// memory for as long as it is held, so the lot is swept on every switch:
    /// entries that have FINISHED their turn are dropped (their reply is on
    /// disk — see `ChatEngine.persistsUnobserved`), and only if the lot is
    /// still over the limit are the oldest still-running ones let go. A
    /// running engine is never evicted while there is an idle one to drop
    /// instead: evicting it is exactly the cancellation this type exists to
    /// avoid.
    static let backgroundLimit = 6

    /// How a new engine is built. Production leaves this nil and goes
    /// through `ChatTransportFactory`; tests supply scripted transports so a
    /// switch can be exercised against an engine that is actually mid-turn.
    private let engineFactory: ((ChatScope) -> ChatEngine)?

    /// Production code always goes through `.shared` — a single process-wide
    /// registry is the whole point, and two of them would defeat the sharing
    /// this type exists for. The initializer is reachable only so a test can
    /// build an ISOLATED registry: there are four `ChatScope` cases and the
    /// existing registry suite already claims them on the singleton, so a
    /// switching test has no free scope to work in otherwise.
    init(engineFactory: ((ChatScope) -> ChatEngine)? = nil) {
        self.engineFactory = engineFactory
    }

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
    ///
    /// After a background switch this returns the engine for the chat the
    /// panel is NOW showing, which is what every caller means by "the
    /// scope's engine" — including the mobile bridge, whose resolver asks
    /// precisely so it can avoid hijacking what the Mac has on screen.
    func engine(for scope: ChatScope, api: LlmIdeAPIClient) -> ChatEngine {
        if let existing = displayed[scope] { return existing }
        let created = makeEngine(scope: scope, api: api)
        displayed[scope] = created
        return created
    }

    /// The live engine holding `sessionID` — displayed or parked — if any.
    ///
    /// The one-live-engine-per-session rule depends on this: any other party
    /// that wants to drive a turn against a session (today
    /// `ExplorerMobileEngineResolver`, for phone-driven turns) must ask here
    /// FIRST and use what it gets back. Two engines holding one session are
    /// two writers to one file, and the loser's turns vanish on the winner's
    /// next `persistCurrentChat`.
    func liveEngine(for sessionID: UUID) -> ChatEngine? {
        if let parked = background[sessionID] { return parked }
        return displayed.values.first { $0.currentSessionIDString == sessionID.uuidString }
    }

    /// Whether `sessionID` has a turn in flight right now, on any engine.
    /// Drives the "still working" marker in the session picker, so a chat
    /// left running is visibly distinct from one that was stopped.
    func isRunning(_ sessionID: UUID) -> Bool {
        liveEngine(for: sessionID)?.busy == true
    }

    /// Session ids currently mid-turn off-screen. Read by the session list.
    var backgroundRunningSessionIDs: Set<UUID> {
        Set(background.filter { $0.value.busy }.keys)
    }

    /// Switch `scope`'s displayed chat to `sessionID` and return the engine
    /// the panel should render from now on — which may be a DIFFERENT
    /// instance than the one it was rendering. The caller re-points its own
    /// engine reference at the result and re-runs its hook wiring
    /// (`CodeAssistantPanel.wireEngine`).
    ///
    /// Three cases, in the order they must be checked:
    ///
    /// 1. **The target is already parked** — hand that engine back, running
    ///    turn and all. This must be checked BEFORE case 3: taking the
    ///    "reuse the idle displayed engine" shortcut for a session that is
    ///    parked-and-running would load its stale on-disk history into a
    ///    second engine while the parked one keeps writing the real one.
    /// 2. **The outgoing engine is busy** — park it and display a fresh
    ///    engine loaded with the target session.
    /// 3. **Neither** — the ordinary case: `switchSession(to:)` on the one
    ///    displayed engine, no new instance, behaviour identical to before.
    ///
    /// Returns the unchanged current engine if `sessionID` doesn't resolve to
    /// a session in this scope — same existence/scope contract as
    /// `ChatEngine.switchSession(to:)`, which no-ops on a bad id.
    func switchDisplayedSession(scope: ChatScope, to sessionID: UUID, api: LlmIdeAPIClient) -> ChatEngine {
        let current = engine(for: scope, api: api)
        if current.currentSessionIDString == sessionID.uuidString { return current }
        guard let target = ChatSessionStore.load(id: sessionID), target.scope == scope else {
            return current
        }

        if let parked = background.removeValue(forKey: sessionID) {
            backgroundOrder.removeAll { $0 == sessionID }
            retire(current)
            adopt(parked, scope: scope)
            sweepBackground()
            return parked
        }

        guard current.busy else {
            current.switchSession(to: sessionID)
            sweepBackground()
            return current
        }

        park(current)
        let fresh = makeEngine(scope: scope, api: api)
        fresh.switchSession(to: sessionID)
        displayed[scope] = fresh
        sweepBackground()
        return fresh
    }

    /// Start a new empty chat in `scope` without stopping a running one.
    ///
    /// `ChatEngine.createNewSession()` calls `resetActiveTurnState()` for the
    /// same reason `switchSession` does — it is about to blank `messages` —
    /// so "+ New chat" killed an in-flight turn exactly the way switching
    /// did. Parking first means the running chat keeps going and the new,
    /// empty chat opens on its own engine.
    ///
    /// Returns the engine the panel should render.
    func newDisplayedSession(scope: ChatScope, api: LlmIdeAPIClient) -> ChatEngine {
        let current = engine(for: scope, api: api)
        guard current.busy else {
            current.createNewSession()
            sweepBackground()
            return current
        }
        park(current)
        let fresh = makeEngine(scope: scope, api: api)
        // The mint below decides the new chat's engine stamp from the provider
        // it is born under, and this engine is minted BEFORE the panel adopts
        // and wires it — so without this hand-off it would fall back to the
        // Settings default provider, which `switchProvider(.custom)` never
        // updates. The displayed engine is already wired to the composer's
        // live selection; carry that over so "+ New chat" during a running
        // turn stamps exactly like an idle one.
        fresh.resolveNewChatProvider = current.resolveNewChatProvider
        fresh.mintFreshSession()
        displayed[scope] = fresh
        sweepBackground()
        return fresh
    }

    /// Stop and drop the background engine holding `sessionID`, if any.
    ///
    /// Required before deleting a chat: a parked engine still running that
    /// session would persist it again at turn end and RESURRECT the file the
    /// delete just removed — and `ChatEngine.deleteSession` can only reach
    /// the engine it is called on, which by definition is not this one.
    func discardBackground(sessionID: UUID) {
        guard let engine = background.removeValue(forKey: sessionID) else { return }
        backgroundOrder.removeAll { $0 == sessionID }
        engine.stop()
        engine.persistsUnobserved = false
    }

    // MARK: - Lot management

    private func makeEngine(scope: ChatScope, api: LlmIdeAPIClient) -> ChatEngine {
        if let engineFactory { return engineFactory(scope) }
        return ChatEngine(
            scope: scope,
            transport: ChatTransportFactory.makeTransport(
                api: api, useV2: AgentV2Selection.toggleEnabled()))
    }

    /// Move a mid-turn engine off-screen, still running.
    private func park(_ engine: ChatEngine) {
        guard let id = UUID(uuidString: engine.currentSessionIDString) else { return }
        // Land any debounced write from the observed period before the
        // panel's `.onChange` stops firing for this instance.
        engine.flushPendingPersist()
        engine.persistsUnobserved = true
        background[id] = engine
        backgroundOrder.removeAll { $0 == id }
        backgroundOrder.append(id)
    }

    /// Bring a parked engine back on screen.
    private func adopt(_ engine: ChatEngine, scope: ChatScope) {
        engine.persistsUnobserved = false
        displayed[scope] = engine
        // The pointer is what a relaunch restores, and this chat is now the
        // scope's visible one — `switchSession` would have done this, but
        // adopting deliberately skips it (it would cancel the very turn we
        // are preserving).
        engine.rememberCurrentPointer()
        engine.refreshSessions()
    }

    /// The outgoing engine when the incoming one comes from the lot: park it
    /// if it is mid-turn, otherwise let it go after landing its writes.
    private func retire(_ engine: ChatEngine) {
        if engine.busy {
            park(engine)
        } else {
            engine.flushPendingPersist()
        }
    }

    /// Drop parked engines that have finished their turn, then — only if the
    /// lot is still over its limit — the oldest still-running ones.
    private func sweepBackground() {
        for (id, engine) in background where !engine.busy {
            engine.persistsUnobserved = false
            background.removeValue(forKey: id)
            backgroundOrder.removeAll { $0 == id }
        }
        while background.count > Self.backgroundLimit, let oldest = backgroundOrder.first {
            background[oldest]?.stop()
            background.removeValue(forKey: oldest)
            backgroundOrder.removeFirst()
        }
    }
}
