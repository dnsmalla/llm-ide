import Foundation

/// Chat's half of `MobileChatHosting` (`Core/Contracts/MobileChatHosting.swift`):
/// what the iPhone's chat, Explorer-chat and approval traffic needs from the
/// chat engines and the session store, expressed in Core types only.
///
/// Mobile Control is build-excludable and Chat is not, so this file must
/// compile with `mobile_sync` off: it names no MobileControl or
/// `SharedProtocol` type. Shell constructs it in `FeatureCatalog.bootMobile`
/// and hands it to the manager — the only layer allowed to name both.
@MainActor
final class ChatMobileHost: MobileChatHosting {
    /// The phone bridge's off-screen `.explorer` engines. Registered with
    /// `ChatEngineRegistry` as its external holder (see `ExternalEngineHolder`)
    /// so the registry can see these engines when it resolves which engine
    /// owns a session — without that, a session the phone is running here
    /// looks unheld and the Mac opens a second engine on the same file.
    /// Held strongly here because the registry's reference is weak.
    private let explorerResolver = ExplorerMobileEngineResolver()

    init() {
        // Set at construction rather than at first use: `switchDisplayedSession`
        // consults the holder on the MAC user's action, which can happen
        // before the phone has ever driven a turn. Shell builds this host in
        // `bootMobile`, the same moment the manager used to do it in its init.
        ChatEngineRegistry.shared.externalHolder = explorerResolver
    }

    // MARK: - Explorer session lookup (scope + project guard)

    /// The Explorer chat with this id, or nil when there is none — including
    /// when the id names a session of another scope (quick chat, conflicts,
    /// visual, docGen). Every phone path that takes a phone-supplied session
    /// id goes through this, so the phone can reach Explorer chats only.
    // internal: pinned by MobileExploreScopeTests
    static func loadExplorerSession(id: UUID) -> ChatSession? {
        guard let session = ChatSessionStore.load(id: id), session.scope == .explorer else { return nil }
        return session
    }

    /// `loadExplorerSession(id:)` narrowed to the chats the phone's list shows
    /// for `projectId` — the handlers checked scope but not project, so a
    /// session id the phone kept from project A still loaded, renamed and
    /// chatted after the Mac switched to project B.
    static func loadExplorerSession(id: UUID, visibleInProject projectId: String?) -> ChatSession? {
        guard let session = loadExplorerSession(id: id),
              isExplorerSession(session, visibleInProject: projectId) else { return nil }
        return session
    }

    /// The exact rule of `ChatSessionStore.list(for:visibleInProject:)`: its
    /// own project's chats plus unassigned ones; everything when no project is open.
    nonisolated static func isExplorerSession(_ session: ChatSession, visibleInProject projectId: String?) -> Bool {
        guard let projectId else { return true }
        return session.projectId == nil || session.projectId == projectId
    }

    // MARK: - Explorer sessions

    func explorerSessions(visibleInProject projectId: String?) -> [MobileChatSessionSummary] {
        ChatSessionStore.list(for: .explorer, visibleInProject: projectId).map {
            MobileChatSessionSummary(id: $0.id, title: $0.title, lastUsedAt: $0.lastUsedAt)
        }
    }

    func explorerSession(id: UUID, visibleInProject projectId: String?) -> MobileChatSessionHistory? {
        guard let session = Self.loadExplorerSession(id: id, visibleInProject: projectId) else { return nil }
        return MobileChatSessionHistory(id: session.id, title: session.title,
                                        lines: Self.wireLines(session.messages))
    }

    /// `wireTurn()` — not the raw message — because that is what the phone
    /// always received for a loaded session: tool results folded into a user
    /// line and a stopped reply carrying its `_(stopped)_` marker.
    nonisolated static func wireLines(_ messages: [ChatMessage]) -> [MobileChatLine] {
        messages.map { message in
            let turn = message.wireTurn()
            return MobileChatLine(role: turn.role.rawValue, content: turn.content)
        }
    }

    func createExplorerSession(projectId: String?) -> UUID {
        let session = ChatSession(scope: .explorer, title: "New chat", projectId: projectId)
        ChatSessionStore.save(session)
        return session.id
    }

