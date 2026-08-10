// Loop Engineering — three-pane workspace (Stages / Detail / Log):
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
    @Environment(LibraryItemStore.self) private var itemStore

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
    private let approvals: VerifyApprovalStore

    @State private var stages: [LoopStage] = []
    @State private var maxIterations: Int = 10
    @State private var consecutiveFailureStop: Int = 2
    /// 0 means "no wall-clock limit" — a Stepper cannot express `nil`, so the
    /// zero sentinel is mapped to/from `LoopEngineConfig.wallClockBudgetSeconds`
    /// in `currentConfig` and `loadConfig`.
    @State private var wallClockMinutes: Int = 60
    @State private var maxRepairsPerStage: Int = 3
    @State private var protectedPathPolicy: ProtectedPathPolicy = .revert
    /// No UI (the built-in protected set covers the common cases); held in state
    /// purely so a hand-edited value survives a save from this page instead of
    /// being silently dropped.
    @State private var extraProtectedGlobs: [String] = []
    @State private var selectedStageId: String?
    @State private var lastStatus: LoopEngineStatus?
    @State private var didRejectLastRun = false
    @State private var skillCatalog: [LlmIdeAPIClient.SkillLibraryEntry] = []
    @State private var skillsLoaded = false
    @State private var pastRuns: [LoopRunIndexEntry] = []

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
            Task { await loadSkillsIfNeeded() }
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
                    }
                    Button("Regression sweep") {
                        let nextOrder = (stages.map(\.order).max() ?? -1) + 1
                        stages.append(LoopStage(name: "Regression", kind: .regressionSweep, command: nil, order: nextOrder))
                    }
                    Button("Skill (generate)") {
                        let nextOrder = (stages.map(\.order).max() ?? -1) + 1
                        stages.append(LoopStage(name: "New Skill Stage", kind: .skill, command: nil, order: nextOrder))
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
            Divider().background(t.border)
            VStack(alignment: .leading, spacing: 6) {
                SectionLabel("BUDGETS")
                Stepper("Max iterations: \(maxIterations)", value: $maxIterations, in: 1...20)
                Stepper("Stop after \(consecutiveFailureStop) non-improving failures", value: $consecutiveFailureStop, in: 1...10)
                Stepper(wallClockMinutes == 0 ? "Time budget: none" : "Time budget: \(wallClockMinutes) min",
                        value: $wallClockMinutes, in: 0...480, step: 15)
                Stepper("Max repairs per stage: \(maxRepairsPerStage)", value: $maxRepairsPerStage, in: 1...10)

                SectionLabel("PROTECTED PATHS")
                Picker("If a repair edits a test or build file", selection: $protectedPathPolicy) {
                    ForEach(ProtectedPathPolicy.allCases, id: \.self) { policy in
                        Text(policy.label).tag(policy)
                    }
                }
                .pickerStyle(.menu)
                Text("Tests, build config and system/ are reverted by default, and a stage that only passes after such an edit is reported blocked — not fixed.")
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
                    .fixedSize(horizontal: false, vertical: true)

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

                Text("Target source (optional)").font(Typography.caption).foregroundStyle(t.textMuted)
                let allItems = LibraryItem.Category.allCases.flatMap { itemStore.items(for: $0) }
                Picker("Target", selection: Binding(
                    get: { stages[index].targetPath ?? "" },
                    set: { stages[index].targetPath = $0.isEmpty ? nil : $0 }
                )) {
                    Text("None").tag("")
                    ForEach(allItems) { item in
                        Text(item.name).tag(item.path)
                    }
                }

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
                Stepper(stages[index].timeoutSeconds.map { "\($0)s" } ?? "Default (600s)",
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
    private var workspaceContext: WorkspaceRoot.Context? {
        WorkspaceRoot.context(config: config, projectStore: projectStore)
    }

    /// The git working tree shell-command stages run in and approvals are
    /// keyed against — `nil` when the active project has no resolvable git
    /// working tree (e.g. a fresh non-repo project).
    private var activeGitRootURL: URL? {
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
            extraProtectedGlobs: extraProtectedGlobs)
    }

    private func loadConfig() {
        guard let projectId = activeProjectId else {
            resetStagesToDefaults()
            return
        }
        loadPastRuns()
        if let saved = LoopEngineConfig.load(for: projectId) {
            let ensured = LoopStageDetector.ensureDefaultStages(in: saved, gitRoot: activeGitRootURL)
            stages = ensured.stages
            maxIterations = ensured.maxIterations
            consecutiveFailureStop = ensured.consecutiveFailureStop
            wallClockMinutes = ensured.wallClockBudgetSeconds.map { Int($0 / 60) } ?? 0
            maxRepairsPerStage = ensured.maxRepairsPerStage
            protectedPathPolicy = ensured.protectedPathPolicy
            extraProtectedGlobs = ensured.extraProtectedGlobs
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
                toSave.save(for: projectId)
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
        stages = newStages
        maxIterations = 10
        consecutiveFailureStop = 2
        wallClockMinutes = 60
        maxRepairsPerStage = 3
        protectedPathPolicy = .revert
        extraProtectedGlobs = []
        pastRuns = []
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

    private func saveConfig() {
        guard let projectId = activeProjectId else { return }
        currentConfig.save(for: projectId)
    }

    /// Refreshes the "past runs" list from the journal on disk. Best-effort: an
    /// absent journal is the normal state for a project that has never looped.
    private func loadPastRuns() {
        guard let root = workspaceContext?.projectRoot else {
            pastRuns = []
            return
        }
        pastRuns = journal.recentRuns(root: root, limit: 15)
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
        if LoopEngineConfig.shouldPersist(stages) || LoopEngineConfig.load(for: projectId) != nil {
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
