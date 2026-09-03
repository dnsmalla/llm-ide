import SwiftUI

struct AutoCodeView: View {
    /// Optional so previews / non-shell callers still construct the view; the
    /// "Model & Limits" panel degrades to a sign-in hint when nil.
    var api: LlmIdeAPIClient? = nil

    @EnvironmentObject private var autoCode: AutoCodeUpdateService
    @EnvironmentObject private var config: AppConfig
    @EnvironmentObject private var theme: ThemeStore
    @EnvironmentObject private var logStore: TaskLogStore
    @EnvironmentObject private var autoTaskSettings: AutoTaskSettings
    @EnvironmentObject private var autoTaskTemplates: AutoTaskTemplateStore
    @EnvironmentObject private var autoTaskSkills: AutoTaskSkillCatalog
    @EnvironmentObject private var projectStore: ProjectStore
    @Environment(ShellState.self) private var shell

    @State private var selectedTask: AutoTask? = .reviewCode
    @State private var taskToReset: AutoTask? = nil
    /// When true the right pane shows the usage-limits panel instead of a task.
    @State private var showModelLimits = false
    /// Whether the "Effective prompt" card is expanded. Collapsed by default —
    /// it is the answer to "what will this actually send", not something to
    /// read on every visit.
    @State private var showEffectivePrompt = false
    @State private var customTasks: [CustomAutoTask] = []
    @State private var showingAddCustomTask = false
    @State private var selectedCustomTaskId: String? = nil
    @State private var customTaskPendingDelete: CustomAutoTask? = nil

    /// Derived live from `customTasks` instead of stored as a snapshot — a
    /// stored `CustomAutoTask?` would go stale the moment another mutation
    /// (e.g. the enable toggle) reloads `customTasks`, silently re-saving
    /// the stale copy's fields on the next edit.
    private var selectedCustomTask: CustomAutoTask? {
        customTasks.first(where: { $0.id == selectedCustomTaskId })
    }

    var body: some View {
        // Fixed-width left column — HSplitView overrides a child's width
        // frame, so pin it outside the split to keep it minimal.
        HStack(spacing: 0) {
            leftPane
                .frame(width: 280)
            Divider()
            rightPane
                .frame(minWidth: 300, maxWidth: .infinity)
        }
        .background(theme.current.body)
        .onChange(of: autoCode.currentTask) { _, new in
            // During a global Run Now the orchestrator advances currentTask
            // task-by-task; follow it so the user watches each log fill.
            // Per-task ▶ Run leaves currentTask == the viewed task (no jump).
            if let new {
                selectedTask = new
                showModelLimits = false
                selectedCustomTaskId = nil
            }
        }
        .onAppear {
            customTasks = CustomAutoTask.loadAll()
            autoCode.loadRunHistoryForDisplay()
        }
        .onReceive(NotificationCenter.default.publisher(for: .customAutoTasksChanged)) { _ in
            customTasks = CustomAutoTask.loadAll()
        }
        .onChange(of: autoCode.currentCustomTaskId) { _, newId in
            // Mirrors the built-in onChange above: during a custom task's
            // run, jump the right pane to follow it.
            if let newId, customTasks.contains(where: { $0.id == newId }) {
                selectedCustomTaskId = newId
                selectedTask = nil
                showModelLimits = false
            }
        }
    }

    // MARK: - Left pane

