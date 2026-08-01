import SwiftUI

/// Validated cron editor for one Auto Task.
///
/// Two modes so it's always clear whether the task is actually scheduled:
/// - **Display ("set") mode** (default): the committed cron, its human
///   description, and an explicit status — `Scheduled · next …`,
///   `Auto Tasks paused`, or `Task disabled — won't run` — so you can see at
///   a glance that it will run. Press Edit to change it.
/// - **Edit mode**: a TextField with live validation, committed via Save
///   (or Enter). Invalid input is rejected; Cancel reverts. The previous
///   field was always an editable TextField that only committed on Enter, so
///   typing-then-clicking-away silently lost the value and the field never
///   looked "set".
struct CronField: View {
    let task: AutoTask
    @ObservedObject var settings: AutoTaskSettings
    @EnvironmentObject private var theme: ThemeStore

    @State private var draft: String = ""
    @State private var isEditing = false
    @State private var touched = false

    private var savedCron: String { settings.cron(for: task) }
    private var isValid: Bool { CronExpression.parse(draft) != nil }
    private var isDirty: Bool { draft != savedCron }
    /// True only when the master switch AND this task's per-task flag are on —
    /// i.e. the scheduler will actually fire it.
    private var willRun: Bool { settings.enabled && settings.isEnabled(task: task) }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if isEditing {
                editRow
            } else {
                displayRow
            }
        }
        .onAppear { draft = savedCron }
    }

    // MARK: - Display ("set") mode

    private var displayRow: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "clock")
                .foregroundStyle(willRun ? theme.current.accent3 : theme.current.textMuted)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 1) {
                Text(savedCron)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(theme.current.text)
                if let desc = CronExpression.parse(savedCron)?.describe {
                    Text(desc)
                        .font(.caption2)
                        .foregroundStyle(theme.current.textMuted)
                }
                statusLine
            }
            Spacer(minLength: 8)
            Button("Edit") {
                draft = savedCron
                touched = false
                isEditing = true
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
    }

    /// One-line schedule status so the user knows whether the task will run:
    /// green "Scheduled · next …" only when both the master switch and this
    /// task's flag are on.
    @ViewBuilder
    private var statusLine: some View {
        if !settings.enabled {
            statusText("Auto Tasks paused — master switch off", icon: "pause.circle")
        } else if !settings.isEnabled(task: task) {
            statusText("Task disabled — won't run", icon: "pause.circle")
        } else if let next = settings.nextFireAt(for: task) {
            statusText("Scheduled · next \(AutoTask.fireFormatter.string(from: next))",
                       icon: "checkmark.circle.fill", color: theme.current.accent3)
        } else {
            statusText("No upcoming fire", icon: "clock")
        }
    }

    private func statusText(_ text: String, icon: String, color: Color? = nil) -> some View {
        HStack(spacing: 4) {
            Image(systemName: icon).font(.system(size: 9))
            Text(text)
        }
        .font(.caption2)
        .foregroundStyle(color ?? theme.current.textMuted)
    }

    // MARK: - Edit mode

    private var editRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "clock")
                    .foregroundStyle(theme.current.textMuted)
                TextField("cron", text: $draft)
                    .font(.system(.caption, design: .monospaced))
                    .onSubmit { save() }
                if !isValid && touched {
                    Text("invalid cron")
                        .font(.caption2)
                        .foregroundStyle(theme.current.danger)
                }
                Button("Save") { save() }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(!isValid || !isDirty)
                Button("Cancel") {
                    draft = savedCron
                    touched = false
                    isEditing = false
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
            // Live description of the draft so the user sees what they're saving.
            if isDirty && isValid, let desc = CronExpression.parse(draft)?.describe {
                Text(desc)
                    .font(.caption2)
                    .foregroundStyle(theme.current.textMuted)
            }
        }
    }

    private func save() {
        touched = true
        guard isValid else { return }            // stay in edit mode on invalid
        settings.setCron(draft, for: task)       // persists + recomputes next-fire + notifies
        isEditing = false
    }
}
