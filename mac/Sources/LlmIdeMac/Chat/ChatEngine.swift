import Foundation

/// The chat turn lifecycle — send / stop / stream / queue / auto-continue —
/// lifted out of `CodeAssistantPanel` so it can be driven (and tested)
/// without a SwiftUI view or a live server.
///
/// Everything here is a 1:1 MOVE of the corresponding method in
/// `CodeAssistantPanel+Session.swift`, not a rewrite: same ordering, same
/// guards, same comments explaining why each guard exists. Two things changed
/// shape in the move, both mechanical:
///
///  1. The `/code-assist` round-trip goes through `ChatTransport` instead of
///     `codeAssistRoundTrip`'s direct `LlmIdeAPIClient` calls, so a test can
///     script chunks/progress/errors deterministically.
///  2. Anything the moved bodies read out of panel-only state that this task
///     does NOT move (the `CodeAssistantSession` nudge counter, the panel's
///     attachment list, its per-turn auto-git-op budget, its history packer,
///     `autoChainPendingAction`, the VoiceOver post) is reached through an
///     injected closure that defaults to a no-op. The panel wires them in
///     Task 7; until then the engine is exercised only by its own tests and
///     the panel keeps running its own copies of these methods.
///
/// Task 17 split the grown file along its MARK sections — all pure moves,
/// no behavior change. This file keeps the type declaration (stored state,
/// hooks, init), the turn lifecycle, and streaming. Session management
/// lives in ChatEngine+Session.swift, wire-history packing in
/// ChatEngine+History.swift, panel-driven writes in
/// ChatEngine+PanelWrites.swift, the phone-driven turn surface in
/// ChatEngine+ExternalTurn.swift, and the auto-chain policy types in
/// ChatEngine+AutoChain.swift. Because extensions can't hold stored
/// properties (and Swift's `private` is file-scoped), the state those files
/// mutate is internal rather than `private(set)` — still engine-owned by
/// convention: nothing outside ChatEngine's own files writes it.
@MainActor
@Observable
final class ChatEngine {
    /// FIFO of messages queued while a turn runs. Identifiable so a cancel
    /// button removes the RIGHT entry even after the queue shifts (drain pops
    /// the head between render and tap) — index-keyed rows deleted the wrong one.
    struct QueuedMessage: Identifiable, Equatable {
        let id = UUID()
        let text: String
        let skillIds: [String]
        var userMetadata: ChatMessage.Metadata?
    }

    // MARK: - Observable state (moved 1:1 from the panel)

    /// The conversation. `[ChatMessage]` (not the wire `[CodeAssistTurn]`) is
    /// the engine's own representation as of Task 9: a turn carries its
    /// status, its tool steps, its mode/usage metadata and — for a
    /// client-executed tool result — a typed `ToolResultPayload`, instead of
    /// encoding all of that in magic content strings the view had to sniff.
    /// The wire shape is produced on the way OUT only, by `wireTurn()` /
    /// `historyForRequest`; the server contract is unchanged.
    var messages: [ChatMessage] = []
    var busy = false
    /// Live agent status streamed from /code-assist (SSE): "Searching the web…",
    /// "Writing the answer…", etc. Shown in place of a static "Thinking…" so a
    /// 60–90s agent turn doesn't look hung. Reset at the start of each turn.
    var statusText = ""
    /// Error banner text for the transcript. Publicly settable, unlike the
    /// rest of the turn state: the panel raises its own failures here
    /// (`applyPendingEdit`, `autoChainPendingAction`, `/model`) and the
    /// transcript's error bubble clears it on dismiss — exactly as they did
    /// when this was the panel's own `@State var error`.
    var error: String?
    /// Messages the user submitted while a turn was running, in FIFO order; they
    /// auto-send one per turn as the current run finishes (or is stopped).
    var queued: [QueuedMessage] = []
    /// The assistant turn currently receiving live text — real token streaming
    /// from the server's SSE `chunk` events, mutated in place via
    /// `beginStreamingTurn`/`appendStreamedChunk`/`finishStreamingTurn`.
    /// nil once nothing is streaming.
    var revealingTurnID: UUID?
    /// Characters streamed into the current turn so far. A progress SIGNAL,
    /// not a truncation length: the views render `content` in full and use
    /// this only to know that the stream moved (the transcript follows it to
    /// keep the growing reply on screen). Maintained incrementally — summing
    /// each flushed batch — because `String.count` is O(n) in grapheme
    /// clusters, and recomputing it per chunk made a long reply O(n²).
    var revealedCount = 0

    // MARK: - Chunk coalescing

    /// Text that has arrived from the transport but is not yet written into
    /// `messages`. The server emits one SSE `chunk` per model text delta —
    /// 5-20 characters — so a normal reply arrives as a thousand-plus
    /// callbacks. Writing each one straight into `messages` published a
    /// thousand SwiftUI invalidations, a thousand `WKWebView` document
    /// reloads, and (via the panel's `.onChange(of: engine.messages)`) a
    /// thousand synchronous session-file read/write pairs, all on the
    /// MainActor. Batching them at `chunkCoalesceNanos` cuts every one of
    /// those to ~20/second without changing what the user ends up seeing.
    var pendingChunkText = ""
    /// The turn `pendingChunkText` belongs to. A chunk for a different turn
    /// flushes the buffer first, so text can never land on the wrong message.
    var pendingChunkTurnID: UUID?
    /// The in-flight coalescing delay, if one is scheduled.
    var chunkFlushTask: Task<Void, Never>?
    /// How long chunks accumulate before being published. ~50 ms reads as
    /// continuous typing (20 fps) while collapsing the per-delta storm. A
    /// knob only so tests can flush deterministically; production never
    /// changes it.
    var chunkCoalesceNanos: UInt64 = 50_000_000

    // MARK: - Persistence debounce