    func renameExplorerSession(id: UUID, visibleInProject projectId: String?, title: String) -> String? {
        guard var session = Self.loadExplorerSession(id: id, visibleInProject: projectId) else { return nil }
        session.title = title
        ChatSessionStore.save(session)
        return session.title
    }

    /// Delete an Explorer chat on behalf of the phone, routed through
    /// whichever engine currently holds it. The old direct
    /// `ChatSessionStore.delete` resurrected the chat whenever an engine
    /// still had it loaded: `persistCurrentChat` recreates the file when
    /// `load(id:)` comes back nil (`?? ChatSession(id:scope:)` keeps the id),
    /// so the Mac panel's next history change — or an in-flight phone turn's
    /// cancellation-path persist — brought the deleted chat right back, and
    /// the server's session-memory rows for it were never forgotten.
    ///
    /// `ChatEngine.deleteSession` already does every piece correctly for a
    /// session its engine is showing (cancel + finalize the in-flight turn,
    /// delete, fall back to the next session or mint a fresh one — which is
    /// also what moves the engine OFF the deleted id so nothing can
    /// re-persist it), so the shared engine goes through it when it is
    /// showing the session. Off-screen engines — parked by the Mac mid-turn
    /// or held by the phone bridge — are detached and dropped instead
    /// (`ChatEngineRegistry.discardOffScreenEngines`); the parked lot used
    /// to be skipped entirely, so a parked turn resurrected the chat. The
    /// file itself is then removed directly — plus the memory forget the raw
    /// path used to skip, which is also re-issued unconditionally because
    /// off-screen engines never get a panel to wire their
    /// `forgetSessionMemory` hook (a duplicate server DELETE is idempotent).
    ///
    /// Refuses a session that exists but is not an Explorer chat: the phone
    /// sends a bare UUID, and without this a paired phone could delete any
    /// ChatSession on the Mac (the quick chat, a conflicts/visual/docGen
    /// chat). An id that no longer exists still runs the engine cleanup.
    func deleteExplorerSession(id uid: UUID, visibleInProject projectId: String?,
                               api: LlmIdeAPIClient?) async -> MobileChatDeleteOutcome {
        if let existing = ChatSessionStore.load(id: uid), existing.scope != .explorer {
            return .notExplorer
        }
        // The phone only ever listed the active project's chats; an id from
        // another project is stale and must not delete a chat it cannot see.
        if let existing = ChatSessionStore.load(id: uid),
           !Self.isExplorerSession(existing, visibleInProject: projectId) {
            return .otherProject
        }
        // `api` is optional only so the network forget at the tail degrades
        // gracefully — the local file delete and engine routing above it
        // must not be skipped when it's nil, or the phone silently keeps a
        // session it deleted.
        let shared = api.map { ChatEngineRegistry.shared.engine(for: .explorer, api: $0) }
        // Off-screen engines FIRST — the one the Mac parked mid-turn and the
        // one the phone bridge holds for a phone turn. Left running, either
        // would persist the chat again at turn end and resurrect it. They are
        // forgotten rather than `deleteSession`ed: that would move an engine
        // nothing displays onto a fallback chat and overwrite the Explorer's
        // "last active chat" pointer from it.
        ChatEngineRegistry.shared.discardOffScreenEngines(sessionID: uid)
        if shared?.currentSessionIDString == uid.uuidString {
            await shared?.deleteSession(uid)
        }
        if ChatSessionStore.load(id: uid) != nil {
            ChatSessionStore.delete(id: uid)
        }
        if ChatArchiveHost.shared.ownsDelete {
            await ChatArchiveHost.shared.finishDelete(uid)
        } else if let api {
            _ = try? await api.forgetSessionMemory(sessionId: uid.uuidString)
        }
        // Drop any cached off-screen engine for this id too — a later
        // explore_chat referencing the same (now-deleted) session must not
        // resolve to a stale cached instance.
        explorerResolver.forget(sessionID: uid)
        return .deleted
    }

    var explorerSessionsDirectory: URL? { ChatSessionStore.explorerSessionsDirectory }

