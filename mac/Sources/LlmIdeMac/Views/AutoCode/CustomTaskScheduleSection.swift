import SwiftUI

/// Mode + cron editor for an existing custom auto-task in the detail pane.
/// Cron lives on `CustomAutoTask`; next-fire runtime state lives in
/// `AutoTaskSettings.customNextFireAt(for:)`.
struct CustomTaskScheduleSection: View {
    let task: CustomAutoTask
    let autoCode: AutoCodeUpdateService
    @ObservedObject var settings: AutoTaskSettings
    let onChanged: () -> Void

    @EnvironmentObject private var theme: ThemeStore

    @State private var cronDraft: String = ""
    @State private var cronEditing = false
    @State private var cronTouched = false

    private var savedCron: String { task.cron ?? "" }
    private var cronIsValid: Bool {
        cronDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || CronExpression.parse(cronDraft.trimmingCharacters(in: .whitespacesAndNewlines)) != nil
    }
    private var willRun: Bool { settings.enabled && task.isEnabled && task.cron != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Mode").font(Typography.caption).foregroundStyle(theme.current.textMuted)
                Picker("Mode", selection: modeBinding) {
                    ForEach(CustomAutoTask.Mode.allCases, id: \.self) { m in
                        Text(m.label).tag(m)
                    }
                }
                .pickerStyle(.segmented)
                Text(task.mode.detail)
                    .font(.caption2)
                    .foregroundStyle(theme.current.textMuted)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("Schedule").font(Typography.caption).foregroundStyle(theme.current.textMuted)
                if cronEditing {
                    cronEditRow
                } else {
                    cronDisplayRow
                }
            }
        }
        .onAppear {
            cronDraft = savedCron
        }
        .onChange(of: task.id) { _, _ in
            cronDraft = savedCron
            cronEditing = false
            cronTouched = false
        }
    }

    private var modeBinding: Binding<CustomAutoTask.Mode> {
        Binding(
            get: { task.mode },
            set: { newMode in
                var updated = task
                updated.mode = newMode
                updated.save()
                onChanged()
            }
        )
    }

    private var cronDisplayRow: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "clock")
                .foregroundStyle(willRun ? theme.current.accent3 : theme.current.textMuted)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 2) {
                if savedCron.isEmpty {
                    Text("Manual only — use ▶ Run")
                        .font(.caption)
                        .foregroundStyle(theme.current.textMuted)
                } else {
                    Text(savedCron)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(theme.current.text)
                    if let desc = CronExpression.parse(savedCron)?.describe {
                        Text(desc)
                            .font(.caption2)
                            .foregroundStyle(theme.current.textMuted)
                    }
                }
                scheduleStatusLine
            }
            Spacer(minLength: 8)
            Button("Edit") {
                cronDraft = savedCron
                cronTouched = false
                cronEditing = true
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
    }

    @ViewBuilder
    private var scheduleStatusLine: some View {
        if savedCron.isEmpty {
            EmptyView()
        } else if !settings.enabled {
            statusText("Auto Tasks paused — master switch off", icon: "pause.circle")
        } else if !task.isEnabled {
            statusText("Task disabled — won't run", icon: "pause.circle")
        } else if let next = settings.customNextFireAt(for: task.id) {
            statusText("Scheduled · next \(AutoTask.fireFormatter.string(from: next))",
                       icon: "checkmark.circle.fill", color: theme.current.accent3)
        } else {
            statusText("No upcoming fire", icon: "clock")
        }
    }

    private var cronEditRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "clock")
                    .foregroundStyle(theme.current.textMuted)
                TextField("Cron (empty = manual only)", text: $cronDraft)
                    .font(.system(.caption, design: .monospaced))
                    .onSubmit { saveCron() }
                if cronTouched && !cronIsValid {
                    Text("invalid")
                        .font(.caption2)
                        .foregroundStyle(theme.current.danger)
                }
                Button("Save") { saveCron() }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(!cronIsValid || cronDraft.trimmingCharacters(in: .whitespacesAndNewlines) == savedCron)
                Button("Cancel") {
                    cronDraft = savedCron
                    cronTouched = false
                    cronEditing = false
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
            if cronIsValid {
                let trimmed = cronDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed.isEmpty {
                    Text("Clears the schedule — task runs only via ▶ Run")
                        .font(.caption2)
                        .foregroundStyle(theme.current.textMuted)
                } else if let desc = CronExpression.parse(trimmed)?.describe {
                    Text(desc)
                        .font(.caption2)
                        .foregroundStyle(theme.current.textMuted)
                }
            }
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

    private func saveCron() {
        cronTouched = true
        guard cronIsValid else { return }
        let trimmed = cronDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        var updated = task
        updated.cron = trimmed.isEmpty ? nil : trimmed
        updated.save()
        if updated.cron != nil {
            autoCode.realignCustomNextFire(for: updated, now: Date())
        } else {
            settings.setCustomNextFireAt(nil, for: task.id)
        }
        cronEditing = false
        onChanged()
    }
}
