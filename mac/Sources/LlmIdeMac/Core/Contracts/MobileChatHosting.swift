import Foundation

// The seam between Mobile Control (build-excludable, `mobile_sync`) and Chat
// (always compiled). Mobile Control drives phone chat turns, lists/edits
// Explorer chats and relays parked approvals — all of which live in Chat's
// engine and session store. Before this seam the manager named `ChatEngine`,
// `ChatEngineRegistry`, `ChatSessionStore`, `ChatSession` and
// `QuickChatContext` directly, which is a feature → feature edge the boundary
// gate forbids. Now Mobile Control sees only these Core types; Chat
// implements them (`Features/Chat/Services/ChatMobileHost.swift`) and Shell
// hands the implementation to the manager in `FeatureCatalog.bootMobile`.
//
// Everything here is Foundation or Core-owned (`AgentContext`,
// `AgentV2Approval`, `LlmIdeAPIClient`, `TierRouteFallback`, `AppConfig`,
// `ProjectStore`), so the file compiles with `mobile_sync` off — Chat's
// implementation must never need `SharedProtocol` or a MobileControl type.

/// One transcript line in the `{role, content}` shape the phone renders.
/// Role strings are the raw values Chat already put on the wire
/// (`"user"` / `"assistant"`), so the phone frames are byte-identical.
struct MobileChatLine: Equatable, Sendable {
    let role: String
    let content: String
}

/// One Explorer chat row in the phone's session list.
struct MobileChatSessionSummary: Equatable, Sendable {
    let id: UUID
    let title: String
    let lastUsedAt: Date
}

/// One Explorer chat with its transcript, for `explore_load_session`.
struct MobileChatSessionHistory: Equatable, Sendable {
    let id: UUID
    let title: String
    let lines: [MobileChatLine]
}

/// What a phone-requested Explorer chat delete did. The two refusals are
/// distinct only so the Mac log says why; the phone hears nothing either way
/// (its follow-up re-list shows the kept session).
enum MobileChatDeleteOutcome: Equatable, Sendable {
    case deleted
    /// The id names a session of another scope (quick chat, conflicts, …).
    case notExplorer
    /// The id names an Explorer chat of a project the phone cannot see.
    case otherProject
}

/// One chat engine as a phone turn drives it — the shared on-screen engine,
/// an off-screen one the phone bridge holds, or the shared quick-chat engine.
///
/// Contract: every member runs on the main actor; the object identity is
/// stable for the engine's lifetime (Mobile Control keys its single-slot
/// approval hook ownership on `ObjectIdentifier`).
@MainActor
protocol MobileChatTurnEngine: AnyObject {
    /// The loaded session's id, or "" before any session is loaded.
    var currentSessionIDString: String { get }
    /// True when the next turn runs on the Agent (v2) engine — the tier route
    /// must then pick an Agent-engine-capable provider.
    var usesAgentV2Engine: Bool { get }
    /// A turn is running. `runExternalTurn` throws (does not run) while true.
    var busy: Bool { get }
    /// Single-slot hook: called with each approval a turn parks on. The owner
    /// that installs it must clear it only if it still owns it.
    var onExternalApproval: ((AgentV2Approval) -> Void)? { get set }
    /// The approval the engine is currently parked on, if any.
    var parkedApproval: AgentV2Approval? { get }
    /// The engine's transcript, user and assistant lines only (tool-result
    /// rows are turn bookkeeping the phone does not render), oldest first.
    var conversationLines: [MobileChatLine] { get }

    /// Run one turn against `expectedSessionID`. Throws a busy error when a
    /// turn is already running, a session-moved error when the engine is no
    /// longer on `expectedSessionID`, and a cancellation the host's
    /// `isTurnCancellation` recognises when the Mac or phone stopped it.
    /// Returns the final reply text.
    func runExternalTurn(
        message: String,
        skillIds: [String],
        attachments: [LlmIdeAPIClient.CodeAttachment],
        agentContext: AgentContext?,
        model: String?,
        provider: String?,
        mode: String?,
        permissionMode: String?,
        routeFallback: TierRouteFallback?,
        expectedSessionID: UUID,
        onProgress: @escaping (String) -> Void
    ) async throws -> String

