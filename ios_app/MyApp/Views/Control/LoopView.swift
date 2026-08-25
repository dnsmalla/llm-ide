import SwiftUI
import SharedProtocol

/// Native iOS view for the Mac-side Loop: start it, stop it, watch it, and read
/// finished runs. Proxied through the paired Mac WebSocket.
///
/// A control surface, nothing more. Stages are listed so a run is legible but
/// are not editable here — configuring a loop (stage order, budgets, templates,
/// the New Loop wizard) stays on the Mac, where there is room for it and where
/// the work actually happens. Styling mirrors `AutoTaskView` so the two sheets
/// feel like one surface.
struct LoopView: View {
    @EnvironmentObject var connection: ConnectionService
    @EnvironmentObject var loopStore: LoopStore
    @Environment(\.dismiss) private var dismiss

    private var isConnected: Bool { connection.connectionStatus == .connected }
    private var state: LoopState? { loopStore.state }

    var body: some View {
        NavigationStack {
            List {
                if !isConnected || state == nil {
                    emptyState
                } else if let s = state, !s.configured {
                    notConfigured
                } else if let s = state {
                    statusSection(s)
                    stagesSection(s)
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
                } else if let err = loopStore.lastError {
                    StatusBanner(.error(message: err) { loopStore.lastError = nil })
                        .padding(.top, DesignSystem.Spacing.sm)
                }
            }
            .animation(.easeInOut(duration: 0.2), value: state?.running)
            .animation(.easeInOut(duration: 0.2), value: state?.queuedCount)
            .navigationTitle("Loop")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        loopStore.refreshAll()
                    } label: { Image(systemName: "arrow.clockwise") }
                        .accessibilityLabel("Refresh loop status")
                }
            }
            .task {
                loopStore.refreshAll()
                loopStore.startPollingIfRunning()
            }
            .onDisappear { loopStore.stopPolling() }
            .refreshable { loopStore.refreshAll() }
        }
    }

    // MARK: - Sections

    private var emptyState: some View {
        Section {
            Text(isConnected ? "Loading loop status…" : "Connect to your Mac to control the loop.")
                .font(DesignSystem.Typography.footnoteFont)
                .foregroundColor(DesignSystem.Colors.textTertiary)
        }
    }

    private var notConfigured: some View {
        Section("Not set up") {
            Text("This project has no loop yet. Create one on the Mac — Loop → New Loop — and it will show up here.")
                .font(DesignSystem.Typography.footnoteFont)
                .foregroundColor(DesignSystem.Colors.textTertiary)
        }
    }

    @ViewBuilder
    private func statusSection(_ s: LoopState) -> some View {
        Section(s.projectName ?? "Loop") {
            HStack {
                Circle()
                    .fill(statusIndicatorColor(s))
                    .frame(width: 8, height: 8)
                Text(statusHeadline(s))
                    .font(DesignSystem.Typography.headlineFont)
                Spacer()
                if s.running && !s.startedHere {
                    // Distinguish a run this phone began from one the desktop
                    // or the scheduler began — both are watchable and stoppable
                    // from here, but only one of them was your doing.
                    Text("started on Mac")
                        .font(DesignSystem.Typography.footnoteFont)
                        .foregroundColor(DesignSystem.Colors.textTertiary)
                }
            }

            if s.queuedCount > 0 {
                Text(queueDetailText(s))
                    .font(DesignSystem.Typography.footnoteFont)
                    .foregroundColor(DesignSystem.Colors.primaryDark)
            }

            if let summary = s.lastStatusSummary, !s.running {
                LabeledContent("Last run", value: summary)
                    .font(DesignSystem.Typography.footnoteFont)
            }
            if s.maxIterations > 0 {
                LabeledContent("Max iterations", value: "\(s.maxIterations)")
                    .font(DesignSystem.Typography.footnoteFont)
            }

            HStack(spacing: DesignSystem.Spacing.md) {
                Button {
                    loopStore.start()
                } label: {
                    Label("Start", systemImage: "play.fill")
                }
                .buttonStyle(.borderedProminent)
                .disabled(s.running || !isConnected)

                Button {
                    loopStore.stop()
                } label: {
                    Label("Stop", systemImage: "stop.fill")
                }
                .buttonStyle(.bordered)
                .disabled(!s.running || !isConnected)
            }
            .padding(.vertical, 2)

            if let status = loopStore.actionStatus {
                Text(status)
                    .font(DesignSystem.Typography.footnoteFont)
                    .foregroundColor(DesignSystem.Colors.textTertiary)
            }

            if !s.logTail.isEmpty {
                DisclosureGroup("Live log") {
                    // Newest last, matching the Mac's own log pane so the two
                    // read the same way side by side.
                    ForEach(Array(s.logTail.enumerated()), id: \.offset) { _, line in
                        Text(line)
                            .font(DesignSystem.Typography.codeFont)
                            .foregroundColor(DesignSystem.Colors.textTertiary)
                            .textSelection(.enabled)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func stagesSection(_ s: LoopState) -> some View {
        if !s.stages.isEmpty {
            Section("Stages (\(s.stages.count))") {
                ForEach(s.stages) { stage in
                    HStack {
                        Image(systemName: stage.enabled ? "checkmark.circle" : "circle.slash")
                            .foregroundStyle(stage.enabled
                                             ? DesignSystem.Colors.primary
                                             : DesignSystem.Colors.textTertiary)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(stage.name).font(DesignSystem.Typography.bodyFont)
                            Text("\(stage.kind) · \(stage.severity)")
                                .font(DesignSystem.Typography.footnoteFont)
                                .foregroundColor(DesignSystem.Colors.textTertiary)
                        }
                        Spacer()
                        // Only a Mac new enough to send stage ids can run one
                        // stage — hide the button entirely on older snapshots
                        // rather than showing a control that cannot work.
                        // Enabled even for disabled stages: the Mac
                        // force-enables the target for a solo run, matching
                        // the desktop's "Run this stage only".
                        if let stageId = stage.stageId {
                            Button {
                                loopStore.startStage(stageId: stageId)
                            } label: {
                                Image(systemName: "play.circle")
                            }
                            .buttonStyle(.borderless)
                            .disabled(s.running || !isConnected)
                            .accessibilityLabel("Run \(stage.name) only")
                        }
                    }
                }
                Text("Edit stages on the Mac. ▶ runs just that stage.")
                    .font(DesignSystem.Typography.footnoteFont)
                    .foregroundColor(DesignSystem.Colors.textTertiary)
            }
        }
    }

    @ViewBuilder
    private var historySection: some View {
        Section("Recent runs") {
            if loopStore.history.isEmpty {
                Text("No finished runs yet.")
                    .font(DesignSystem.Typography.footnoteFont)
                    .foregroundColor(DesignSystem.Colors.textTertiary)
            } else {
                ForEach(loopStore.history) { run in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Image(systemName: run.statusCode == "success"
                                  ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                                .foregroundStyle(run.statusCode == "success"
                                                 ? DesignSystem.Colors.primary
                                                 : DesignSystem.Colors.danger)
                            Text(run.statusSummary)
                                .font(DesignSystem.Typography.bodyFont)
                                .lineLimit(2)
                        }
                        Text("\(Self.dateText(run.startedAt)) · \(run.iterationsUsed) iteration(s) · \(Self.durationText(run.durationSeconds)) · \(run.trigger)")
                            .font(DesignSystem.Typography.footnoteFont)
                            .foregroundColor(DesignSystem.Colors.textTertiary)
                    }
                }
            }
        }
    }

    // MARK: - Status helpers

    private func statusHeadline(_ s: LoopState) -> String {
        if s.running {
            return s.queuedCount > 0 ? "Running · \(s.queuedCount) queued" : "Running"
        }
        if s.queuedCount > 0 {
            return "\(s.queuedCount) queued"
        }
        return "Idle"
    }

    private func statusIndicatorColor(_ s: LoopState) -> Color {
        if s.running { return DesignSystem.Colors.primary }
        if s.queuedCount > 0 { return DesignSystem.Colors.primaryDark }
        return DesignSystem.Colors.textTertiary
    }

    private func queueDetailText(_ s: LoopState) -> String {
        if s.running {
            let noun = s.queuedCount == 1 ? "run" : "runs"
            return "\(s.queuedCount) \(noun) waiting behind the current one."
        }
        let noun = s.queuedCount == 1 ? "run" : "runs"
        return "\(s.queuedCount) \(noun) waiting to start."
    }

    // MARK: - Formatting

    private static func dateText(_ epoch: Double) -> String {
        let f = DateFormatter()
        f.dateStyle = .short
        f.timeStyle = .short
        return f.string(from: Date(timeIntervalSince1970: epoch))
    }

    private static func durationText(_ seconds: Double) -> String {
        if seconds < 60 { return "\(Int(seconds.rounded()))s" }
        let minutes = Int(seconds) / 60
        let rest = Int(seconds) % 60
        return "\(minutes)m \(rest)s"
    }
}