    /// The pending debounced session write, if one is scheduled.
    ///
    /// `persistCurrentChat()` is a synchronous read-modify-write of the
    /// session JSON file (`Data(contentsOf:)` plus an atomic `write(to:)`) on
    /// the MainActor, and the panel drives it from `.onChange(of: messages)`
    /// — which fires on every mutation, streamed text included. Coalescing
    /// the chunk storm already cut that from ~1000 writes per reply to
    /// ~20/second; debouncing takes the streaming path down to about one per
    /// second. Every non-streaming caller still writes immediately, and
    /// `flushPendingPersist()` lands the last one at the end of a turn, so
    /// nothing is ever left only in memory.
    var persistDebounceTask: Task<Void, Never>?
    /// How long a streaming-path write waits for further mutations before
    /// landing. A knob only so tests don't wait a real second.
    var persistDebounceNanos: UInt64 = 1_000_000_000

    /// Handle to the in-flight user turn, so `stop()` can cancel it.
    var runTask: Task<Void, Never>?
    /// Handle to the in-flight EXTERNAL (phone-driven) turn, for the same
    /// reason `runTask` exists: `stop()` — the Mac panel's Stop button — and
    /// `resetActiveTurnState()` must be able to cancel a phone turn that is
    /// visibly streaming on the shared engine. Separate from `runTask`
    /// because the result types differ (`String`/`Error`, not `Void`).
    /// Owned by `runExternalTurn`; see its doc comment for how cancellation
    /// reaches it from both surfaces.
    var externalRunTask: Task<String, Error>?
    /// Bumped every time the active chat session changes (create/switch/
    /// delete-fallback). Captured by the auto-continue `asyncAfter` closure
    /// before its delay; if the epoch has moved on by the time it fires, the
    /// closure no-ops instead of starting a turn against a different chat's
    /// history.
    var sessionEpoch: UInt = 0
    /// Measured render height per assistant turn, keyed by MESSAGE id, so each
    /// markdown web-view bubble can be sized to its content in the scroll list.
    /// Written by the VIEW (`ChatMessageList`), so it stays publicly settable
    /// rather than `private(set)`. Stays a dictionary — unlike the tool
    /// steps/mode that moved onto `ChatMessage` in Task 9, a measured render
    /// height is view geometry, not chat data, and must never be persisted.
    /// (It is also more correct now than it was: `ChatMessage.id` is stable
    /// across a save/reload, where `CodeAssistTurn.id` was minted fresh on
    /// every decode.)
    var bubbleHeights: [UUID: CGFloat] = [:]
    /// While `true`, the panel's `handleHistoryChange` persists but skips the
    /// VoiceOver announcement. Set around bulk history loads and around the
    /// streaming placeholder append so an empty turn isn't read aloud.
    /// Publicly settable: the panel's session load/switch paths set it too.
    var suppressHistoryAnnounce = false
    /// The parked AskUserQuestion the v2 engine is blocking on, if any. Set
    /// by the transport's `onApproval` callback (`handleApprovalArrival`),
    /// dropped by submit/dismiss and at turn start. Nil on legacy engines,
    /// which never park a question. The STATE object rather than the raw
    /// `AgentV2Approval` so submit/lastError can evolve on the card without
    /// the engine re-publishing a new value. See AgentV2ApprovalState.swift.
    var pendingApproval: AgentV2ApprovalState?

    /// Saved chats for `scope`, newest `lastUsedAt` first. Reloaded from disk
    /// by `refreshSessions()` — deliberately NOT on every history change; see
    /// `persistCurrentChat`'s doc comment.
    var sessions: [ChatSession] = []
    /// UUID string of the chat currently loaded into `messages`. Empty until
    /// `handleOnAppearSessions()` resolves (or mints) one.
    var currentSessionIDString = ""

    /// Agent-turn metadata. The engine owns it; the panel reads the same
    /// object (it is a reference type, so both see one state).
    let agent = CodeAssistantAgentState()
    /// The turn transport. A `var` (not `let`) since Task 12's agent-engine
    /// toggle: the panel swaps it via `setTransport(_:)` when the user flips
    /// the beta setting, engine identity unchanged. Still engine-owned by
    /// convention — nothing outside `setTransport` assigns it.
    var transport: ChatTransport
    /// Transient banner for v2-engine conditions that are NOT turn failures
    /// — today only the stale-server notice ("Server update needed for the
    /// Agent engine", raised when a v2 turn 404s and the legacy engine
    /// completed it instead). Cleared at the start of the next turn; the
    /// transcript renders it dismissibly next to the error bubble.
    var agentV2Notice: String?
    /// Sidebar section this engine's chats belong to. Fixed for the engine's
    /// lifetime: it scopes the session files (`ChatSession.scope`), the
    /// `"chat.current.<scope>"` relaunch pointer, and `switchSession`'s
    /// cross-scope guard.
    let scope: ChatScope

    /// Delay before a `continueNeeded` reply auto-fires its follow-up turn.
    /// A knob only so tests don't wait 0.8 real seconds; production never
    /// changes it.
    var continueDelayNanos: UInt64 = 800_000_000

    // MARK: - Injected collaborators (the panel wires these in Task 7)

    /// Client-side context snapshot for a turn. Not read by the engine itself
    /// today — `resolveTransportInput` supplies `agentContext` as part of the
    /// fully-formed input — but part of the published interface later tasks
    /// build on.
    var buildContext: () async -> AgentContext = { AgentContext(indexedRepos: []) }

    /// VoiceOver announcement for a finished turn. Injected rather than calling
    /// `NSAccessibility.post` inline so the engine is silent (and AppKit-free)
    /// under test; the panel supplies the real posting closure.
    var sendAnnouncement: (String) -> Void = { _ in }

