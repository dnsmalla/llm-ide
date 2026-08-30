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
// Stages can be reordered (drag in the left list, or Move up/down in a
// stage's ⋯ menu) and individually disabled — a disabled stage is skipped
// by the runner entirely, which is the escape hatch for pinned default
// stages that cannot be deleted. Edits auto-save (debounced) once the
// project has a real config, so a project switch can no longer silently
// discard them; Run and Save still persist immediately.

import SwiftUI

struct LoopEngineView: View {
    let api: LlmIdeAPIClient
    /// Which `LoopDefinition` within the active project this instance is the
    /// workspace for — set once by `LoopEngineHomeView` for the selected row
    /// in its loop list. Everything below that used to key off only
    /// `activeProjectId` now keys off `(activeProjectId, loopId)`.
    let loopId: String

    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @EnvironmentObject var projectStore: ProjectStore
    /// The shared per-task log. This page owns its runner, so without mirroring
    /// into here a run started FROM THIS PAGE was invisible to every other
    /// surface — including the iPhone, which can see that a run is in flight
    /// (the runner's process-wide guard) but had no lines to show for it.
    @EnvironmentObject var logStore: TaskLogStore

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
    /// "Approve command" button and, via the SAME instance handed to
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
    /// Past-run inspector — when set, the log pane shows the journal record
    /// instead of the live in-memory log.
    @State var selectedPastRunId: String?
    @State var inspectedPastRun: LoopRunRecord?
    @State var pastRunInspectLoadFailed = false
    /// The in-flight `Task { await runLoop() }`, held only so Stop has
    /// something to cancel. `runner.running` alone can't be acted on — it's
    /// a `@Published` observation, not a handle — and cancelling this Task
    /// is what makes `Task.isCancelled` true everywhere down the call tree
    /// `runner.run` awaits through, including inside `ShellFaultVerifier`.
    @State private var runTask: Task<Void, Never>?
    /// Debounced autosave of the current config (see `scheduleAutosave`).
    @State private var autosaveTask: Task<Void, Never>?
    /// The not-yet-written autosave payload. Held separately from the task so a
    /// project switch or view teardown can FLUSH it (write now) instead of the
    /// cancel-and-lose that a bare task would force.
    @State private var pendingAutosave: PendingAutosave?
    /// What THIS loop currently has persisted (`nil` ⇒ no saved entry for this
    /// `loopId` yet). The autosave baseline: loading a loop must not trigger a
    /// write of the file it just read, and a no-op edit round-trip must not
    /// rewrite a committed `system/loop.json`. Also stands in for "does this
    /// loop already exist in the store" (`!= nil`), so the guard costs no disk
    /// read per keystroke.
    @State private var persistedLoop: LoopDefinition?

    struct PendingAutosave {
        let loop: LoopDefinition
        let projectId: String
        let projectRoot: URL?
    }

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
    /// When enabled, a run that would queue on the main checkout uses an
    /// isolated git worktree instead.
    @State var useWorktreesForConcurrentRuns = false
    /// Filename of the most recent run-summary note, for the Output section's
    /// "last written" line. Read from disk rather than the note index so an
    /// unindexed/hand-deleted note cannot make the row lie.
    @State var lastSummaryNoteName: String?
    /// This loop's own display name — editable (see Task 9, not yet done).
    @State var loopName: String = ""
    /// This loop's free-text goal/acceptance-criteria — `nil`/empty for
    /// every loop that has never set one, which is byte-identical to
    /// pre-multi-loop behavior. Edited in the OVERVIEW section.
    @State var goal: String = ""
    @State var acceptanceCriteria: String = ""
    /// Optional path allowlist, edited in the SETTINGS section. Empty means
    /// unrestricted — see `LoopDefinition.scopeGlobs`.
    @State var scopeGlobs: [String] = []
    /// Which built-in loop this is (`LoopDefaultLoopKey`), or nil for a loop
    /// the user created. Immutable identity — carried in state only so a save
    /// from this page cannot drop it, the way a `LoopDefinition` field this
    /// view forgets to thread would.
    @State var loopDefaultKey: String?
    /// Mirrors `LoopDefinition.runsOnSchedule`. Toggled from the loop-list
    /// pane, not here, so — exactly like `isPrimaryLoop` — this copy can be
    /// stale and `writeLoop` takes the value from disk instead.
    @State var runsOnSchedule = false
    /// Whether the loop this page represents was the project's Primary loop
    /// as of the last `loadConfig()` — i.e. refreshed on a project/loop
    /// switch only, NOT when Primary is reassigned from the loop-list pane
    /// while this page stays mounted (`reloadKey` doesn't change for that,
    /// so `loadConfig()` never re-runs). Used only to attribute legacy
    /// (pre-migration) journal entries — whose `loopId` is `nil` — to the
    /// Primary loop's Past Runs list in `loadPastRuns()`. Deliberately NOT
    /// the source of truth for persistence: `writeLoop` takes `isPrimary`
    /// from disk instead, precisely because this copy can be stale.
    @State var isPrimaryLoop = false

