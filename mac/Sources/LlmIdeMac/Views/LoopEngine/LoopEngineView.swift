// Loop Engineering — three-pane workspace parallel to RegressionView:
//
//   ┌────────────────┬────────────────────────────┬────────────────┐
//   │ Stages         │ Detail                      │ Log            │
//   │  • ordered list │  Selected stage's editor +  │ Streamed lines │
//   │  • add stages   │  Run button + last status   │ from the most  │
//   │  • iteration    │                             │ recent run,    │
//   │    knobs        │                             │ live while it  │
//   │                 │                             │ runs           │
//   └────────────────┴────────────────────────────┴────────────────┘
//
// Selecting a stage on the left drives what the middle pane edits.
// Shell-command stages must be approved (VerifyApprovalStore) before a
// run will actually execute them — LoopEngineRunner's own preflight
// enforces this again server-side, so the approve button here is a
// convenience, not the only gate.
//
// No stage-reorder UI exists yet (stage order is fixed at detection/add
// time) — don't add "reorder" back to the bullet list above without
// also adding the UI for it.

import SwiftUI

struct LoopEngineView: View {
    let api: LlmIdeAPIClient

    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @EnvironmentObject var projectStore: ProjectStore

    /// Owns the run — a `@StateObject` (not a locally-constructed value
    /// per run) so its `@Published log`/`running`/`iteration` actually
    /// drive the log pane live while a run is in progress, matching
    /// RegressionRunner's own `@StateObject` pattern in RegressionView.
    /// Building a fresh `LoopEngineRunner` inside `runLoop()` instead
    /// would mean SwiftUI never observes it, and the log pane would sit
    /// empty for the run's entire duration (up to `stageTimeout` per
    /// stage) before dumping everything at once at the end.
    @StateObject private var runner: LoopEngineRunner

    /// Shared verify-command allowlist — consulted by the detail pane's
    /// "Approve & enable" button and, via the SAME instance handed to
    /// `runner` at construction, at verify time. Must be one shared
    /// instance (not two separate `VerifyApprovalStore()`s) so an
    /// approval made here is visible to the runner's own preflight —
    /// harmless in practice since both read/write the same UserDefaults
    /// key, but keeping one instance avoids relying on that coincidence.
    private let approvals: VerifyApprovalStore

    @State private var stages: [LoopStage] = []
    @State private var maxIterations: Int = 5
    @State private var consecutiveFailureStop: Int = 2
    @State private var selectedStageId: String?
    @State private var lastStatus: LoopEngineStatus?
    @State private var didRejectLastRun = false

    init(api: LlmIdeAPIClient) {
        self.api = api
        let approvals = VerifyApprovalStore()
        self.approvals = approvals
        // Same transport/model tier RegressionView uses for its own
        // prompter/judge/repairer — Loop Engineering's stage repair is a
        // multi-file code edit, so the full chat model is used, not the
        // sub-model tier (mirrors AgentLoopStageRepairer's own doc
        // comment). Hardcoded, not read from AppConfig: @EnvironmentObject
        // values aren't populated yet during a View's own init.
        let prompter = CodeAssistPrompter(api: api, agent: "claude_code")
        let regressionRunner = RegressionRunner(
            prompter: prompter, judge: CodeAssistJudge(api: api),
            verifier: ShellFaultVerifier(), repairer: AgentFaultRepairer(api: api))
        _runner = StateObject(wrappedValue: LoopEngineRunner(
            stageRepairer: AgentLoopStageRepairer(api: api),
            regressionSweep: RegressionRunnerSweepAdapter(runner: regressionRunner),
            approvals: approvals))
    }

    var body: some View {
        HSplitView {
            stagesPane
                .frame(minWidth: 220, idealWidth: 260, maxWidth: 320)
            detailPane
                .frame(minWidth: 320, maxWidth: .infinity)
            logPane
                .frame(minWidth: 260, idealWidth: 320, maxWidth: 420)
        }
        .background(theme.current.body)
        .navigationTitle("Loop Engineering")
        // Keyed on the active project's id (not a plain .onAppear) so
        // switching projects while this view stays mounted reloads THIS
        // project's config instead of silently running/saving the
        // PREVIOUS project's stages against the new project's gitRoot —
        // AppShell only recreates section views on a section switch, not
        // on a project switch. Mirrors GraphMemorySettingsSection's
        // `.task(id: projectStore.activeProject?.bundle.id)` pattern.
        .task(id: activeProjectId) {
            selectedStageId = nil
            runner.clearLog()
            lastStatus = nil
            didRejectLastRun = false
            loadConfig()
        }
    }