    /// message, history, attachments, skills → the wire input. The panel's
    /// implementation fills language/model/provider/mode from its own picker
    /// state (see `ChatTransportInput.makeProvider`). The default is a plain
    /// pass-through so the engine is constructible with a transport alone.
    var resolveTransportInput: (String, [LlmIdeAPIClient.CodeAssistTurn],
                                [LlmIdeAPIClient.CodeAttachment], [String]) async -> ChatTransportInput = {
        message, history, attachments, skills in
        ChatTransportInput(message: message, history: history, attachments: attachments,
                           skills: skills, agentContext: nil, language: nil,
                           model: nil, provider: nil, mode: nil)
    }

    /// Called at the very top of every user turn, before any state changes.
    /// Exists so the panel can reset per-turn budgets it still owns (today:
    /// `autoGitOpsThisTurn`, which `autoChainPendingAction` reads and which is
    /// therefore extracted with it, not here).
    var onTurnStart: () -> Void = {}

    /// The prompt the user just sent, for the panel's `CodeAssistantSession`
    /// repeat counter (`session.record(prompt:)`).
    var onRecordPrompt: (String) -> Void = { _ in }

    /// Called with the same prompt right after `onRecordPrompt`. The panel's
    /// wiring applies its own `session.shouldNudge(for:)` test before setting
    /// `agent.nudgePrompt` — the decision stays with the session counter that
    /// owns the threshold, exactly as it did inline.
    var onNudge: (String) -> Void = { _ in }

    /// Attachments to send with a USER turn. `sendFollowup` deliberately sends
    /// none (it re-invokes the agent on the synthetic ack turn already in
    /// history), so this is only consulted by `runTurn` — matching the panel,
    /// where `runTurn` passed `attachmentState.attachments` and `sendFollowup`
    /// passed `[]`.
    var attachmentsForTurn: () -> [LlmIdeAPIClient.CodeAttachment] = { [] }

    /// Packs `messages` for the wire — `[ChatMessage]` in, wire turns out.
    /// Defaults to the engine's own `historyForRequest` (set in `init`, since
    /// a property initializer can't reference `self`) rather than a bare
    /// wire-encoding no-op: code review on Task 12 found that the bare
    /// no-op default was still reachable in production — any engine the
    /// registry hands out whose panel hasn't (yet, or ever, for an
    /// off-screen mobile-bridge engine) called `wireEngine()` fell back to
    /// it, silently dropping the 400k-char total / 24k-per-turn budget for
    /// exactly the phone-driven turns Task 12 added. A caller that
    /// deliberately wants the bare encoder (rather than the budgeted one)
    /// can still reassign this after construction.
    var packHistory: ([ChatMessage]) -> [LlmIdeAPIClient.CodeAssistTurn] = { $0.map { $0.wireTurn() } }

    /// Auto-chain the next pending action (file edit / git op / shell command)
    /// when the budget allows — the panel's `autoChainPendingAction`, which is
    /// extracted later. Both round-trip sites call it so a chained plan keeps
    /// the same truncated-path data-loss guard.
    var autoChain: ((PendingTool?, LlmIdeAPIClient.CodeAssistResponse.Usage?) async -> Void)?

    /// Called with the messages that just replaced `messages` wholesale
    /// (session switch / delete-fallback / on-appear load). The panel wires
    /// this to `rebuildSentPrompts(from:)`, which reseeds the composer's
    /// ↑-recall list — panel-owned composer state until Task 14.
    var onHistoryReplaced: ([ChatMessage]) -> Void = { _ in }

    /// Extra per-conversation reset the panel still owns, called from
    /// `resetActiveTurnState()` in place of the `expandedTurns.removeAll()`
    /// that lived there — `expandedTurns` is view-only expand state, not chat
    /// data, so it stays with the view. No-op until Task 7 wires it.
    var onResetActiveTurnExtra: () -> Void = {}

    /// Extra transient reset the panel still owns, called from
    /// `resetTransientSessionState()`: the composer/attachment state
    /// (`sentPrompts`/`historyIndex`/`draftStash`/`draft`/attachments/
    /// selected skills/auto-attached path/attach notice) that doesn't move
    /// into the engine until Task 14. No-op until Task 7 wires it.
    var onResetTransientStateExtra: () -> Void = {}

    /// Forget the deleted chat's session memory (the server's
    /// `kb/session-memory.mjs` table, distinct from durable project memory).
    /// Injected so `deleteSession` never touches the network under test; the
    /// panel wires it to `api.forgetSessionMemory(sessionId:)` in Task 7.
    var forgetSessionMemory: (String) async -> Void = { _ in }

    /// Drops the deleted chat's SERVER-SIDE v2 chat→SDK-session mapping
    /// (`DELETE /agent/v2/session`) so the Agent engine's next turn for a
    /// re-created chat with the same id can't resume a stale SDK session.
    /// Best-effort by contract: the panel wires it to
    /// `api.agentV2DeleteSession` (which swallows its own failures to the
    /// log), the local delete has already completed by the time it runs, and
    /// tests script a recording double.
    var deleteAgentV2Session: (String) async -> Void = { _ in }

    /// Posts an AskUserQuestion decision (`POST /agent/v2/decision`) —
    /// (requestId, sdkSessionId, answers) → the server's `ok` flag. Injected
    /// like every other network collaborator: the engine reaches the backend
    /// only through `ChatTransport`, which has no decision surface (the
    /// decision is a separate request posted while the turn's stream stays
    /// open). The default reports failure so an unwired engine surfaces that
    /// on the card instead of silently succeeding; Task 12's panel wiring
    /// connects the real `LlmIdeAPIClient.agentV2Decision`.
    var postApprovalDecision: (String, String, [String: String]) async throws -> Bool = { _, _, _ in false }

    /// Posts a `ToolApproval` decision (`{requestId, sdkSessionId, action}`,
    /// no `answers`) on the V2 engine via `POST /agent/v2/decision` — sibling
    /// to `postApprovalDecision`, which answers an `AskUserQuestion`. Default
    /// reports failure, same convention as every other network collaborator
    /// here; the panel wires the real `LlmIdeAPIClient.agentV2ToolDecision`.
    var postToolDecision: (String, String, String) async throws -> Bool = { _, _, _ in false }

