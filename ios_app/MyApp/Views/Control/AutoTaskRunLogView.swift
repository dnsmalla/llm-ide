import SwiftUI
import SharedProtocol

/// Live auto-task log mirror — same per-task buffers as the Mac Auto Tasks page.
/// Opens automatically when a run is started from iPhone; Mac pushes log snapshots
/// as lines append to `TaskLogStore`.
struct AutoTaskRunLogView: View {
    @EnvironmentObject var connection: ConnectionService
    @EnvironmentObject var autoTaskStore: AutoTaskStore
    @Environment(\.dismiss) private var dismiss

    @State private var selectedTaskId: String = ""

    private var state: AutoTaskState? { autoTaskStore.autoTaskState }
    private var isRunning: Bool { state?.isRunning == true }

    private var taskGroups: [AutoTaskTaskLogs] {
        if !autoTaskStore.autoTaskLogGroups.isEmpty { return autoTaskStore.autoTaskLogGroups }
        return (state?.tasks ?? []).map { AutoTaskTaskLogs(id: $0.id, label: $0.label, lines: []) }
    }

    private var selectedGroup: AutoTaskTaskLogs? {
        if !selectedTaskId.isEmpty,
           let match = taskGroups.first(where: { $0.id == selectedTaskId }) {
            return match
        }
        if let current = state?.currentTask,
           let match = taskGroups.first(where: { $0.id == current }) {
            return match
        }
        return taskGroups.first(where: { !$0.lines.isEmpty }) ?? taskGroups.first
    }

