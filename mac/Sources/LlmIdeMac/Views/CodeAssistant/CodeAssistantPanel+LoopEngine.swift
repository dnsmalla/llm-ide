import SwiftUI
import Combine

extension CodeAssistantPanel {

    /// Header button: kicks off a Loop Engineering run against the active
    /// project. Icon-only, styled like `clearChatButton`/`sessionDropdownButton`
    /// in ChatSessionHeader.swift so it doesn't introduce a new visual style
    /// into the header row.
    var loopEngineeringButton: some View {
        Button {
            guard let active = projectStore.activeProject else { return }
            let gitRoot = URL(fileURLWithPath: active.localPath, isDirectory: true)
            Task {
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
        .disabled(projectStore.activeProject == nil)
    }

    /// Starts a Loop Engineering run against the active project and appends
    /// its progress as a single assistant turn in the current chat history,
    /// updated live as the run's log grows. Mirrors how `RegressionRunner`
    /// already streams progress into `RegressionView`'s log pane, but
    /// surfaced in the chat transcript instead of a dedicated page.
    @MainActor
    func runLoopEngineeringFromChat(projectId: String, gitRoot: URL, language: String) async {
        let placeholderIndex = history.count
        // Captured BEFORE the first await below — if the user switches to a
        // different chat session while this run is in flight, `history`
        // gets swapped out from under us (see `sessionEpoch`'s doc comment
        // on CodeAssistantPanel) and `placeholderIndex` could alias a turn
        // in the NEW session. Every mutation below re-checks this epoch
        // first so a session switch makes this run stop touching `history`
        // instead of corrupting the wrong chat.
        let startEpoch = sessionEpoch
        history.append(LlmIdeAPIClient.CodeAssistTurn(role: .assistant, content: "Starting Loop Engineering…"))

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

        // `CodeAssistantPanel` is a value-type `View`, so this closure can't
        // capture `self` weakly (only class types support `weak`) — it
        // captures a copy of `self` the way `voiceService.onFinalResult`
        // already does elsewhere in this file. Mutating `history` through
        // that copy still reaches the SAME on-screen state because `@State`
        // boxes its storage in a shared reference underneath. `[weak
        // runner]` guards the one thing here that IS a class instance.
        let cancellable = runner.$log.sink { [weak runner] lines in
            guard runner != nil, sessionEpoch == startEpoch, placeholderIndex < history.count else { return }
            let text = lines.map(\.text).joined(separator: "\n")
            history[placeholderIndex].content = text.isEmpty ? "Starting Loop Engineering…" : text
        }

        // run() returns LoopEngineStatus? — nil means rejected (a run is
        // already in progress for this repo, instance- or process-wide).
        // Task 6 already logs a warning line via appendLog() before
        // returning nil, and the sink above is subscribed before this call,
        // so that warning already reached the chat transcript through the
        // log stream — but state the stop reason explicitly too, using the
        // shared LoopEngineStatus.summary.
        let result = await runner.run(config: loopConfig, faultsRoot: gitRoot, gitRoot: gitRoot)
        cancellable.cancel()

        guard sessionEpoch == startEpoch, placeholderIndex < history.count else { return }
        let logText = runner.log.map(\.text).joined(separator: "\n")
        let resultLine = result.map { "\n\n**Result:** \($0.summary)" } ?? "\n\n**Result:** a run is already in progress for this repo"
        history[placeholderIndex].content = logText + resultLine
    }
}