    /// Posts a `ToolApproval` decision on the LEGACY engine via
    /// `POST /code-assist/decision` (Task 8) — the legacy-engine counterpart
    /// of `postToolDecision`. The session id is the legacy chat's own
    /// `agentContext.sessionId` (`AgentV2ApprovalState.legacySessionId`), not
    /// an SDK session id. The panel wires the real
    /// `LlmIdeAPIClient.codeAssistDecision`.
    var postLegacyToolDecision: (String, String, String) async throws -> Bool = { _, _, _ in false }

    init(scope: ChatScope, transport: ChatTransport) {
        self.scope = scope
        self.transport = transport
        // See `packHistory`'s doc comment: this can't be the property's own
        // default (a property initializer has no `self`), so it's assigned
        // here instead — `[weak self]` because a strongly-captured `self` in
        // a property `self` itself holds would be a retain cycle. The
        // fallback (reached only if `self` has already been deallocated,
        // which can't happen for a synchronous call from a live instance) is
        // the same bare wire-encoding the property used to default to.
        self.packHistory = { [weak self] messages in
            guard let self else { return messages.map { $0.wireTurn() } }
            return self.historyForRequest(messages)
        }
        connectTransportObservers()
    }

    /// Swap the turn transport (the agent-engine beta toggle's onChange).
    /// Refused mid-turn: the in-flight round-trip holds the old transport,
    /// and swapping under it would split one visible turn across two engines
    /// (and strand any v2 approvals parked against the old one). A flip
    /// during a turn simply applies on the next flip or the next engine.
    func setTransport(_ newTransport: ChatTransport) {
        guard !busy else { return }
        transport = newTransport
        connectTransportObservers()
    }

    /// Point the engine-selection transport's callbacks at engine state.
    /// Called from `init` and `setTransport` so a swapped transport is wired
    /// the same way the original was. No-op for legacy transports.
    private func connectTransportObservers() {
        guard let engineTransport = transport as? AgentV2EngineTransport else { return }
        engineTransport.onStaleServer = { [weak self] in
            self?.agentV2Notice = AgentV2EngineTransport.staleServerBannerText
        }
        // D3 clean cut: selection is per-chat, so the composite must see the
        // CURRENT session's engine marker — only this engine knows which
        // chat is loaded. Unwired (nil), the composite stays fail-closed on
        // legacy, so an engine with no session can never take a v2 turn.
        engineTransport.sessionEngineMarker = { [weak self] in
            self?.currentSessionEngineMarker()
        }
    }

    // MARK: - Turn lifecycle

    /// Launch a turn as an unstructured Task whose handle Stop can cancel.
    func startTurn(_ message: String, skillIds: [String] = [], userMetadata: ChatMessage.Metadata? = nil) {
        runTask = Task { await runTurn(message, skillIds: skillIds, userMetadata: userMetadata) }
    }

    /// Cancel the in-flight turn — panel-driven (`runTask`) or phone-driven
    /// (`externalRunTask`) alike. URLSession.data(for:) throws on
    /// cancellation, so the network request is actually aborted; both turn
    /// kinds treat that as a clean stop (no error bubble).
    func stop() {
        runTask?.cancel()
        externalRunTask?.cancel()
    }

    /// Queue a message the user sent while a turn was running. Drained FIFO,
    /// one per turn, by `runTurn`'s tail.
    func enqueue(_ text: String, skillIds: [String], userMetadata: ChatMessage.Metadata? = nil) {
        queued.append(.init(text: text, skillIds: skillIds, userMetadata: userMetadata))
    }