    var body: some View {
        VStack(spacing: 0) {
            if connection.connectionStatus != .connected {
                StatusBanner(.connection(isConnecting: connection.connectionStatus == .connecting))
            }
            if let err = autoTaskStore.lastError {
                StatusBanner(.error(message: err) { autoTaskStore.clearError() })
            }

            statusHeader
            taskPicker
            logTranscript
        }
        .background(DesignSystem.Colors.background.ignoresSafeArea())
        .navigationTitle("Run Log")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Back") {
                    autoTaskStore.dismissRunLog()
                    dismiss()
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                if isRunning {
                    Button(role: .destructive) {
                        autoTaskStore.autoTaskStop()
                        haptic(.medium)
                    } label: {
                        Label("Stop", systemImage: "stop.fill")
                    }
                } else {
                    Button {
                        autoTaskStore.autoTaskLogsList()
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                }
            }
        }
        .onAppear {
            syncSelectedTask()
            autoTaskStore.runLogViewDidAppear()
        }
        .onDisappear {
            autoTaskStore.runLogViewDidDisappear()
        }
        .onChange(of: state?.currentTask) { _ in syncSelectedTask() }
        .onChange(of: autoTaskStore.autoTaskLogGroups.map(\.id)) { _ in syncSelectedTask() }
    }

    // MARK: — Header

    private var statusHeader: some View {
        VStack(alignment: .leading, spacing: DesignSystem.Spacing.xs) {
            HStack(spacing: 6) {
                if isRunning {
                    ProgressView().scaleEffect(0.75)
                    Text("Running on Mac")
                        .font(DesignSystem.Typography.subheadlineFont.weight(.semibold))
                        .foregroundColor(DesignSystem.Colors.primary)
                } else {
                    Image(systemName: "checkmark.circle")
                        .foregroundColor(DesignSystem.Colors.textTertiary)
                    Text("Idle")
                        .font(DesignSystem.Typography.subheadlineFont.weight(.semibold))
                        .foregroundColor(DesignSystem.Colors.textSecondary)
                }
                Spacer()
                if let msg = state?.statusMessage, !msg.isEmpty {
                    Text(msg)
                        .font(DesignSystem.Typography.captionFont)
                        .foregroundColor(DesignSystem.Colors.textTertiary)
                        .lineLimit(1)
                }
            }
            if let step = state?.currentStep, !step.isEmpty, isRunning {
                Text(step)
                    .font(DesignSystem.Typography.bodyFont)
                    .foregroundColor(DesignSystem.Colors.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(DesignSystem.Spacing.md)
        .background(DesignSystem.Colors.surfaceSecondary)
    }

    // MARK: — Task picker (mirrors Mac left-pane task list)

    private var taskPicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: DesignSystem.Spacing.sm) {
                ForEach(taskGroups) { group in
                    Button {
                        selectedTaskId = group.id
                        haptic(.light)
                    } label: {
                        HStack(spacing: 4) {
                            if state?.currentTask == group.id, isRunning {
                                ProgressView().scaleEffect(0.55)
                            }
                            Text(group.label)
                                .font(DesignSystem.Typography.footnoteFont.weight(.medium))
                            if !group.lines.isEmpty {
                                Text("\(group.lines.count)")
                                    .font(.system(size: 10, weight: .semibold, design: .rounded))
                                    .padding(.horizontal, 5)
                                    .padding(.vertical, 2)
                                    .background(DesignSystem.Colors.primary.opacity(0.15))
                                    .clipShape(Capsule())
                            }
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .foregroundColor(selectedGroup?.id == group.id
                                         ? DesignSystem.Colors.primary
                                         : DesignSystem.Colors.textSecondary)
                        .background(selectedGroup?.id == group.id
                                      ? DesignSystem.Colors.primaryLight
                                      : DesignSystem.Colors.surface)
                        .clipShape(Capsule())
                        .overlay(
                            Capsule().stroke(
                                selectedGroup?.id == group.id
                                    ? DesignSystem.Colors.primary.opacity(0.35)
                                    : DesignSystem.Colors.border,
                                lineWidth: 1
                            )
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, DesignSystem.Spacing.md)
            .padding(.vertical, DesignSystem.Spacing.sm)
        }
        .background(DesignSystem.Colors.background)
    }

    // MARK: — Log transcript

    private var logTranscript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    if let group = selectedGroup {
                        if group.lines.isEmpty {
                            emptyLogState(for: group)
                        } else {
                            ForEach(group.lines) { line in
                                logLineRow(line).id(line.id)
                            }
                        }
                    } else {
                        Text("Waiting for logs from your Mac…")
                            .font(DesignSystem.Typography.footnoteFont)
                            .foregroundColor(DesignSystem.Colors.textTertiary)
                            .frame(maxWidth: .infinity, alignment: .center)
                            .padding(.top, 40)
                    }
                }
                .padding(DesignSystem.Spacing.md)
            }
            .onChange(of: selectedGroup?.lines.last?.id) { id in
                guard let id else { return }
                withAnimation(.easeOut(duration: 0.15)) {
                    proxy.scrollTo(id, anchor: .bottom)
                }
            }
        }
        .background(DesignSystem.Colors.surface)
    }

    private func logLineRow(_ line: AutoTaskLogLine) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(Date(epochSeconds: line.timestamp), format: .dateTime.hour().minute().second())
                .font(DesignSystem.Typography.captionFont.monospaced())
                .foregroundColor(DesignSystem.Colors.textTertiary)
            Text(line.text)
                .font(DesignSystem.Typography.footnoteFont.monospaced())
                .foregroundColor(line.level == "error"
                                 ? DesignSystem.Colors.danger
                                 : DesignSystem.Colors.textPrimary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 2)
    }

    private func emptyLogState(for group: AutoTaskTaskLogs) -> some View {
        VStack(spacing: DesignSystem.Spacing.sm) {
            if state?.currentTask == group.id, isRunning, let step = state?.currentStep, !step.isEmpty {
                HStack(alignment: .top, spacing: 8) {
                    ProgressView().scaleEffect(0.75)
                    Text(step)
                        .font(DesignSystem.Typography.bodyFont)
                        .foregroundColor(DesignSystem.Colors.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Text(isRunning
                 ? "Waiting for log lines from your Mac…"
                 : "No log lines yet for \(group.label).")
                .font(DesignSystem.Typography.footnoteFont)
                .foregroundColor(DesignSystem.Colors.textTertiary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .padding(.top, 40)
    }

    private func syncSelectedTask() {
        if let focus = autoTaskStore.focusedLogTaskId, !focus.isEmpty {
            selectedTaskId = focus
            return
        }
        if let current = state?.currentTask, !current.isEmpty {
            selectedTaskId = current
            return
        }
        if selectedTaskId.isEmpty, let first = taskGroups.first?.id {
            selectedTaskId = first
        }
    }
}
