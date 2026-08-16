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

    private(set) var history: [LlmIdeAPIClient.CodeAssistTurn] = []
    private(set) var busy = false
    /// Live agent status streamed from /code-assist (SSE): "Searching the web…",
    /// "Writing the answer…", etc. Shown in place of a static "Thinking…" so a
    /// 60–90s agent turn doesn't look hung. Reset at the start of each turn.
    private(set) var statusText = ""
    private(set) var error: String?
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
    /// Tool steps per assistant turn, keyed by turn id. Display-only and
    /// in-memory — deliberately NOT part of `CodeAssistTurn`, which is what
    /// gets persisted AND replayed to the model; the agent does not need its
    /// own tool log fed back to it. Written only here (from the transport's
    /// progress callback), so `private(set)` is the whole contract.
    private(set) var turnActivity: [UUID: [CodeAssistantPanel.ToolStep]] = [:]
    /// Resolved mode for each assistant turn, keyed by turn id — populated in
    /// `finishStreamingTurn`, read by `ChatMessageList` to show `ModeBadge`.
    private(set) var turnModes: [UUID: CodeAssistMode] = [:]
    /// Measured render height per assistant turn, keyed by turn id, so each
    /// markdown web-view bubble can be sized to its content in the scroll list.
    /// Unlike the two dictionaries above this one is written by the VIEW
    /// (`ChatMessageList` takes it as a `Binding`), so it stays publicly
    /// settable rather than `private(set)`.
    var bubbleHeights: [UUID: CGFloat] = [:]
    /// While `true`, the panel's `handleHistoryChange` persists but skips the
    /// VoiceOver announcement. Set around bulk history loads and around the
    /// streaming placeholder append so an empty turn isn't read aloud.
    /// Publicly settable: the panel's session load/switch paths set it too.
    var suppressHistoryAnnounce = false

    /// Agent-turn metadata. The engine owns it; the panel reads the same
    /// object (it is a reference type, so both see one state).
    let agent = CodeAssistantAgentState()
    let transport: ChatTransport

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

    /// Packs `history` for the wire — the panel's `historyForRequest`, which
    /// stays panel-side in this task (its contract is pinned by
    /// `HistoryForRequestTests` against the panel). Defaults to identity;
    /// **Task 7 must wire this to `historyForRequest` when it rewires the call
    /// sites**, otherwise the 400k-char request budget silently disappears.
    var packHistory: ([LlmIdeAPIClient.CodeAssistTurn]) -> [LlmIdeAPIClient.CodeAssistTurn] = { $0 }

    /// Auto-chain the next pending action (file edit / git op / shell command)
    /// when the budget allows — the panel's `autoChainPendingAction`, which is
    /// extracted later. Both round-trip sites call it so a chained plan keeps
    /// the same truncated-path data-loss guard.
    var autoChain: ((PendingTool?, LlmIdeAPIClient.CodeAssistResponse.Usage?) async -> Void)?

    init(transport: ChatTransport) {
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
        // even if the network call is slow.
        history.append(.init(role: .user, content: message))
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
            let recent = packHistory(history)
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
            // the complete reply now. If chunks DID arrive, history[idx]
            // already holds the complete text and this is a no-op overwrite
            // with the same value.
            if let idx = history.firstIndex(where: { $0.id == streamingID }) {
                history[idx].content = resp.reply
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
            // drop, decode error, etc.) gets the same "(stopped)" cleanup —
            // an orphaned empty/partial placeholder turn must not linger in
            // `history` forever either way — plus the `self.error` banner
            // explaining what went wrong.
            let isCancellation = error is CancellationError || (error as? URLError)?.code == .cancelled
            if revealingTurnID == streamingID {
                finishStreamingTurn(streamingID, pendingTool: nil, tasks: nil, continueNeeded: nil, usage: nil, mode: nil, stopped: true)
            }
            if !isCancellation {
                self.error = error.localizedDescription
            }
        }
        // Drain the next queued message (FIFO) as a fresh, un-cancelled turn.
        if !queued.isEmpty {
            let next = queued.removeFirst()
            startTurn(next.text, skillIds: next.skillIds)
        } else {
            busy = false
            runTask = nil
        }
    }

    /// `sendFollowup` guards on `!busy` so a rapid double-confirm or manual
    /// ⌘↵ mid-stream can't stack overlapping round-trips. But 3 call sites
    /// (`confirmUpdateFile`'s auto-edit path, and `runGitOpFlow`'s two early
    /// returns) run their action from INSIDE a turn that already set
    /// `busy = true` and need their own synthetic-ack `sendFollowup` to
    /// actually fire, not be silently skipped by that guard. This is the
    /// one place that unblocks it — `busy = false` here is always safe to
    /// call from those three sites specifically: `runTurn`/`sendFollowup`
    /// re-set `busy = false` at their own tail regardless (a benign no-op
    /// once already false), and each of the three callers is on the
    /// success path of an action that just appended the synthetic-ack turn
    /// the follow-up needs to see.
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
            let recent = packHistory(history)
            // The synthetic "(executed create-gitlab-issue …)" turn we
            // pushed before this call IS the signal the agent needs to
            // see. Keep it in `history`; pass "(continue)" as the user
            // message purely to pass the server's empty-message guard.
            let input = await resolveTransportInput("(continue)", recent, [], [])
            let resp = try await transport.roundTrip(
                input,
                onProgress: { [self] progress in recordProgress(progress) },
                onChunk: { [self] text in appendStreamedChunk(streamingID, text) }
            )
            if let idx = history.firstIndex(where: { $0.id == streamingID }) {
                history[idx].content = resp.reply
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
            // leave it orphaned in `history` forever.
            if revealingTurnID == streamingID {
                finishStreamingTurn(streamingID, pendingTool: nil, tasks: nil, continueNeeded: nil, usage: nil, mode: nil, stopped: true)
            }
            self.error = error.localizedDescription
        }
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
        guard progress.isTool, let turnID = revealingTurnID else { return }
        var steps = turnActivity[turnID] ?? []
        // The loop re-emits on every iteration; a repeat of the same
        // action back-to-back is noise, not a second step.
        if steps.last?.label == progress.label { return }
        steps.append(.init(label: progress.label, tool: progress.tool))
        turnActivity[turnID] = steps
    }

    /// Begin a new streaming assistant turn: appends a placeholder turn to
    /// `history` and marks it as the one `appendStreamedChunk` will mutate.
    /// The append happens with `suppressHistoryAnnounce` set so the
    /// length-triggered VoiceOver announcement in `handleHistoryChange`
    /// doesn't fire on an empty placeholder — `finishStreamingTurn` fires the
    /// real announcement itself, once, with the complete text.
    func beginStreamingTurn() -> UUID {
        let turn = LlmIdeAPIClient.CodeAssistTurn(role: .assistant, content: "")
        suppressHistoryAnnounce = true
        history.append(turn)
        DispatchQueue.main.async { [self] in suppressHistoryAnnounce = false }
        revealingTurnID = turn.id
        revealedCount = 0
        return turn.id
    }

    /// Append `text` to the streaming turn identified by `id`. `revealedCount`
    /// tracks the turn's current length so `ChatMessageList.displayedContent`
    /// (which truncates to `revealedCount` characters for whichever turn
    /// matches `revealingTurnID`) shows the growing content as it arrives —
    /// the same read path the old fixed-schedule reveal used, now driven by
    /// real chunk arrival instead of an artificial timer.
    func appendStreamedChunk(_ id: UUID, _ text: String) {
        guard let idx = history.firstIndex(where: { $0.id == id }) else { return }
        history[idx].content += text
        revealedCount = history[idx].content.count
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
        // Only store non-default modes — ModeBadge never renders for
        // .execute/.auto, and most turns use one of those, so skipping them
        // here keeps this dictionary from growing with entries nothing ever
        // reads back.
        if let mode, let resolved = CodeAssistMode(rawValue: mode), resolved != .execute, resolved != .auto {
            turnModes[id] = resolved
        }
        if let idx = history.firstIndex(where: { $0.id == id }) {
            if stopped {
                if !history[idx].content.isEmpty {
                    history[idx].content += "\n\n_(stopped)_"
                }
            }
            let text = String(history[idx].content.prefix(200))
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
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
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
}
