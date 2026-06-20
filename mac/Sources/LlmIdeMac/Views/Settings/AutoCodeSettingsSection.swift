import SwiftUI

struct AutoCodeSettingsSection: View {
    @EnvironmentObject private var config: AppConfig
    @EnvironmentObject private var autoCodeUpdate: AutoCodeUpdateService
    @EnvironmentObject var theme: ThemeStore
    @Environment(ShellState.self) private var shell

    private let lookbackOptions = [1, 3, 5, 10, 20]
    private let dayOptions = [1, 3, 7, 14, 30]
    /// Cadence options in minutes. Floor matches AutoCodeUpdateService.minIntervalMinutes.
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
                    get: { config.autoCodeUpdateEnabled },
                    set: { enabled in
                        config.autoCodeUpdateEnabled = enabled
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
                    if config.autoCodeLookbackByDays {
                        Picker("", selection: $config.autoCodeLookbackDays) {
                            ForEach(dayOptions, id: \.self) { n in Text("\(n)").tag(n) }
                        }
                        .labelsHidden().pickerStyle(.menu).frame(width: 70)
                        Text("days")
                            .font(Typography.body)
                            .foregroundStyle(theme.current.textMuted)
                    } else {
                        Picker("", selection: $config.autoCodeUpdateLookbackCount) {
                            ForEach(lookbackOptions, id: \.self) { n in Text("\(n)").tag(n) }
                        }
                        .labelsHidden().pickerStyle(.menu).frame(width: 70)
                        Text("meetings")
                            .font(Typography.body)
                            .foregroundStyle(theme.current.textMuted)
                    }
                    Spacer()
                    Picker("", selection: $config.autoCodeLookbackByDays) {
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
                    Picker("", selection: $config.autoCodeIntervalMinutes) {
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

                // Task type selection
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    Text("Run automatically")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                        .padding(.top, 2)

                    // Wraps to a second row past ~3 columns at the
                    // Settings card's natural width; FlowLayout-ish
                    // behavior via two HStacks keeps the labels from
                    // truncating on narrower windows.
                    HStack(spacing: Spacing.lg) {
                        taskToggle("Review Code",      icon: "checkmark.shield",          binding: $config.autoCodeRunReviewCode)
                        taskToggle("Review Doc",       icon: "doc.text.magnifyingglass",  binding: $config.autoCodeRunReviewDoc)
                        taskToggle("Review Conflicts", icon: "exclamationmark.triangle",  binding: $config.autoCodeRunReviewConflicts)
                        taskToggle("Regression",       icon: "arrow.uturn.backward.circle", binding: $config.autoCodeRunRegression)
                    }
                    taskToggle("Attempt repair on regression", icon: "wrench.and.screwdriver",
                               binding: $config.regressionAttemptRepair)
                    taskToggle("Auto-reopen regressed faults", icon: "arrow.uturn.backward",
                               binding: $config.regressionAutoReopen)
                    HStack {
                        Image(systemName: "timer").font(.system(size: 12))
                        Text("Verify timeout (s)").font(Typography.caption)
                        Spacer()
                        TextField("120", value: $config.regressionVerifyTimeout, format: .number)
                            .frame(width: 60).textFieldStyle(.roundedBorder)
                    }
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
                                Text("Running…")
                            }
                        } else {
                            Text("Run Now")
                        }
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(autoCodeUpdate.isRunning)

                    // Stop an in-flight run — cancels remaining tasks and kills
                    // the currently-running CLI subprocess.
                    if autoCodeUpdate.isRunning {
                        Button("Stop") { autoCodeUpdate.cancel() }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                    }

                    // Review tasks write their findings to log files; give a
                    // one-click way to read them (success or failure).
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

    /// Mirrors exactly what `run()` requires to find a target — covers
    /// GitLab, GitHub, the active project's linkedRepo, and token presence,
    /// rather than only checking GitLab (which falsely warned GitHub-only
    /// setups).
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
