import SwiftUI
import Combine

extension CodeAssistantPanel {

    /// Header button: kicks off a Loop Engineering run against the active
    /// project. Icon-only, styled like `clearChatButton`/`sessionDropdownButton`
    /// in ChatSessionHeader.swift so it doesn't introduce a new visual style
    /// into the header row.
    ///
    /// Reuses the panel's existing `busy`/`runTask` turn machinery instead of
    /// bespoke state: `busy` disables/queues the composer exactly like a
    /// normal chat turn, and the composer's existing Stop button (`stop()`,
    /// which just does `runTask?.cancel()`) becomes usable against this run
    /// for free — `LoopEngineRunner.run()` already turns task cancellation
    /// into a clean `.aborted` status.
    ///
    /// Disable condition covers three idle checks, not just `busy`:
    /// - `busy` — a turn/run is actively in flight.
    /// - `runTask != nil` — always nil except during an active turn/run
    ///   (set by the turn tail / `resetTransientSessionState`), so this
    ///   also catches the ~0.8s window between a normal turn's tail
    ///   clearing `busy` and `finishStreamingTurn`'s scheduled
    ///   `DispatchQueue.main.asyncAfter` autonomous-continue closure firing
    ///   `startTurn(...)` — which does NOT itself check `busy`/`runTask`
    ///   and would silently overwrite (and orphan) this run's `runTask` if
    ///   this button fired inside that window.
    /// - `agent.agentIsAutonomous` — true for exactly that same window,
    ///   closing it explicitly rather than relying on timing.
    ///
    /// Matches `LoopEngineView`'s own `.disabled(runner.running || ...)`
    /// precedent, just against this panel's equivalent idle signals.
    var loopEngineeringButton: some View {
        Button {
            guard let active = projectStore.activeProject,
                  !busy, runTask == nil, !agent.agentIsAutonomous
            else { return }
            // Set synchronously here, before the Task is even created — if
            // this were left to the top of `runLoopEngineeringFromChat`
            // instead, a fast double-click could fire twice in the single
            // hop before that first `await` suspension point flips `busy`.
            // Harmless in practice (`LoopEngineRunner.activeRoots` still
            // prevents two runs from actually touching the same working
            // tree), but it would leave an orphaned first run plus a
            // confusing duplicate "already in progress" placeholder turn.
            busy = true
            let gitRoot = URL(fileURLWithPath: active.localPath, isDirectory: true)
            runTask = Task {
                await runLoopEngineeringFromChat(
                    projectId: active.bundle.id, gitRoot: gitRoot, language: prefLanguage)
            }
        } label: {
            Image(systemName: "repeat.circle")
                .font(.system(size: 11, weight: .medium))
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .foregroundStyle(theme.current.textMuted)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Run Loop Engineering against the active project")
        .accessibilityLabel("Run Loop Engineering")
        .disabled(projectStore.activeProject == nil || busy || runTask != nil || agent.agentIsAutonomous)
    }

    /// Starts a Loop Engineering run against the active project and appends
    /// its progress as a single assistant turn in the current chat history,
    /// updated live as the run's log grows. Mirrors how `RegressionRunner`
    /// already streams progress into `RegressionView`'s log pane, but
    /// surfaced in the chat transcript instead of a dedicated page.
    ///
    /// Sets/clears `busy` and drains `queued` exactly like `runTurn` does,
    /// since this occupies the SAME `runTask` slot — a chat message the
    /// user sends while a run is in progress gets queued by the composer
    /// (as it would during any other turn) and must still get drained once
    /// this "turn" ends, or it would sit forever waiting for an unrelated
    /// turn to drain it.
    @MainActor
    func runLoopEngineeringFromChat(projectId: String, gitRoot: URL, language: String) async {
        // `busy` itself is already set by the button (see its own doc
        // comment) before this function is even reached; setting it again
        // here is a harmless no-op that also makes this function correct
        // to call on its own. The rest of these mirror `runTurn`'s own
        // start-of-turn resets:
        // - `agent.pendingTool = nil` — without this, a stale action card
        //   left over from a PREVIOUS turn stays clickable once this
        //   placeholder becomes the new "last assistant turn" it renders
        //   under; confirming that stale card would run ITS OWN completion
        //   handler, which sets `busy = false` — silently killing this
        //   run's busy/Stop state while the run keeps executing.
        // - `statusText`/`error` — otherwise a stale SSE progress string or
        //   error bubble from the previous turn lingers under this run as
        //   if it were live.
        busy = true
        agent.pendingTool = nil
        statusText = ""
        error = nil
        let placeholderTurn = LlmIdeAPIClient.CodeAssistTurn(role: .assistant, content: "Starting Loop Engineering…")
        let placeholderId = placeholderTurn.id
        // Captured BEFORE the first await below — if the user switches to a
        // different chat session while this run is in flight, `history`
        // gets swapped out from under us (see `sessionEpoch`'s doc comment
        // on CodeAssistantPanel) and a stale index could alias a turn in the
        // NEW session. The id-based lookups below are the actual guard
        // against that (an id from the OLD history simply won't be found in
        // a swapped-in one); `sessionEpoch` is kept as a belt-and-suspenders
        // check for the common case, and to short-circuit before scanning
        // `history` at all.
        let startEpoch = sessionEpoch
        history.append(placeholderTurn)

        // `projectId` here is the stable Project.id (see the contract on
        // LoopEngineConfig.load/save from Task 1) — the same key Task 9's
        // Auto Task and Task 11's LoopEngineView use, so all three triggers
        // share one config per project. `gitRoot` doubles as `faultsRoot`
        // below (matches Task 11's `runLoop()` same-root simplification).
        let loopConfig = LoopEngineConfig.load(for: projectId) ?? {
            let detected = LoopEngineConfig(stages: LoopStageDetector.detectDefaultStages(gitRoot: gitRoot))
            detected.save(for: projectId)
            return detected
        }()
        let prompter = CodeAssistPrompter(api: api, language: language)
        let regressionRunner = RegressionRunner(prompter: prompter, judge: CodeAssistJudge(api: api),
                                                verifier: ShellFaultVerifier(), repairer: AgentFaultRepairer(api: api))
        let runner = LoopEngineRunner(
            stageRepairer: AgentLoopStageRepairer(api: api, language: language),
            regressionSweep: RegressionRunnerSweepAdapter(runner: regressionRunner)
        )

        // Throttled: `runner.$log` fires once per `appendLog` call (every
        // stage pass/fail, every iteration, every repair attempt) — without
        // this, a multi-stage/multi-iteration run would drive this panel's
        // `.onChange(of: history)` → persistCurrentChat pipeline (a full
        // chat-session JSON re-encode + disk write) once per log line,
        // potentially hundreds of synchronous writes for one run.
        // `latest: true` keeps only the newest snapshot per 500ms window —
        // fine here since each emission is already the FULL log-so-far
        // (see `text = lines.map(\.text).joined(...)` below), not a delta.
        //
        // `[weak runner]` avoids an unnecessary retain cycle through the log
        // subscription — not required for correctness, since `runner` goes
        // out of scope (and `cancellable.cancel()` below runs) as soon as
        // this function returns either way; kept for clarity.
        let cancellable = runner.$log
            .throttle(for: .milliseconds(500), scheduler: RunLoop.main, latest: true)
            .sink { [weak runner] lines in
                guard runner != nil, sessionEpoch == startEpoch else { return }
                guard let idx = history.firstIndex(where: { $0.id == placeholderId }) else { return }
                let text = lines.map(\.text).joined(separator: "\n")
                history[idx].content = text.isEmpty ? "Starting Loop Engineering…" : text
            }

        // run() returns LoopEngineStatus? — nil means rejected (a run is
        // already in progress for this repo, instance- or process-wide) or
        // aborted via the Stop button (Task.isCancelled), which
        // LoopEngineRunner.run() already turns into `.aborted` rather than
        // throwing. Task 6 already logs a warning line via appendLog()
        // before returning nil, and the sink above is subscribed before
        // this call, so that warning already reached the chat transcript
        // through the (throttled) log stream — but state the stop reason
        // explicitly too, using the shared LoopEngineStatus.summary.
        let result = await runner.run(config: loopConfig, faultsRoot: gitRoot, gitRoot: gitRoot)
        cancellable.cancel()

        if sessionEpoch == startEpoch, let idx = history.firstIndex(where: { $0.id == placeholderId }) {
            let logText = runner.log.map(\.text).joined(separator: "\n")
            let resultLine = result.map { "\n\n**Result:** \($0.summary)" } ?? "\n\n**Result:** a run is already in progress for this repo"
            history[idx].content = logText + resultLine
        }

        // Same tail as `runTurn`: drain the next queued message (FIFO) as a
        // fresh turn if the user sent one while this run occupied `busy`/
        // `runTask`; otherwise release both.
        if !queued.isEmpty {
            let next = queued.removeFirst()
            startTurn(next.text, skillIds: next.skillIds)
        } else {
            busy = false
            runTask = nil
        }
    }
}
