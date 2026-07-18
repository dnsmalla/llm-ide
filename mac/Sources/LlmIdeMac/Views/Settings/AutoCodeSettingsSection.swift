import SwiftUI

struct AutoCodeSettingsSection: View {
    @EnvironmentObject private var autoTaskSettings: AutoTaskSettings
    @EnvironmentObject private var autoCodeUpdate: AutoCodeUpdateService
    @EnvironmentObject var theme: ThemeStore
    @Environment(ShellState.self) private var shell

    private let lookbackOptions = [1, 3, 5, 10, 20]
    private let dayOptions = [1, 3, 7, 14, 30]
    private let intervalOptions = [5, 15, 30, 60, 180, 360, 720, 1440]

    private func intervalLabel(_ minutes: Int) -> String {
        switch minutes {
        case ..<60:  return "\(minutes) min"
        case 60:     return "1 hour"
        case 1440:   return "24 hours"
        default:
            let h = minutes / 60
            return "\(h) hours"
        }
    }

    var body: some View {
        SettingsSectionCard(icon: "arrow.triangle.2.circlepath.circle", title: "Auto Tasks") {
            VStack(alignment: .leading, spacing: Spacing.sm) {

                // Row 1: Enabled toggle
                Toggle(isOn: Binding(
                    get: { autoTaskSettings.enabled },
                    set: { enabled in
                        autoTaskSettings.enabled = enabled
                        if enabled {
                            autoCodeUpdate.start()
                        } else {
                            autoCodeUpdate.stop()
                        }
                    }
                )) {
                    Text("Enabled")
                        .font(Typography.body)
                        .foregroundStyle(theme.current.text)
                }
                .toggleStyle(.switch)

                // Row 2: Lookback — by count (N meetings) or by age (N days).
                HStack(spacing: Spacing.md) {
                    Text("Scan last")
                        .font(Typography.body)
                        .foregroundStyle(theme.current.textMuted)
                    if autoTaskSettings.lookbackByDays {
                        Picker("", selection: $autoTaskSettings.lookbackDays) {
                            ForEach(dayOptions, id: \.self) { n in Text("\(n)").tag(n) }
                        }
                        .labelsHidden().pickerStyle(.menu).frame(width: 70)
                        Text("days")
                            .font(Typography.body)
                            .foregroundStyle(theme.current.textMuted)
                    } else {
                        Picker("", selection: $autoTaskSettings.lookbackMeetingCount) {
                            ForEach(lookbackOptions, id: \.self) { n in Text("\(n)").tag(n) }
                        }
                        .labelsHidden().pickerStyle(.menu).frame(width: 70)
                        Text("meetings")
                            .font(Typography.body)
                            .foregroundStyle(theme.current.textMuted)
                    }
                    Spacer()
                    Picker("", selection: $autoTaskSettings.lookbackByDays) {
                        Text("by count").tag(false)
                        Text("by age").tag(true)
                    }
                    .labelsHidden().pickerStyle(.segmented).frame(width: 150)
                }

                // Cadence: how often the auto-task timer fires while enabled.
                HStack(spacing: Spacing.md) {
                    Text("Run every")
                        .font(Typography.body)
                        .foregroundStyle(theme.current.textMuted)
                    Picker("", selection: $autoTaskSettings.intervalMinutes) {
                        ForEach(intervalOptions, id: \.self) { m in
                            Text(intervalLabel(m)).tag(m)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .frame(width: 110)
                    Text("(only while the app is open)")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                }

                // Dirty-tree behavior: skip (default) vs auto-stash + restore.
                Toggle(isOn: $autoTaskSettings.autoStash) {
                    Label("Auto-stash uncommitted changes", systemImage: "tray.and.arrow.down")
                        .font(Typography.caption)
                        .foregroundStyle(autoTaskSettings.autoStash ? theme.current.text : theme.current.textMuted)
                }
                .toggleStyle(.checkbox)
                .help("When on, auto-tasks stash your uncommitted changes before running and restore them after, instead of skipping. If a restore conflicts, your changes stay safe in `git stash`. Off by default.")

                Text("Per-task toggles, Run, and live logs live on the Auto Tasks page. Quick status + Run are in the menu bar.")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .fixedSize(horizontal: false, vertical: true)

                // Warning hint when no usable repo target is configured.
                if !hasLinkedRepo {
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
                    .padding(.vertical, 2)
                }
            }
        }
    }

    private var hasLinkedRepo: Bool {
        autoCodeUpdate.resolveBackendAndProject() != nil
    }

}
