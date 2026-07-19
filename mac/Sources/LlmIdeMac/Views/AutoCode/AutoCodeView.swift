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

    @State private var selectedTask: AutoTask? = .reviewCode
    @State private var taskToReset: AutoTask? = nil
    /// When true the right pane shows the usage-limits panel instead of a task.
    @State private var showModelLimits = false
    private enum EditPreviewMode { case edit, preview }
    /// Which pane the per-task page shows for prompt tasks. Default Edit.
    @State private var editPreview: EditPreviewMode = .edit

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
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(theme.current.surface)

            Divider()

            // Task type rows - organized by category
            VStack(spacing: 0) {
                // Review Tasks
                taskCategoryHeader("Review Tasks")
                taskRow(.reviewCode,      label: "Review Code",      icon: "checkmark.shield",
                        enabled: $autoTaskSettings.runReviewCode)
                taskRow(.reviewDoc,       label: "Review Doc",       icon: "doc.text.magnifyingglass",
                        enabled: $autoTaskSettings.runReviewDoc)
                taskRow(.reviewConflicts, label: "Review Conflicts", icon: "exclamationmark.triangle",
                        enabled: $autoTaskSettings.runReviewConflicts)

                // Automation Tasks
                taskCategoryHeader("Automation Tasks")
                taskRow(.updateIssues,    label: "Update Issues",      icon: "checklist",
                        enabled: $autoTaskSettings.runUpdateIssues)
                taskRow(.updatePlanStatus, label: "Update Plan Status",  icon: "chart.bar.doc.horizontal",
                        enabled: $autoTaskSettings.runUpdatePlanStatus)
                taskRow(.generateDoc,     label: "Generate Documentation", icon: "wand.and.stars",
                        enabled: $autoTaskSettings.runGenerateDoc)

                // Maintenance Tasks
                taskCategoryHeader("Maintenance Tasks")
                taskRow(.regression,      label: "Regression",       icon: "arrow.uturn.backward.circle",
                        enabled: $autoTaskSettings.runRegression)
                taskRow(.generateKnowledge, label: "Knowledge",       icon: "brain",
                        enabled: $autoTaskSettings.runGenerateKnowledge)
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

// MARK: - AutoTask enum

enum AutoTask: String, CaseIterable, Identifiable {
    case reviewCode
    case reviewDoc
    case reviewConflicts
    /// Re-asks past `status: fixed` FaultReports and flips regressed
    /// ones back to `status: open`. Has no editable prompt template
    /// because the prompts come from the saved fault reports themselves.
    case regression
    /// Knowledge generation (code graph + agent memory + search index). The
    /// generation itself is automatic (GraphAutoUpdater on open/edit + the
    /// auto code-index); this task surfaces the current state for the user to
    /// REVIEW. Structural — no editable prompt template.
    case generateKnowledge
    /// Documentation generation from code changes. Generates comprehensive
    /// docs for new APIs, data structures, config changes, and migration guides.
    case generateDoc
    /// Issue creation and updates from code review findings and meeting
    /// action items. Creates or updates GitHub/GitLab issues.
    case updateIssues
    /// Plan status updates from external outcome trackers (GitHub/GitLab/Linear/Backlog).
    /// Polls external providers and updates plan task statuses. Structural — no editable prompt.
    case updatePlanStatus

    var id: String { rawValue }

    var label: String {
        switch self {
        case .reviewCode:        return "Review Code"
        case .reviewDoc:         return "Review Doc"
        case .reviewConflicts:   return "Review Conflicts"
        case .regression:        return "Regression"
        case .generateKnowledge: return "Knowledge"
        case .generateDoc:       return "Generate Documentation"
        case .updateIssues:      return "Update Issues"
        case .updatePlanStatus:  return "Update Plan Status"
        }
    }

    var icon: String {
        switch self {
        case .reviewCode:        return "checkmark.shield"
        case .reviewDoc:         return "doc.text.magnifyingglass"
        case .reviewConflicts:   return "exclamationmark.triangle"
        case .regression:        return "arrow.uturn.backward.circle"
        case .generateKnowledge: return "brain"
        case .generateDoc:       return "wand.and.stars"
        case .updateIssues:      return "checklist"
        case .updatePlanStatus:  return "chart.bar.doc.horizontal"
        }
    }

    /// Log-file suffix used by `runCLI(prompt:)`, `logTail`, and error hints.
    var logSuffix: String {
        switch self {
        case .reviewCode:        return "review-code"
        case .reviewDoc:         return "review-doc"
        case .reviewConflicts:   return "review-conflicts"
        case .regression:        return "regression"
        case .generateKnowledge: return "knowledge"
        case .generateDoc:       return "generate-doc"
        case .updateIssues:      return "update-issues"
        case .updatePlanStatus:  return "update-plan-status"
        }
    }

    /// Structural tasks (regression, generateKnowledge) don't have a user-
    /// editable prompt template. Callers should hide the template editor when
    /// this returns nil.
    func templateBinding(config: AppConfig) -> Binding<String>? {
        switch self {
        case .reviewCode:      return Binding(get: { config.autoTaskTemplateReviewCode },
                                              set: { config.autoTaskTemplateReviewCode = $0 })
        case .reviewDoc:       return Binding(get: { config.autoTaskTemplateReviewDoc },
                                              set: { config.autoTaskTemplateReviewDoc = $0 })
        case .reviewConflicts: return Binding(get: { config.autoTaskTemplateReviewConflicts },
                                              set: { config.autoTaskTemplateReviewConflicts = $0 })
        case .generateDoc:     return Binding(get: { config.autoTaskTemplateGenerateDoc },
                                              set: { config.autoTaskTemplateGenerateDoc = $0 })
        case .updateIssues:    return Binding(get: { config.autoTaskTemplateUpdateIssues },
                                              set: { config.autoTaskTemplateUpdateIssues = $0 })
        case .updatePlanStatus: return nil
        case .regression, .generateKnowledge: return nil
        }
    }

    func resetTemplate(config: AppConfig) {
        switch self {
        case .reviewCode:      config.autoTaskTemplateReviewCode = AppConfig.defaultTemplateReviewCode
        case .reviewDoc:       config.autoTaskTemplateReviewDoc = AppConfig.defaultTemplateReviewDoc
        case .reviewConflicts: config.autoTaskTemplateReviewConflicts = AppConfig.defaultTemplateReviewConflicts
        case .generateDoc:     config.autoTaskTemplateGenerateDoc = AppConfig.defaultTemplateGenerateDoc
        case .updateIssues:    config.autoTaskTemplateUpdateIssues = AppConfig.defaultTemplateUpdateIssues
        case .updatePlanStatus: break       // no template to reset
        case .regression, .generateKnowledge: break       // no template to reset
        }
    }
}

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
        case .generateKnowledge, .updatePlanStatus:
            Text("Nothing to configure — see the description above.")
                .font(Typography.caption)
                .foregroundStyle(theme.current.textMuted)
        default:
            EmptyView()
        }
    }
}