    private var leftPane: some View {
        VStack(spacing: 0) {
            // Enable toggle header
            HStack {
                // Bound to the shared AutoTaskSettings (single source of truth)
                // so this stays live with the Menu bar + Settings. Arming the
                // scheduler is the service's job — it observes `enabled`.
                Toggle("", isOn: $autoTaskSettings.enabled)
                .toggleStyle(.switch)
                .labelsHidden()

                Text(autoTaskSettings.enabled ? "Enabled" : "Disabled")
                    .font(Typography.body.weight(.semibold))
                    .foregroundStyle(autoTaskSettings.enabled
                        ? theme.current.accent : theme.current.textMuted)

                Spacer()

                if autoCode.isRunning {
                    ProgressView().controlSize(.mini)
                }

                Button { showingAddCustomTask = true } label: {
                    Image(systemName: "plus.circle")
                }
                .buttonStyle(.borderless)
                .help("Add Custom Task")

                if FeatureCatalog.isMobileCompiled {
                    Button { FeatureCatalog.refreshAutoTaskStateForMobile() } label: {
                        Image(systemName: "arrow.triangle.2.circlepath")
                    }
                    .buttonStyle(.borderless)
                    .help("Push current state to a paired iPhone now")
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(theme.current.surface)

            // Absorbed from the deleted Settings → Auto Tasks shortcut
            // section — this was the only place that warned the user
            // Auto Tasks can't run without a linked repo + token; without
            // it here, a misconfigured setup would just silently no-op.
            // hasResolvableBackend is side-effect-free (safe to read from
            // a view body) — see its doc comment in AutoCodeUpdateService.
            if !autoCode.hasResolvableBackend {
                VStack(alignment: .leading, spacing: 6) {
                    Text("No linked repository detected. Auto Tasks need an active GitLab or GitHub project with a local clone path and a matching access token.")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                    Button("Open Settings") {
                        shell.section = .settings
                    }
                    .font(Typography.caption)
                    .buttonStyle(.borderless)
                    .foregroundStyle(theme.current.accent)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(theme.current.surface)
            }

            // Filter — when on, off-task rows (and empty category headers)
            // are hidden so the page focuses on the active set. Toggle off
            // to see and re-enable every task.
            Toggle(isOn: $autoTaskSettings.showOnlyEnabledTasks) {
                Text("Show only enabled")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
            }
            .toggleStyle(.switch)
            .controlSize(.small)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(theme.current.surface)

            Divider()

            // Task rows, organized by category. When "Show only enabled" is on,
            // off-task rows are filtered out and empty category headers hidden.
            VStack(spacing: 0) {
                if visibleTasks.isEmpty {
                    Text("No enabled tasks — turn off \"Show only enabled\" to manage all tasks.")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    ForEach(Self.taskGroups) { group in
                        let visible = group.tasks.filter { isTaskVisible($0) }
                        if !visible.isEmpty {
                            taskCategoryHeader(group.title)
                            ForEach(visible, id: \.self) { task in
                                taskRow(task, label: task.label, icon: task.icon,
                                        enabled: taskEnabledBinding(task))
                            }
                        }
                    }
                    let visibleCustom = customTasks.filter { !autoTaskSettings.showOnlyEnabledTasks || $0.isEnabled }
                    if !visibleCustom.isEmpty {
                        taskCategoryHeader("Custom Tasks")
                        ForEach(visibleCustom) { task in
                            customTaskRow(task)
                        }
                    }
                }
            }
            .padding(.vertical, 4)

            Divider()

            // Config surface (not a runnable task) — usage limits + auto-fallback.
            modelLimitsRow

            Divider()

            // Recent Auto Task executions
            Text("Recent runs")
                .font(Typography.section)
                .foregroundStyle(theme.current.textMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .padding(.top, 8)
                .padding(.bottom, 4)

            if autoCode.runHistoryEntries.isEmpty {
                Text("No runs recorded yet. Use Run Now or ▶ on a task.")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(autoCode.runHistoryEntries) { record in
                            runHistoryRow(record)
                        }
                    }
                }
                .frame(maxHeight: 140)
            }

            Divider()

            // Meeting action-item pipeline (Sources → Implement)
            Text("Action items")
                .font(Typography.section)
                .foregroundStyle(theme.current.textMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .padding(.top, 8)
                .padding(.bottom, 4)

            if autoCode.allEntries.isEmpty {
                Text("No action items yet. Run Sources → Issue or record a meeting with action items.")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(autoCode.allEntries, id: \.actionId) { entry in
                            historyRow(entry)
                        }
                    }
                }
                .frame(maxHeight: 120)
            }

            Spacer(minLength: 0)

            if let error = autoCode.lastError {
                StatusBanner(severity: .error, message: error, onDismiss: { autoCode.dismissLastError() })
                    .padding(.horizontal, 12)
                    .padding(.vertical, 4)
            }

            Divider()

            // Run Now / Stop
            HStack(spacing: 8) {
                Button {
                    autoCode.runNow()
                } label: {
                    Label(autoCode.isRunning ? (autoCode.currentStep ?? "Running…") : "Run Now",
                          systemImage: autoCode.isRunning ? "ellipsis.circle" : "play.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(autoCode.isRunning)
                .controlSize(.regular)

                if autoCode.isRunning {
                    Button {
                        autoCode.cancel()
                    } label: {
                        Label("Stop", systemImage: "stop.fill")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.regular)
                }
            }
            .padding(12)
        }
        .background(theme.current.surface)
    }

    // MARK: - Task filtering

    /// Category groupings shown in the left pane (order = display order).
    private struct TaskGroup: Identifiable {
        let id: String
        let title: String
        let tasks: [AutoTask]
    }
    private static let taskGroups: [TaskGroup] = [
        .init(id: "pipeline", title: "Pipeline Tasks",
              tasks: [.sourceUpdate, .sourcesToIssue, .implementIssues, .reviewMerge]),
        .init(id: "review", title: "Review Tasks",
              tasks: [.reviewCode, .reviewDoc, .reviewConflicts]),
        .init(id: "automation", title: "Automation Tasks",
              tasks: [.updateIssues, .updatePlanStatus, .generateDoc]),
        .init(id: "maintenance", title: "Maintenance Tasks",
              tasks: [.regression, .generateKnowledge]),
    ]

    /// A task is visible unless the filter is on AND the task is disabled.
    private func isTaskVisible(_ task: AutoTask) -> Bool {
        !autoTaskSettings.showOnlyEnabledTasks || autoTaskSettings.isEnabled(task: task)
    }

    /// All tasks that pass the current filter (drives the empty-state check).
    private var visibleTasks: [AutoTask] {
        AutoTask.allCases.filter { isTaskVisible($0) }
    }

    /// Generic per-task enable binding, routed through AutoTaskSettings so a
    /// toggle flips the right `run*` flag (and persists) exactly like the old
    /// hand-written `$autoTaskSettings.runX` bindings did.
    private func taskEnabledBinding(_ task: AutoTask) -> Binding<Bool> {
        Binding(
            get: { autoTaskSettings.isEnabled(task: task) },
            set: { autoTaskSettings.setEnabled($0, task: task) }
        )
    }

    /// Every custom-task mutation (add/toggle/delete) goes through here:
    /// persist, reload the in-memory list so the UI reflects it immediately,
    /// then push the change to a paired iPhone. Built-in tasks push
    /// automatically via Combine observers on autoCode/autoTaskSettings;
    /// CustomAutoTask is a plain struct with no such observation, so this
    /// explicit push is the real mechanism for it (the "Refresh" button
    /// calls the same underlying method for a manual, visible re-sync).
    private func persistCustomTasksChange() {
        customTasks = CustomAutoTask.loadAll()
        FeatureCatalog.refreshAutoTaskStateForMobile()
    }

    @ViewBuilder
    private func taskRow(_ task: AutoTask, label: String, icon: String,
                         enabled: Binding<Bool>) -> some View {
        HStack(spacing: 10) {
            Toggle("", isOn: enabled)
                .toggleStyle(.checkbox)
                .labelsHidden()

            Label(label, systemImage: icon)
                .font(Typography.body)
                .foregroundStyle(enabled.wrappedValue ? theme.current.text : theme.current.textMuted)

            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(selectedTask == task
            ? theme.current.accent.opacity(0.12)
            : Color.clear)
        .contentShape(Rectangle())
        .onTapGesture { selectedTask = task; showModelLimits = false; selectedCustomTaskId = nil }
        .overlay(alignment: .leading) {
            if selectedTask == task && !showModelLimits {
                Rectangle()
                    .fill(theme.current.accent)
                    .frame(width: 3)
            }
        }
    }

    @ViewBuilder
    private func customTaskRow(_ task: CustomAutoTask) -> some View {
        HStack(spacing: 10) {
            Toggle("", isOn: Binding(
                get: { task.isEnabled },
                set: { newValue in
                    var updated = task
                    updated.isEnabled = newValue
                    updated.save()
                    persistCustomTasksChange()
                }
            ))
            .toggleStyle(.checkbox)
            .labelsHidden()

            Label(task.name, systemImage: "sparkles")
                .font(Typography.body)
                .foregroundStyle(task.isEnabled ? theme.current.text : theme.current.textMuted)

            if task.mode == .implement {
                Text("Implement")
                    .font(.caption2)
                    .foregroundStyle(theme.current.accent3)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(theme.current.accent3.opacity(0.12))
                    .clipShape(Capsule())
            }
            if task.cron != nil {
                Image(systemName: "clock")
                    .font(.caption2)
                    .foregroundStyle(theme.current.textMuted)
                    .help(task.cron ?? "")
            }

            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(selectedCustomTaskId == task.id
            ? theme.current.accent.opacity(0.12)
            : Color.clear)
        .contentShape(Rectangle())
        .onTapGesture { selectedCustomTaskId = task.id; selectedTask = nil; showModelLimits = false }
        .overlay(alignment: .leading) {
            if selectedCustomTaskId == task.id {
                Rectangle().fill(theme.current.accent).frame(width: 3)
            }
        }
        .contextMenu {
            Button("Delete", role: .destructive) { customTaskPendingDelete = task }
                .disabled(autoCode.currentCustomTaskId == task.id)
        }
    }

    @ViewBuilder
    private func taskCategoryHeader(_ title: String) -> some View {
        HStack(spacing: 0) {
            Text(title.uppercased())
                .font(Typography.section)
                .foregroundStyle(theme.current.textMuted)
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(theme.current.body)
    }

    private var modelLimitsRow: some View {
        HStack(spacing: 10) {
            Label("Model & Limits", systemImage: "gauge.with.dots.needle.67percent")
                .font(Typography.body)
                .foregroundStyle(showModelLimits ? theme.current.text : theme.current.textMuted)
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(showModelLimits ? theme.current.accent.opacity(0.12) : Color.clear)
        .contentShape(Rectangle())
        .onTapGesture { showModelLimits = true; selectedTask = nil; selectedCustomTaskId = nil }
        .overlay(alignment: .leading) {
            if showModelLimits {
                Rectangle().fill(theme.current.accent).frame(width: 3)
            }
        }
    }

    private func historyRow(_ entry: ProcessedActionsRegistry.RegistryEntry) -> some View {
        HStack(spacing: 8) {
            statusIcon(entry.status).frame(width: 14)
            Text(entry.actionText)
                .font(Typography.caption)
                .foregroundStyle(theme.current.text)
                .lineLimit(1)
            Spacer(minLength: 4)
            Text(entry.lastUpdated, style: .relative)
                .font(Typography.caption)
                .foregroundStyle(theme.current.textMuted)
                .lineLimit(1)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 5)
    }

    private func runHistoryRow(_ record: AutoTaskRunRecord) -> some View {
        Button {
            if let name = record.logFileName {
                autoCode.revealLogFile(named: name)
            }
        } label: {
            HStack(spacing: 8) {
                runStatusIcon(record.status).frame(width: 14)
                VStack(alignment: .leading, spacing: 1) {
                    Text(record.taskLabel)
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.text)
                        .lineLimit(1)
                    Text("\(record.trigger.rawValue) · \(Int(record.finishedAt.timeIntervalSince(record.startedAt)))s")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(theme.current.textMuted)
                }
                Spacer(minLength: 4)
                Text(record.finishedAt, style: .relative)
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .lineLimit(1)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(record.logFileName != nil ? "Reveal log in Finder" : record.summary ?? "")
    }

    private func runStatusIcon(_ status: AutoTaskRunStatus) -> some View {
        let t = theme.current
        let (symbol, color): (String, Color) = switch status {
        case .success:   ("checkmark.circle.fill", t.success)
        case .failed:    ("xmark.circle.fill", t.danger)
        case .cancelled: ("stop.circle.fill", t.warning)
        case .skipped:   ("minus.circle.fill", t.textMuted)
        }
        return Image(systemName: symbol).foregroundStyle(color).font(.system(size: 11))
    }

    // MARK: - Right pane

    private var rightPane: some View {
        Group {
            if showModelLimits {
                ModelLimitsPanel(api: api)
            } else if let task = selectedTask {
                templateEditor(task)
            } else if let custom = selectedCustomTask {
                customTaskEditor(custom)
            } else {
                VStack(spacing: 12) {
                    Image(systemName: "arrow.triangle.2.circlepath.circle")
                        .font(.system(size: 36))
                        .foregroundStyle(theme.current.textMuted)
                    Text("Select a review task from the left to edit its AI prompt.")
                        .font(Typography.body)
                        .foregroundStyle(theme.current.textMuted)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(theme.current.body)
            }
        }
        .sheet(isPresented: $showingAddCustomTask) {
            AddCustomAutoTaskSheet(
                onConfirm: { name, template, mode, cron in
                    let task = CustomAutoTask(name: name, template: template, mode: mode, cron: cron)
                    task.save()
                    if cron != nil {
                        autoCode.realignCustomNextFire(for: task, now: Date())
                    }
                    persistCustomTasksChange()
                    selectedCustomTaskId = task.id
                    selectedTask = nil
                    showModelLimits = false
                    showingAddCustomTask = false
                },
                onCancel: { showingAddCustomTask = false }
            )
        }
        .confirmationDialog(
            customTaskPendingDelete.map { "Delete \"\($0.name)\"?" } ?? "",
            isPresented: Binding(
                get: { customTaskPendingDelete != nil },
                set: { if !$0 { customTaskPendingDelete = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                // Guard here too, not just on the two entry points' buttons —
                // this is the one place both the row context-menu and the
                // detail-pane Delete button funnel into, so it's the single
                // spot that can't be bypassed. A currently-running task
                // can't be deleted out from under its in-flight CLI process.
                if let task = customTaskPendingDelete, autoCode.currentCustomTaskId != task.id {
                    task.delete()
                    logStore.clear(task.id)
                    // Its input/output/skill/template settings are keyed by
                    // this id and nothing can reach them again.
                    autoCode.taskConfigs.remove(taskId: task.id)
                    persistCustomTasksChange()
                    if selectedCustomTaskId == task.id { selectedCustomTaskId = nil }
                }
                customTaskPendingDelete = nil
            }
            Button("Cancel", role: .cancel) { customTaskPendingDelete = nil }
        }
    }

    @ViewBuilder
    private func templateEditor(_ task: AutoTask) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack(spacing: 10) {
                Image(systemName: task.icon)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(theme.current.accent)
                Text(task.label)
                    .font(Typography.title)
                    .foregroundStyle(theme.current.text)
                Spacer()
                Button { autoCode.runSingle(task) } label: {
                    Label(autoCode.currentTask == task
                          ? (autoCode.currentStep ?? "Running…")
                          : "Run",
                          systemImage: autoCode.currentTask == task ? "ellipsis.circle" : "play.fill")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(autoCode.isRunning)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 14)
            .background(theme.current.surface)

            // Per-task cron schedule + next-fire, bound to this task. Lives in
            // the header block so each task's editor shows its own schedule next
            // to the Run button (the page's `autoTaskSettings` is the source).
            CronField(task: task, settings: autoTaskSettings)
                .padding(.horizontal, 20)
                .padding(.vertical, 8)
                .background(theme.current.surface)

            Divider()

            // Settings + Template for prompt tasks; the About doc and its
            // knobs for structural ones (which run no prompt, so an input path
            // or a template would be a control that does nothing).
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let ownPrompt = task.templateBinding(config: config) {
                        AutoTaskSettingsSection(taskId: task.rawValue,
                                                configs: autoCode.taskConfigs,
                                                skills: autoTaskSkills,
                                                projectRoot: activeProjectRoot,
                                                writesFiles: false)
                        AutoTaskTemplateSection(taskId: task.rawValue,
                                                ownPrompt: ownPrompt,
                                                ownPromptLabel: "Built-in prompt",
                                                onRestoreDefault: { taskToReset = task },
                                                configs: autoCode.taskConfigs,
                                                templates: autoTaskTemplates)
                        // Every built-in prompt task runs read-only — runCLI
                        // reverts the tree afterwards — so the preview must
                        // show the read-only wording the run will really use.
                        effectivePromptSection(taskId: task.rawValue,
                                               ownPrompt: ownPrompt.wrappedValue,
                                               writesFiles: false)
                    } else {
                        aboutSection(task)
                        structuralConfigSection(task)
                    }
                }
                .padding(20)
            }

            if let error = autoCode.taskErrors[task.rawValue] {
                StatusBanner(severity: .error, message: error, onDismiss: { autoCode.dismissTaskError(for: task) })
                    .padding(.horizontal, 12)
                    .padding(.vertical, 4)
            }

            // Live, scrollable per-task log (accumulates across runs).
            logSection(task)

            // Last run status
            if let last = autoCode.lastRunDate {
                Divider()
                Text("Last run \(last, style: .relative) ago · \(autoCode.statusMessage)")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 8)
                    .background(theme.current.surface)
            }
        }
        .background(theme.current.body)
        .confirmationDialog(
            "Reset \"\(task.label)\" template to default?",
            isPresented: Binding(
                get: { taskToReset == task },
                set: { if !$0 { taskToReset = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Reset to Default", role: .destructive) {
                task.resetTemplate(config: config)
                taskToReset = nil
            }
            Button("Cancel", role: .cancel) {
                taskToReset = nil
            }
        } message: {
            Text("Your custom prompt will be permanently replaced.")
        }
    }

    @ViewBuilder
    private func customTaskEditor(_ task: CustomAutoTask) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "sparkles")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(theme.current.accent)
                Text(task.name)
                    .font(Typography.title)
                    .foregroundStyle(theme.current.text)
                Spacer()
                Button { _ = autoCode.runSingleCustom(task) } label: {
                    Label(autoCode.currentCustomTaskId == task.id
                          ? (autoCode.currentStep ?? "Running…")
                          : "Run",
                          systemImage: autoCode.currentCustomTaskId == task.id ? "ellipsis.circle" : "play.fill")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(autoCode.isRunning)
                Button("Delete", role: .destructive) { customTaskPendingDelete = task }
                    .buttonStyle(.borderless)
                    .font(Typography.caption)
                    .disabled(autoCode.currentCustomTaskId == task.id)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 14)
            .background(theme.current.surface)

            CustomTaskScheduleSection(task: task, autoCode: autoCode, settings: autoTaskSettings) {
                persistCustomTasksChange()
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 8)
            .background(theme.current.surface)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    AutoTaskSettingsSection(taskId: task.id,
                                            configs: autoCode.taskConfigs,
                                            skills: autoTaskSkills,
                                            projectRoot: activeProjectRoot,
                                            writesFiles: task.mode == .implement)
                    AutoTaskTemplateSection(taskId: task.id,
                                            ownPrompt: Binding(
                                                get: { task.template },
                                                set: { newValue in
                                                    var updated = task
                                                    updated.template = newValue
                                                    updated.save()
                                                    customTasks = CustomAutoTask.loadAll()
                                                }
                                            ),
                                            ownPromptLabel: "This task's prompt",
                                            configs: autoCode.taskConfigs,
                                            templates: autoTaskTemplates)
                    effectivePromptSection(taskId: task.id, ownPrompt: task.template,
                                           writesFiles: task.mode == .implement)
                }
                .padding(20)
            }

            if let error = autoCode.taskErrors[task.id] {
                StatusBanner(severity: .error, message: error, onDismiss: { autoCode.dismissTaskError(forId: task.id) })
                    .padding(.horizontal, 12)
                    .padding(.vertical, 4)
            }

            customTaskLogSection(task.id)

            if let last = autoCode.lastRunDate {
                Divider()
                Text("Last run \(last, style: .relative) ago · \(autoCode.statusMessage)")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 8)
                    .background(theme.current.surface)
            }
        }
        .background(theme.current.body)
    }

    /// Live, scrollable log for a custom task — same layout as `logSection`
    /// but keyed by the task's string id via the TaskLogStore string overload.
    @ViewBuilder
    private func customTaskLogSection(_ id: String) -> some View {
        let lines = logStore.lines(for: id)
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Log · live")
                    .font(Typography.section)
                    .foregroundStyle(theme.current.textMuted)
                Spacer()
                Button { logStore.clear(id) } label: {
                    Label("Clear", systemImage: "trash")
                }
                .buttonStyle(.borderless)
                .foregroundStyle(theme.current.textMuted)
                .font(Typography.caption)
                .disabled(lines.isEmpty)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 6)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    ForEach(lines) { line in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(line.timestamp, format: .dateTime.hour().minute().second())
                                .font(Typography.caption)
                                .foregroundStyle(theme.current.textMuted)
                            Text(line.text)
                                .font(Typography.mono)
                                .foregroundStyle(line.level == .error ? theme.current.danger : theme.current.text)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(.horizontal, 8)
                    }
                }
                .padding(8)
            }
            .frame(maxHeight: 320)
            .background(theme.current.surface)
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(theme.current.border, lineWidth: 1))
            .cornerRadius(6)
            .padding(.horizontal, 16)
            .padding(.bottom, 12)
        }
    }

    /// The active project's root, which the Settings pickers resolve their
    /// relative paths against. nil when no project is open — the pickers then
    /// disable rather than storing paths with nothing to be relative to.
    private var activeProjectRoot: URL? {
        projectStore.activeProject.map { URL(fileURLWithPath: $0.localPath) }
    }

    /// Static "what this task does" doc for a structural task.
    @ViewBuilder
    private func aboutSection(_ task: AutoTask) -> some View {
        AutoTaskSectionCard("About", systemImage: "info.circle") {
            MarkdownPreview(markdown: aboutMarkdown(for: task))
                .frame(maxWidth: .infinity)
        }
    }

    /// Exactly what the CLI will receive — the selected template (or the task's
    /// own prompt) with the skill directive and resolved paths folded in.
    ///
    /// Composed by the same `composedPrompt` the runner calls, so this is the
    /// real thing rather than a re-implementation that can drift from it. It is
    /// the only place the interaction between the Settings and Template cards
    /// becomes visible before a run.
    @ViewBuilder
    private func effectivePromptSection(taskId: String, ownPrompt: String,
                                        writesFiles: Bool) -> some View {
        AutoTaskSectionCard("Effective prompt", systemImage: "text.viewfinder",
                            accessory: AnyView(
                                Button(showEffectivePrompt ? "Hide" : "Show") {
                                    showEffectivePrompt.toggle()
                                }
                                .buttonStyle(.borderless)
                                .font(Typography.caption)
                            )) {
            if showEffectivePrompt {
                ScrollView {
                    Text(autoCode.composedPrompt(taskId: taskId, ownPrompt: ownPrompt,
                                                 projectRoot: activeProjectRoot?.path,
                                                 writesFiles: writesFiles))
                        .font(Typography.mono)
                        .foregroundStyle(theme.current.text)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                }
                .frame(maxHeight: 220)
                .background(theme.current.body)
                .overlay(RoundedRectangle(cornerRadius: Radius.sm)
                    .strokeBorder(theme.current.border, lineWidth: 1))
                .clipShape(RoundedRectangle(cornerRadius: Radius.sm))
            } else {
                Text("What this task will send to the CLI, with the skill and paths above applied.")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// Live, scrollable per-task log with a Clear button.
    @ViewBuilder
    private func logSection(_ task: AutoTask) -> some View {
        let lines = logStore.lines(for: task)
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Log · live")
                    .font(Typography.section)
                    .foregroundStyle(theme.current.textMuted)
                Spacer()
                Button { logStore.clear(task) } label: {
                    Label("Clear", systemImage: "trash")
                }
                .buttonStyle(.borderless)
                .foregroundStyle(theme.current.textMuted)
                .font(Typography.caption)
                .disabled(lines.isEmpty)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 6)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    ForEach(lines) { line in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(line.timestamp, format: .dateTime.hour().minute().second())
                                .font(Typography.caption)
                                .foregroundStyle(theme.current.textMuted)
                            Text(line.text)
                                .font(Typography.mono)
                                .foregroundStyle(line.level == .error ? theme.current.danger : theme.current.text)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(.horizontal, 8)
                    }
                }
                .padding(8)
            }
            .frame(maxHeight: 320)
            .background(theme.current.surface)
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(theme.current.border, lineWidth: 1))
            .cornerRadius(6)
            .padding(.horizontal, 16)
            .padding(.bottom, 12)
        }
    }

    // MARK: - Helpers

    @ViewBuilder
    private func statusIcon(_ status: ProcessedActionsRegistry.EntryStatus) -> some View {
        switch status {
        case .pending:
            Image(systemName: "circle.dotted")
                .foregroundStyle(theme.current.textMuted)
                .accessibilityLabel("Pending")
        case .implementing:
            ProgressView()
                .controlSize(.mini)
                .accessibilityLabel("Implementing")
        case .done:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(theme.current.success)
                .accessibilityLabel("Done")
        case .failed:
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(theme.current.danger)
                .accessibilityLabel("Failed")
        }
    }

}

