import SwiftUI
import UIKit
import SharedProtocol

/// Native iOS view for the Mac-side "Auto Tasks" surface: the master enable
/// switch, per-task toggles + single-run buttons, run/stop controls, the live
/// status + created/implemented/failed counts, and recent run history. Mirrors
/// the Mac's Auto Tasks tab through the same ControlService bridge Task 4 wired.
///
/// Styling mirrors `ExplorerChatView` / `LlmIdeControlView` (DesignSystem tokens,
/// connection/error banners, "Done" dismiss) so all three sheets feel like one
/// surface. The Mac is the source of truth — every toggle/run just sends a
/// request and the reply refreshes `autoTaskState`.
struct AutoTaskView: View {
    @EnvironmentObject var controlService: ControlService
    @Environment(\.dismiss) private var dismiss

    private var isConnected: Bool { controlService.connectionStatus == .connected }
    private var state: AutoTaskState? { controlService.autoTaskState }

    var body: some View {
        NavigationStack {
            List {
                if !isConnected || state == nil {
                    emptyState
                } else {
                    headerSection
                    tasksSection
                    historySection
                }
            }
            .listStyle(.insetGrouped)
            .background(DesignSystem.Colors.background.ignoresSafeArea())
            .scrollContentBackground(.hidden)
            .animation(.easeInOut(duration: 0.2), value: state?.isRunning)
            .animation(.easeInOut(duration: 0.2), value: controlService.errorMessage)
            .navigationTitle("Auto Tasks")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        controlService.autoTaskList()
                        controlService.autoTaskHistory()
                    } label: { Image(systemName: "arrow.clockwise") }
                }
            }
            .onAppear {
                controlService.autoTaskList()
                controlService.autoTaskHistory()
            }
        }
    }

    // MARK: — Header (master enable + run/stop + counts)

    private var headerSection: some View {
        Section {
            VStack(spacing: DesignSystem.Spacing.md) {
                // Master enable + running badge
                HStack(spacing: DesignSystem.Spacing.sm) {
                    Toggle(isOn: masterBinding) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Auto Tasks")
                                .font(.system(size: DesignSystem.Typography.headline, weight: .semibold))
                                .foregroundColor(DesignSystem.Colors.textPrimary)
                            Text(state?.masterEnabled == true ? "Enabled" : "Disabled")
                                .font(.system(size: DesignSystem.Typography.footnote))
                                .foregroundColor(DesignSystem.Colors.textTertiary)
                        }
                    }
                    runningBadge
                }

                if let msg = state?.statusMessage, !msg.isEmpty {
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: state?.isRunning == true ? "bolt.fill" : "info.circle")
                            .font(.system(size: 12))
                            .foregroundColor(DesignSystem.Colors.primary)
                        Text(msg)
                            .font(.system(size: DesignSystem.Typography.footnote))
                            .foregroundColor(DesignSystem.Colors.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                // Counts
                HStack(spacing: DesignSystem.Spacing.sm) {
                    countTile("Created",   value: state?.createdCount ?? 0,
                              color: DesignSystem.Colors.primary, icon: "sparkles")
                    countTile("Implemented", value: state?.implementedCount ?? 0,
                              color: DesignSystem.Colors.success, icon: "checkmark.circle")
                    countTile("Failed",    value: state?.failedCount ?? 0,
                              color: DesignSystem.Colors.danger, icon: "xmark.circle")
                }

                // Run Now / Stop
                if state?.isRunning == true {
                    Button(role: .destructive) {
                        controlService.autoTaskStop()
                        haptic(.medium)
                    } label: {
                        Label("Stop", systemImage: "stop.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                } else {
                    Button {
                        controlService.autoTaskRun(nil)
                        haptic(.medium)
                    } label: {
                        Label("Run Now", systemImage: "play.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(state?.masterEnabled != true)
                }
            }
            .padding(.vertical, 4)
        }
    }

    /// Master enable is server-owned; the toggle sends the request and the
    /// refreshed `auto_task_state` reply drives the displayed value.
    private var masterBinding: Binding<Bool> {
        Binding(
            get: { state?.masterEnabled ?? false },
            set: { controlService.autoTaskToggle(task: nil, enabled: $0) }
        )
    }

    @ViewBuilder
    private var runningBadge: some View {
        if state?.isRunning == true {
            HStack(spacing: 4) {
                ProgressView()
                    .scaleEffect(0.6)
                Text("Running")
                    .font(.system(size: DesignSystem.Typography.footnote, weight: .medium))
            }
            .foregroundColor(DesignSystem.Colors.primary)
        } else if let last = state?.lastRunDate {
            HStack(spacing: 4) {
                Circle().fill(Color.gray.opacity(0.5)).frame(width: 6, height: 6)
                Text("Idle · \(Date(epochSeconds: last).relativeTimeShort())")
                    .font(.system(size: DesignSystem.Typography.footnote))
            }
            .foregroundColor(DesignSystem.Colors.textTertiary)
        }
    }

    private func countTile(_ title: String, value: Int, color: Color, icon: String) -> some View {
        VStack(spacing: 4) {
            Image(systemName: icon)
                .font(.system(size: 13))
                .foregroundColor(color)
            Text("\(value)")
                .font(.system(size: DesignSystem.Typography.title2, weight: .bold, design: .rounded))
                .foregroundColor(DesignSystem.Colors.textPrimary)
            Text(title)
                .font(.system(size: DesignSystem.Typography.caption))
                .foregroundColor(DesignSystem.Colors.textTertiary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .background(DesignSystem.Colors.surfaceSecondary)
        .clipShape(RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusS))
    }

    // MARK: — Per-task rows

    private var tasksSection: some View {
        Section {
            ForEach(state?.tasks ?? [], id: \.id) { task in
                taskRow(task)
            }
        } header: {
            Text("Tasks")
        }
    }

    @ViewBuilder
    private func taskRow(_ task: AutoTaskInfo) -> some View {
        VStack(alignment: .leading, spacing: DesignSystem.Spacing.xs) {
            HStack(spacing: DesignSystem.Spacing.sm) {
                Toggle(isOn: taskBinding(task)) {
                    Text(task.label)
                        .font(.system(size: DesignSystem.Typography.body))
                        .foregroundColor(DesignSystem.Colors.textPrimary)
                }
                .toggleStyle(.switch)

                Button {
                    controlService.autoTaskRun(task.id)
                    haptic(.light)
                } label: {
                    Image(systemName: "play.circle")
                        .font(.system(size: 22))
                        .foregroundColor(controlService.connectionStatus == .connected
                            ? DesignSystem.Colors.primary
                            : DesignSystem.Colors.textTertiary)
                }
                .buttonStyle(.plain)
                .disabled(!isConnected)

                if state?.currentTask == task.id {
                    ProgressView().scaleEffect(0.7)
                }
            }

            if let err = task.lastError, !err.isEmpty {
                HStack(alignment: .top, spacing: 4) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 10))
                        .foregroundColor(DesignSystem.Colors.danger)
                    Text(err)
                        .font(.system(size: DesignSystem.Typography.footnote))
                        .foregroundColor(DesignSystem.Colors.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.vertical, 2)
    }

    /// Per-task enable is server-owned; sends the toggle and the refreshed
    /// state reply updates the row.
    private func taskBinding(_ task: AutoTaskInfo) -> Binding<Bool> {
        Binding(
            get: { task.enabled },
            set: { controlService.autoTaskToggle(task: task.id, enabled: $0) }
        )
    }

    // MARK: — History

    private var historySection: some View {
        Section {
            if controlService.autoTaskHistoryEntries.isEmpty {
                Text("No runs yet")
                    .font(.system(size: DesignSystem.Typography.footnote))
                    .foregroundColor(DesignSystem.Colors.textTertiary)
            } else {
                ForEach(Array(controlService.autoTaskHistoryEntries.enumerated()), id: \.offset) { _, entry in
                    historyRow(entry)
                }
            }
        } header: {
            HStack {
                Text("History")
                Spacer()
                Button {
                    controlService.autoTaskHistory()
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 12))
                        .foregroundColor(DesignSystem.Colors.primary)
                }
            }
        }
    }

    @ViewBuilder
    private func historyRow(_ entry: AutoTaskHistoryEntry) -> some View {
        HStack(alignment: .top, spacing: DesignSystem.Spacing.sm) {
            Image(systemName: historyIcon(entry.status))
                .font(.system(size: 13))
                .foregroundColor(historyColor(entry.status))
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.actionText)
                    .font(.system(size: DesignSystem.Typography.subheadline))
                    .foregroundColor(DesignSystem.Colors.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    Text(entry.status)
                        .font(.system(size: DesignSystem.Typography.caption, weight: .medium))
                        .foregroundColor(historyColor(entry.status))
                    Text("· \(Date(epochSeconds: entry.lastUpdated).relativeTimeShort())")
                        .font(.system(size: DesignSystem.Typography.caption))
                        .foregroundColor(DesignSystem.Colors.textTertiary)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private func historyColor(_ status: String) -> Color {
        switch status.lowercased() {
        case let s where s.contains("success") || s.contains("implement"): return DesignSystem.Colors.success
        case let s where s.contains("fail") || s.contains("error"):       return DesignSystem.Colors.danger
        case let s where s.contains("creat"):                             return DesignSystem.Colors.primary
        default:                                                          return DesignSystem.Colors.textTertiary
        }
    }

    private func historyIcon(_ status: String) -> String {
        switch status.lowercased() {
        case let s where s.contains("success") || s.contains("implement"): return "checkmark.circle.fill"
        case let s where s.contains("fail") || s.contains("error"):       return "xmark.circle.fill"
        case let s where s.contains("creat"):                             return "sparkles"
        default:                                                          return "circle.fill"
        }
    }

    // MARK: — Empty state

    private var emptyState: some View {
        Section {
            VStack(spacing: DesignSystem.Spacing.sm) {
                Image(systemName: !isConnected ? "wifi.slash" : "bolt.slash")
                    .font(.system(size: 34))
                    .foregroundColor(DesignSystem.Colors.textTertiary)
                Text(!isConnected ? "Not connected to your Mac" : "No auto-task state")
                    .font(.system(size: DesignSystem.Typography.callout, weight: .medium))
                    .foregroundColor(DesignSystem.Colors.textSecondary)
                Text(!isConnected
                     ? "Connect to your Mac to view and control auto tasks."
                     : "Tap refresh, or enable Auto Tasks on your Mac.")
                    .font(.system(size: DesignSystem.Typography.footnote))
                    .foregroundColor(DesignSystem.Colors.textTertiary)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 40)
            .listRowBackground(Color.clear)
        }
    }

    // MARK: — Helpers
}
