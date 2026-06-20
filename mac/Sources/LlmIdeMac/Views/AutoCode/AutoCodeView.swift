import SwiftUI

struct AutoCodeView: View {
    @EnvironmentObject private var autoCode: AutoCodeUpdateService
    @EnvironmentObject private var config: AppConfig
    @EnvironmentObject private var theme: ThemeStore

    @State private var selectedTask: AutoTask? = .reviewCode
    @State private var taskToReset: AutoTask? = nil

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
    }

    // MARK: - Left pane

    private var leftPane: some View {
        VStack(spacing: 0) {
            // Enable toggle header
            HStack {
                Toggle("", isOn: Binding(
                    get: { config.autoCodeUpdateEnabled },
                    set: { on in
                        config.autoCodeUpdateEnabled = on
                        if on { autoCode.start() } else { autoCode.stop() }
                    }
                ))
                .toggleStyle(.switch)
                .labelsHidden()

                Text(config.autoCodeUpdateEnabled ? "Enabled" : "Disabled")
                    .font(Typography.body.weight(.semibold))
                    .foregroundStyle(config.autoCodeUpdateEnabled
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

            // Task type rows
            VStack(spacing: 0) {
                taskRow(.reviewCode,      label: "Review Code",      icon: "checkmark.shield",
                        enabled: $config.autoCodeRunReviewCode)
                taskRow(.reviewDoc,       label: "Review Doc",       icon: "doc.text.magnifyingglass",
                        enabled: $config.autoCodeRunReviewDoc)
                taskRow(.reviewConflicts, label: "Review Conflicts", icon: "exclamationmark.triangle",
                        enabled: $config.autoCodeRunReviewConflicts)
                taskRow(.regression,      label: "Regression",       icon: "arrow.uturn.backward.circle",
                        enabled: $config.autoCodeRunRegression)
            }
            .padding(.vertical, 4)

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

            // Run Now
            Button {
                Task { await autoCode.run() }
            } label: {
                Label(autoCode.isRunning ? "Running…" : "Run Now",
                      systemImage: autoCode.isRunning ? "ellipsis.circle" : "play.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(autoCode.isRunning)
            .controlSize(.regular)
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
        .onTapGesture { selectedTask = task }
        .overlay(alignment: .leading) {
            if selectedTask == task {
                Rectangle()
                    .fill(theme.current.accent)
                    .frame(width: 3)
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
            if let task = selectedTask {
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

            if let template = task.templateBinding(config: config) {
                Text("Prompt template")
                    .font(Typography.section)
                    .foregroundStyle(theme.current.textMuted)
                    .padding(.horizontal, 20)
                    .padding(.top, 16)
                    .padding(.bottom, 6)

                TextEditor(text: template)
                    .font(Typography.mono)
                    .foregroundStyle(theme.current.text)
                    .scrollContentBackground(.hidden)
                    .background(theme.current.surface)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 16)
                    .overlay(
                        RoundedRectangle(cornerRadius: 6)
                            .strokeBorder(theme.current.border, lineWidth: 1)
                            .padding(.horizontal, 16)
                            .padding(.bottom, 16)
                    )
            } else {
                // Structural task (regression). Explain what it does
                // and where the prompts come from instead of an empty
                // editor.
                structuralTaskDescription(task)
            }

            if let error = autoCode.taskErrors[task.rawValue] {
                StatusBanner(severity: .error, message: error, onDismiss: { autoCode.dismissTaskError(for: task) })
                    .padding(.horizontal, 12)
                    .padding(.vertical, 4)
            }

            // Inline review findings from the last run — so the user reads
            // them here instead of hunting for the log file. (Reveal Logs in
            // Settings still opens the full log + the rotated .prev copy.)
            if let findings = autoCode.taskOutputs[task.rawValue], !findings.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Findings (last run)")
                        .font(Typography.section)
                        .foregroundStyle(theme.current.textMuted)
                    ScrollView {
                        Text(findings)
                            .font(Typography.mono)
                            .foregroundStyle(theme.current.text)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(8)
                    }
                    .frame(maxHeight: 220)
                    .background(theme.current.surface)
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(theme.current.border, lineWidth: 1))
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 4)
            }

            Spacer(minLength: 0)

            // Last run status
            if let last = autoCode.lastRunDate {
                Divider()
                HStack {
                    Text("Last run \(last, style: .relative) ago · \(autoCode.statusMessage)")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                    Spacer()
                }
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

    // MARK: - Helpers

    /// Right-pane content for tasks that don't take a prompt template
    /// (today: regression). Describes what the task does + where the
    /// inputs come from so the user knows what changing the toggle on
    /// the left actually triggers.
    @ViewBuilder
    private func structuralTaskDescription(_ task: AutoTask) -> some View {
        let t = theme.current
        VStack(alignment: .leading, spacing: 10) {
            switch task {
            case .regression:
                Text("What this does")
                    .font(Typography.section)
                    .foregroundStyle(t.textMuted)
                Text("Re-asks every `status: fixed` fault report saved under `<repo>/.understand-anything/memory/faults/` and flips any that come back with a different answer back to `status: open` so they show up in the next code review.")
                    .font(Typography.body)
                    .foregroundStyle(t.text)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Prompts come from the saved fault reports themselves, not from a template — so there's nothing to edit here. Use the standalone Regression tab to run an ad-hoc sweep with a UI that streams progress per fault.")
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Off by default. Toggling it on adds a regression pass to the end of every Auto Code run — typically a few seconds per fixed fault, multiplied by however many you have. Skip if your fault archive is large or if you're on a flaky network.")
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            default:
                EmptyView()
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 16)
        .padding(.bottom, 16)
    }

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

    var id: String { rawValue }

    var label: String {
        switch self {
        case .reviewCode:      return "Review Code"
        case .reviewDoc:       return "Review Doc"
        case .reviewConflicts: return "Review Conflicts"
        case .regression:      return "Regression"
        }
    }

    var icon: String {
        switch self {
        case .reviewCode:      return "checkmark.shield"
        case .reviewDoc:       return "doc.text.magnifyingglass"
        case .reviewConflicts: return "exclamationmark.triangle"
        case .regression:      return "arrow.uturn.backward.circle"
        }
    }

    /// Structural tasks (regression) don't have a user-editable
    /// prompt template — the prompt comes from saved fault reports.
    /// Callers should hide the template editor when this returns nil.
    func templateBinding(config: AppConfig) -> Binding<String>? {
        switch self {
        case .reviewCode:      return Binding(get: { config.autoTaskTemplateReviewCode },
                                              set: { config.autoTaskTemplateReviewCode = $0 })
        case .reviewDoc:       return Binding(get: { config.autoTaskTemplateReviewDoc },
                                              set: { config.autoTaskTemplateReviewDoc = $0 })
        case .reviewConflicts: return Binding(get: { config.autoTaskTemplateReviewConflicts },
                                              set: { config.autoTaskTemplateReviewConflicts = $0 })
        case .regression:      return nil
        }
    }

    func resetTemplate(config: AppConfig) {
        switch self {
        case .reviewCode:      config.autoTaskTemplateReviewCode = AppConfig.defaultTemplateReviewCode
        case .reviewDoc:       config.autoTaskTemplateReviewDoc = AppConfig.defaultTemplateReviewDoc
        case .reviewConflicts: config.autoTaskTemplateReviewConflicts = AppConfig.defaultTemplateReviewConflicts
        case .regression:      break       // no template to reset
        }
    }
}
