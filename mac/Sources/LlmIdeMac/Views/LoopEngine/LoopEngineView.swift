// Loop Engineering — three-pane workspace parallel to RegressionView:
//
//   ┌────────────────┬────────────────────────────┬────────────────┐
//   │ Stages         │ Detail                      │ Log            │
//   │  • ordered list │  Selected stage's editor +  │ Streamed lines │
//   │  • add/reorder  │  Run button + last status   │ from the most  │
//   │  • iteration    │                             │ recent run     │
//   │    knobs        │                             │                │
//   └────────────────┴────────────────────────────┴────────────────┘
//
// Selecting a stage on the left drives what the middle pane edits.
// Shell-command stages must be approved (VerifyApprovalStore) before a
// run will actually execute them — LoopEngineRunner's own preflight
// enforces this again server-side, so the approve button here is a
// convenience, not the only gate.

import SwiftUI

struct LoopEngineView: View {
    let api: LlmIdeAPIClient

    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @EnvironmentObject var projectStore: ProjectStore

    @State private var stages: [LoopStage] = []
    @State private var maxIterations: Int = 5
    @State private var consecutiveFailureStop: Int = 2
    @State private var selectedStageId: String?
    @State private var running = false
    @State private var log: [LoopEngineRunner.LogLine] = []
    @State private var lastStatus: LoopEngineStatus?
    @State private var didRejectLastRun = false

    /// Shared verify-command allowlist — consulted by the detail pane's
    /// "Approve & enable" button and (via a matching instance handed to
    /// the runner at run time) at verify time. Mirrors RegressionView's
    /// own `approvals` property.
    private let approvals = VerifyApprovalStore()

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
        .onAppear(perform: loadConfig)
    }

    // MARK: - Stages pane

    private var stagesPane: some View {
        let t = theme.current
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                SectionLabel("STAGES")
                Spacer()
                Button {
                    stages.append(LoopStage(name: "New Stage", kind: .shellCommand, command: "", order: stages.count))
                } label: { Image(systemName: "plus") }
                    .buttonStyle(.borderless)
                    .help("Add a shell-command stage")
            }
            List(stages.sorted(by: { $0.order < $1.order }), selection: $selectedStageId) { stage in
                stageRow(stage)
                    .tag(stage.id)
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
            Button(running ? "Running…" : "Run") { Task { await runLoop() } }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(running || stages.isEmpty || activeGitRootURL == nil)
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

                if let gitRoot = activeGitRootURL, let command = stages[index].command, !command.isEmpty {
                    let approved = approvals.isStageApproved(repo: gitRoot, stageId: stages[index].id, command: command)
                    Button(approved ? "Approved" : "Approve & enable") {
                        approvals.approveStage(repo: gitRoot, stageId: stages[index].id, command: command)
                        // Force a body re-evaluation so the approved state
                        // (and the sidebar's warning triangle) reflect the
                        // change immediately — approvals live in
                        // UserDefaults, not @Published state, so nothing
                        // else here would trigger a redraw.
                        selectedStageId = stages[index].id
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(approved)
                } else if activeGitRootURL == nil {
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
                stages.removeAll { $0.id == stages[index].id }
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
                Button("Clear") { log.removeAll() }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(log.isEmpty)
            }
            .padding(.horizontal, Spacing.lg)
            .padding(.vertical, Spacing.sm)
            Divider().background(t.border)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        if log.isEmpty {
                            Text("No runs yet.")
                                .font(Typography.caption)
                                .foregroundStyle(t.textMuted)
                                .padding(Spacing.lg)
                        }
                        ForEach(log) { line in
                            logRow(line).id(line.id)
                        }
                    }
                    .padding(.horizontal, Spacing.md)
                    .padding(.vertical, 4)
                }
                .onChange(of: log.count) { _, _ in
                    if let last = log.last {
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

    /// The git working tree shell-command stages run in and approvals are
    /// keyed against. The active project IS the repo in v1 — a project
    /// using the clone-into-code layout (project root != git clone dir)
    /// isn't distinguished by this page; the Auto Task path resolves both
    /// roots separately.
    private var activeGitRootURL: URL? {
        projectStore.activeProject.map { URL(fileURLWithPath: $0.localPath, isDirectory: true) }
    }

    private func loadConfig() {
        guard let projectId = activeProjectId else { return }
        if let saved = LoopEngineConfig.load(for: projectId) {
            stages = saved.stages
            maxIterations = saved.maxIterations
            consecutiveFailureStop = saved.consecutiveFailureStop
        } else if let gitRoot = activeGitRootURL {
            let detected = LoopStageDetector.detectDefaultStages(gitRoot: gitRoot)
            stages = detected
            LoopEngineConfig(stages: detected, maxIterations: maxIterations, consecutiveFailureStop: consecutiveFailureStop)
                .save(for: projectId)
        }
    }

    private func saveConfig() {
        guard let projectId = activeProjectId else { return }
        LoopEngineConfig(stages: stages, maxIterations: maxIterations, consecutiveFailureStop: consecutiveFailureStop)
            .save(for: projectId)
    }

    @MainActor
    private func runLoop() async {
        guard activeProjectId != nil, let gitRoot = activeGitRootURL else { return }
        saveConfig()
        let projectConfig = LoopEngineConfig(stages: stages, maxIterations: maxIterations, consecutiveFailureStop: consecutiveFailureStop)

        // Same transport/model tier RegressionView uses for its own
        // prompter/judge/repairer — Loop Engineering's stage repair is a
        // multi-file code edit, so the full chat model is used, not the
        // sub-model tier (mirrors AgentLoopStageRepairer's own doc comment).
        let prompter = CodeAssistPrompter(api: api, agent: "claude_code")
        let regressionRunner = RegressionRunner(
            prompter: prompter, judge: CodeAssistJudge(api: api),
            verifier: ShellFaultVerifier(), repairer: AgentFaultRepairer(api: api))
        let runner = LoopEngineRunner(
            stageRepairer: AgentLoopStageRepairer(api: api),
            regressionSweep: RegressionRunnerSweepAdapter(runner: regressionRunner),
            approvals: approvals)

        running = true
        // faultsRoot == gitRoot here (both `activeProject.localPath`) — the
        // "project IS the repo" case `RegressionRunner.run(at:)`'s own
        // same-root convenience overload already assumes.
        let result = await runner.run(config: projectConfig, faultsRoot: gitRoot, gitRoot: gitRoot)
        log = runner.log
        lastStatus = result
        didRejectLastRun = (result == nil)
        running = false
    }
}
