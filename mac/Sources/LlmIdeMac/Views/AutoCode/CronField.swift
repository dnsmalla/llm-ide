import SwiftUI

/// Validated cron editor for one Auto Task.
///
/// An **Active** switch arms or disarms the schedule, and starts OFF. The
/// expression and the arming are separate on purpose: every task carries a
/// cron string, so without this the only way to stop a task firing was to
/// destroy a schedule the user had tuned. Disarming keeps the expression and
/// greys out the whole row — Edit included, since editing a cron that cannot
/// run only invites the user to tune something inert; activate first, then
/// edit.
///
/// Two modes so it's always clear whether the task is actually scheduled:
/// - **Display ("set") mode** (default): the committed cron, its human
///   description, and an explicit status — `Scheduled · next …`,
///   `Schedule off`, `Auto Tasks paused`, or `Task disabled — won't run` —
///   so you can see at a glance that it will run. Press Edit to change it.
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
    /// Whether this task's cron is armed. Bound to the Active switch.
    private var isActive: Bool { settings.isScheduleActive(for: task) }
    /// True only when the schedule is armed AND the master switch AND this
    /// task's per-task flag are on — i.e. the scheduler will actually fire it.
    private var willRun: Bool { isActive && settings.enabled && settings.isEnabled(task: task) }

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
                .opacity(isActive ? 1 : 0.55)
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
            // Dims the EXPRESSION only, never the switch that turns it back
            // on — greying out the one control the user needs to click would
            // read as "this row is unavailable" rather than "this schedule is
            // off".
            .opacity(isActive ? 1 : 0.55)
            Spacer(minLength: 8)
            activeToggle
            Button("Edit") {
                draft = savedCron
                touched = false
                isEditing = true
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            // Editing a disarmed cron would let the user tune a schedule that
            // cannot run and looks set — activate first, then edit.
            .disabled(!isActive)
        }
    }

    /// Arms/disarms this task's cron without touching the expression.
    private var activeToggle: some View {
        Toggle("Active", isOn: Binding(
            get: { isActive },
            set: { settings.setScheduleActive($0, for: task) }
        ))
        .toggleStyle(.switch)
        .controlSize(.mini)
        .font(.caption2)
        .foregroundStyle(theme.current.textMuted)
        .fixedSize()
        .help(isActive
              ? "Scheduled — the cron below fires this task"
              : "Schedule off — this task runs only when you press Run")
        .accessibilityLabel("Schedule active")
    }

    /// One-line schedule status so the user knows whether the task will run:
    /// green "Scheduled · next …" only when both the master switch and this
    /// task's flag are on.
    @ViewBuilder
    private var statusLine: some View {
        if !isActive {
            statusText("Schedule off — runs only when you press Run", icon: "clock.badge.xmark")
        } else if !settings.enabled {
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