    // MARK: - Turns

    func explorerTurnEngine(for sessionID: UUID, api: LlmIdeAPIClient) -> (any MobileChatTurnEngine)? {
        let shared = ChatEngineRegistry.shared.engine(for: .explorer, api: api)
        return explorerResolver.engine(for: sessionID, sharedExplorerEngine: shared, api: api)
    }

    /// Resolve (creating if needed) the SAME `.quick` `ChatEngine` the menu
    /// bar and the LLM Chat sheet drive, pointed at the Mac's currently
    /// active project — there is no SwiftUI view on the phone path to do this
    /// via `.onAppear`/`.onChange`, so this collapses both into one call.
    ///
    /// `QuickChatContext.attach` is that decision, shared with both Mac
    /// surfaces' `.onAppear`/`.onChange` — including the case the phone path
    /// used to be the only correct implementation of: an engine already
    /// loaded for a STALE project must be repointed via
    /// `switchQuickChatProject(to:)`, never by poking `quickChatProjectId`.
    func quickChat(config: AppConfig, projectStore: ProjectStore,
                   api: LlmIdeAPIClient) -> MobileQuickChat? {
        guard let ctx = QuickChatContext.resolve(config: config, projectStore: projectStore) else { return nil }
        let engine = ChatEngineRegistry.shared.engine(for: .quick, api: api)
        // No session list on the phone, and this runs per request — skip the
        // list re-read the Mac surfaces want on every open.
        QuickChatContext.attach(engine, toProject: ctx.projectId, refreshSessionListIfUnchanged: false)
        // Topped up with the project's open issues — `## Recent open issues`
        // is the only way an agent learns about them (no tool fetches
        // issues). Without it the phone answered "list the issues" with
        // nothing while the Mac panel, which has always passed them, listed
        // them fine.
        return MobileQuickChat(engine: engine, agentContext: {
            await ctx.withRecentIssues(config: config, projectStore: projectStore)
        })
    }

    func quickChatServerSupportsAsk(apiVersion: Int?) -> Bool {
        QuickChatContext.serverSupportsAsk(apiVersion)
    }

    func quickChatUnsupportedServerMessage(apiVersion: Int?) -> String {
        QuickChatContext.unsupportedServerMessage(apiVersion: apiVersion)
    }

    var quickChatNoProjectMessage: String { QuickChatContext.noProjectMessage }

    func isTurnCancellation(_ error: Error) -> Bool {
        ChatEngine.isCancellation(error)
    }
}

// MARK: - ChatEngine as a phone turn engine

/// `runExternalTurn`, `busy`, `currentSessionIDString`, `usesAgentV2Engine`
/// and `clearCurrentChat` are the engine's own members; only the approval and
/// transcript views below are adapted, because their Chat-side types
/// (`ChatEngineHooks`, `AgentV2ApprovalState`, `ChatMessage`) must not cross
/// into Core.
extension ChatEngine: MobileChatTurnEngine {
    var onExternalApproval: ((AgentV2Approval) -> Void)? {
        get { hooks.onExternalApproval }
        set { hooks.onExternalApproval = newValue }
    }

    var parkedApproval: AgentV2Approval? { pendingApproval?.approval }

    /// Raw `role`/`content`, not `wireTurn()`: this is what the phone's quick
    /// chat history always showed (no stopped marker, tool rows dropped).
    var conversationLines: [MobileChatLine] {
        messages
            .filter { $0.role == .user || $0.role == .assistant }
            .map { MobileChatLine(role: $0.role.rawValue, content: $0.content) }
    }

    /// The state is captured BEFORE the POST and its error read AFTER it: a
    /// successful submit drops it from `pendingApproval`, so reading the
    /// engine afterwards would lose a failure the state recorded.
    func submitPhoneToolDecision(action: String) async -> String? {
        let state = pendingApproval
        await submitToolDecision(action: action)
        return state?.lastError
    }

    func submitPhoneApproval(answers: [String: String]) async -> String? {
        let state = pendingApproval
        await submitApproval(answers: answers)
        return state?.lastError
    }
}