    /// Run one user turn end-to-end. On completion it drains `queued` (if any)
    /// as a FRESH task — an unstructured `Task {}` does NOT inherit the current
    /// task's cancellation, so a stopped turn still lets the queued message run.
    func runTurn(_ message: String, skillIds: [String] = [], userMetadata: ChatMessage.Metadata? = nil) async {
        onTurnStart()
        onRecordPrompt(message)
        onNudge(message)
        // Append the user turn FIRST so the message appears immediately
        // even if the network call is slow. Constructed directly rather than
        // through `ChatMessage.migrate` (which `appendTurn` uses for the
        // confirmers' synthetic acks): this one is known statically to be a
        // real human turn, so a prompt that happens to start with "(" must
        // not be classified as a tool result.
        messages.append(ChatMessage(role: .user, content: message, status: .done, createdAt: Date(), metadata: userMetadata))
        busy = true
        statusText = ""
        error = nil
        // Transient v2 banner (stale-server notice): it described the
        // PREVIOUS turn's fallback — a new turn starting means it has served
        // its purpose.
        agentV2Notice = nil
        // Clear any stale pending-tool card from a prior turn the user ignored —
        // otherwise it stays interactive against the old args while a new turn runs.
        agent.pendingTool = nil
        // Same reasoning for a parked v2 approval: a NEW turn starting means
        // the old question was never answered (or already expired/aborted
        // server-side), so its card must not stay interactive against the
        // previous turn's requestId.
        pendingApproval = nil
        // Same reasoning for a finished plan's checklist: without this, a prior
        // turn's completed/failed task list stays in agentPendingTasks and
        // (since PlanTimelineCard pins to the latest assistant turn) would
        // visibly attach to this NEW, unrelated turn if its response happens
        // not to include a fresh `tasks` field.
        agent.agentPendingTasks = []
        // Captured once, fixed for this whole invocation, and declared
        // OUTSIDE the do block below so every catch clause can compare
        // against it directly — re-reading the global `revealingTurnID`
        // inside a catch would pick up whatever turn is CURRENTLY
        // streaming, not the one this call started, if a stale/delayed
        // catch fires after a session switch started a newer turn.
        let streamingID = beginStreamingTurn()
        do {
            // Replay as much of the conversation as fits (see
            // historyForRequest); the server applies its own prompt-aware
            // budget on top.
            let recent = packHistory(messages)
            let input = await resolveTransportInput(
                message,
                Array(recent.dropLast()),  // exclude the just-pushed user turn — server appends it
                attachmentsForTurn(),
                skillIds
            )
            // Stream so the user sees live progress ("Searching the web…",
            // "Writing the answer…") instead of a frozen spinner for the
            // 60–90s an agent turn can take. Falls back to buffered on a
            // stream failure (see CodeAssistTransport). The 4-callback form
            // surfaces v2 approvals; legacy transports take the protocol's
            // default, which forwards to the 3-callback method above and
            // never fires onApproval — byte-identical to the old call.
            let resp = try await transport.roundTrip(
                input,
                onProgress: { [self] progress in recordProgress(progress) },
                onChunk: { [self] text in appendStreamedChunk(streamingID, text) },
                onApproval: { [self] approval in
                    handleApprovalArrival(approval, legacySessionId: legacySessionIdForApproval(input))
                }
            )
            // If Stop fired during the await, don't append the (now-unwanted) reply.
            try Task.checkCancellation()
            // If the buffered fallback path fired (no chunk events ever
            // arrived), the placeholder turn is still empty — fill it from
            // the complete reply now. If chunks DID arrive this is usually a
            // same-value overwrite, but it is LOAD-BEARING, not a no-op: the
            // server's fence loop can drop streamed text from the final reply
            // (e.g. its echo-stall guard discards a raw tool-result dump the
            // sniffer already streamed), and this overwrite is what removes
            // that text from the visible chat.
            // `resp.reply` is the authoritative full text, so anything still
            // sitting in the coalescing buffer is about to be overwritten by
            // it — drop it rather than flushing a tail the next line discards.
            discardPendingChunks()
            if let idx = messages.firstIndex(where: { $0.id == streamingID }) {
                messages[idx].content = resp.reply
            }
            finishStreamingTurn(
                streamingID,
                pendingTool: resp.pendingTool,
                tasks: resp.tasks,
                continueNeeded: resp.continueNeeded,
                usage: resp.usage,
                mode: resp.mode,
                stopped: false
            )
            // Only the primary turn's chain check runs here — the follow-up
            // turn's own chain check (inside sendFollowup) covers every step
            // after this one, so an agent that keeps proposing edits can't loop.
            await autoChain?(resp.pendingTool, resp.usage)
        } catch {
            // Stopped-by-user (CancellationError, or URLError.cancelled from
            // URLSession) leaves the partial streamed text (if any) in place,
            // tagged as stopped, with no error banner. A real failure (network
            // drop, decode error, etc.) gets the same finalization — an
            // orphaned `.streaming` placeholder must not linger in `messages`
            // forever either way — plus the `self.error` banner explaining
            // what went wrong, and a per-message `.failed` status carrying the
            // reason (Task 16 hangs the retry affordance off exactly that).
            let isCancellation = error is CancellationError || (error as? URLError)?.code == .cancelled
            if revealingTurnID == streamingID {
                finishStreamingTurn(streamingID, pendingTool: nil, tasks: nil, continueNeeded: nil, usage: nil, mode: nil, stopped: true)
            }
            if !isCancellation {
                self.error = error.localizedDescription
                markFailed(streamingID, error)
            }
        }
        // Drain the next queued message (FIFO) as a fresh, un-cancelled turn.
        drainQueueOrRelease()
    }

    /// Every turn's shared tail: hand the slot to the next queued message
    /// (FIFO, as a fresh un-cancelled task) or release `busy`/`runTask`.
    /// Also called by the panel at the end of a run it drives itself through
    /// this same slot — see `beginPanelRun`.
    func drainQueueOrRelease() {
        if !queued.isEmpty {
            let next = queued.removeFirst()
            startTurn(next.text, skillIds: next.skillIds, userMetadata: next.userMetadata)
        } else {
            busy = false
            runTask = nil
            // Land any debounced streaming write now the turn is over, so a
            // finished conversation is on disk immediately instead of up to
            // `persistDebounceNanos` later. A no-op when nothing is pending —
            // including for a panel-driven engine, whose `.onChange` has
            // usually already written through `finishStreamingTurn`'s
            // mutations. Engines with no panel attached (the mobile bridge)
            // rely on this call.
            flushPendingPersist()
            // Clear the completed phone turn's handle HERE, not in
            // runExternalTurn's wrapper: the body reaches this idle branch
            // before the wrapper's await resumes, and by then a second
            // external turn may legitimately have stored its own handle —
            // an unconditional wrapper-side clear would orphan the newer
            // turn's Stop support. Cancelling an already-completed task is
            // a no-op, so a stale handle was never dangerous; this keeps
            // the field tidy for stop()/tests.
            externalRunTask = nil
        }
    }

    /// Drop a still-queued message the user cancelled from the composer.
    /// Keyed by id, not index — the queue may have shifted (FIFO drain)
    /// between the row rendering and the tap.
    func cancelQueued(id: UUID) {
        queued.removeAll { $0.id == id }
    }

