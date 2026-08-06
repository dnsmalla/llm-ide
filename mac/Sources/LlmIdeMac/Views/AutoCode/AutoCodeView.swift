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
    @Environment(ShellState.self) private var shell

    @State private var selectedTask: AutoTask? = .reviewCode
    @State private var taskToReset: AutoTask? = nil
    /// When true the right pane shows the usage-limits panel instead of a task.
    @State private var showModelLimits = false
    private enum EditPreviewMode { case edit, preview }
    /// Which pane the per-task page shows for prompt tasks. Default Edit.
    @State private var editPreview: EditPreviewMode = .edit
    @State private var customTasks: [CustomAutoTask] = []
    @State private var showingAddCustomTask = false
    @State private var selectedCustomTask: CustomAutoTask? = nil
    @State private var customTaskPendingDelete: CustomAutoTask? = nil
    @Environment(MobileControlManager.self) private var mobileControl

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
            }
        }
        .onAppear { customTasks = CustomAutoTask.loadAll() }
        .onChange(of: autoCode.currentCustomTaskId) { _, newId in
            // Mirrors the built-in onChange above: during a custom task's
            // run, jump the right pane to follow it.
            if let newId, let task = customTasks.first(where: { $0.id == newId }) {
                selectedCustomTask = task
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

                Button { mobileControl.refreshAutoTaskStateForMobile() } label: {
                    Image(systemName: "arrow.triangle.2.circlepath")
                }
                .buttonStyle(.borderless)
                .help("Push current state to a paired iPhone now")
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

            // Run history
            Text("History")
                .font(Typography.section)
                .foregroundStyle(theme.current.textMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .padding(.top, 8)
                .padding(.bottom, 4)

            if autoCode.allEntries.isEmpty {
                Text("No actions found yet. Run Auto Tasks or record a meeting with action items.")
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
        mobileControl.refreshAutoTaskStateForMobile()
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
        .onTapGesture { selectedTask = task; showModelLimits = false }
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

            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(selectedCustomTask?.id == task.id
            ? theme.current.accent.opacity(0.12)
            : Color.clear)
        .contentShape(Rectangle())
        .onTapGesture { selectedCustomTask = task; selectedTask = nil; showModelLimits = false }
        .overlay(alignment: .leading) {
            if selectedCustomTask?.id == task.id {
                Rectangle().fill(theme.current.accent).frame(width: 3)
            }
        }
        .contextMenu {
            Button("Delete", role: .destructive) { customTaskPendingDelete = task }
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
        .onTapGesture { showModelLimits = true; selectedTask = nil }
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
                onConfirm: { name, template in
                    let task = CustomAutoTask(name: name, template: template)
                    task.save()
                    persistCustomTasksChange()
                    selectedCustomTask = task
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
                if let task = customTaskPendingDelete {
                    task.delete()
                    persistCustomTasksChange()
                    if selectedCustomTask?.id == task.id { selectedCustomTask = nil }
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
                if task.templateBinding(config: config) != nil {
                    Button("Restore Default") {
                        taskToReset = task
                    }
                    .buttonStyle(.borderless)
                    .foregroundStyle(theme.current.textMuted)
                    .font(Typography.caption)
                }
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

            // Edit | Preview toggle (prompt tasks), or structural config.
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let template = task.templateBinding(config: config) {
                        Picker("", selection: $editPreview) {
                            Text("Edit").tag(EditPreviewMode.edit)
                            Text("Preview").tag(EditPreviewMode.preview)
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        if editPreview == .edit {
                            editSection(template: template)
                        } else {
                            previewSection(task)
                        }
                    } else {
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

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Edit template")
                        .font(Typography.section)
                        .foregroundStyle(theme.current.textMuted)
                    TextEditor(text: Binding(
                        get: { task.template },
                        set: { newValue in
                            var updated = task
                            updated.template = newValue
                            updated.save()
                            customTasks = CustomAutoTask.loadAll()
                            if selectedCustomTask?.id == task.id { selectedCustomTask = updated }
                        }
                    ))
                    .font(Typography.mono)
                    .foregroundStyle(theme.current.text)
                    .scrollContentBackground(.hidden)
                    .background(theme.current.surface)
                    .frame(minHeight: 180)
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(theme.current.border, lineWidth: 1))
                    .cornerRadius(6)
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

    @ViewBuilder
    private func previewSection(_ task: AutoTask) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Preview")
                .font(Typography.section)
                .foregroundStyle(theme.current.textMuted)
            MarkdownPreview(markdown: previewMarkdown(for: task))
                .frame(maxWidth: .infinity)
                .background(theme.current.surface)
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(theme.current.border, lineWidth: 1))
                .cornerRadius(6)
        }
    }

    /// Markdown shown in the preview: the editable template for prompt tasks,
    /// a static About doc for structural tasks.
    private func previewMarkdown(for task: AutoTask) -> String {
        task.templateBinding(config: config)?.wrappedValue ?? aboutMarkdown(for: task)
    }

    @ViewBuilder
    private func editSection(template: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Edit template")
                .font(Typography.section)
                .foregroundStyle(theme.current.textMuted)
            TextEditor(text: template)
                .font(Typography.mono)
                .foregroundStyle(theme.current.text)
                .scrollContentBackground(.hidden)
                .background(theme.current.surface)
                .frame(minHeight: 180)
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(theme.current.border, lineWidth: 1))
                .cornerRadius(6)
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