    // MARK: - Stages pane

    private var stagesPane: some View {
        let t = theme.current
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                SectionLabel("STAGES")
                Spacer()
                Button {
                    let nextOrder = (stages.map(\.order).max() ?? -1) + 1
                    stages.append(LoopStage(name: "New Stage", kind: .shellCommand, command: "", order: nextOrder))
                } label: {
                    Image(systemName: "plus")
                }
                .buttonStyle(.borderless)
                .help("Add a shell-command stage")
                .accessibilityLabel("Add stage")
            }
            List(sortedStages, selection: $selectedStageId) { stage in
                stageRow(stage)
            }
            .listStyle(.sidebar)
            Divider().background(t.border)
            VStack(alignment: .leading, spacing: 6) {
                Stepper("Max iterations: \(maxIterations)", value: $maxIterations, in: 1...20)
                Stepper("Stop after \(consecutiveFailureStop) identical failures", value: $consecutiveFailureStop, in: 1...10)
                Button("Save") { saveConfig() }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
            .font(Typography.caption)
            .padding(.horizontal, Spacing.md)
            .padding(.bottom, Spacing.md)
        }
        .padding(.top, Spacing.sm)
        .background(t.surface)
    }

    /// Display order matches `LoopEngineRunner`'s own execution order
    /// exactly (`(order, id)`, not just `order`) — `order` values can
    /// collide (e.g. after removing a stage and adding a new one), and a
    /// sort keyed on `order` alone isn't guaranteed stable across
    /// re-renders, so the sidebar could show a different order than the
    /// stages actually run in. The `id` tie-break makes both sorts
    /// deterministic and identical.
    private var sortedStages: [LoopStage] {
        stages.sorted { ($0.order, $0.id) < ($1.order, $1.id) }
    }

    @ViewBuilder
    private func stageRow(_ stage: LoopStage) -> some View {
        let t = theme.current
        HStack(spacing: 6) {
            Image(systemName: stage.kind == .regressionSweep ? "arrow.uturn.backward.circle" : "terminal")
                .foregroundStyle(t.textMuted)
            Text(stage.name)
                .font(Typography.filename)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 4)
            if stage.kind == .shellCommand,
               let command = stage.command,
               let gitRoot = activeGitRootURL,
               !approvals.isStageApproved(repo: gitRoot, stageId: stage.id, command: command) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(.orange)
                    .help("Command not yet approved on this machine")
            }
        }
    }

    // MARK: - Detail pane

    private var detailPane: some View {
        let t = theme.current
        return VStack(alignment: .leading, spacing: 0) {
            toolbar
            Divider().background(t.border)
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.md) {
                    if let id = selectedStageId, let index = stages.firstIndex(where: { $0.id == id }) {
                        stageDetail(index: index)
                    } else {
                        Text("Select a stage on the left, or add one.")
                            .font(Typography.body)
                            .foregroundStyle(t.textMuted)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Spacing.lg)
            }
        }
        .background(t.body)
    }

    private var toolbar: some View {
        HStack(spacing: Spacing.md) {
            Button(runner.running ? "Running… (iteration \(runner.iteration))" : "Run") {
                Task { await runLoop() }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(runner.running || stages.isEmpty || activeGitRootURL == nil)
            if let lastStatus {
                Text(lastStatus.summary)
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
            } else if didRejectLastRun {
                Text("A run is already in progress for this repo")
                    .font(Typography.caption)
                    .foregroundStyle(.orange)
            }
            Spacer()
        }
        .padding(.horizontal, Spacing.lg)
        .padding(.vertical, Spacing.sm)
    }

    @ViewBuilder
    private func stageDetail(index: Int) -> some View {
        let t = theme.current
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("Name").font(Typography.caption).foregroundStyle(t.textMuted)
            TextField("Stage name", text: $stages[index].name)
                .textFieldStyle(.roundedBorder)

            if stages[index].kind == .shellCommand {
                Text("Command").font(Typography.caption).foregroundStyle(t.textMuted)
                TextField("e.g. swift test", text: Binding(
                    get: { stages[index].command ?? "" },
                    set: { stages[index].command = $0 }
                ))
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 11, design: .monospaced))

                if let gitRoot = activeGitRootURL {
                    if let command = stages[index].command, !command.isEmpty {
                        let approved = approvals.isStageApproved(repo: gitRoot, stageId: stages[index].id, command: command)
                        Button(approved ? "Approved" : "Approve & enable") {
                            approvals.approveStage(repo: gitRoot, stageId: stages[index].id, command: command)
                            // Force a body re-evaluation so the approved
                            // state (and the sidebar's warning triangle)
                            // reflect the change immediately — approvals
                            // live in UserDefaults, not @Published state,
                            // so nothing else here would trigger a redraw.
                            selectedStageId = stages[index].id
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .disabled(approved)
                    } else {
                        Text("Enter a command for this stage.")
                            .font(Typography.caption)
                            .foregroundStyle(t.textMuted)
                    }
                } else {
                    Text("Open a project with a cloned repo to approve or run shell-command stages.")
                        .font(Typography.caption)
                        .foregroundStyle(t.textMuted)
                }
            } else {
                Text("Re-runs the Regression sweep (fault reports + repo checks) with repair attempted on failure.")
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
            }

            Button("Remove Stage", role: .destructive) {
                // Capture the id BEFORE mutating `stages` — reading
                // `stages[index]` again from inside removeAll's predicate
                // (which holds exclusive access to `stages` for the
                // duration of the call) would be a mutate-while-reading
                // access to the same @State storage.
                let id = stages[index].id
                stages.removeAll { $0.id == id }
                selectedStageId = nil
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
    }

    // MARK: - Log pane

    private var logPane: some View {
        let t = theme.current
        return VStack(spacing: 0) {
            HStack {
                SectionLabel("RUN LOG")
                Spacer()
                Button("Clear") { runner.clearLog() }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(runner.log.isEmpty)
            }
            .padding(.horizontal, Spacing.lg)
            .padding(.vertical, Spacing.sm)
            Divider().background(t.border)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        if runner.log.isEmpty {
                            Text("No runs yet.")
                                .font(Typography.caption)
                                .foregroundStyle(t.textMuted)
                                .padding(Spacing.lg)
                        }
                        ForEach(runner.log) { line in
                            logRow(line).id(line.id)
                        }
                    }
                    .padding(.horizontal, Spacing.md)
                    .padding(.vertical, 4)
                }
                .onChange(of: runner.log.count) { _, _ in
                    if let last = runner.log.last {
                        withAnimation(.linear(duration: 0.1)) {
                            proxy.scrollTo(last.id, anchor: .bottom)
                        }
                    }
                }
            }
        }
        .background(t.surface)
    }

    @ViewBuilder
    private func logRow(_ line: LoopEngineRunner.LogLine) -> some View {
        let t = theme.current
        HStack(alignment: .top, spacing: 6) {
            Text(AppDateFormatter.hourMinuteSecond(line.at))
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(t.textMuted)
            Circle()
                .fill(levelColor(line.level))
                .frame(width: 5, height: 5)
                .padding(.top, 5)
            Text(line.text)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(levelColor(line.level))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func levelColor(_ level: LoopEngineRunner.LogLine.Level) -> Color {
        let t = theme.current
        switch level {
        case .info:  return t.text
        case .warn:  return t.accent4
        case .error: return t.danger
        }
    }

    // MARK: - State helpers

    /// The stable llm-ide Project.id (`ProjectStore.ActiveProject` has no
    /// `.id` of its own — only `.bundle.id`; see the contract documented on
    /// `LoopEngineConfig.load`/`save`). Do NOT use `localPath` or any
    /// repo-backend id here — this must match what the Auto Task path
    /// keys by, or the Auto Task and this page silently maintain two
    /// different configs for the same project.
    private var activeProjectId: String? { projectStore.activeProject?.bundle.id }

    /// The two-root context (`projectRoot` for faults/index/memory, `gitRoot`
    /// for the actual git working tree) — the single source of truth also
    /// used by RegressionView. In the "clone-into-code" layout these differ
    /// (project root vs `code/<repo>`); using the project root for both, as
    /// this view previously did via `activeProject.localPath`, silently
    /// pointed shell-command stages and stage detection at the wrong tree.
    private var workspaceContext: WorkspaceRoot.Context? {
        WorkspaceRoot.context(config: config, projectStore: projectStore)
    }

    /// The git working tree shell-command stages run in and approvals are
    /// keyed against — `nil` when the active project has no resolvable git
    /// working tree (e.g. a fresh non-repo project).
    private var activeGitRootURL: URL? {
        workspaceContext?.gitRoot
    }

    private func loadConfig() {
        guard let projectId = activeProjectId else {
            resetStagesToDefaults()
            return
        }
        if let saved = LoopEngineConfig.load(for: projectId) {
            stages = saved.stages
            maxIterations = saved.maxIterations
            consecutiveFailureStop = saved.consecutiveFailureStop
        } else if let gitRoot = activeGitRootURL {
            let detected = LoopStageDetector.detectDefaultStages(gitRoot: gitRoot)
            resetStagesToDefaults(stages: detected)
            // Only persist when detection found real tooling beyond the bare
            // Regression stage — same policy as the Auto Task sweep's own
            // guard in AutoCodeUpdateService+PipelineTasks.swift, so this
            // page can't permanently lock in a Regression-only config for
            // the project before the repo is fully populated/detectable.
            if LoopEngineConfig.shouldPersist(detected) {
                LoopEngineConfig(stages: detected, maxIterations: maxIterations, consecutiveFailureStop: consecutiveFailureStop)
                    .save(for: projectId)
            }
        } else {
            // No saved config AND no git root to detect defaults from
            // (e.g. the project folder isn't resolvable yet) — reset
            // instead of falling through and leaving a PREVIOUS
            // project's stages displayed (and later saved/run against
            // THIS project's id/gitRoot).
            resetStagesToDefaults()
        }
    }

    /// Single reset path for "no config to show" — used both when no
    /// project is active and when a project has neither a saved config
    /// nor a detectable git root.
    private func resetStagesToDefaults(stages newStages: [LoopStage] = []) {
        stages = newStages
        maxIterations = 5
        consecutiveFailureStop = 2
    }

    private func saveConfig() {
        guard let projectId = activeProjectId else { return }
        LoopEngineConfig(stages: stages, maxIterations: maxIterations, consecutiveFailureStop: consecutiveFailureStop)
            .save(for: projectId)
    }

    @MainActor
    private func runLoop() async {
        // `gitRoot` is `LoopEngineRunner.run`'s non-optional parameter, so a
        // run must not start until a real git working tree is resolved —
        // mirrors RegressionView's own guard against running git-dependent
        // operations with no working tree.
        guard let projectId = activeProjectId,
              let context = workspaceContext,
              let gitRoot = context.gitRoot
        else { return }
        // Run implicitly saves the current stage list — but only when it's
        // safe to: an explicit "Save" always persists (user intent), while
        // this auto-save must not silently lock in a bare-Regression list
        // that `loadConfig()` deliberately left unsaved (see
        // `LoopEngineConfig.shouldPersist`). Once a real config already
        // exists for this project, overwriting it here is fine even if the
        // in-memory `stages` happens to be Regression-only right now — that
        // reflects a real edit (e.g. the user removed the Test stage), not
        // an unconfirmed auto-detection.
        if LoopEngineConfig.shouldPersist(stages) || LoopEngineConfig.load(for: projectId) != nil {
            saveConfig()
        }
        let projectConfig = LoopEngineConfig(stages: stages, maxIterations: maxIterations, consecutiveFailureStop: consecutiveFailureStop)
        let result = await runner.run(config: projectConfig, faultsRoot: context.projectRoot, gitRoot: gitRoot)
        lastStatus = result
        didRejectLastRun = (result == nil)
    }
}