    /// `sendFollowup` guards on `!busy` so a rapid double-confirm, a manual
    /// ⌘↵ mid-stream, or a sheet confirm racing the 0.8s auto-continue window
    /// `finishStreamingTurn` schedules after a `pendingTool` turn can't stack
    /// overlapping round-trips. But `acknowledge(_:followUp: .forceUnblock)`
    /// runs its action from INSIDE a turn that already set `busy = true` —
    /// the Bypass-mode auto-chain path through `autoChainPendingAction`
    /// (bash / update-file / git-op executed without a card) — and needs its
    /// own ack's follow-up to actually fire, not be silently skipped by that
    /// guard. This is the one place that unblocks it.
    ///
    /// As of Task 10's Issue-1 fix, `acknowledge`'s `.forceUnblock` case is
    /// this method's ONLY caller — every confirmer that runs from a
    /// user-driven SHEET tap instead (create/comment/update issue, create PR,
    /// create branch) uses `.ifIdle`, which goes through plain
    /// `sendFollowup()` so it correctly no-ops if an autonomous turn is still
    /// streaming when the sheet confirms, rather than starting a second
    /// concurrent round-trip. `busy = false` here is safe ONLY because
    /// `.forceUnblock` is reserved for call sites that are themselves the
    /// tail of an action whose own work already finished (the auto-chained
    /// tool's execution, not a network call, has already completed by the
    /// time its ack is appended) — `runTurn`/`sendFollowup` re-set
    /// `busy = false` at their own tail regardless (a benign no-op once
    /// already false). A future direct call site here (or a new
    /// `.forceUnblock` use) must re-derive that same argument, not assume it.
    func unblockAndFollowUp() async {
        busy = false
        await sendFollowup()
    }

    func sendFollowup() async {
        // Don't fire a second round-trip if one is already in flight.
        // Without this guard, rapid confirms or a manual ⌘↵ during
        // model streaming would stack overlapping /code-assist requests.
        guard !busy else { return }
        busy = true
        statusText = ""
        agentV2Notice = nil
        defer { busy = false }
        // Captured once, fixed for this whole invocation, and declared
        // OUTSIDE the do block below — see runTurn's matching comment for
        // why the catch clause must compare against this exact id instead
        // of re-reading the (possibly now-different) global `revealingTurnID`.
        let streamingID = beginStreamingTurn()
        do {
            let recent = packHistory(messages)
            // The synthetic "(executed create-gitlab-issue …)" turn we
            // pushed before this call IS the signal the agent needs to
            // see. Keep it in `messages`; pass "(continue)" as the user
            // message purely to pass the server's empty-message guard.
            let input = await resolveTransportInput("(continue)", recent, [], [])
            let resp = try await transport.roundTrip(
                input,
                onProgress: { [self] progress in recordProgress(progress) },
                onChunk: { [self] text in appendStreamedChunk(streamingID, text) },
                onApproval: { [self] approval in
                    handleApprovalArrival(approval, legacySessionId: legacySessionIdForApproval(input))
                }
            )
            // `resp.reply` is the authoritative full text, so anything still
            // sitting in the coalescing buffer is about to be overwritten by
            // it — drop it rather than flushing a tail the next line discards.
            discardPendingChunks()
            if let idx = messages.firstIndex(where: { $0.id == streamingID }) {
                messages[idx].content = resp.reply
            }
            finishStreamingTurn(
                streamingID,
                pendingTool: resp.pendingTool,
                tasks: resp.tasks,
                continueNeeded: resp.continueNeeded,
                usage: resp.usage,
                mode: resp.mode,
                stopped: false
            )
            // Chain the NEXT step hands-free when allowed — this is what lets a
            // multi-step plan (e.g. "update A, then update B" or "commit and
            // push") finish without a card for every step. Mirrors runTurn's
            // own call; without this, only the FIRST step (checked in runTurn)
            // would auto-run and every step after it would stall on a
            // pending-action card even in Auto edit mode. Reading `resp`
            // directly (rather than `agent.pendingTool`/no usage at all, as
            // before) gives this call site the same truncated-path data-loss
            // guard runTurn's copy already had.
            await autoChain?(resp.pendingTool, resp.usage)
        } catch {
            // Same cleanup as runTurn's generic catch — beginStreamingTurn()
            // already inserted an empty placeholder turn before this
            // round-trip started, and a non-cancellation failure must not
            // leave it orphaned in `messages` forever.
            if revealingTurnID == streamingID {
                finishStreamingTurn(streamingID, pendingTool: nil, tasks: nil, continueNeeded: nil, usage: nil, mode: nil, stopped: true)
            }
            // The banner stays unconditional here (unlike runTurn, which
            // suppresses it for a user-initiated stop) — a follow-up is not
            // something the user can press Stop on, so any error reaching
            // this point is worth showing. The `.failed` STATUS, though, is
            // reserved for real failures, so a cancellation propagated from
            // an outer task doesn't mark a message retryable.
            self.error = error.localizedDescription
            let isCancellation = error is CancellationError || (error as? URLError)?.code == .cancelled
            if !isCancellation {
                markFailed(streamingID, error)
            }
        }
    }

    /// Whether the transcript can offer a Retry on the failed reply `id`.
    ///
    /// True only for the shape `runTurn` produces: a `.failed` assistant
    /// placeholder immediately preceded by the user turn it was answering.
    /// A failure inside `sendFollowup` has no user turn of its own to re-send
    /// (its prompt is the synthetic "(continue)"), and re-running it would
    /// mean re-driving a tool chain — so it stays un-retryable rather than
    /// offering a button that does something subtly different from what it says.
    func canRetryFailedTurn(_ id: UUID) -> Bool {
        guard let idx = messages.firstIndex(where: { $0.id == id }),
              messages[idx].status == .failed,
              idx > 0, messages[idx - 1].role == .user else { return false }
        return true
    }

    /// Re-send the user turn whose reply failed.
    ///
    /// Drops the failed placeholder AND the user turn above it, then runs the
    /// prompt again from scratch — `runTurn` appends its own user turn, so
    /// leaving the original would double it in both the transcript and the
    /// replayed history. Refused while another turn is running, for the same
    /// reason `sendFollowup` guards on `busy`: two concurrent round-trips
    /// racing one streaming placeholder.
    ///
    /// The retry carries no `skillIds`: a turn's selected skills aren't
    /// recorded on the message, so there is nothing to recover them from. The
    /// composer's current selection is what a re-send would pick up anyway if
    /// the user re-typed the prompt, and that's the honest equivalent here.
    func retryFailedTurn(_ id: UUID) {
        guard !busy, canRetryFailedTurn(id),
              let idx = messages.firstIndex(where: { $0.id == id }) else { return }
        let userTurn = messages[idx - 1]
        messages.removeSubrange((idx - 1)...idx)
        // The banner described the failure being retried; a retry that fails
        // again raises its own.
        error = nil
        startTurn(userTurn.content, userMetadata: userTurn.metadata)
    }

