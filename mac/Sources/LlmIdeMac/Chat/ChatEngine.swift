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
    }

    // MARK: - Observable state (moved 1:1 from the panel)

    /// The conversation. `[ChatMessage]` (not the wire `[CodeAssistTurn]`) is
    /// the engine's own representation as of Task 9: a turn carries its
    /// status, its tool steps, its mode/usage metadata and — for a
    /// client-executed tool result — a typed `ToolResultPayload`, instead of
    /// encoding all of that in magic content strings the view had to sniff.
    /// The wire shape is produced on the way OUT only, by `wireTurn()` /
    /// `historyForRequest`; the server contract is unchanged.
    private(set) var messages: [ChatMessage] = []
    private(set) var busy = false
    /// Live agent status streamed from /code-assist (SSE): "Searching the web…",
    /// "Writing the answer…", etc. Shown in place of a static "Thinking…" so a
    /// 60–90s agent turn doesn't look hung. Reset at the start of each turn.
    private(set) var statusText = ""
    /// Error banner text for the transcript. Publicly settable, unlike the
    /// rest of the turn state: the panel raises its own failures here
    /// (`applyPendingEdit`, `autoChainPendingAction`, `/model`) and the
    /// transcript's error bubble clears it on dismiss — exactly as they did
    /// when this was the panel's own `@State var error`.
    var error: String?
    /// Messages the user submitted while a turn was running, in FIFO order; they
    /// auto-send one per turn as the current run finishes (or is stopped).
    private(set) var queued: [QueuedMessage] = []
    /// The assistant turn currently receiving live text — real token streaming
    /// from the server's SSE `chunk` events, mutated in place via
    /// `beginStreamingTurn`/`appendStreamedChunk`/`finishStreamingTurn`.
    /// nil once nothing is streaming.
    private(set) var revealingTurnID: UUID?
    private(set) var revealedCount = 0
    /// Handle to the in-flight user turn, so `stop()` can cancel it.
    private(set) var runTask: Task<Void, Never>?
    /// Bumped every time the active chat session changes (create/switch/
    /// delete-fallback). Captured by the auto-continue `asyncAfter` closure
    /// before its delay; if the epoch has moved on by the time it fires, the
    /// closure no-ops instead of starting a turn against a different chat's
    /// history.
    private(set) var sessionEpoch: UInt = 0
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

    /// Saved chats for `scope`, newest `lastUsedAt` first. Reloaded from disk
    /// by `refreshSessions()` — deliberately NOT on every history change; see
    /// `persistCurrentChat`'s doc comment.
    private(set) var sessions: [ChatSession] = []
    /// UUID string of the chat currently loaded into `messages`. Empty until
    /// `handleOnAppearSessions()` resolves (or mints) one.
    private(set) var currentSessionIDString = ""

    /// Agent-turn metadata. The engine owns it; the panel reads the same
    /// object (it is a reference type, so both see one state).
    let agent = CodeAssistantAgentState()
    let transport: ChatTransport
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
    /// The panel wires this to the engine's own `historyForRequest` (moved
    /// here in Task 7 together with `HistoryForRequestTests`); the default
    /// only does the wire encoding, so a test that doesn't care about
    /// budgeting can construct the engine with a transport alone. Leaving it
    /// unwired in production would silently drop the 400k-char request budget.
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

    init(scope: ChatScope, transport: ChatTransport) {
        self.scope = scope
        self.transport = transport
    }

    // MARK: - Turn lifecycle

    /// Launch a turn as an unstructured Task whose handle Stop can cancel.
    func startTurn(_ message: String, skillIds: [String] = []) {
        runTask = Task { await runTurn(message, skillIds: skillIds) }
    }

    /// Cancel the in-flight turn. URLSession.data(for:) throws on cancellation,
    /// so the network request is actually aborted; runTurn treats that as a
    /// clean stop (no error bubble) and then drains any queued message.
    func stop() {
        runTask?.cancel()
    }

    /// Queue a message the user sent while a turn was running. Drained FIFO,
    /// one per turn, by `runTurn`'s tail.
    func enqueue(_ text: String, skillIds: [String]) {
        queued.append(.init(text: text, skillIds: skillIds))
    }

    /// Run one user turn end-to-end. On completion it drains `queued` (if any)
    /// as a FRESH task — an unstructured `Task {}` does NOT inherit the current
    /// task's cancellation, so a stopped turn still lets the queued message run.
    func runTurn(_ message: String, skillIds: [String] = []) async {
        onTurnStart()
        onRecordPrompt(message)
        onNudge(message)
        // Append the user turn FIRST so the message appears immediately
        // even if the network call is slow. Constructed directly rather than
        // through `ChatMessage.migrate` (which `appendTurn` uses for the
        // confirmers' synthetic acks): this one is known statically to be a
        // real human turn, so a prompt that happens to start with "(" must
        // not be classified as a tool result.
        messages.append(ChatMessage(role: .user, content: message, status: .done, createdAt: Date()))
        busy = true
        statusText = ""
        error = nil
        // Clear any stale pending-tool card from a prior turn the user ignored —
        // otherwise it stays interactive against the old args while a new turn runs.
        agent.pendingTool = nil
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
            // stream failure (see CodeAssistTransport).
            let resp = try await transport.roundTrip(
                input,
                onProgress: { [self] progress in recordProgress(progress) },
                onChunk: { [self] text in appendStreamedChunk(streamingID, text) }
            )
            // If Stop fired during the await, don't append the (now-unwanted) reply.
            try Task.checkCancellation()
            // If the buffered fallback path fired (no chunk events ever
            // arrived), the placeholder turn is still empty — fill it from
            // the complete reply now. If chunks DID arrive, messages[idx]
            // already holds the complete text and this is a no-op overwrite
            // with the same value.
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
            startTurn(next.text, skillIds: next.skillIds)
        } else {
            busy = false
            runTask = nil
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
                onChunk: { [self] text in appendStreamedChunk(streamingID, text) }
            )
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

    /// Tag the placeholder message for a failed round-trip: `.failed` status
    /// plus the reason, so the transcript can offer a retry instead of
    /// leaving a silent empty bubble behind an error banner. Separate from
    /// `finishStreamingTurn(stopped:)`, which runs first and handles the
    /// stream/chain teardown that a stop and a failure share.
    private func markFailed(_ id: UUID, _ error: Error) {
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
    private func recordProgress(_ progress: LlmIdeAPIClient.AgentProgress) {
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

    /// Append `text` to the streaming turn identified by `id`. `revealedCount`
    /// tracks the turn's current length so `ChatMessageList.displayedContent`
    /// (which truncates to `revealedCount` characters for whichever turn
    /// matches `revealingTurnID`) shows the growing content as it arrives —
    /// the same read path the old fixed-schedule reveal used, now driven by
    /// real chunk arrival instead of an artificial timer.
    func appendStreamedChunk(_ id: UUID, _ text: String) {
        guard let idx = messages.firstIndex(where: { $0.id == id }) else { return }
        messages[idx].content += text
        revealedCount = messages[idx].content.count
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
            return
        }
        self.agent.pendingTool = pendingTool
        if let newTasks = tasks {
            agent.agentPendingTasks = newTasks
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

    // MARK: - Session management
    //
    // Moved 1:1 from `CodeAssistantPanel+Session.swift` (the panel keeps its
    // own copies until Task 7 rewires it). Three mechanical changes, all
    // forced by the move out of the view:
    //
    //  1. `persistCurrentChat(history:)` loses its parameter — the engine owns
    //     `messages`, so it applies the same 50-turn cap its callers used to
    //     pass in.
    //  2. `rebuildSentPrompts(from:)` (composer state, still panel-owned)
    //     becomes the `onHistoryReplaced` hook; `expandedTurns.removeAll()`
    //     (view expand state) and the composer/attachment resets become the
    //     `onResetActiveTurnExtra` / `onResetTransientStateExtra` hooks.
    //  3. `deleteSession`'s `Task.detached { api.forgetSessionMemory(…) }`
    //     becomes the injected `forgetSessionMemory` closure (see below for
    //     why it moved to the tail of the method).

    /// UserDefaults key holding the last-active chat id for this scope.
    private var pointerKey: String { "chat.current.\(scope.rawValue)" }

    /// Persist `messages` into the current UUID session file, deriving a
    /// title from the first user turn if it's still "New chat".
    ///
    /// Does NOT call `refreshSessions()` — this runs on every history change
    /// (i.e. every turn), and the sidebar/dropdown session list only needs
    /// to reflect the latest title/timestamp when it's actually shown or
    /// when sessions are created/switched/deleted. Reloading the list from
    /// disk on every message was wasted work on the hot path.
    ///
    /// Only the last 50 turns are written — the same cap every caller of the
    /// panel's `persistCurrentChat(history:)` applied at the call site.
    func persistCurrentChat() {
        guard let id = UUID(uuidString: currentSessionIDString) else { return }
        let capped = Array(messages.suffix(50))
        var session = ChatSessionStore.load(id: id) ?? ChatSession(id: id, scope: scope)
        session.scope = scope
        // A straight assignment as of Task 9 — `messages` IS the persisted
        // shape now, so ids/`createdAt`/status/tool steps carry through
        // untouched. (Task 8 needed a position-by-position reconciliation
        // against the file on disk here, because the engine's own array was
        // still `[CodeAssistTurn]` and every persist had to re-synthesize
        // `ChatMessage`s — handing all 50 retained messages a brand-new id
        // and a `createdAt` of "now" on every single turn unless carefully
        // matched up. Owning `[ChatMessage]` end-to-end removes the problem
        // rather than compensating for it; the identity guarantee is the
        // same, and `ChatEngineSessionTests.persistPreservesIdentity` still
        // pins it.)
        session.messages = capped
        if session.title == "New chat" || session.title.isEmpty {
            if let firstUser = capped.first(where: { $0.role == .user }) {
                let raw = firstUser.content
                    .replacingOccurrences(of: "\n", with: " ")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if !raw.isEmpty {
                    session.title = String(raw.prefix(40))
                }
            }
        }
        ChatSessionStore.save(session)
    }

    /// Reload `sessions` for this scope from disk, newest first.
    func refreshSessions() {
        sessions = ChatSessionStore.list(for: scope)
    }

    /// Renames a saved chat. Safe from being clobbered later:
    /// persistCurrentChat's auto-title-from-first-message logic only fires
    /// when the title is still "New chat"/empty, so any other title —
    /// including a manual rename — is left alone on every later save.
    func renameSession(_ id: UUID, to newTitle: String) {
        let trimmed = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, var session = ChatSessionStore.load(id: id) else { return }
        session.title = String(trimmed.prefix(60))
        ChatSessionStore.save(session)
        refreshSessions()
    }

    /// Mirror `currentSessionIDString` to UserDefaults so the current chat
    /// survives relaunch.
    func rememberCurrentPointer() {
        UserDefaults.standard.set(currentSessionIDString, forKey: pointerKey)
    }

    /// Resolve which chat this scope should show on appear: migrate any legacy
    /// per-scope file, load the session list, then restore the remembered
    /// pointer → fall back to the newest session → mint a fresh one. Sets
    /// `messages` itself (like every other session-swap method here) and
    /// returns it for the caller's convenience.
    ///
    /// Extracted from `CodeAssistantPanel.handleOnAppear`, which also does
    /// model-picker and initial-attachment setup — that half stays in the view.
    @discardableResult
    func handleOnAppearSessions() -> [ChatMessage] {
        _ = ChatSessionStore.migrateScopeFileIfNeeded(for: scope)
        refreshSessions()
        if currentSessionIDString.isEmpty {
            currentSessionIDString = UserDefaults.standard.string(forKey: pointerKey) ?? ""
        }
        suppressHistoryAnnounce = true
        if let cur = UUID(uuidString: currentSessionIDString),
           let session = ChatSessionStore.load(id: cur),
           session.scope == scope {
            messages = session.messages
            onHistoryReplaced(session.messages)
        } else if let newest = sessions.first {
            currentSessionIDString = newest.id.uuidString
            messages = newest.messages
            onHistoryReplaced(newest.messages)
            rememberCurrentPointer()
        } else {
            // No usable pointer and no saved chats for this scope — start one.
            // (mintFreshSession clears `messages` itself.)
            mintFreshSession()
        }
        DispatchQueue.main.async { [self] in suppressHistoryAnnounce = false }
        return messages
    }

    /// Cancel any in-flight turn and clear per-conversation transient
    /// state (`busy`, `queued`, plus whatever `onResetActiveTurnExtra` owns —
    /// the panel's `expandedTurns`). Called whenever the active chat is
    /// swapped out (create/switch/delete) so a running reply can't land its
    /// result in — or leave `busy` stuck locking — the newly active chat, and
    /// queued messages / expanded-message ids don't survive the swap.
    func resetActiveTurnState() {
        runTask?.cancel()
        runTask = nil
        busy = false
        queued.removeAll()
        onResetActiveTurnExtra()
        // runTask?.cancel() above is fire-and-forget — the actual
        // CancellationError cleanup inside runTurn's/sendFollowup's catch
        // block runs asynchronously and is NOT guaranteed to complete before
        // callers of this function persist or swap `messages` right after it
        // returns (session switch/create/delete). Finalize any in-flight
        // streaming turn synchronously here instead, so the outgoing
        // session's placeholder is never left unfinished when persisted.
        if let streamingID = revealingTurnID {
            finishStreamingTurn(streamingID, pendingTool: nil, tasks: nil, continueNeeded: nil, usage: nil, mode: nil, stopped: true)
        } else {
            revealedCount = 0
        }
    }

    /// Reset all agent + transient state for a freshly created, switched-to,
    /// or fallback chat. Does NOT touch `messages` — callers are responsible
    /// for that. If the caller also fires `onHistoryReplaced` (i.e. it's
    /// loading a non-empty history rather than starting a blank chat), fire it
    /// AFTER this so its seeded composer recall state isn't clobbered by
    /// `onResetTransientStateExtra`'s blanket reset.
    ///
    /// Bumps `sessionEpoch` and mints a fresh `agentSessionId`, so anything
    /// tied to the outgoing session — in particular the auto-continue
    /// `asyncAfter` closure scheduled from `finishStreamingTurn` — can detect
    /// the switch and no-op instead of acting on the new session's history.
    func resetTransientSessionState() {
        agent.pendingTool = nil
        error = nil
        agent.nudgePrompt = nil
        agent.agentSessionId = UUID().uuidString
        agent.agentPendingTasks = []
        agent.agentIsAutonomous = false
        agent.agentStopRequested = false
        sessionEpoch += 1
        // Composer/attachment state the panel still owns (Task 14 moves it).
        // Order against the engine-owned resets above is immaterial — the two
        // sets of fields are disjoint.
        onResetTransientStateExtra()
    }

    /// Save a fresh session as the new current one, point all the bookkeeping
    /// (pointer, defaults, sessions list) at it, and reset transient state
    /// for a blank chat. Shared tail of `createNewSession` and the
    /// no-sessions-left branch of `deleteSession`.
    func mintFreshSession() {
        let fresh = ChatSession(scope: scope)
        ChatSessionStore.save(fresh)
        currentSessionIDString = fresh.id.uuidString
        rememberCurrentPointer()
        refreshSessions()
        messages = []
        resetTransientSessionState()
    }

    /// Start a new empty chat for this scope. No-op if the current chat is
    /// already an untouched "New chat" (avoids duplicate empty rows from
    /// repeated taps on "+ New chat").
    func createNewSession() {
        if messages.isEmpty {
            let title = sessions.first(where: { $0.id.uuidString == currentSessionIDString })?.title ?? "New chat"
            if title == "New chat" || title.isEmpty { return }
        }
        // Finalize any in-flight stream BEFORE persisting — otherwise an
        // unfinished placeholder turn could be written to disk (see
        // resetActiveTurnState's doc comment).
        resetActiveTurnState()
        persistCurrentChat()
        mintFreshSession()
    }

    /// Switch the active chat to `id`, persisting the outgoing chat first.
    func switchSession(to id: UUID) {
        guard id.uuidString != currentSessionIDString else { return }
        guard let session = ChatSessionStore.load(id: id), session.scope == scope else { return }
        // Finalize any in-flight stream BEFORE persisting — otherwise an
        // unfinished placeholder turn could be written to disk (see
        // resetActiveTurnState's doc comment).
        resetActiveTurnState()
        persistCurrentChat()
        currentSessionIDString = id.uuidString
        rememberCurrentPointer()
        resetTransientSessionState()
        suppressHistoryAnnounce = true
        messages = session.messages
        onHistoryReplaced(session.messages)
        DispatchQueue.main.async { [self] in suppressHistoryAnnounce = false }
        ChatSessionStore.save(session)
        refreshSessions()
    }

    /// Delete chat `id`. If it was the active chat, switch to the next most
    /// recent session, or mint a fresh empty one if none remain.
    ///
    /// `async` only because of the session-memory forget at the tail. Every
    /// state change below still happens before the first suspension point, so
    /// a caller's `Task { await engine.deleteSession(id) }` updates the UI in
    /// the same turn the panel's old synchronous call did.
    func deleteSession(_ id: UUID) async {
        // Captured once: the panel's version read `currentSessionIDString`
        // twice inside one synchronous body, so both reads saw the same value.
        let wasActive = id.uuidString == currentSessionIDString
        if wasActive { resetActiveTurnState() }
        ChatSessionStore.delete(id: id)
        refreshSessions()
        if wasActive {
            if let next = sessions.first {
                currentSessionIDString = next.id.uuidString
                rememberCurrentPointer()
                resetTransientSessionState()
                suppressHistoryAnnounce = true
                messages = next.messages
                onHistoryReplaced(next.messages)
                DispatchQueue.main.async { [self] in suppressHistoryAnnounce = false }
            } else {
                // No sessions left for this scope — mint a blank one and
                // point everything (pointer, defaults, sessions list) at it.
                mintFreshSession()
            }
        }
        // Delete this chat's session memory (kb/session-memory.mjs — a real DB
        // table, distinct from project memory, which is durable and untouched
        // by this), so facts captured from a chat the user has thrown away
        // don't keep coming back in every later prompt. Last, and awaited
        // rather than detached: the chat file and the UI are already updated,
        // so a slow/failed forget delays nothing the user can see (and a
        // failure is recoverable by a later delete).
        await forgetSessionMemory(id.uuidString)
    }

    /// Header trash: delete the current chat (mints a fresh empty one if it
    /// was the last remaining session for this scope).
    func clearCurrentChat() async {
        guard let id = UUID(uuidString: currentSessionIDString) else {
            createNewSession()
            return
        }
        await deleteSession(id)
    }

    /// Reload the active chat from disk and reseed anything derived from it.
    /// Driven by `.explorerChatTranscriptChanged`: an iPhone `explore_chat`
    /// persisted a turn into this session's file, so the in-memory copy is
    /// stale — and would otherwise be written back over the phone's turn by
    /// the next `persistCurrentChat`. The scope guard mirrors
    /// `switchSession`'s: a notification naming a chat from another section
    /// must not load into this engine.
    func reloadFromDisk(id: UUID) {
        guard let session = ChatSessionStore.load(id: id), session.scope == scope else { return }
        messages = session.messages
        onHistoryReplaced(session.messages)
    }

    // MARK: - History change

    /// Persist the chat and announce a newly-arrived assistant turn — the
    /// panel's `handleHistoryChange`, driven by `.onChange(of: engine.messages)`.
    ///
    /// Only a GROWING history announces, and only when the new last turn is
    /// the assistant's: an in-place edit (streamed chunks land as content
    /// mutations on an existing turn) must not re-read the whole reply on
    /// every chunk. `suppressHistoryAnnounce` covers the two cases where the
    /// array does grow but nothing should be read aloud — a bulk session load
    /// and the empty streaming placeholder (`finishStreamingTurn` announces
    /// that one itself, once, with the complete text).
    ///
    /// The announcement goes through `sendAnnouncement` rather than
    /// `NSAccessibility.post` directly, so the engine stays AppKit-free and
    /// silent under test — same as `finishStreamingTurn`.
    func announceAndPersist(oldValue: [ChatMessage],
                            newValue: [ChatMessage]) {
        persistCurrentChat()
        guard !suppressHistoryAnnounce else { return }
        if newValue.count > oldValue.count,
           let last = newValue.last,
           last.role == .assistant {
            let text = String(last.content.prefix(200))
            if !text.isEmpty {
                sendAnnouncement(text)
            }
        }
    }

    // MARK: - History packing for the wire

    /// Total characters of chat history sent per request. The server applies
    /// its own (smaller, prompt-aware) budget — see `config.history` and
    /// `selectHistoryTurns` in `llm_agent/runtime/loop.mjs` — so this only has
    /// to keep the POST body clear of the server's 8 MB request-body limit.
    static let maxHistoryChars = 400_000
    /// Per-turn clip. One runaway turn (a big command output, a whole file)
    /// must not be able to consume the entire budget by itself.
    static let maxHistoryTurnChars = 24_000

    /// The history to replay on the wire: as much as fits `maxHistoryChars`,
    /// newest-first, ALWAYS including the first user turn.
    ///
    /// Replaces a flat `history.suffix(8)`. Eight turns sounds generous until
    /// you count tool calls: every client-executed tool (bash / update-file /
    /// git-op) appends a synthetic result turn plus the agent's reply, so a
    /// four-step task pushed the user's original request out of the window and
    /// the agent carried on with no idea what it had been asked to do.
    ///
    /// Takes its input as a parameter rather than reading `self.messages`:
    /// both round-trip sites pack the history they are about to send, and the
    /// contract is pinned turn-by-turn by `HistoryForRequestTests`.
    ///
    /// Wire-encodes FIRST (`wireTurn()`, which re-renders a `.toolResult`
    /// message through `ToolResultPayload.legacyContent()` and re-attaches the
    /// stopped marker), then budgets. Both budgets have to measure what is
    /// actually SENT — a tool-result message's `content` and its reconstructed
    /// wire text can differ, and it's the latter that lands in the POST body.
    func historyForRequest(_ msgs: [ChatMessage])
        -> [LlmIdeAPIClient.CodeAssistTurn]
    {
        let clipped = msgs.map { $0.wireTurn() }.map { turn -> LlmIdeAPIClient.CodeAssistTurn in
            guard turn.content.count > Self.maxHistoryTurnChars else { return turn }
            return .init(role: turn.role,
                         content: String(turn.content.prefix(Self.maxHistoryTurnChars))
                             + "\n…(turn clipped)")
        }
        let total = clipped.reduce(0) { $0 + $1.content.count }
        if total <= Self.maxHistoryChars { return clipped }

        // Reserve the anchor (first user turn) before packing the tail.
        let anchorIdx = clipped.firstIndex { $0.role == .user }
        var budget = Self.maxHistoryChars
        var anchor: LlmIdeAPIClient.CodeAssistTurn?
        if let idx = anchorIdx, clipped[idx].content.count <= budget {
            anchor = clipped[idx]
            budget -= clipped[idx].content.count
        }
        var tail: [LlmIdeAPIClient.CodeAssistTurn] = []
        let stopAt = anchor == nil ? -1 : (anchorIdx ?? -1)
        var i = clipped.count - 1
        while i > stopAt {
            let cost = clipped[i].content.count
            if cost > budget { break }
            budget -= cost
            tail.append(clipped[i])
            i -= 1
        }
        return (anchor.map { [$0] } ?? []) + tail.reversed()
    }

    // MARK: - Panel-driven writes
    //
    // `messages` is `private(set)` because the engine owns the turn lifecycle.
    // These are the narrow openings the panel still needs, each matching one
    // thing it did directly when it owned the array.

    /// Append a synthetic turn the PANEL produced: the "(executed create-issue
    /// → …)" / "(bash result …)" / "(applied update to …)" acknowledgements
    /// every client-executed tool writes so the agent sees its own result as
    /// conversation context, and the placeholder a chat-triggered Loop run
    /// streams its log into.
    ///
    /// Still takes a WIRE turn — the confirmers in `CodeAssistant+Bash/Git/
    /// Edits/Issues/PR.swift` legitimately produce those strings (that text is
    /// what the agent has to read back on the next round-trip), and they are
    /// unchanged by Task 9. What changed is that the string is classified
    /// ONCE, here, the moment it enters the transcript: `ChatMessage.migrate`
    /// turns it into a typed `.toolResult` message, so nothing downstream —
    /// least of all the view — ever sniffs it again.
    ///
    /// Returns the new message's id: the message gets its own (the caller's
    /// `CodeAssistTurn.id` is a throwaway client-side value), and the
    /// chat-triggered Loop run needs that handle to stream into via
    /// `setTurnContent`.
    @discardableResult
    func appendTurn(_ turn: LlmIdeAPIClient.CodeAssistTurn) -> UUID {
        let message = ChatMessage(wireTurn: turn, sessionDate: Date())
        messages.append(message)
        return message.id
    }

    /// How (if at all) `acknowledge` should re-invoke the agent after
    /// appending a client-executed tool's result.
    ///
    /// The two "yes" cases are NOT interchangeable — picking the wrong one
    /// reintroduces exactly the bug Task 10's code review caught: forcing a
    /// follow-up through while an autonomous turn is already mid-stream
    /// starts a second concurrent `/code-assist` round-trip (two streaming
    /// placeholders racing `revealingTurnID`, and `runTask` tracking only one
    /// of them, so Stop can't cancel both).
    enum FollowUp {
        /// Don't start a follow-up turn.
        case none
        /// Start one only if the engine is idle — routes through plain
        /// `sendFollowup()`, which no-ops under its own `!busy` guard. This is
        /// the right choice for every confirmer that runs from a USER-DRIVEN
        /// sheet tap (create/comment/update issue, create PR, create branch):
        /// the tap can race the 0.8s auto-continue window
        /// `finishStreamingTurn` schedules after a `pendingTool` turn, and if
        /// an autonomous turn is already mid-stream when the sheet confirms,
        /// the follow-up should be silently skipped exactly as the old
        /// `sendFollowup()` call at those sites always did — not forced
        /// through.
        case ifIdle
        /// Force the engine out of `busy` and start a follow-up
        /// unconditionally — routes through `unblockAndFollowUp()`. Reserved
        /// for a confirmer whose action can legitimately run from INSIDE a
        /// turn that already set `busy = true` (the Bypass-mode auto-chain
        /// path through `autoChainPendingAction`: bash / update-file / git-op
        /// executed without a card) — there, `busy` would otherwise stay
        /// stuck `true` forever, because nothing else clears it until this
        /// ack's own follow-up runs.
        case forceUnblock
    }

    /// Append a client-executed tool's result as a typed `.toolResult`
    /// message, then apply `followUp` to decide whether (and how) to
    /// re-invoke the agent so it can react to it in natural language.
    ///
    /// This is what the confirmers in `CodeAssistant+Bash/Git/Issues/PR.swift`
    /// and `CodeAssistantPanel+Session.swift`/`+Edits.swift` call now (Task
    /// 10) instead of each building its own synthetic ack STRING and passing
    /// it through `appendTurn` to be classified back into a payload via
    /// `ChatMessage.migrate`: they build the typed `ToolResultPayload`
    /// directly, and `payload.legacyContent()` is what still reconstructs the
    /// exact string the server has always read on the wire — nothing about
    /// that contract changes here, only where the classification work used to
    /// happen (on the way OUT of a string) now happens on the way IN.
    ///
    /// See `FollowUp`'s own cases for which one a given call site needs —
    /// they are not interchangeable.
    func acknowledge(_ payload: ChatMessage.ToolResultPayload, followUp: FollowUp) async {
        let message = ChatMessage(
            role: .toolResult,
            content: payload.legacyContent(),
            status: .done,
            createdAt: Date(),
            toolResult: payload
        )
        messages.append(message)
        switch followUp {
        case .none:
            break
        case .ifIdle:
            await sendFollowup()
        case .forceUnblock:
            await unblockAndFollowUp()
        }
    }

    /// Replace the content of an existing message, addressed by id. No-op when
    /// the id is gone (the session was switched out from under a long-running
    /// producer) — deliberately, so a stale writer can't resurrect a turn into
    /// a chat it doesn't belong to.
    func setTurnContent(id: UUID, _ content: String) {
        guard let idx = messages.firstIndex(where: { $0.id == id }) else { return }
        messages[idx].content = content
    }

    /// Replace `messages` wholesale from an externally-sourced transcript —
    /// e.g. `LlmChatViewModel.loadHistory()`'s periodic poll of the
    /// server-persisted `/kb/agent/ask` history. Unlike `switchSession`/
    /// `handleOnAppearSessions`, this does NOT touch `ChatSessionStore`, the
    /// current-chat pointer, or transient/agent state — a caller that isn't
    /// backed by this engine's disk session store (the LLM Chat sheet's
    /// history lives server-side, not in a `ChatSession` file) just wants the
    /// in-memory transcript kept in sync with the source of truth. Callers
    /// are responsible for not calling this mid-turn (would clobber the
    /// in-flight streaming placeholder) — `busy` is intentionally not
    /// asserted here so a test can drive it directly.
    func replaceMessages(_ msgs: [ChatMessage]) {
        messages = msgs
    }

    /// Claim the turn slot for a run the PANEL executes itself (today: the
    /// Loop Engineering run started from the chat header, which streams its
    /// log into one assistant turn rather than going through `transport`).
    /// Applies the same start-of-turn resets `runTurn` does, for the same
    /// reasons: a stale action card left interactive under the new "latest
    /// assistant turn" can run its own completion handler and clear `busy`
    /// out from under the run, and a leftover status/error line would render
    /// as if it belonged to it.
    ///
    /// Idempotent, and paired with `drainQueueOrRelease()` at the end of the
    /// run so a message queued during it is still drained.
    func beginPanelRun() {
        busy = true
        agent.pendingTool = nil
        statusText = ""
        error = nil
    }

    /// Hand the engine the handle for a panel-driven run, so the composer's
    /// existing Stop button (`stop()`) cancels it like any other turn.
    func setRunTask(_ task: Task<Void, Never>?) {
        runTask = task
    }
}