    /// Reads `<projectRoot>/system/loop-runs/` for the "past runs" list. A
    /// separate instance from the runner's own journal is fine — the file layout
    /// is the contract, and this one only ever reads.
    private let journal = FileLoopRunJournal()

    init(api: LlmIdeAPIClient, loopId: String) {
        self.api = api
        self.loopId = loopId
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
        .onAppear {
            // Same buffer the Auto Tasks page and the phone read. Page-driven
            // runs therefore appear in that log too: it is one loop with one
            // activity trail, and this page keeps its own richer log pane.
            runner.onLog = { [weak logStore] line in
                logStore?.append(AutoTask.loopEngineering.rawValue, line.text,
                                 level: line.level == .error ? .error : .info)
            }
        }
        .task(id: reloadKey) {
            selectedStageId = nil
            runner.clearLog()
            lastStatus = nil
            didRejectLastRun = false
            clearPastRunInspection()
            loadConfig()
            Task { await loadSkillsIfNeeded() }
        }
        // Debounced autosave: before this, edits lived only in @State and a
        // project switch silently discarded them — the Save button sits at
        // the bottom of SETTINGS and Run is not always the next step. Guarded
        // inside scheduleAutosave by the same shouldPersist rule runLoop's
        // implicit save uses (so it can't lock in an unconfirmed
        // bare-Regression detection) and by the persistedLoop baseline (so
        // merely loading a loop never rewrites the committed file).
        // Every exit flushes the pending write rather than dropping it:
        // project/loop switch (loadConfig), leaving this page (onDisappear),
        // and app quit (willTerminate below — a sleeping Task dies with the
        // process on Cmd-Q, the same reason LoopEngineRunner installs its
        // own termination handler).
        .onChange(of: currentLoop) { _, updated in
            scheduleAutosave(updated)
        }
        .onDisappear {
            flushPendingAutosave()
        }
        .onReceive(NotificationCenter.default.publisher(
            for: NSApplication.willTerminateNotification)) { _ in
            flushPendingAutosave()
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
            List(selection: $selectedStageId) {
                ForEach(Array(sortedStages.enumerated()), id: \.element.id) { position, stage in
                    stageRow(stage, position: position)
                }
                .onMove { offsets, destination in
                    var ordered = sortedStages
                    ordered.move(fromOffsets: offsets, toOffset: destination)
                    stages = LoopStage.renumbered(ordered)
                }
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

    /// Display order matches `LoopEngineRunner`'s own execution order exactly —
    /// both go through `LoopStage.runOrder`, so the sidebar can never show a
    /// different order than the stages actually run in.
    var sortedStages: [LoopStage] {
        LoopStage.runOrder(stages)
    }

    @ViewBuilder
    private func stageRow(_ stage: LoopStage, position: Int) -> some View {
        let t = theme.current
        HStack(spacing: 6) {
            Image(systemName: stage.kind == .regressionSweep ? "arrow.uturn.backward.circle"
                  : stage.kind == .shellCommand ? "terminal" : "sparkles")
                .foregroundStyle(t.textMuted)
            Text(stage.name)
                .font(Typography.filename)
                .lineLimit(1)
                .truncationMode(.middle)
                .strikethrough(!stage.enabled)
            Spacer(minLength: 4)
            if !stage.enabled {
                Text("off")
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(t.textMuted)
                    .help("Disabled — the runner skips this stage")
            }
            if stage.enabled,
               stage.kind == .shellCommand,
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
                    .help("Default stage — can't be deleted (disable it instead)")
            }
            stageMenu(stage, position: position, count: stages.count)
        }
        .opacity(stage.enabled ? 1 : 0.55)
    }

    /// One ⋯ menu for a stage, shared by the sidebar row and the PROCESS card
    /// so the two surfaces can never offer different actions for the same stage.
    /// `position`/`count` are passed in (both callers already have them) rather
    /// than re-derived — `sortedStages` is a full sort per access, and Menu
    /// content is built eagerly per row per render.
    @ViewBuilder
    func stageMenu(_ stage: LoopStage, position: Int, count: Int) -> some View {
        Menu {
            Button(stage.enabled ? "Disable" : "Enable") { setStageEnabled(stage, !stage.enabled) }
            Button("Move up") { moveStage(stage, by: -1) }
                .disabled(position == 0)
            Button("Move down") { moveStage(stage, by: 1) }
                .disabled(position == count - 1)
            Divider()
            Button("Run this stage only") { startRun(only: stage) }
                .disabled(runner.running || activeGitRootURL == nil)
            Divider()
            Button("Duplicate") { duplicateStage(stage) }
            if !stage.isDefault {
                Button("Delete", role: .destructive) { deleteStage(stage) }
            }
        } label: {
            Image(systemName: "ellipsis")
                .foregroundStyle(theme.current.textMuted)
        }
        .buttonStyle(.borderless)
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
                        .help("Default stage — can't be deleted (disable it instead)")
                }
                Spacer()
                // Routed through setStageEnabled (not a raw indexed write) so
                // the switch and the ⋯ menu share one mutation path — an
                // invariant added to disabling can't be skipped by one of them.
                Toggle("", isOn: Binding(
                    get: { stage.enabled },
                    set: { setStageEnabled(stage, $0) }
                ))
                .toggleStyle(.switch)
                .controlSize(.mini)
                .labelsHidden()
                .help(stage.enabled ? "Enabled — runs every iteration"
                      : "Disabled — the runner skips this stage")
                stageMenu(stage, position: position, count: stages.count)
            }
            stageDetail(index: index)
                .opacity(stage.enabled ? 1 : 0.55)
        }
        .padding(Spacing.sm)
        .background(selectedStageId == stage.id ? t.accent.opacity(0.08) : t.surface)
        .cornerRadius(8)
        .id(stage.id)
        // `simultaneousGesture`, not `.onTapGesture` — a plain tap gesture on
        // this container would compete with the nested TextFields/Pickers/
        // Buttons in `stageDetail`, swallowing the first click instead of
        // focusing/activating them. `simultaneous` lets this fire alongside
        // whichever child control the click actually landed on.
        .simultaneousGesture(TapGesture().onEnded { selectedStageId = stage.id })
    }

    private var toolbar: some View {
        HStack(spacing: Spacing.md) {
            Button(runner.waitingInQueue ? "Queued…"
                   : runner.running ? "Running… (iteration \(runner.iteration))" : "Run") {
                startRun()
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(runner.running || runner.waitingInQueue
                      || !stages.contains(where: \.enabled) || activeGitRootURL == nil)
            if runner.running {
                // Cancelling `runTask` makes `Task.isCancelled` true on the
                // same task `runner.run` is awaiting on, which is how a
                // shell-command stage in progress actually notices — see
                // `ShellFaultVerifier`. The runner reports `.aborted` and
                // still journals the run, same as any other terminal status.
                Button("Stop") { runTask?.cancel() }
                    .controlSize(.small)
            } else if runner.waitingInQueue {
                Button("Leave queue") { runTask?.cancel() }
                    .controlSize(.small)
            }
            if let lastStatus {
                Text(lastStatus.summary)
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
            } else if didRejectLastRun {
                Text("This runner was already busy")
                    .font(Typography.caption)
                    .foregroundStyle(.orange)
            } else if runner.waitingInQueue, let gitRoot = activeGitRootURL {
                let ahead = LoopEngineRunner.queuedRunCount(gitRoot: gitRoot)
                Text(ahead > 0 ? "Waiting — \(ahead + 1) in line" : "Waiting for the current run")
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
                        // "Approve command", not the old "Approve & enable" —
                        // "enable" now means the per-stage enabled toggle, and a
                        // button claiming to enable while only approving would
                        // leave a disabled stage silently skipped.
                        let approved = approvals.isStageApproved(repo: gitRoot, stageId: stages[index].id, command: command)
                        Button(approved ? "Approved" : "Approve command") {
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
                // Rooted at the git root ONLY (no projectRoot fallback) to match
                // targetPath/outputPath's documented contract ("relative to the
                // project's git root") and the New Loop wizard's PathPickerField —
                // a projectRoot fallback here would silently store paths relative
                // to the wrong base on a project with no git repo.
                PathPickerField(root: activeGitRootURL,
                                path: $stages[index].targetPath)

                Text("Output (optional) — where the skill should write its result").font(Typography.caption).foregroundStyle(t.textMuted)
                PathPickerField(root: activeGitRootURL,
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
        let inspecting = inspectedPastRun != nil || pastRunInspectLoadFailed
        return VStack(spacing: 0) {
            HStack {
                SectionLabel(inspecting ? "RUN DETAIL" : "RUN LOG")
                Spacer()
                if inspecting {
                    if let record = inspectedPastRun,
                       let root = workspaceContext?.projectRoot {
                        // Ask the journal where the file actually is — recomputing
                        // the month bucket here would miss the scan fallback and
                        // hand Finder a path that does not exist.
                        if let url = journal.resolveRecordURL(
                            id: record.id, startedAt: record.startedAt, root: root) {
                            Button("Reveal JSON") {
                                NSWorkspace.shared.activateFileViewerSelecting([url])
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                        }
                    }
                    Button("Back") { clearPastRunInspection() }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                } else {
                    Button("Clear") { runner.clearLog() }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .disabled(runner.log.isEmpty)
                }
            }
            .padding(.horizontal, Spacing.lg)
            .padding(.vertical, Spacing.sm)
            Divider().background(t.border)
            if pastRunInspectLoadFailed {
                Text("Could not load this run's journal record.")
                    .font(Typography.caption)
                    .foregroundStyle(t.danger)
                    .padding(Spacing.lg)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else if let record = inspectedPastRun {
                pastRunInspector(record)
            } else {
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
                            Button { selectPastRun(entry) } label: {
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
                                    Spacer(minLength: 0)
                                }
                                .padding(.vertical, 3)
                                .padding(.horizontal, 4)
                                .background(
                                    selectedPastRunId == entry.id
                                        ? t.accent.opacity(0.12) : Color.clear,
                                    in: RoundedRectangle(cornerRadius: 4))
                            }
                            .buttonStyle(.plain)
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

    /// Combines project and loop identity so switching EITHER — a project
    /// switch, or the home view moving the selection to a different loop
    /// within the same project — triggers a reload. A plain `activeProjectId`
    /// alone would leave a project-switch-only `.task(id:)` blind to a loop
    /// switch within the same project.
    private var reloadKey: String {
        "\(activeProjectId ?? "none")::\(loopId)"
    }

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

    /// The config this page currently represents — unchanged in shape; still
    /// just the budgets/stages half of the loop.
    private var currentConfig: LoopEngineConfig {
        LoopEngineConfig(
            stages: stages,
            maxIterations: maxIterations,
            consecutiveFailureStop: consecutiveFailureStop,
            wallClockBudgetSeconds: LoopBudgetsEditor.seconds(fromMinutes: wallClockMinutes),
            maxRepairsPerStage: maxRepairsPerStage,
            protectedPathPolicy: protectedPathPolicy,
            extraProtectedGlobs: extraProtectedGlobs,
            writeSummaryNote: writeSummaryNote,
            useWorktreesForConcurrentRuns: useWorktreesForConcurrentRuns)
    }

    /// The full `LoopDefinition` this page currently represents — `currentConfig`
    /// plus this loop's identity and contract fields. The single builder used
    /// by every save/autosave/run path, so a field added to `LoopDefinition`
    /// can't be silently dropped by one call site forgetting to thread it —
    /// same rationale `currentConfig`'s own doc comment gives for its half.
    private var currentLoop: LoopDefinition {
        LoopDefinition(id: loopId, name: loopName, isPrimary: isPrimaryLoop,
                       goal: goal.isEmpty ? nil : goal,
                       acceptanceCriteria: acceptanceCriteria.isEmpty ? nil : acceptanceCriteria,
                       scopeGlobs: scopeGlobs, defaultKey: loopDefaultKey,
                       runsOnSchedule: runsOnSchedule, config: currentConfig)
    }

    private func loadConfig() {
        // A pending autosave belongs to the PREVIOUS loop — loadConfig runs
        // on project/loop switch, and the state assignments below will fire
        // onChange for the NEW loop. Write the old loop's edits out first;
        // cancelling here would lose exactly the edit autosave exists to keep.
        flushPendingAutosave()
        // Reset up front: this flag is set by applySelectedTemplate() for
        // THIS loop's Template section, and a project/loop switch (the sole
        // caller of loadConfig(), via .task(id: reloadKey)) must not let it
        // survive into a different loop's empty-stages state for an
        // unrelated reason (no saved config, no git root).
        appliedTemplateHadNoTooling = false
        guard let projectId = activeProjectId else {
            resetStagesToDefaults()
            return
        }
        let store = LoopEngineConfigStore.loops(projectRoot: workspaceContext?.projectRoot,
                                                projectId: projectId, gitRoot: activeGitRootURL)
        if let existing = store.loops.first(where: { $0.id == loopId }) {
            // Loop-SCOPED ensure: only the default stages this loop's own
            // `defaultKey` owns are re-pinned. The aggregate version would
            // clone every built-in check into this loop — the bug the
            // independent-loops split fixed.
            let ensuredConfig = LoopStageDetector.ensureDefaultStages(in: existing, gitRoot: activeGitRootURL).config
            stages = ensuredConfig.stages
            maxIterations = ensuredConfig.maxIterations
            consecutiveFailureStop = ensuredConfig.consecutiveFailureStop
            wallClockMinutes = LoopBudgetsEditor.minutes(fromSeconds: ensuredConfig.wallClockBudgetSeconds)
            maxRepairsPerStage = ensuredConfig.maxRepairsPerStage
            protectedPathPolicy = ensuredConfig.protectedPathPolicy
            extraProtectedGlobs = ensuredConfig.extraProtectedGlobs
            writeSummaryNote = ensuredConfig.writeSummaryNote
            useWorktreesForConcurrentRuns = ensuredConfig.useWorktreesForConcurrentRuns
            loopName = existing.name
            isPrimaryLoop = existing.isPrimary
            goal = existing.goal ?? ""
            acceptanceCriteria = existing.acceptanceCriteria ?? ""
            scopeGlobs = existing.scopeGlobs
            loopDefaultKey = existing.defaultKey
            runsOnSchedule = existing.runsOnSchedule
            // Baseline set from currentLoop (not `existing`) so a lossy
            // round-trip cannot register as an edit and rewrite the file on
            // open — same reasoning the pre-multi-loop version documented.
            persistedLoop = currentLoop
        } else {
            // No entry for `loopId` in this project's ensured list. Reset for
            // display, and deliberately do NOT persist: `LoopEngineHomeView`
            // is the only creator of loops and always saves before selecting,
            // so reaching here means either a mid-project-switch render still
            // holding the previous project's loopId, or a loop deleted out
            // from under this view — writing in either case would put a
            // phantom loop into an unrelated project's committed loop.json.
            // Showing an empty pipeline (rather than a detected one) is also
            // honest: a detected aggregate is no longer any loop's real
            // contents now that the built-in checks are separate loops.
            resetStagesToDefaults()
        }
        loadPastRuns()
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
    private func resetStagesToDefaults() {
        // Seeded from the app-wide defaults (Settings → Loop), not from literals:
        // a project being set up for the first time must inherit what the user
        // configured once, and repeating the numbers here would silently diverge
        // from `LoopEngineConfig`'s and the Settings card's own values.
        let seed = LoopEngineDefaults.newConfig(stages: [])
        stages = seed.stages
        maxIterations = seed.maxIterations
        consecutiveFailureStop = seed.consecutiveFailureStop
        wallClockMinutes = LoopBudgetsEditor.minutes(fromSeconds: seed.wallClockBudgetSeconds)
        maxRepairsPerStage = seed.maxRepairsPerStage
        protectedPathPolicy = seed.protectedPathPolicy
        extraProtectedGlobs = seed.extraProtectedGlobs
        writeSummaryNote = seed.writeSummaryNote
        useWorktreesForConcurrentRuns = seed.useWorktreesForConcurrentRuns
        // Reset the loop-identity/contract state too — without this, closing
        // a project that had a loop with a Goal set and opening one with no
        // config yet would leave that Goal text displayed against the new,
        // unrelated project.
        loopName = "Main Loop"
        goal = ""
        acceptanceCriteria = ""
        scopeGlobs = []
        isPrimaryLoop = false
        loopDefaultKey = nil
        runsOnSchedule = false
        pastRuns = []
        lastSummaryNoteName = nil
        // Nothing is persisted for this loop (that is what "reset to
        // defaults" means here) — autosave's exists-check must say so.
        persistedLoop = nil
    }

    /// Append a non-default copy of `stage` (new id, cleared isDefault +
    /// defaultKey, next order) — a copy must not claim the default's identity,
    /// or `ensureDefaultStages`'s key match could pin the copy instead.
    private func duplicateStage(_ stage: LoopStage) {
        let nextOrder = (stages.map(\.order).max() ?? -1) + 1
        var copy = stage
        copy.id = UUID().uuidString
        copy.isDefault = false
        copy.defaultKey = nil
        copy.order = nextOrder
        stages.append(copy)
    }

    /// Move `stage` one position up (`-1`) or down (`+1`) in run order.
    private func moveStage(_ stage: LoopStage, by offset: Int) {
        stages = LoopStage.moving(stages, id: stage.id, by: offset)
    }

    /// Enable or disable `stage` — a disabled stage is skipped by the runner
    /// but keeps its place, command, and approval.
    private func setStageEnabled(_ stage: LoopStage, _ enabled: Bool) {
        guard let index = stages.firstIndex(where: { $0.id == stage.id }) else { return }
        stages[index].enabled = enabled
    }

    /// Kick off a run on `runTask` — the Run button and the per-stage
    /// "Run this stage only" both go through here so Stop always has one
    /// task to cancel.
    func startRun(only stage: LoopStage? = nil) {
        runTask = Task {
            await runLoop(only: stage)
            runTask = nil
        }
    }

    /// Whether implicit persistence (autosave, Run's implicit save) may write
    /// `loop`. One predicate for both paths — the composed rule lived inline
    /// at each site once and had already diverged by review time.
    ///
    /// - Empty stage lists are never implicitly saved: a template whose stages
    ///   all resolved to nothing (no test tooling) must not wipe the loop's
    ///   saved stages moments after Apply. Explicit Save still can.
    /// - Otherwise the same rule as always: a real config (`shouldPersist`) or
    ///   a loop that already has one — implicit saves can't lock in an
    ///   unconfirmed bare-Regression detection.
    private func isSafeToPersistImplicitly(_ loop: LoopDefinition) -> Bool {
        guard !loop.config.stages.isEmpty else { return false }
        return LoopEngineConfig.shouldPersist(loop.config.stages) || persistedLoop != nil
    }

    /// Debounced persistence of `loop` for the active project.
    ///
    /// The payload (loop + project identity) is captured in `pendingAutosave`
    /// at schedule time, and a switch to a DIFFERENT project **flushes** it —
    /// `loadConfig` (the project/loop-switch handler) writes the old loop's
    /// edits under the old project's key before touching any state.
    /// Cancelling on switch, as the first version did, would lose exactly the
    /// edit this feature exists to keep.
    private func scheduleAutosave(_ loop: LoopDefinition) {
        guard let projectId = activeProjectId else { return }
        // Baseline: what's already on disk (or the just-loaded equivalent).
        // Loading a loop fires onChange too — without this, opening the
        // page would rewrite a committed file it only read.
        guard loop != persistedLoop else { return }
        guard isSafeToPersistImplicitly(loop) else { return }
        // Defensive: a pending save for another project is flushed, never
        // replaced. loadConfig already flushes on switch, so this is normally
        // a no-op, but this method must stay safe on its own.
        if let pending = pendingAutosave, pending.projectId != projectId {
            flushPendingAutosave()
        }
        autosaveTask?.cancel()
        pendingAutosave = PendingAutosave(loop: loop, projectId: projectId,
                                          projectRoot: workspaceContext?.projectRoot)
        autosaveTask = Task {
            try? await Task.sleep(nanoseconds: 800_000_000)
            guard !Task.isCancelled else { return }
            flushPendingAutosave()
        }
    }

    /// Writes the pending autosave now, if any. Called by the debounce task on
    /// fire, by `loadConfig` before a project/loop switch overwrites state, and
    /// on `onDisappear` when the user leaves the Loop page.
    func flushPendingAutosave() {
        guard let pending = pendingAutosave else { return }
        pendingAutosave = nil
        autosaveTask?.cancel()
        autosaveTask = nil
        writeLoop(pending.loop, projectRoot: pending.projectRoot, projectId: pending.projectId)
        if pending.projectId == activeProjectId {
            persistedLoop = pending.loop
        }
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
        // Explicit save supersedes any pending autosave of older state.
        pendingAutosave = nil
        autosaveTask?.cancel()
        autosaveTask = nil
        writeLoop(currentLoop, projectRoot: workspaceContext?.projectRoot, projectId: projectId)
        persistedLoop = currentLoop
    }

    /// Writes `loop` into this project's full loop list, replacing the entry
    /// with the same id. Read-modify-write is required because
    /// `LoopEngineConfigStore` persists the WHOLE list per project, not one
    /// loop at a time.
    ///
    /// Two things this deliberately does NOT do:
    ///
    /// - **It never writes `isPrimary` from this view's state.** Primary is
    ///   assigned by `LoopEngineHomeView`, which writes the list directly;
    ///   this page's `isPrimaryLoop` is only refreshed by `loadConfig()`,
    ///   which does not re-run on a Primary reassignment (its `reloadKey`
    ///   doesn't change). Trusting the in-memory copy therefore let an
    ///   ordinary edit-after-reassignment write a stale flag back, leaving a
    ///   project with zero or two primaries — and `primaryLoop()`'s
    ///   `?? first` fallback then silently pointed the scheduled Auto Task
    ///   and the phone at a loop the user never designated. The on-disk flag
    ///   is authoritative.
    /// - **It never APPENDS.** A missing entry means the loop was deleted
    ///   (possibly moments ago, inside autosave's 800ms debounce) or that
    ///   this view still holds a previous project's `loopId` mid-switch.
    ///   Appending in either case resurrects a deleted loop or writes a
    ///   phantom one into an unrelated project's committed `loop.json`.
    ///   `LoopEngineHomeView` is the only creator of loops, and it saves
    ///   before selecting, so there is no legitimate append case left.
    private func writeLoop(_ loop: LoopDefinition, projectRoot: URL?, projectId: String) {
        guard var store = LoopEngineConfigStore.load(projectRoot: projectRoot, projectId: projectId),
              let index = store.loops.firstIndex(where: { $0.id == loop.id })
        else { return }
        var toWrite = loop
        toWrite.isPrimary = store.loops[index].isPrimary
        // Same reasoning as `isPrimary` above: the loop-list pane can toggle
        // this while this page stays mounted, so the on-disk flag wins.
        toWrite.runsOnSchedule = store.loops[index].runsOnSchedule
        store.loops[index] = toWrite
        LoopEngineConfigStore.save(store, projectRoot: projectRoot, projectId: projectId)
    }

    /// Refreshes the "past runs" list from the journal on disk. Best-effort: an
    /// absent journal is the normal state for a project that has never looped.
    private func loadPastRuns() {
        guard let root = workspaceContext?.projectRoot else {
            pastRuns = []
            return
        }
        // Read more than the display limit — a project journal interleaves
        // every loop's runs, so filtering down to this loop must not starve
        // the list.
        let recent = journal.recentRuns(root: root, limit: 60)
        pastRuns = Array(recent.filter { $0.loopId == loopId || ($0.loopId == nil && isPrimaryLoop) }.prefix(15))
        lastSummaryNoteName = Self.newestSummaryNoteName(projectRoot: root)
        refreshInspectedPastRun(projectRoot: root)
    }

    func selectPastRun(_ entry: LoopRunIndexEntry) {
        selectedPastRunId = entry.id
        guard let root = workspaceContext?.projectRoot else {
            inspectedPastRun = nil
            pastRunInspectLoadFailed = true
            return
        }
        inspectedPastRun = journal.loadRecord(id: entry.id, startedAt: entry.startedAt, root: root)
        pastRunInspectLoadFailed = inspectedPastRun == nil
    }

    func clearPastRunInspection() {
        selectedPastRunId = nil
        inspectedPastRun = nil
        pastRunInspectLoadFailed = false
    }

    /// Re-load the open inspector after a fresh run appends to the journal.
    private func refreshInspectedPastRun(projectRoot: URL) {
        guard let id = selectedPastRunId,
              let entry = pastRuns.first(where: { $0.id == id })
        else { return }
        inspectedPastRun = journal.loadRecord(id: entry.id, startedAt: entry.startedAt, root: projectRoot)
        pastRunInspectLoadFailed = inspectedPastRun == nil
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
        wallClockMinutes = LoopBudgetsEditor.minutes(fromSeconds: applied.wallClockBudgetSeconds)
        maxRepairsPerStage = applied.maxRepairsPerStage
        protectedPathPolicy = applied.protectedPathPolicy
        extraProtectedGlobs = applied.extraProtectedGlobs
        writeSummaryNote = applied.writeSummaryNote
        useWorktreesForConcurrentRuns = applied.useWorktreesForConcurrentRuns
        // Stage ids are regenerated on apply, so the old selection no longer exists.
        selectedStageId = nil
    }

    /// Replaces the current stage list and budgets with the selected template's.
    ///
    /// Persists like any other edit — via the debounced autosave (the pre-autosave
    /// design deliberately kept Apply unsaved so templates could be compared, but
    /// unsaved edits silently dying on a project switch proved the worse trap).
    /// The warning text in the TEMPLATE section says so before the click.
    func applySelectedTemplate() {
        guard let template = selectedTemplate else { return }
        // The no-tooling flag is derived from this one `applied(to:)` call —
        // a separate emptiness check would run the same LoopStageDetector
        // probing a second time for no reason.
        let applied = template.applied(to: activeGitRootURL)
        appliedTemplateHadNoTooling = !template.config.stages.isEmpty && applied.stages.isEmpty
        assignConfig(applied)
    }

    func saveCurrentAsTemplate() {
        let saved = templateStore.save(
            name: newTemplateName, summary: newTemplateSummary, config: currentConfig)
        selectedTemplateId = saved.id
        newTemplateName = ""
        newTemplateSummary = ""
    }

    /// - Parameter single: when set, run just this one stage (forced enabled)
    ///   under the current budgets — the ⋯ menu's "Run this stage only", for
    ///   debugging one stage without paying for the whole pipeline. The saved
    ///   config is still the FULL current one; the single-stage list exists
    ///   only for this run.
    @MainActor
    private func runLoop(only single: LoopStage? = nil) async {
        clearPastRunInspection()
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
        if isSafeToPersistImplicitly(currentLoop) {
            saveConfig()
        }
        var runConfig = currentConfig
        if let solo = single {
            guard let soloed = LoopStage.soloing(runConfig.stages, id: solo.id) else {
                // Refuse rather than fall through: running the WHOLE pipeline
                // when one stage was asked for is the worst possible fallback.
                // Unreachable today (solo comes from the live stages array),
                // kept fail-closed per LoopStage.soloing's contract.
                didRejectLastRun = true
                return
            }
            // "Run this stage only" — see LoopStage.soloing for why the full
            // stage list is kept with the others disabled.
            runConfig.stages = soloed
        }
        let result = await runner.run(config: runConfig, faultsRoot: context.projectRoot,
                                      gitRoot: gitRoot, projectId: projectId,
                                      loopId: loopId, loopName: loopName,
                                      goal: goal.isEmpty ? nil : goal,
                                      acceptanceCriteria: acceptanceCriteria.isEmpty ? nil : acceptanceCriteria,
                                      scopeGlobs: scopeGlobs)
        lastStatus = result
        didRejectLastRun = (result == nil)
        // The run just journalled itself; re-read so the list reflects it.
        loadPastRuns()
    }
}
