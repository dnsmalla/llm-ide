import SwiftUI

struct AutoCodeSettingsSection: View {
    @EnvironmentObject private var config: AppConfig
    @EnvironmentObject private var autoCodeUpdate: AutoCodeUpdateService
    @EnvironmentObject var theme: ThemeStore
    @Environment(ShellState.self) private var shell

    private let lookbackOptions = [1, 3, 5, 10, 20]

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

                // Row 2: Lookback picker
                HStack(spacing: Spacing.md) {
                    Text("Scan last")
                        .font(Typography.body)
                        .foregroundStyle(theme.current.textMuted)
                    Picker("", selection: $config.autoCodeUpdateLookbackCount) {
                        ForEach(lookbackOptions, id: \.self) { n in
                            Text("\(n)").tag(n)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .frame(width: 70)
                    Text("meetings")
                        .font(Typography.body)
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
                        Task { await autoCodeUpdate.run() }
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
                }

                // Warning hint when no active+cloned GitLab project is configured
                if !hasLinkedRepo {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("No linked repository detected. An active GitLab project with a local clone path is required.")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                        Button("Open GitLab Settings") {
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
        config.gitLabSavedProjects.contains { $0.isActive && !($0.localPath ?? "").isEmpty }
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