    /// Tag the placeholder message for a failed round-trip: `.failed` status
    /// plus the reason, so the transcript can offer a retry instead of
    /// leaving a silent empty bubble behind an error banner. Separate from
    /// `finishStreamingTurn(stopped:)`, which runs first and handles the
    /// stream/chain teardown that a stop and a failure share.
    /// Internal (not private) since Task 17's file split: the external-turn
    /// extension file calls it from its catch paths.
    func markFailed(_ id: UUID, _ error: Error) {
        guard let idx = messages.firstIndex(where: { $0.id == id }) else { return }
        messages[idx].status = .failed
        var metadata = messages[idx].metadata ?? ChatMessage.Metadata()
        metadata.failedError = error.localizedDescription
        messages[idx].metadata = metadata
    }

    // MARK: - Streaming

    /// Live status + durable tool-step log for the streaming turn. Moved from
    /// the `onProgress` closure `codeAssistRoundTrip` passed to
    /// `api.codeAssistStream`; shared by both round-trip sites, which each
    /// passed an identical body.
    /// Internal (not private) since Task 17's file split: the external-turn
    /// extension file forwards progress through it.
    func recordProgress(_ progress: LlmIdeAPIClient.AgentProgress) {
        statusText = progress.label
        // Keep a durable row for each TOOL step (not for thinking/writing,
        // which are momentary): this is the record that replaces the raw fence
        // JSON the user used to watch stream into the reply.
        // Written straight onto the streaming MESSAGE (Task 9) rather than
        // into a `turnActivity[turnID]` side table: the steps belong to the
        // turn, so they now survive a save/reload like the rest of it, and
        // the transcript reads them from one place whether the turn is live
        // or loaded from disk.
        guard progress.isTool, let turnID = revealingTurnID,
              let idx = messages.firstIndex(where: { $0.id == turnID }) else { return }
        // The loop re-emits on every iteration; a repeat of the same
        // action back-to-back is noise, not a second step.
        if messages[idx].toolSteps.last?.label == progress.label { return }
        messages[idx].toolSteps.append(.init(label: progress.label, tool: progress.tool))
    }

    /// Begin a new streaming assistant turn: appends a `.streaming`
    /// placeholder message and marks it as the one `appendStreamedChunk` will
    /// mutate. The append happens with `suppressHistoryAnnounce` set so the
    /// length-triggered VoiceOver announcement in `handleHistoryChange`
    /// doesn't fire on an empty placeholder — `finishStreamingTurn` fires the
    /// real announcement itself, once, with the complete text.
    func beginStreamingTurn() -> UUID {
        let message = ChatMessage(role: .assistant, content: "", status: .streaming, createdAt: Date())
        suppressHistoryAnnounce = true
        messages.append(message)
        DispatchQueue.main.async { [self] in suppressHistoryAnnounce = false }
        revealingTurnID = message.id
        revealedCount = 0
        return message.id
    }

    /// Buffer `text` for the streaming turn identified by `id`, publishing it
    /// into `messages` at most once per `chunkCoalesceNanos`.
    ///
    /// This is deliberately NOT a straight `messages[idx].content += text`
    /// anymore: see `pendingChunkText` for what a per-delta write costs. The
    /// buffer is published by `flushPendingChunks()`, which every exit from a
    /// turn calls before it reads or overwrites the turn's content — so no
    /// caller can observe a partially-drained stream.
    func appendStreamedChunk(_ id: UUID, _ text: String) {
        // A chunk for a different turn means the previous turn is done
        // receiving text; land its buffer before starting a new one rather
        // than appending across the boundary.
        if let pending = pendingChunkTurnID, pending != id { flushPendingChunks() }
        pendingChunkTurnID = id
        pendingChunkText += text
        guard chunkFlushTask == nil else { return }
        chunkFlushTask = Task { [chunkCoalesceNanos] in
            try? await Task.sleep(nanoseconds: chunkCoalesceNanos)
            // `Task.sleep` throws on cancellation, so a cancelled flush lands
            // nothing here — the buffer stays put for whichever exit path
            // (finishStreamingTurn, the reply overwrite) flushes it next.
            guard !Task.isCancelled else { return }
            self.flushPendingChunks()
        }
    }

    /// Publish every buffered chunk into its turn and clear the timer.
    /// Idempotent and cheap when the buffer is empty, so exit paths can call
    /// it unconditionally.
    func flushPendingChunks() {
        chunkFlushTask?.cancel()
        chunkFlushTask = nil
        guard !pendingChunkText.isEmpty, let id = pendingChunkTurnID else {
            pendingChunkText = ""
            return
        }
        let batch = pendingChunkText
        pendingChunkText = ""
        guard let idx = messages.firstIndex(where: { $0.id == id }) else {
            pendingChunkTurnID = nil
            return
        }
        messages[idx].content += batch
        // Incremental, not `content.count` — see `revealedCount`. Combining
        // marks at a batch boundary can make this drift a character or two
        // above the true grapheme count, which is harmless: nothing slices
        // the content by it, it only has to move when the stream moves.
        revealedCount += batch.count
    }

    /// Drop buffered chunks without publishing them. For the one case where
    /// the buffer is genuinely unwanted: the turn's content is about to be
    /// replaced wholesale by the server's authoritative final reply, so
    /// flushing first would append text the overwrite is about to discard
    /// anyway — and would briefly render a duplicated tail while it did.
    func discardPendingChunks() {
        chunkFlushTask?.cancel()
        chunkFlushTask = nil
        pendingChunkText = ""
        pendingChunkTurnID = nil
    }

