import SwiftUI

struct MenuBarAutoTaskView: View {
    @EnvironmentObject private var autoTaskSettings: AutoTaskSettings
    @EnvironmentObject private var autoCodeUpdate: AutoCodeUpdateService
    @EnvironmentObject private var theme: ThemeStore

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Title row
            HStack {
                Image(systemName: "arrow.triangle.2.circlepath")
                    .foregroundStyle(autoTaskSettings.enabled ? theme.current.accent : theme.current.textMuted)
                Text("Auto Tasks")
                    .font(.system(.body, design: .default).weight(.semibold))
                Spacer()
                if autoCodeUpdate.isRunning {
                    ProgressView()
                        .controlSize(.small)
                }
            }

            Divider()

            // Status section
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text("Status:")
                        .font(.caption)
                        .foregroundStyle(theme.current.textMuted)
                    Spacer()
                    statusBadge
                }

                let summary = autoTaskSettings.menuBarSummary
                if !summary.isEmpty {
                    Text(summary)
                        .font(.caption)
                        .foregroundStyle(theme.current.textMuted)
                        .lineLimit(2)
                }

                HStack(spacing: 4) {
                    Image(systemName: "timer")
                        .font(.caption2)
                        .foregroundStyle(theme.current.textMuted)
                    Text("Every \(autoTaskSettings.intervalDescription)")
                        .font(.caption2)
                        .foregroundStyle(theme.current.textMuted)
                }

                HStack(spacing: 4) {
                    Image(systemName: "calendar")
                        .font(.caption2)
                        .foregroundStyle(theme.current.textMuted)
                    Text("Lookback: \(autoTaskSettings.lookbackDescription)")
                        .font(.caption2)
                        .foregroundStyle(theme.current.textMuted)
                }
            }

            Divider()

            // Last run stats
            if autoCodeUpdate.lastRunDate != nil {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Last run:")
                        .font(.caption)
                        .foregroundStyle(theme.current.textMuted)
                    HStack(spacing: 8) {
                        stat("Created", count: autoCodeUpdate.createdCount)
                        stat("Implemented", count: autoCodeUpdate.implementedCount)
                        stat("Failed", count: autoCodeUpdate.failedCount)
                    }
                }
                Divider()
            }

            // Quick toggles
            VStack(alignment: .leading, spacing: 6) {
                Toggle(isOn: $autoTaskSettings.enabled) {
                    Label("Enabled", systemImage: "power")
                        .font(.caption)
                }
                .toggleStyle(.checkbox)

                if autoCodeUpdate.isRunning {
                    Button(action: { autoCodeUpdate.cancel() }) {
                        Label("Stop", systemImage: "stop.circle")
                            .font(.caption)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Button(action: { autoCodeUpdate.runNow() }) {
                        Label("Run Now", systemImage: "arrow.triangle.2.circlepath")
                            .font(.caption)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                Button(action: { autoCodeUpdate.revealLogsInFinder() }) {
                    Label("View Logs", systemImage: "doc.plaintext")
                        .font(.caption)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            Divider()

            // Settings link
            Button {
                NotificationCenter.default.post(name: .openSettings, object: nil)
            } label: {
                Text("Configure in Settings")
                    .font(.caption)
                    .foregroundStyle(theme.current.accent)
            }
            .buttonStyle(.plain)
        }
        .padding(12)
        .frame(width: 280)
    }

    @ViewBuilder
    private var statusBadge: some View {
        if autoCodeUpdate.isRunning {
            HStack(spacing: 4) {
                ProgressView()
                    .controlSize(.small)
                Text("Running")
                    .font(.caption2)
                    .foregroundStyle(theme.current.accent)
            }
        } else if autoTaskSettings.enabled {
            Text("Idle")
                .font(.caption2)
                .foregroundStyle(.green)
        } else {
            Text("Disabled")
                .font(.caption2)
                .foregroundStyle(.orange)
        }
    }

    @ViewBuilder
    private func stat(_ label: String, count: Int) -> some View {
        VStack(spacing: 1) {
            Text(String(count))
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundStyle(theme.current.text)
            Text(label)
                .font(.caption2)
                .foregroundStyle(theme.current.textMuted)
        }
        .frame(maxWidth: .infinity)
        .padding(6)
        .background(theme.current.border)
        .cornerRadius(4)
    }
}