    /// Answer the parked ToolApproval. Returns the submit error recorded on
    /// THAT approval (nil when it landed) — read after the POST, because a
    /// failed decision keeps the approval parked with its error for the Mac.
    func submitPhoneToolDecision(action: String) async -> String?
    /// Answer the parked AskUserQuestion; same return contract as above.
    func submitPhoneApproval(answers: [String: String]) async -> String?
    /// Wipe the loaded chat (and its server-side session memory) — the quick
    /// chat's header-trash action.
    func clearCurrentChat() async
}

/// The phone's quick chat: the shared engine, attached to the Mac's active
/// project, plus that project's agent context (resolved lazily, because it
/// awaits an issue fetch the history/clear paths never need).
@MainActor
struct MobileQuickChat {
    let engine: any MobileChatTurnEngine
    let agentContext: () async -> AgentContext
}

/// Everything Mobile Control needs from Chat.
///
/// Contract: main-actor only. A host is installed once per process by Shell;
/// with no host installed Mobile Control replies "Chat not installed" and
/// never crashes. Explorer-session lookups that take `visibleInProject` apply
/// the same rule as the Mac's Explorer list (that project's chats plus
/// unassigned ones; everything when it is nil) and only ever return Explorer
/// chats, never another scope's session with the same id.
@MainActor
protocol MobileChatHosting: AnyObject {
    // MARK: Explorer sessions

    /// Explorer chats visible in `projectId`, in the list order the Mac uses.
    func explorerSessions(visibleInProject projectId: String?) -> [MobileChatSessionSummary]
    /// The Explorer chat `id`, when it exists and is visible in `projectId`.
    func explorerSession(id: UUID, visibleInProject projectId: String?) -> MobileChatSessionHistory?
    /// Create and persist an empty Explorer chat under `projectId`.
    /// Postcondition: `explorerSession(id: result, …)` finds it.
    func createExplorerSession(projectId: String?) -> UUID
    /// Set the title of a visible Explorer chat verbatim. Returns the stored
    /// title, or nil when no such chat is visible (nothing is written).
    func renameExplorerSession(id: UUID, visibleInProject projectId: String?, title: String) -> String?
    /// Delete an Explorer chat through whichever engine holds it, so no
    /// engine can persist it back. Refusals touch nothing.
    func deleteExplorerSession(id: UUID, visibleInProject projectId: String?,
                               api: LlmIdeAPIClient?) async -> MobileChatDeleteOutcome
    /// The directory Explorer chats are stored in (watched to push list
    /// changes to the phone), or nil when it cannot be resolved.
    var explorerSessionsDirectory: URL? { get }

    // MARK: Turns

    /// The engine a phone turn on Explorer chat `sessionID` must run on —
    /// the Mac's on-screen engine only when that cannot hijack what the Mac
    /// shows, otherwise a private off-screen one. Nil when the session no
    /// longer resolves.
    func explorerTurnEngine(for sessionID: UUID, api: LlmIdeAPIClient) -> (any MobileChatTurnEngine)?
    /// The shared quick chat attached to the Mac's active project, or nil
    /// when no project is open.
    func quickChat(config: AppConfig, projectStore: ProjectStore,
                   api: LlmIdeAPIClient) -> MobileQuickChat?
    /// Whether a server at `apiVersion` honours the quick chat's read-only
    /// mode (an older one would run write tools with no approval UI).
    func quickChatServerSupportsAsk(apiVersion: Int?) -> Bool
    /// The answer to give when `quickChatServerSupportsAsk` is false.
    func quickChatUnsupportedServerMessage(apiVersion: Int?) -> String
    /// The answer to give when no project is open on the Mac.
    var quickChatNoProjectMessage: String { get }
    /// True when `error` means the turn was stopped (Mac Stop, session
    /// switch/delete, phone cancel) rather than failed.
    func isTurnCancellation(_ error: Error) -> Bool
}
