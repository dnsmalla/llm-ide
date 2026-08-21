import SwiftUI
import SharedProtocol

/// Host shell for a paired Mac. Renders **native data** from the Mac (Explore
/// sessions, Auto Task state) — not a pixel screen mirror. Chat / Explore /
/// Auto open as full-screen sheets for work.
struct MobileHomeView: View {
    let deviceName: String
    @EnvironmentObject var connection: ConnectionService
    @EnvironmentObject var llmIdeStore: LlmIdeChatStore
    @EnvironmentObject var explorerStore: ExplorerChatStore
    @EnvironmentObject var autoTaskStore: AutoTaskStore
    @EnvironmentObject var macStatusStore: MacStatusStore
    @EnvironmentObject var connectionStore: ConnectionStore

    @State private var showSettings: Bool = false
    @State private var showLlmIde: Bool = false
    @State private var showExplore: Bool = false
    @State private var showAutoTask: Bool = false

    private var isConnected: Bool { connection.connectionStatus == .connected }
    private var autoState: AutoTaskState? { autoTaskStore.autoTaskState }

    var body: some View {
        ZStack {
            DesignSystem.Colors.background.ignoresSafeArea()

            if isConnected {
                nativeDashboard
            } else {
                disconnectedHint
            }

            if let error = connection.errorMessage {
                VStack {
                    errorBanner(error)
                    Spacer()
                }
            }

            if let status = autoTaskStore.actionStatus {
                VStack {
                    Spacer()
                    actionToast(status).padding(.bottom, 24)
                }
                .allowsHitTesting(false)
            }
        }
        .navigationTitle(deviceName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarContent }
        .toolbarBackground(DesignSystem.Colors.background, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .navigationDestination(isPresented: $showSettings) { SettingsView() }
        .sheet(isPresented: $showLlmIde) {
            LlmIdeControlView()
                .environmentObject(connection)
                .environmentObject(llmIdeStore)
        }
        .sheet(isPresented: $showExplore) {
            ExplorerChatView()
                .environmentObject(connection)
                .environmentObject(explorerStore)
        }
        .sheet(isPresented: $showAutoTask) {
            AutoTaskView()
                .environmentObject(connection)
                .environmentObject(autoTaskStore)
        }
        .onAppear { refreshMacData() }
        .onChange(of: connection.connectionStatus) { status in
            if status == .connected { refreshMacData() }
        }
        .animation(.easeInOut(duration: 0.2), value: autoTaskStore.actionStatus)
    }

    // MARK: — Native dashboard (data mirror, not screen mirror)

    private var nativeDashboard: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DesignSystem.Spacing.lg) {
                Text("Work from your iPhone — data syncs with your Mac over the local connection.")
                    .font(DesignSystem.Typography.footnoteFont)
                    .foregroundColor(DesignSystem.Colors.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)

                macStatusStrip
                autoTaskSummaryCard
                exploreSummaryCard
                chatAction
            }
            .padding(DesignSystem.Spacing.md)
        }
    }

    private var macStatusStrip: some View {
        VStack(alignment: .leading, spacing: DesignSystem.Spacing.xs) {
            HStack(spacing: DesignSystem.Spacing.sm) {
                statusDot("Backend", up: macStatusStore.macStatus?.backendUp == true)
                statusDot("Mobile", up: macStatusStore.macStatus?.mobileControlUp == true)
                Spacer()
            }
            if let status = macStatusStore.macStatus {
                if let project = status.projectName, !project.isEmpty {
                    Text(project)
                        .font(DesignSystem.Typography.subheadlineFont.weight(.semibold))
                        .foregroundColor(DesignSystem.Colors.textPrimary)
                        .lineLimit(1)
                }
                HStack(spacing: DesignSystem.Spacing.sm) {
                    if let branch = status.gitBranch, !branch.isEmpty {
                        Label(branch, systemImage: "arrow.triangle.branch")
                            .font(DesignSystem.Typography.captionFont)
                            .foregroundColor(DesignSystem.Colors.textSecondary)
                            .lineLimit(1)
                    }
                    if let ws = status.workspacePath, !ws.isEmpty {
                        Text(ws)
                            .font(DesignSystem.Typography.captionFont.monospaced())
                            .foregroundColor(DesignSystem.Colors.textTertiary)
                            .lineLimit(1)
                    }
                }
            } else {
                Text("Loading Mac status…")
                    .font(DesignSystem.Typography.captionFont)
                    .foregroundColor(DesignSystem.Colors.textTertiary)
            }
        }
        .padding(DesignSystem.Spacing.md)
        .background(DesignSystem.Colors.surfaceSecondary)
        .clipShape(RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusM))
    }

    private func statusDot(_ label: String, up: Bool) -> some View {
        HStack(spacing: 4) {
            Circle()
                .fill(up ? DesignSystem.Colors.success : DesignSystem.Colors.danger)
                .frame(width: 7, height: 7)
            Text(label)
                .font(DesignSystem.Typography.captionFont.weight(.medium))
                .foregroundColor(DesignSystem.Colors.textSecondary)
        }
    }

    private var autoTaskSummaryCard: some View {
        VStack(alignment: .leading, spacing: DesignSystem.Spacing.sm) {
            HStack {
                Label("Auto Tasks", systemImage: "bolt.fill")
                    .font(DesignSystem.Typography.headlineFont.weight(.semibold))
                    .foregroundColor(DesignSystem.Colors.textPrimary)
                Spacer()
                if autoState?.isRunning == true {
                    HStack(spacing: 4) {
                        ProgressView().scaleEffect(0.65)
                        Text("Running")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(DesignSystem.Colors.primary)
                    }
                }
            }

            if let state = autoState {
                Text(state.statusMessage ?? (state.masterEnabled ? "Enabled on Mac" : "Disabled on Mac"))
                    .font(DesignSystem.Typography.subheadlineFont)
                    .foregroundColor(DesignSystem.Colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: DesignSystem.Spacing.sm) {
                    metricPill("Created", value: state.createdCount)
                    metricPill("Done", value: state.implementedCount)
                    metricPill("Failed", value: state.failedCount)
                }

                if let current = state.currentTask,
                   let label = state.tasks.first(where: { $0.id == current })?.label {
                    Text("Current: \(label)")
                        .font(DesignSystem.Typography.captionFont)
                        .foregroundColor(DesignSystem.Colors.textTertiary)
                }

                if let step = state.currentStep, !step.isEmpty, state.isRunning {
                    HStack(alignment: .top, spacing: 6) {
                        ProgressView().scaleEffect(0.65)
                        Text(step)
                            .font(DesignSystem.Typography.captionFont)
                            .foregroundColor(DesignSystem.Colors.primary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                Button {
                    autoTaskStore.openRunLog(focusTask: state.currentTask)
                    showAutoTask = true
                } label: {
                    Label("View live log", systemImage: "doc.text")
                        .font(DesignSystem.Typography.footnoteFont.weight(.semibold))
                }
                .buttonStyle(.bordered)
                .tint(DesignSystem.Colors.primary)
            } else {
                Text("Loading auto-task state from Mac…")
                    .font(DesignSystem.Typography.subheadlineFont)
                    .foregroundColor(DesignSystem.Colors.textTertiary)
            }

            Button { showAutoTask = true } label: {
                Text("Open Auto Tasks")
                    .font(DesignSystem.Typography.bodyFont.weight(.semibold))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(DesignSystem.Colors.primary)
        }
        .padding(DesignSystem.Spacing.md)
        .background(DesignSystem.Colors.surfaceSecondary)
        .clipShape(RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusM))
    }

    private var exploreSummaryCard: some View {
        VStack(alignment: .leading, spacing: DesignSystem.Spacing.sm) {
            Label("Explorer chat", systemImage: "sidebar.left")
                .font(DesignSystem.Typography.headlineFont.weight(.semibold))
                .foregroundColor(DesignSystem.Colors.textPrimary)

            if let current = explorerStore.exploreCurrent {
                Text("Active: \(current.title.isEmpty ? "Untitled" : current.title)")
                    .font(DesignSystem.Typography.subheadlineFont)
                    .foregroundColor(DesignSystem.Colors.textSecondary)
                if let last = current.history.last(where: { !$0.text.isEmpty }) {
                    Text(last.role == .user ? "You: \(last.text)" : last.text)
                        .font(DesignSystem.Typography.footnoteFont)
                        .foregroundColor(DesignSystem.Colors.textTertiary)
                        .lineLimit(2)
                }
            } else if explorerStore.exploreSessions.isEmpty {
                Text("No explorer sessions yet on this Mac.")
                    .font(DesignSystem.Typography.subheadlineFont)
                    .foregroundColor(DesignSystem.Colors.textTertiary)
            } else {
                Text("\(explorerStore.exploreSessions.count) session(s) on Mac")
                    .font(DesignSystem.Typography.subheadlineFont)
                    .foregroundColor(DesignSystem.Colors.textSecondary)
            }

            if !explorerStore.exploreSessions.isEmpty {
                ForEach(explorerStore.exploreSessions.prefix(3), id: \.id) { session in
                    HStack {
                        Text(session.title.isEmpty ? "Untitled" : session.title)
                            .font(DesignSystem.Typography.footnoteFont)
                            .foregroundColor(DesignSystem.Colors.textPrimary)
                            .lineLimit(1)
                        Spacer()
                        Text(Date(epochSeconds: session.lastUsedAt).relativeTimeShort())
                            .font(DesignSystem.Typography.captionFont)
                            .foregroundColor(DesignSystem.Colors.textTertiary)
                    }
                }
            }

            Button { showExplore = true } label: {
                Text("Open Explorer")
                    .font(DesignSystem.Typography.bodyFont.weight(.semibold))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .tint(DesignSystem.Colors.primary)
        }
        .padding(DesignSystem.Spacing.md)
        .background(DesignSystem.Colors.surfaceSecondary)
        .clipShape(RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusM))
    }

    private var chatAction: some View {
        Button { showLlmIde = true } label: {
            featureRow(icon: "bubble.left.and.text.bubble.right", title: "llm-agent", subtitle: "Shared chat with your Mac")
        }
    }

    private func featureRow(icon: String, title: String, subtitle: String) -> some View {
        HStack(spacing: DesignSystem.Spacing.md) {
            Image(systemName: icon)
                .font(.system(size: 20))
                .foregroundColor(DesignSystem.Colors.primary)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(DesignSystem.Typography.bodyFont.weight(.semibold))
                    .foregroundColor(DesignSystem.Colors.textPrimary)
                Text(subtitle)
                    .font(DesignSystem.Typography.footnoteFont)
                    .foregroundColor(DesignSystem.Colors.textTertiary)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(DesignSystem.Colors.textTertiary)
        }
        .padding(DesignSystem.Spacing.md)
        .background(DesignSystem.Colors.surfaceSecondary)
        .clipShape(RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusM))
    }

    private func metricPill(_ label: String, value: Int) -> some View {
        VStack(spacing: 2) {
            Text("\(value)")
                .font(DesignSystem.Typography.title3Font.weight(.bold).design(.rounded))
                .foregroundColor(DesignSystem.Colors.textPrimary)
            Text(label)
                .font(DesignSystem.Typography.captionFont)
                .foregroundColor(DesignSystem.Colors.textTertiary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .background(DesignSystem.Colors.background.opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusS))
    }

    private func refreshMacData() {
        guard isConnected else { return }
        macStatusStore.requestMacStatus()
        autoTaskStore.refreshAll()
        explorerStore.exploreListSessions()
    }

    // MARK: — Disconnected

    private var disconnectedHint: some View {
        VStack(spacing: DesignSystem.Spacing.md) {
            if connection.connectionStatus == .connecting {
                ProgressView()
                    .tint(DesignSystem.Colors.primary)
            } else {
                Image(systemName: "wifi.slash")
                    .font(.system(size: 44))
                    .foregroundColor(DesignSystem.Colors.textTertiary)
            }
            Text(connection.connectionStatus == .connecting ? "Connecting…" : "Not connected")
                .font(DesignSystem.Typography.title2Font.weight(.semibold))
                .foregroundColor(DesignSystem.Colors.textPrimary)
            if connection.connectionStatus == .disconnected {
                Text("Your Mac is still saved. Reconnect now, or reopen the app once it's back online.")
                    .font(DesignSystem.Typography.subheadlineFont)
                    .foregroundColor(DesignSystem.Colors.textTertiary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, DesignSystem.Spacing.lg)
                Button {
                    connection.connectDirect(
                        ip: connectionStore.deviceIP,
                        port: connectionStore.devicePort,
                        pin: connectionStore.devicePIN
                    )
                } label: {
                    Text("Reconnect")
                        .font(DesignSystem.Typography.bodyFont.weight(.semibold))
                        .frame(maxWidth: 200)
                }
                .buttonStyle(.borderedProminent)
                .tint(DesignSystem.Colors.primary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: — Error banner

    private func errorBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: DesignSystem.Spacing.sm) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 14))
                .foregroundColor(DesignSystem.Colors.danger)
            Text(message)
                .font(.system(size: 13))
                .foregroundColor(.white)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            Button { connection.errorMessage = nil } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(.white.opacity(0.7))
            }
        }
        .padding(DesignSystem.Spacing.md)
        .background(Color(red: 0.25, green: 0.07, blue: 0.09).opacity(0.95))
        .overlay(
            RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusM)
                .stroke(DesignSystem.Colors.danger.opacity(0.5), lineWidth: 1)
        )
        .cornerRadius(DesignSystem.Layout.cornerRadiusM)
        .padding(.horizontal, DesignSystem.Spacing.md)
        .padding(.top, DesignSystem.Spacing.sm)
    }

    // MARK: — Toolbar

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            HStack(spacing: DesignSystem.Spacing.md) {
                Button { refreshMacData() } label: {
                    Image(systemName: "arrow.clockwise")
                        .foregroundColor(DesignSystem.Colors.textSecondary)
                }
                .accessibilityLabel("Refresh Mac status")
                HStack(spacing: 5) {
                    Circle().fill(statusColor).frame(width: 8, height: 8)
                    Text(statusLabel)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(DesignSystem.Colors.textSecondary)
                }
                Menu {
                    Button { showSettings = true } label: {
                        Label("Settings", systemImage: "gear")
                    }
                    Divider()
                    Button {
                        connection.closeConnection()
                    } label: {
                        Label("Close Connection", systemImage: "wifi.slash")
                    }
                    Button(role: .destructive) {
                        connection.disconnect()
                        connectionStore.clear()
                        // Drop every mirrored surface too: clearing the pairing
                        // alone left the previous Mac's transcripts, session ids
                        // and status on screen for the next device.
                        connection.resetStoresForNewDevice()
                    } label: {
                        Label("Forget this Mac", systemImage: "xmark.circle")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle.fill")
                        .font(DesignSystem.Typography.headlineFont)
                        .foregroundColor(DesignSystem.Colors.textSecondary)
                }
                .accessibilityLabel("More actions")
            }
        }
    }

    private func actionToast(_ message: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "checkmark.circle.fill")
                .foregroundColor(DesignSystem.Colors.success)
            Text(message)
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(.white)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.ultraThinMaterial.opacity(0.9), in: Capsule())
        .overlay(Capsule().stroke(Color.white.opacity(0.12), lineWidth: 1))
    }

    private var statusColor: Color {
        switch connection.connectionStatus {
        case .connected:    return .green
        case .connecting:   return .orange
        case .disconnected: return .red
        }
    }

    private var statusLabel: String {
        switch connection.connectionStatus {
        case .connected:    return "Live"
        case .connecting:   return "Connecting"
        case .disconnected: return "Offline"
        }
    }
}