// AutoTask enum moved to Models/AutoCode/AutoTask.swift.

/// Wraps `SelfSizingMarkdownView`, capturing its reported content height into
/// `@State` so the preview sizes to its rendered markdown inside the page's
/// `ScrollView`.
private struct MarkdownPreview: View {
    let markdown: String
    @EnvironmentObject private var theme: ThemeStore
    @State private var height: CGFloat = 1

    var body: some View {
        SelfSizingMarkdownView(markdown: markdown, isDark: theme.current.isDark) { h in
            if abs(h - height) > 1 { height = h }
        }
        .frame(height: max(height, 1))
    }
}

private extension AutoCodeView {
    /// Static markdown shown as the "preview" for structural (non-template) tasks.
    func aboutMarkdown(for task: AutoTask) -> String {
        switch task {
        case .sourceUpdate:
            return """
            # Source Update

            Fetches configured email and Slack sources into the meeting library and
            re-indexes notes. Requires a project open (for the notes folder + indexer).
            Configure sources under Settings → Connections.
            """
        case .sourcesToIssue:
            return """
            # Sources → Issue

            Scans recent meeting notes (lookback window from schedule settings), extracts
            action items, and creates upstream GitHub/GitLab issues. Requires Create issue
            in the repo allow-list.
            """
        case .implementIssues:
            return """
            # Implement Issues

            Runs the CLI against pending entries in the processed-actions registry — typically
            local `fix/*` branches. Requires Create branch and Auto-commit in the
            repo allow-list.
            """
        case .reviewMerge:
            return """
            # Review & Merge

            Pushes local `fix/*` branches and opens MR/PRs for human review. Never auto-merges.
            Requires Push and Create PR/MR in the repo allow-list. Issue comments
            (when enabled) require Comment on issue.
            """
        case .regression:
            return """
            # Regression

            Re-asks every `status: fixed` fault report under `<repo>/system/faults/` and
            flips any that come back with a different answer to `status: open`.

            Prompts come from the saved fault reports, so there's no prompt template to edit.
            Configure the sweep behavior below.
            """
        case .generateKnowledge:
            return """
            # Knowledge

            Surfaces the current state of the auto-generated code graph + agent memory.
            Generation itself is automatic (on open/edit); this task only reports what's there.
            """
        case .updatePlanStatus:
            return """
            # Update Plan Status

            Polls external outcome trackers (GitHub/GitLab/Linear/Backlog) for dispatched
            plan tasks and updates their local status. Requires provider credentials.
            """
        default:
            return ""
        }
    }

