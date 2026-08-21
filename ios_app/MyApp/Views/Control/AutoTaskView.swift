import SwiftUI
import SharedProtocol

/// Native iOS view for the Mac-side Auto Tasks surface: master enable, per-task
/// toggles, run/stop controls, live status counts, and run history. Proxied
/// through the paired Mac WebSocket to the Mac auto-task runner.
///
/// Styling mirrors `ExplorerChatView` / `LlmIdeControlView` (DesignSystem tokens,
/// connection/error banners, "Done" dismiss) so all three sheets feel like one
/// surface. The Mac is the source of truth — every toggle/run just sends a
/// request and the reply refreshes `autoTaskState`.
struct AutoTaskView: View {
    @EnvironmentObject var connection: ConnectionService
    @EnvironmentObject var autoTaskStore: AutoTaskStore
    @Environment(\.dismiss) private var dismiss

    private var isConnected: Bool { connection.connectionStatus == .connected }
    private var state: AutoTaskState? { autoTaskStore.autoTaskState }

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
            .overlay(alignment: .top) {
                if !isConnected {
                    StatusBanner(.connection(isConnecting: connection.connectionStatus == .connecting))
                        .padding(.top, DesignSystem.Spacing.sm)
                } else if let err = connection.errorMessage {
                    StatusBanner(.error(message: err) { connection.errorMessage = nil })
                        .padding(.top, DesignSystem.Spacing.sm)
                }
            }
            .animation(.easeInOut(duration: 0.2), value: state?.isRunning)
            .animation(.easeInOut(duration: 0.2), value: connection.errorMessage)
            .navigationTitle("Auto Tasks")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        autoTaskStore.refreshAll()
                    } label: { Image(systemName: "arrow.clockwise") }
                }
                .accessibilityLabel("Refresh auto tasks")
            }
            .onAppear {
                autoTaskStore.refreshAll()
            }
            .onChange(of: connection.connectionStatus) { status in
                if status == .connected { autoTaskStore.refreshAll() }
            }
            .navigationDestination(isPresented: $autoTaskStore.isRunLogPresented) {
                AutoTaskRunLogView()
                    .environmentObject(connection)
                    .environmentObject(autoTaskStore)
            }
            .onChange(of: autoTaskStore.isRunLogPresented) { presented in
                if !presented { autoTaskStore.stopLogPolling() }
            }
        }
    }

    // MARK: — Header (master enable + run/stop + counts)

    private var headerSection: some View {
        Section {
            VStack(spacing: DesignSystem.Spacing.md) {
                if let err = autoTaskStore.lastError {
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 12))
                            .foregroundColor(DesignSystem.Colors.danger)
                        Text(err)
                            .font(DesignSystem.Typography.footnoteFont)
                            .foregroundColor(DesignSystem.Colors.danger)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                        Button { autoTaskStore.clearError() } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundColor(DesignSystem.Colors.textTertiary)
                        }
                    }
                }

                // Master enable + running badge
                HStack(spacing: DesignSystem.Spacing.sm) {
                    Toggle(isOn: masterBinding) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Auto Tasks")
                                .font(DesignSystem.Typography.headlineFont.weight(.semibold))
                                .foregroundColor(DesignSystem.Colors.textPrimary)
                            Text(state?.masterEnabled == true ? "Enabled" : "Disabled")
                                .font(DesignSystem.Typography.footnoteFont)
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
                            .font(DesignSystem.Typography.footnoteFont)
                            .foregroundColor(DesignSystem.Colors.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                if state?.isRunning == true {
                    executionPanel
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
                        autoTaskStore.autoTaskStop()
                        haptic(.medium)
                    } label: {
                        Label("Stop", systemImage: "stop.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                } else {
                    Button {
                        autoTaskStore.autoTaskRun(nil)
                        haptic(.medium)
                    } label: {
                        Label("Run Now", systemImage: "play.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(state?.masterEnabled != true)
                }
                if state?.masterEnabled != true {
                    Text("Turn on the master switch above to run tasks from iPhone.")
                        .font(DesignSystem.Typography.captionFont)
                        .foregroundColor(DesignSystem.Colors.textTertiary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(.vertical, 4)
        }
    }

    /// Live execution mirror — step + current task while Mac runs.
    private var executionPanel: some View {
        VStack(alignment: .leading, spacing: DesignSystem.Spacing.xs) {
            HStack(spacing: 6) {
                ProgressView().scaleEffect(0.75)
                Text("Running on Mac")
                    .font(DesignSystem.Typography.subheadlineFont.weight(.semibold))
                    .foregroundColor(DesignSystem.Colors.primary)
            }
            if let step = state?.currentStep, !step.isEmpty {
                Text(step)
                    .font(DesignSystem.Typography.bodyFont)
                    .foregroundColor(DesignSystem.Colors.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let current = state?.currentTask,
                      let label = state?.tasks.first(where: { $0.id == current })?.label {
                Text(label)
                    .font(DesignSystem.Typography.bodyFont)
                    .foregroundColor(DesignSystem.Colors.textPrimary)
            }
            Text("Execution happens on your Mac — tap below for the full live log.")
                .font(DesignSystem.Typography.captionFont)
                .foregroundColor(DesignSystem.Colors.textTertiary)
            Button {
                autoTaskStore.openRunLog(focusTask: state?.currentTask)
                haptic(.light)
            } label: {
                Label("View live log", systemImage: "doc.text")
                    .font(DesignSystem.Typography.footnoteFont.weight(.semibold))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .tint(DesignSystem.Colors.primary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(DesignSystem.Spacing.sm)
        .background(DesignSystem.Colors.primary.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusS))
    }

    /// Master enable is server-owned; the toggle sends the request and the
    /// refreshed `auto_task_state` reply drives the displayed value.
    private var masterBinding: Binding<Bool> {
        Binding(
            get: { state?.masterEnabled ?? false },
            set: { autoTaskStore.autoTaskToggle(task: nil, enabled: $0) }
        )
    }

    @ViewBuilder
    private var runningBadge: some View {
        if state?.isRunning == true {
            HStack(spacing: 4) {
                ProgressView()
                    .scaleEffect(0.6)
                Text("Running")
                    .font(DesignSystem.Typography.footnoteFont.weight(.medium))
            }
            .foregroundColor(DesignSystem.Colors.primary)
        } else if let last = state?.lastRunDate {
            HStack(spacing: 4) {
                Circle().fill(Color.gray.opacity(0.5)).frame(width: 6, height: 6)
                Text("Idle · \(Date(epochSeconds: last).relativeTimeShort())")
                    .font(DesignSystem.Typography.footnoteFont)
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
                .font(DesignSystem.Typography.title2Font.weight(.bold).design(.rounded))
                .foregroundColor(DesignSystem.Colors.textPrimary)
            Text(title)
                .font(DesignSystem.Typography.captionFont)
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
                Image(systemName: taskIcon(task.id))
                    .font(.system(size: 16))
                    .foregroundColor(DesignSystem.Colors.primary)
                    .frame(width: 22)

                Toggle(isOn: taskBinding(task)) {
                    Text(task.label)
                        .font(DesignSystem.Typography.bodyFont)
                        .foregroundColor(DesignSystem.Colors.textPrimary)
                }
                .toggleStyle(.switch)

                Button {
                    autoTaskStore.autoTaskRun(task.id)
                    haptic(.light)
                } label: {
                    Image(systemName: state?.currentTask == task.id && state?.isRunning == true
                          ? "ellipsis.circle" : "play.circle")
                        .font(.system(size: 22))
                        .foregroundColor(connection.connectionStatus == .connected
                            ? DesignSystem.Colors.primary
                            : DesignSystem.Colors.textTertiary)
                }
                .buttonStyle(.plain)
                .disabled(!isConnected || state?.isRunning == true)

                if state?.currentTask == task.id, state?.isRunning == true {
                    ProgressView().scaleEffect(0.7)
                }
            }

            if state?.currentTask == task.id,
               let step = state?.currentStep, !step.isEmpty,
               state?.isRunning == true {
                Text(step)
                    .font(DesignSystem.Typography.footnoteFont)
                    .foregroundColor(DesignSystem.Colors.primary)
                    .padding(.leading, 30)
            }

            if let err = task.lastError, !err.isEmpty {
                HStack(alignment: .top, spacing: 4) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 10))
                        .foregroundColor(DesignSystem.Colors.danger)
                    Text(err)
                        .font(DesignSystem.Typography.footnoteFont)
                        .foregroundColor(DesignSystem.Colors.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .onTapGesture {
            if state?.currentTask == task.id, state?.isRunning == true {
                autoTaskStore.openRunLog(focusTask: task.id)
                haptic(.light)
            }
        }
    }

    /// Per-task enable is server-owned; sends the toggle and the refreshed
    /// state reply updates the row.
    private func taskBinding(_ task: AutoTaskInfo) -> Binding<Bool> {
        Binding(
            get: { task.enabled },
            set: { autoTaskStore.autoTaskToggle(task: task.id, enabled: $0) }
        )
    }

    // MARK: — History

    private var historySection: some View {
        Section {
            if autoTaskStore.autoTaskHistoryEntries.isEmpty {
                Text("No runs yet")
                    .font(DesignSystem.Typography.footnoteFont)
                    .foregroundColor(DesignSystem.Colors.textTertiary)
            } else {
                ForEach(Array(autoTaskStore.autoTaskHistoryEntries.enumerated()), id: \.offset) { _, entry in
                    historyRow(entry)
                }
            }
        } header: {
            HStack {
                Text("History")
                Spacer()
                Button {
                    autoTaskStore.autoTaskHistory()
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
                    .font(DesignSystem.Typography.subheadlineFont)
                    .foregroundColor(DesignSystem.Colors.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    Text(entry.status)
                        .font(DesignSystem.Typography.captionFont.weight(.medium))
                        .foregroundColor(historyColor(entry.status))
                    Text("· \(Date(epochSeconds: entry.lastUpdated).relativeTimeShort())")
                        .font(DesignSystem.Typography.captionFont)
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
                    .font(DesignSystem.Typography.calloutFont.weight(.medium))
                    .foregroundColor(DesignSystem.Colors.textSecondary)
                Text(!isConnected
                     ? "Connect to your Mac to view and control auto tasks."
                     : "Tap refresh, or enable Auto Tasks on your Mac.")
                    .font(DesignSystem.Typography.footnoteFont)
                    .foregroundColor(DesignSystem.Colors.textTertiary)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 40)
            .listRowBackground(Color.clear)
        }
    }

    // MARK: — Helpers

    /// SF Symbol names aligned with the Mac `AutoTask.icon` mapping.
    private func taskIcon(_ id: String) -> String {
        switch id {
        case "sourceUpdate":      return "tray.and.arrow.down"
        case "sourcesToIssue":    return "arrow.right.doc.on.clipboard"
        case "implementIssues":   return "hammer"
        case "reviewMerge":       return "arrow.triangle.merge"
        case "reviewCode":        return "checkmark.shield"
        case "reviewDoc":         return "doc.text.magnifyingglass"
        case "reviewConflicts":   return "exclamationmark.triangle"
        case "regression":        return "arrow.uturn.backward.circle"
        case "generateKnowledge": return "brain"
        case "generateDoc":       return "wand.and.stars"
        case "updateIssues":      return "checklist"
        case "updatePlanStatus":  return "chart.bar.doc.horizontal"
        case "loopEngineering":   return "repeat.circle"
        default:                  return "bolt.fill"
        }
    }
}
