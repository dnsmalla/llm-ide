// Loop Engineering — three-pane workspace (Stages / Contract / Log):
//
//   ┌────────────────┬──────────────────────────────┬────────────────┐
//   │ Stages         │ Run + the loop's contract    │ Log            │
//   │  • ordered list│   OVERVIEW  what runs, where │ Streamed lines │
//   │  • add stages  │   TEMPLATE  pick/save recipe │ from the most  │
//   │                │   PROCESS   every stage,      │ recent run,    │
//   │                │             editable in place │ live while it  │
//   │                │   SETTINGS  budgets + policy │ runs, then     │
//   │                │   OUTPUT    what it writes   │ PAST RUNS      │
//   └────────────────┴──────────────────────────────┴────────────────┘
//
// Panel 2 exists to answer, before a run starts: what will this loop do, in
// what order, against which working tree, bounded by what, and what artifacts
// will it leave behind? Sections live in LoopEngineView+DetailPane.swift; the
// @State they read is declared here (a SwiftUI extension cannot own storage),
// which is why those members are internal rather than private — same split as
// CodeAssistantPanel / CodeAssistantPanel+LoopEngine.swift.
//
// PROCESS shows every stage as its own editable card, in run order — a
// generate stage's skill+input picker, a shell stage's command, a regression
// stage's description, all inline, all at once. It used to be "select ONE
// stage on the left, then scroll down to a single SELECTED STAGE editor" —
// that hid skill/input pickers behind a click and made it look like most
// templates had nothing to configure. Clicking a row in the left list still
// scrolls PROCESS to (and highlights) that stage's card; it no longer gates
// what's visible.
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
    /// drive the log pane live while a run is in progress, matching the
    /// standard `@StateObject`-for-live-run-UI pattern.
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
    let approvals: VerifyApprovalStore

    @State var stages: [LoopStage] = []
    @State var maxIterations: Int = 10
    @State var consecutiveFailureStop: Int = 2
    /// 0 means "no wall-clock limit" — a Stepper cannot express `nil`, so the
    /// zero sentinel is mapped to/from `LoopEngineConfig.wallClockBudgetSeconds`
    /// in `currentConfig` and `loadConfig`.
    @State var wallClockMinutes: Int = 60
    @State var maxRepairsPerStage: Int = 3
    @State var protectedPathPolicy: ProtectedPathPolicy = .revert
    /// No UI (the built-in protected set covers the common cases); held in state
    /// purely so a hand-edited value survives a save from this page instead of
    /// being silently dropped.
    @State private var extraProtectedGlobs: [String] = []
    @State var selectedStageId: String?
    @State private var lastStatus: LoopEngineStatus?
    @State private var didRejectLastRun = false
    @State private var skillCatalog: [LlmIdeAPIClient.SkillLibraryEntry] = []
    @State private var skillsLoaded = false
    @State private var pastRuns: [LoopRunIndexEntry] = []
    /// The in-flight `Task { await runLoop() }`, held only so Stop has
    /// something to cancel. `runner.running` alone can't be acted on — it's
    /// a `@Published` observation, not a handle — and cancelling this Task
    /// is what makes `Task.isCancelled` true everywhere down the call tree
    /// `runner.run` awaits through, including inside `ShellFaultVerifier`.
    @State private var runTask: Task<Void, Never>?
    /// Drives the "New Loop" sheet — the top-level create-from-template flow,
    /// distinct from the stages pane's `+` (adds one bare stage) and the
    /// Template section's Apply (overwrites with an un-configured template).
    @State private var isPresentingNewLoopWizard = false

    /// App-wide template library (built-in starters + the user's saved recipes).
    /// A `@StateObject` so the picker updates the moment one is saved or deleted.
    @StateObject var templateStore = LoopTemplateStore()
    @State var selectedTemplateId: UUID?
    /// Set by `applySelectedTemplate()` when the applied template's stages were
    /// all `detectedTestCommand` placeholders and none resolved — so an empty
    /// `stages` reads as "no test tooling found here", not "nothing configured".
    /// Cleared as soon as the user edits stages manually.
    @State var appliedTemplateHadNoTooling = false
    @State var isNamingTemplate = false
    @State var newTemplateName = ""
    @State var newTemplateSummary = ""
    /// Mirrors `LoopEngineConfig.writeSummaryNote`; edited in the Output section.
    @State var writeSummaryNote = false
    /// Filename of the most recent run-summary note, for the Output section's
    /// "last written" line. Read from disk rather than the note index so an
    /// unindexed/hand-deleted note cannot make the row lie.
    @State var lastSummaryNoteName: String?

    /// Reads `<projectRoot>/system/loop-runs/` for the "past runs" list. A
    /// separate instance from the runner's own journal is fine — the file layout
    /// is the contract, and this one only ever reads.
    private let journal = FileLoopRunJournal()

    init(api: LlmIdeAPIClient) {
        self.api = api
        let approvals = VerifyApprovalStore()
        self.approvals = approvals
        // Same transport/model tier the regression sweep uses for its own
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
            skillExecutor: AgentLoopSkillExecutor(api: api),
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
        .navigationTitle("Loop")
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
            Task { await loadSkillsIfNeeded() }
        }
        .sheet(isPresented: $isPresentingNewLoopWizard) {
            NewLoopWizardView(
                templateStore: templateStore,
                skillCatalog: skillCatalog,
                gitRoot: activeGitRootURL,
                onCreate: applyNewLoopConfig)
        }
    }

    // MARK: - Stages pane

    private var stagesPane: some View {
        let t = theme.current
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                SectionLabel("STAGES")
                Spacer()
                Menu {
                    Button("Shell command") {
                        let nextOrder = (stages.map(\.order).max() ?? -1) + 1
                        stages.append(LoopStage(name: "New Stage", kind: .shellCommand, command: "", order: nextOrder))
                        appliedTemplateHadNoTooling = false
                    }
                    Button("Regression sweep") {
                        let nextOrder = (stages.map(\.order).max() ?? -1) + 1
                        stages.append(LoopStage(name: "Regression", kind: .regressionSweep, command: nil, order: nextOrder))
                        appliedTemplateHadNoTooling = false
                    }
                    Button("Skill (generate)") {
                        let nextOrder = (stages.map(\.order).max() ?? -1) + 1
                        stages.append(LoopStage(name: "New Skill Stage", kind: .skill, command: nil, order: nextOrder))
                        appliedTemplateHadNoTooling = false
                    }
                } label: {
                    Image(systemName: "plus")
                }
                .buttonStyle(.borderless)
                .help("Add a stage")
                .accessibilityLabel("Add stage")
            }
            List(sortedStages, selection: $selectedStageId) { stage in
                stageRow(stage)
            }
            .listStyle(.sidebar)
            // Budgets, protected-path policy, template and output all live in the
            // detail pane now: a user should be able to answer "what will this
            // loop do, where, and what does it produce" from one place, and this
            // pane is only wide enough for a list.
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
    var sortedStages: [LoopStage] {
        stages.sorted { ($0.order, $0.id) < ($1.order, $1.id) }
    }

    @ViewBuilder
    private func stageRow(_ stage: LoopStage) -> some View {
        let t = theme.current
        HStack(spacing: 6) {
            Image(systemName: stage.kind == .regressionSweep ? "arrow.uturn.backward.circle"
                  : stage.kind == .shellCommand ? "terminal" : "sparkles")
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
            if stage.isDefault {
                Image(systemName: "lock.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .help("Default stage — can't be deleted")
            }
            Menu {
                Button("Duplicate") { duplicateStage(stage) }
                if !stage.isDefault {
                    Button("Delete", role: .destructive) { deleteStage(stage) }
                }
            } label: {
                Image(systemName: "ellipsis")
                    .foregroundStyle(t.textMuted)
            }
            .buttonStyle(.borderless)
        }
    }

    // MARK: - Detail pane

    /// The contract pane: what this loop will do, where it runs, how it is
    /// bounded, and what it produces — in that order, all in one scroll.
    ///
    /// Sections live in `LoopEngineView+DetailPane.swift`; only the composition
    /// order is here. Nothing is behind a tab on purpose: the question this pane
    /// answers ("what is this loop going to do to my repo?") is one a user asks
    /// *before* running, and an answer split across four tabs is not an answer.
    private var detailPane: some View {
        let t = theme.current
        return VStack(alignment: .leading, spacing: 0) {
            toolbar
            Divider().background(t.border)
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: Spacing.lg) {
                        overviewSection
                        Divider().background(t.border)
                        templateSection
                        Divider().background(t.border)
                        processSection
                        Divider().background(t.border)
                        settingsSection
                        Divider().background(t.border)
                        outputSection
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Spacing.lg)
                }
                // Clicking a row in the left list still means something: it
                // scrolls PROCESS to that stage's card instead of swapping
                // out what's shown, since every card is visible at once now.
                .onChange(of: selectedStageId) { _, newValue in
                    guard let id = newValue else { return }
                    withAnimation(.linear(duration: 0.15)) {
                        proxy.scrollTo(id, anchor: .top)
                    }
                }
            }
        }
        .background(t.body)
    }

    /// Every stage in run order, each in its own editable card — the
    /// "what to do" of the loop. No stage is hidden behind a selection: a
    /// generate stage's skill+input picker, a shell stage's command, a
    /// regression stage's fixed scope, all visible and editable together.
    @ViewBuilder
    private var processSection: some View {
        let t = theme.current
        VStack(alignment: .leading, spacing: Spacing.md) {
            SectionLabel("PROCESS")
            if stages.isEmpty && appliedTemplateHadNoTooling {
                Text("No test tooling detected in this project, so the applied template has nothing to run. Pick another template, or add a stage manually with +.")
                    .font(Typography.body)
                    .foregroundStyle(t.accent4)
            } else if stages.isEmpty {
                Text("No stages yet. Add one with + on the left, or apply a template above.")
                    .font(Typography.body)
                    .foregroundStyle(t.textMuted)
            } else {
                ForEach(Array(sortedStages.enumerated()), id: \.element.id) { position, stage in
                    if let index = stages.firstIndex(where: { $0.id == stage.id }) {
                        processCard(position: position, index: index)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func processCard(position: Int, index: Int) -> some View {
        let t = theme.current
        let stage = stages[index]
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(spacing: 6) {
                Text("\(position + 1)")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(t.textMuted)
                    .frame(width: 14, alignment: .trailing)
                Image(systemName: stage.kind == .regressionSweep ? "arrow.uturn.backward.circle"
                      : stage.kind == .shellCommand ? "terminal" : "sparkles")
                    .foregroundStyle(t.textMuted)
                Text(stage.kind == .skill ? "Generate" : "Verify")
                    .font(Typography.captionStrong)
                    .foregroundStyle(stage.kind == .skill ? t.accent2 : t.accent)
                if stage.isDefault {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 10))
                        .foregroundStyle(t.textMuted)
                        .help("Default stage — can't be deleted")
                }
                Spacer()
                Menu {
                    Button("Duplicate") { duplicateStage(stage) }
                    if !stage.isDefault {
                        Button("Delete", role: .destructive) { deleteStage(stage) }
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .foregroundStyle(t.textMuted)
                }
                .buttonStyle(.borderless)
            }
            stageDetail(index: index)
        }
        .padding(Spacing.sm)
        .background(selectedStageId == stage.id ? t.accent.opacity(0.08) : t.surface)
        .cornerRadius(8)
        .id(stage.id)
        .onTapGesture { selectedStageId = stage.id }
    }

    private var toolbar: some View {
        HStack(spacing: Spacing.md) {
            Button {
                isPresentingNewLoopWizard = true
            } label: {
                Label("New Loop", systemImage: "plus.circle")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .help("Create a loop from a template — choose the recipe, then each stage's skill and input")
            Divider().frame(height: 16)
            Button(runner.running ? "Running… (iteration \(runner.iteration))" : "Run") {
                runTask = Task {
                    await runLoop()
                    runTask = nil
                }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(runner.running || stages.isEmpty || activeGitRootURL == nil)
            if runner.running {
                // Cancelling `runTask` makes `Task.isCancelled` true on the
                // same task `runner.run` is awaiting on, which is how a
                // shell-command stage in progress actually notices — see
                // `ShellFaultVerifier`. The runner reports `.aborted` and
                // still journals the run, same as any other terminal status.
                Button("Stop") { runTask?.cancel() }
                    .controlSize(.small)
            }
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
                            selectedStageId = stages[index].id
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .disabled(approved)
                    } else {
                        Text("Enter a command for this stage.")
                            .font(Typography.caption).foregroundStyle(t.textMuted)
                    }
                } else {
                    Text("Open a project with a cloned repo to approve or run shell-command stages.")
                        .font(Typography.caption).foregroundStyle(t.textMuted)
                }
            } else if stages[index].kind == .skill {
                Text("Skill").font(Typography.caption).foregroundStyle(t.textMuted)
                if skillCatalog.isEmpty {
                    Text(skillsLoaded ? "No library skills found." : "Loading skills…")
                        .font(Typography.caption).foregroundStyle(t.textMuted)
                } else {
                    Picker("Skill", selection: Binding(
                        get: { stages[index].skillId ?? "" },
                        set: { stages[index].skillId = $0.isEmpty ? nil : $0 }
                    )) {
                        Text("None").tag("")
                        ForEach(skillCatalog) { s in
                            Text("\(s.name) · \(s.family)").tag(s.id)
                        }
                    }
                }

                Text("Input (optional) — file or folder under the project root").font(Typography.caption).foregroundStyle(t.textMuted)
                PathPickerField(root: activeGitRootURL ?? workspaceContext?.projectRoot,
                                path: $stages[index].targetPath)

                Text("Output (optional) — where the skill should write its result").font(Typography.caption).foregroundStyle(t.textMuted)
                PathPickerField(root: activeGitRootURL ?? workspaceContext?.projectRoot,
                                path: $stages[index].outputPath)
                Text("Input and output are hints included in the skill's prompt — the skill decides how to use them via its own tool calls.")
                    .font(Typography.caption).foregroundStyle(t.textMuted)
                    .fixedSize(horizontal: false, vertical: true)

                Text("Prompt (optional)").font(Typography.caption).foregroundStyle(t.textMuted)
                TextField("Defaults to: apply this skill", text: Binding(
                    get: { stages[index].prompt ?? "" },
                    set: { stages[index].prompt = $0.isEmpty ? nil : $0 }
                ), axis: .vertical)
                .textFieldStyle(.roundedBorder)

                Text("Runs the skill as a generate step each iteration; the loop's verify stages decide pass/fail.")
                    .font(Typography.caption).foregroundStyle(t.textMuted)
            } else {
                Text("Re-runs the Regression sweep (fault reports + repo checks) with repair attempted on failure.")
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
            }

            Divider().background(t.border).padding(.vertical, 4)

            Text("Severity").font(Typography.caption).foregroundStyle(t.textMuted)
            Picker("Severity", selection: $stages[index].severity) {
                ForEach(LoopStageSeverity.allCases, id: \.self) { severity in
                    Text(severity.label).tag(severity)
                }
            }
            .pickerStyle(.segmented)
            Text(stages[index].severity == .blocking
                 ? "A failure triggers repair and can end the run."
                 : "A failure is recorded only — no repair, no stall, never fails the run. Use for linters and formatters.")
                .font(Typography.caption)
                .foregroundStyle(t.textMuted)
                .fixedSize(horizontal: false, vertical: true)

            if stages[index].kind == .shellCommand {
                Text("Timeout").font(Typography.caption).foregroundStyle(t.textMuted)
                // 0 means "use the runner default" — a Stepper cannot express nil.
                // That default is now no limit, so say so rather than naming a
                // number the runner no longer applies.
                Stepper(stages[index].timeoutSeconds.map { "\($0)s" } ?? "No limit",
                        value: Binding(
                            get: { stages[index].timeoutSeconds ?? 0 },
                            set: { stages[index].timeoutSeconds = $0 == 0 ? nil : $0 }
                        ), in: 0...3600, step: 30)
            }
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
            pastRunsSection
        }
        .background(t.surface)
    }

    /// Runs read back from `<projectRoot>/system/loop-runs/`. The live log above
    /// is in-memory and dies with the app process; this is the part that survives
    /// a restart, which is the whole reason the journal exists.
    @ViewBuilder
    private var pastRunsSection: some View {
        let t = theme.current
        if !pastRuns.isEmpty {
            Divider().background(t.border)
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    SectionLabel("PAST RUNS")
                    Spacer()
                }
                .padding(.horizontal, Spacing.lg)
                .padding(.vertical, Spacing.sm)
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 4) {
                        ForEach(pastRuns, id: \.id) { entry in
                            HStack(alignment: .top, spacing: 6) {
                                Circle()
                                    .fill(entry.statusCode == "success" ? t.success : t.danger)
                                    .frame(width: 5, height: 5)
                                    .padding(.top, 5)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(entry.statusSummary)
                                        .font(.system(size: 11))
                                        .foregroundStyle(t.text)
                                        .fixedSize(horizontal: false, vertical: true)
                                    Text("\(AppDateFormatter.hourMinuteSecond(entry.startedAt)) · \(entry.trigger.rawValue) · \(entry.iterationsUsed) iter · \(Int(entry.durationSeconds))s")
                                        .font(.system(size: 9, design: .monospaced))
                                        .foregroundStyle(t.textMuted)
                                }
                            }
                        }
                    }
                    .padding(.horizontal, Spacing.md)
                    .padding(.bottom, Spacing.sm)
                }
                .frame(maxHeight: 160)
            }
        }
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
    /// for the actual git working tree) — the single source of truth for
    /// resolving the two roots. In the "clone-into-code" layout these differ
    /// (project root vs `code/<repo>`); using the project root for both, as
    /// this view previously did via `activeProject.localPath`, silently
    /// pointed shell-command stages and stage detection at the wrong tree.
    var workspaceContext: WorkspaceRoot.Context? {
        WorkspaceRoot.context(config: config, projectStore: projectStore)
    }

    /// The git working tree shell-command stages run in and approvals are
    /// keyed against — `nil` when the active project has no resolvable git
    /// working tree (e.g. a fresh non-repo project).
    var activeGitRootURL: URL? {
        workspaceContext?.gitRoot
    }

    /// The config this page currently represents — the single builder used by
    /// save AND run. Composing it in one place is what stops a newly added
    /// `LoopEngineConfig` field from being silently reset to its default by a
    /// call site that forgot to thread it through (the same hazard
    /// `LoopStageDetector.ensureDefaultStages` copies-and-mutates to avoid).
    private var currentConfig: LoopEngineConfig {
        LoopEngineConfig(
            stages: stages,
            maxIterations: maxIterations,
            consecutiveFailureStop: consecutiveFailureStop,
            wallClockBudgetSeconds: wallClockMinutes == 0 ? nil : Double(wallClockMinutes) * 60,
            maxRepairsPerStage: maxRepairsPerStage,
            protectedPathPolicy: protectedPathPolicy,
            extraProtectedGlobs: extraProtectedGlobs,
            writeSummaryNote: writeSummaryNote)
    }

    private func loadConfig() {
        guard let projectId = activeProjectId else {
            resetStagesToDefaults()
            return
        }
        loadPastRuns()
        if let saved = LoopEngineConfigStore.load(projectRoot: workspaceContext?.projectRoot, projectId: projectId) {
            let ensured = LoopStageDetector.ensureDefaultStages(in: saved, gitRoot: activeGitRootURL)
            stages = ensured.stages
            maxIterations = ensured.maxIterations
            consecutiveFailureStop = ensured.consecutiveFailureStop
            wallClockMinutes = ensured.wallClockBudgetSeconds.map { Int($0 / 60) } ?? 0
            maxRepairsPerStage = ensured.maxRepairsPerStage
            protectedPathPolicy = ensured.protectedPathPolicy
            extraProtectedGlobs = ensured.extraProtectedGlobs
            writeSummaryNote = ensured.writeSummaryNote
        } else if let gitRoot = activeGitRootURL {
            let detected = LoopStageDetector.detectDefaultStages(gitRoot: gitRoot)
            resetStagesToDefaults(stages: detected)
            // Only persist when detection found real tooling beyond the bare
            // Regression stage — same policy as the Auto Task sweep's own
            // guard in AutoCodeUpdateService+PipelineTasks.swift, so this
            // page can't permanently lock in a Regression-only config for
            // the project before the repo is fully populated/detectable.
            if LoopEngineConfig.shouldPersist(detected) {
                var toSave = currentConfig
                toSave.stages = detected
                LoopEngineConfigStore.save(toSave, projectRoot: workspaceContext?.projectRoot,
                                           projectId: projectId)
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

    /// Live-fetch the central skill catalog (best-effort, latched on success)
    /// for the skill-stage picker — mirrors CompletionController.loadMetaIfNeeded.
    private func loadSkillsIfNeeded() async {
        guard !skillsLoaded else { return }
        if let skills = try? await api.skillLibrary() {
            skillCatalog = skills
            skillsLoaded = true
        }
    }

    /// Single reset path for "no config to show" — used both when no
    /// project is active and when a project has neither a saved config
    /// nor a detectable git root.
    private func resetStagesToDefaults(stages newStages: [LoopStage] = []) {
        // Seeded from the app-wide defaults (Settings → Loop), not from literals:
        // a project being set up for the first time must inherit what the user
        // configured once, and repeating the numbers here would silently diverge
        // from `LoopEngineConfig`'s and the Settings card's own values.
        let seed = LoopEngineDefaults.newConfig(stages: newStages)
        stages = seed.stages
        maxIterations = seed.maxIterations
        consecutiveFailureStop = seed.consecutiveFailureStop
        wallClockMinutes = seed.wallClockBudgetSeconds.map { Int($0 / 60) } ?? 0
        maxRepairsPerStage = seed.maxRepairsPerStage
        protectedPathPolicy = seed.protectedPathPolicy
        extraProtectedGlobs = seed.extraProtectedGlobs
        writeSummaryNote = seed.writeSummaryNote
        pastRuns = []
        lastSummaryNoteName = nil
    }

    /// Append a non-default copy of `stage` (new id, cleared isDefault, next order).
    private func duplicateStage(_ stage: LoopStage) {
        let nextOrder = (stages.map(\.order).max() ?? -1) + 1
        var copy = stage
        copy.id = UUID().uuidString
        copy.isDefault = false
        copy.order = nextOrder
        stages.append(copy)
    }

    /// Remove a stage by id (row ⋯ → Delete). Pinned stages never offer Delete, so this
    /// is only reachable for non-default stages. Clears the selection if it was deleted.
    private func deleteStage(_ stage: LoopStage) {
        let id = stage.id
        stages.removeAll { $0.id == id }
        if selectedStageId == id { selectedStageId = nil }
    }

    func saveConfig() {
        guard let projectId = activeProjectId else { return }
        LoopEngineConfigStore.save(currentConfig, projectRoot: workspaceContext?.projectRoot,
                                   projectId: projectId)
    }

    /// Refreshes the "past runs" list from the journal on disk. Best-effort: an
    /// absent journal is the normal state for a project that has never looped.
    private func loadPastRuns() {
        guard let root = workspaceContext?.projectRoot else {
            pastRuns = []
            return
        }
        pastRuns = journal.recentRuns(root: root, limit: 15)
        lastSummaryNoteName = Self.newestSummaryNoteName(projectRoot: root)
    }

    /// Newest filename under `llm-doc/loop/`, or nil. Walks the directory rather
    /// than reading the note index so a note deleted by hand cannot leave the
    /// Output row claiming a file that is gone.
    private static func newestSummaryNoteName(projectRoot: URL) -> String? {
        let root = projectRoot.appendingPathComponent("llm-doc/loop", isDirectory: true)
        guard let walker = FileManager.default.enumerator(
            at: root, includingPropertiesForKeys: [.contentModificationDateKey])
        else { return nil }
        var newest: (name: String, at: Date)?
        for case let url as URL in walker where url.pathExtension == "md" {
            let at = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?
                .contentModificationDate ?? .distantPast
            guard let current = newest else {
                newest = (url.lastPathComponent, at)
                continue
            }
            if at > current.at { newest = (url.lastPathComponent, at) }
        }
        return newest?.name
    }

    // MARK: - Templates

    var selectedTemplate: LoopTemplate? {
        selectedTemplateId.flatMap { templateStore.template(id: $0) }
    }

    /// Copies every field of `applied` into this view's state — the one place
    /// an applied config is assigned, so a field added to `LoopEngineConfig`
    /// can't be silently dropped by one of the two apply paths below forgetting
    /// to thread it through (the same hazard `currentConfig`'s own doc comment
    /// calls out for the save/run direction).
    private func assignConfig(_ applied: LoopEngineConfig) {
        stages = applied.stages
        maxIterations = applied.maxIterations
        consecutiveFailureStop = applied.consecutiveFailureStop
        wallClockMinutes = applied.wallClockBudgetSeconds.map { Int($0 / 60) } ?? 0
        maxRepairsPerStage = applied.maxRepairsPerStage
        protectedPathPolicy = applied.protectedPathPolicy
        extraProtectedGlobs = applied.extraProtectedGlobs
        writeSummaryNote = applied.writeSummaryNote
        // Stage ids are regenerated on apply, so the old selection no longer exists.
        selectedStageId = nil
    }

    /// Replaces the current stage list and budgets with the selected template's.
    ///
    /// Does NOT save: applying is an edit like any other, and a user who applies a
    /// template to compare it against what they had must be able to switch away
    /// without having overwritten their config. `Run` and `Save` persist, as before.
    func applySelectedTemplate() {
        guard let template = selectedTemplate else { return }
        appliedTemplateHadNoTooling = template.wouldApplyEmpty(to: activeGitRootURL)
        assignConfig(template.applied(to: activeGitRootURL))
    }

    /// Applies a config assembled by the New Loop wizard and saves it right
    /// away. Unlike `applySelectedTemplate` — an edit the user must still
    /// confirm with Save, so switching templates to compare them can't
    /// silently overwrite what they had — finishing the wizard already IS the
    /// confirmation: the user picked a recipe and configured its stages in a
    /// dedicated flow, so there is nothing left to reconsider before it takes
    /// effect as this project's active loop.
    func applyNewLoopConfig(_ applied: LoopEngineConfig) {
        assignConfig(applied)
        selectedTemplateId = nil
        saveConfig()
    }

    func saveCurrentAsTemplate() {
        let saved = templateStore.save(
            name: newTemplateName, summary: newTemplateSummary, config: currentConfig)
        selectedTemplateId = saved.id
        newTemplateName = ""
        newTemplateSummary = ""
    }

    @MainActor
    private func runLoop() async {
        // `gitRoot` is `LoopEngineRunner.run`'s non-optional parameter, so a
        // run must not start until a real git working tree is resolved —
        // guards against running git-dependent stages with no working tree.
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
        if LoopEngineConfig.shouldPersist(stages)
            || LoopEngineConfigStore.exists(projectRoot: context.projectRoot, projectId: projectId) {
            saveConfig()
        }
        let result = await runner.run(config: currentConfig, faultsRoot: context.projectRoot,
                                      gitRoot: gitRoot, projectId: projectId)
        lastStatus = result
        didRejectLastRun = (result == nil)
        // The run just journalled itself; re-read so the list reflects it.
        loadPastRuns()
    }
}