    /// Config controls for structural tasks. Today only Regression has knobs;
    /// the other two render an "about" hint only.
    @ViewBuilder
    func structuralConfigSection(_ task: AutoTask) -> some View {
        switch task {
        case .regression:
            VStack(alignment: .leading, spacing: 8) {
                Text("Configuration")
                    .font(Typography.section)
                    .foregroundStyle(theme.current.textMuted)
                Toggle(isOn: $autoTaskSettings.regressionAttemptRepair) {
                    Label("Attempt repair on regression", systemImage: "wrench.and.screwdriver")
                }.toggleStyle(.checkbox)
                Toggle(isOn: $autoTaskSettings.regressionAutoReopen) {
                    Label("Auto-reopen regressed faults", systemImage: "arrow.uturn.backward")
                }.toggleStyle(.checkbox)
                HStack {
                    Image(systemName: "timer").font(.system(size: 12))
                    Text("Verify timeout (s)").font(Typography.caption)
                    Spacer()
                    TextField("120", value: $autoTaskSettings.regressionVerifyTimeout, format: .number)
                        .frame(width: 60).textFieldStyle(.roundedBorder)
                }
            }
        case .generateKnowledge, .updatePlanStatus,
             .sourceUpdate, .sourcesToIssue, .implementIssues, .reviewMerge:
            Text("Nothing to configure — see the description above.")
                .font(Typography.caption)
                .foregroundStyle(theme.current.textMuted)
        default:
            EmptyView()
        }
    }
}
