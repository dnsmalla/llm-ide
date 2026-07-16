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

                // Task type selection
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    Text("Run automatically")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                        .padding(.top, 2)

                    HStack(spacing: Spacing.lg) {
                        taskToggle("Review Code",      icon: "checkmark.shield",          binding: $autoTaskSettings.runReviewCode)
                        taskToggle("Review Doc",       icon: "doc.text.magnifyingglass",  binding: $autoTaskSettings.runReviewDoc)
                        taskToggle("Review Conflicts", icon: "exclamationmark.triangle",  binding: $autoTaskSettings.runReviewConflicts)
                        taskToggle("Regression",       icon: "arrow.uturn.backward.circle", binding: $autoTaskSettings.runRegression)
                    }
                    taskToggle("Attempt repair on regression", icon: "wrench.and.screwdriver",
                               binding: $autoTaskSettings.regressionAttemptRepair)
                    taskToggle("Auto-reopen regressed faults", icon: "arrow.uturn.backward",
                               binding: $autoTaskSettings.regressionAutoReopen)
                    HStack {
                        Image(systemName: "timer").font(.system(size: 12))
                        Text("Verify timeout (s)").font(Typography.caption)
                        Spacer()
                        TextField("120", value: $autoTaskSettings.regressionVerifyTimeout, format: .number)
                            .frame(width: 60).textFieldStyle(.roundedBorder)
                    }

                    Divider().background(theme.current.border)

                    // Automation tasks
                    taskToggle("Update Issues", icon: "checklist",
                               binding: $config.autoCodeRunUpdateIssues)
                    taskToggle("Update Plan Status", icon: "chart.bar.doc.horizontal",
                               binding: $config.autoCodeRunUpdatePlanStatus)
                    taskToggle("Generate Documentation", icon: "wand.and.stars",
                               binding: $config.autoCodeRunGenerateDoc)
                    taskToggle("Knowledge", icon: "brain",
                               binding: $config.autoCodeRunGenerateKnowledge)
                }

                Divider().background(theme.current.border)

                // Row 3: Status
                VStack(alignment: .leading, spacing: 2) {
                    Text(statusText)
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                    if let _ = autoCodeUpdate.lastRunDate, !autoCodeUpdate.isRunning {
                        Text("\(autoCodeUpdate.createdCount) created · \(autoCodeUpdate.implementedCount) implemented · \(autoCodeUpdate.failedCount) failed")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                    }
                }

                // Row 4: Run Now button
                HStack {
                    Button {
                        autoCodeUpdate.runNow()
                    } label: {
                        if autoCodeUpdate.isRunning {
                            HStack(spacing: 6) {
                                ProgressView().controlSize(.small)
                                Text(autoCodeUpdate.currentStep ?? "Running…")
                            }
                        } else {
                            Text("Run Now")
                        }
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(autoCodeUpdate.isRunning)

                    if autoCodeUpdate.isRunning {
                        Button("Stop") { autoCodeUpdate.cancel() }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                    }

                    Button("Reveal Logs") {
                        autoCodeUpdate.revealLogsInFinder()
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .help("Open the Auto Tasks log folder (review findings + run output) in Finder")
                }

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

    private var statusText: String {
        if autoCodeUpdate.isRunning { return "Running…" }
        guard let lastRun = autoCodeUpdate.lastRunDate else { return "Never run" }
        let ago = RelativeDateTimeFormatter().localizedString(for: lastRun, relativeTo: Date())
        return "Last run \(ago) · \(autoCodeUpdate.statusMessage)"
    }

    private var hasLinkedRepo: Bool {
        autoCodeUpdate.resolveBackendAndProject() != nil
    }

    @ViewBuilder
    private func taskToggle(_ label: String, icon: String, binding: Binding<Bool>) -> some View {
        Toggle(isOn: binding) {
            Label(label, systemImage: icon)
                .font(Typography.caption)
                .foregroundStyle(binding.wrappedValue ? theme.current.text : theme.current.textMuted)
        }
        .toggleStyle(.checkbox)
    }
}