    /// Finalize a streaming turn: fires the VoiceOver announcement exactly
    /// once (with the complete final text), applies `pendingTool`/
    /// `agentPendingTasks`/auto-continue exactly as `runTurn` did before this
    /// refactor, and — when `stopped` — leaves whatever partial text already
    /// streamed in place, tagged as stopped, instead of discarding it.
    func finishStreamingTurn(
        _ id: UUID,
        pendingTool: PendingTool?,
        tasks: [AgentTask]?,
        continueNeeded: Bool?,
        usage: LlmIdeAPIClient.CodeAssistResponse.Usage?,
        mode: String?,
        stopped: Bool
    ) {
        // Land any coalesced text before finalizing. This is what preserves
        // the partial reply on the paths that DON'T overwrite from
        // `resp.reply` — a user Stop, a mid-stream network failure, a session
        // switch finalizing the outgoing turn. Without it the last ≤50 ms of
        // streamed text would be silently dropped on exactly those paths.
        // A no-op after `discardPendingChunks()`, which the success paths run.
        flushPendingChunks()
        revealingTurnID = nil
        revealedCount = 0
        if let idx = messages.firstIndex(where: { $0.id == id }) {
            // A stop is a STATUS now, not a `"\n\n_(stopped)_"` suffix glued
            // onto the content: the partial text stays exactly as it
            // streamed, and the marker is re-synthesized only on the way out
            // to the server (`ChatMessage.wireTurn()`).
            messages[idx].status = stopped ? .stopped : .done
            var metadata = messages[idx].metadata ?? ChatMessage.Metadata()
            // Only store non-default modes — ModeBadge never renders for
            // .execute/.auto, and most turns use one of those, so recording
            // them would only add noise the transcript then has to filter.
            if let mode, let resolved = CodeAssistMode(rawValue: mode),
               resolved != .execute, resolved != .auto {
                metadata.mode = resolved.rawValue
            }
            metadata.usage = usage
            messages[idx].metadata = metadata
            let text = String(messages[idx].content.prefix(200))
            if !text.isEmpty {
                sendAnnouncement(text)
            }
        }
        guard !stopped else {
            // A stopped turn (Stop/Esc mid-send, cancellation, or certain
            // error paths that pass `stopped: true`) must always end any
            // in-flight autonomous chain, regardless of why it stopped —
            // this early return happens BEFORE the `else` branch below that
            // normally resets `agentIsAutonomous`, so without this line the
            // flag stayed stuck `true` forever after a stop even though
            // `busy`/`runTask` correctly cleared via the caller's own tail.
            agent.agentIsAutonomous = false
            // It must also LAND the plan-execute tracker. `updatePlanExecution`
            // below is the only other exit from `.running`, and this return
            // skips it — so a Stop (or any error path passing `stopped: true`)
            // mid-execution left the running card spinning forever with no
            // Dismiss button, the attachment bar hidden behind
            // `phase != .running`, and the plan card stuck on "Executing plan…".
            // `.failed` is the honest phase: its card reads "Plan execution
            // stopped" and carries the Dismiss the running card doesn't have.
            if var tracker = agent.planExecution, tracker.phase == .running {
                tracker.phase = .failed
                agent.planExecution = tracker
            }
            return
        }
        self.agent.pendingTool = pendingTool
        if let newTasks = tasks {
            agent.agentPendingTasks = newTasks
            updatePlanExecution(with: newTasks, continueNeeded: continueNeeded)
        } else if continueNeeded == false {
            updatePlanExecution(with: agent.agentPendingTasks, continueNeeded: continueNeeded)
        }
        if continueNeeded == true && !agent.agentStopRequested {
            agent.agentIsAutonomous = true
            let scheduledEpoch = sessionEpoch
            DispatchQueue.main.asyncAfter(deadline: .now() + .nanoseconds(Int(continueDelayNanos))) {
                MainActor.assumeIsolated {
                    guard self.sessionEpoch == scheduledEpoch else { return }
                    guard !self.agent.agentStopRequested else {
                        self.agent.agentIsAutonomous = false
                        return
                    }
                    // A round-trip (including a synchronous auto-chain — e.g.
                    // update-file/git-op chaining, which can take far longer
                    // than this 0.8s delay) may already be in flight by the
                    // time this fires. That in-flight call will itself
                    // re-evaluate continueNeeded via its own finishStreamingTurn
                    // call when it completes, so firing a second, redundant
                    // "Continue working" turn here would only race its writes to
                    // agent.pendingTool/agent.agentPendingTasks and orphan Stop's
                    // ability to cancel the REAL chain (this closure would
                    // reassign runTask out from under it via startTurn).
                    guard !self.busy else { return }
                    self.startTurn("Continue working on your pending tasks.")
                }
            }
        } else {
            agent.agentIsAutonomous = false
            agent.agentStopRequested = false
        }
        if let u = usage {
            agent.lastMemoryTokens = u.memoryApproxTokens
            agent.lastMemoryHasChat = u.memoryHasChatMemory ?? false
        }
    }

    /// Advance the plan-execute tracker when server tasks complete or fail.
    private func updatePlanExecution(with tasks: [AgentTask], continueNeeded: Bool?) {
        guard var tracker = agent.planExecution, tracker.phase == .running else { return }
        if !tasks.isEmpty { tracker.lastTasks = tasks }
        if tasks.contains(where: { $0.status == .failed }) {
            tracker.phase = .failed
        } else if !tasks.isEmpty,
                  !tasks.contains(where: { $0.status == .pending || $0.status == .inProgress }),
                  continueNeeded != true {
            tracker.phase = .finished
        }
        agent.planExecution = tracker
    }

}
