import SwiftUI
import SharedProtocol

/// The paired shell: Chat first, then the read-only History (Host API v1 `read` or offline sync) and
/// Settings. Chat is the surface people open the app for, so it is the landing tab and the only one that
/// badges when the desktop needs an answer.
struct RootTabView: View {
    let deviceName: String
    @EnvironmentObject var connection: ConnectionService
    @EnvironmentObject var syncStore: SyncStore
    @EnvironmentObject var llmIdeStore: LlmIdeChatStore
    @EnvironmentObject var usageStore: UsageStore
    @EnvironmentObject var projectsStore: ProjectsStore
    @EnvironmentObject var connectionStore: ConnectionStore

    enum Tab: Hashable { case chat, explorer, tasks, loop, history, settings }
    @State private var selection: Tab = .chat
    @State private var showLiveScanner = false

    var body: some View {
        TabView(selection: $selection) {
            NavigationStack {
                if connectionStore.hasDevice {
                    LlmIdeControlView(embedded: true)
                        .safeAreaInset(edge: .top, spacing: 0) {
                            ContextBar(deviceName: deviceName)
                        }
                } else {
                    LiveChatPairingView { showLiveScanner = true }
                }
            }
            .tabItem { Label("Ask", systemImage: "bubble.left.and.bubble.right.fill") }
            .badge(llmIdeStore.pendingApproval == nil ? 0 : 1)
            .tag(Tab.chat)

            if connection.hostCapabilities?.contains("compose") == true {
                NavigationStack { ExplorerChatView() }
                    .tabItem { Label("Execute", systemImage: "hammer") }
                    .tag(Tab.explorer)
            }

            if connection.hostCapabilities?.contains("compose") == true, connection.hostCapabilities?.contains("read") == true {
                NavigationStack { TasksView() }
                    .tabItem { Label("Auto Tasks", systemImage: "checklist") }
                    .tag(Tab.tasks)
            }

            if connection.hostCapabilities?.contains("compose") == true, connection.hostCapabilities?.contains("read") == true {
                NavigationStack { LoopView() }
                    .tabItem { Label("Loop", systemImage: "arrow.triangle.2.circlepath") }
                    .tag(Tab.loop)
            }

            if connection.servesV1Read || syncStore.phase != .off {
                NavigationStack { ReadChatsView() }
                    .tabItem { Label("History", systemImage: "clock.arrow.circlepath") }
                    .tag(Tab.history)
            }

            NavigationStack { SettingsView() }
                .tabItem { Label("Settings", systemImage: "gearshape.fill") }
                .tag(Tab.settings)
        }
        .tint(DesignSystem.Colors.primary)
        .onChange(of: connection.hostCapabilities) { _ in
            if connection.hostCapabilities?.contains("compose") != true, selection == .explorer || selection == .tasks || selection == .loop { selection = .chat }
        }
        .sheet(isPresented: $showLiveScanner) {
            QRScannerSheet { scan in
                guard let info = scan.desktop else { return }
                connectionStore.save(ip: info.ip, pin: info.pin, hostApiOffer: info.hostApiOffer, source: .qrScan)
                connection.connect(ip: info.ip, pin: info.pin)
            }
        }
        .onAppear { refreshHostData() }
        .onChange(of: connection.connectionStatus) { status in
            if status == .connected { refreshHostData() }
        }
        // The host granted or withdrew a capability, or a different desktop was paired.
        .onChange(of: connection.hostCapabilities) { _ in
            if !connection.servesV1Read { usageStore.resetForNewDevice() }
            refreshHostData()
        }
        // The project picker changed: History shows that project's chats only (API 128).
        .onChange(of: projectsStore.state.selectedId) { _ in
            guard connection.servesV1Read else { return }
            Task { await connection.reads.projectChanged() }
        }
        // `read` gone and no sync: the History tab is gone, so never leave the user on it.
        .onChange(of: connection.servesV1Read) { on in
            if !on, syncStore.phase == .off, selection == .history { selection = .chat }
        }
    }

    private func refreshHostData() {
        guard connection.connectionStatus == .connected else { return }
        // `projects.list` is a `host` command (not gated on `read`): load the picker even when this
        // host serves no read screens. A failed list leaves the v1 team chat available.
        projectsStore.refresh()
        guard connection.servesV1Read else { return }
        usageStore.refresh()
        Task { await connection.reads.refresh() }
    }
}

/// Shown on the Chat tab when only offline sync is enrolled: sync is read-only, so live Chat needs a Host API pairing.
struct LiveChatPairingView: View {
    let onScan: () -> Void
    var body: some View {
        VStack(spacing: DesignSystem.Spacing.lg) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 40))
                .foregroundColor(DesignSystem.Colors.primary)
            Text("Live Chat needs the desktop")
                .font(DesignSystem.Typography.titleFont.weight(.bold))
                .foregroundColor(DesignSystem.Colors.textPrimary)
                .multilineTextAlignment(.center)
            Text("Offline sync only copies chats and history to this iPhone. To send messages, questions and approvals, pair the desktop's live connection.")
                .font(DesignSystem.Typography.bodyFont)
                .foregroundColor(DesignSystem.Colors.textSecondary)
                .multilineTextAlignment(.center)
            Button(action: onScan) {
                Label("Scan live pairing QR", systemImage: "qrcode.viewfinder")
                    .font(DesignSystem.Typography.bodyFont.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
            }
            .buttonStyle(.borderedProminent)
            Text("Desktop: Settings → Phone and browser → Live Chat pairing.")
                .font(DesignSystem.Typography.captionFont)
                .foregroundColor(DesignSystem.Colors.textTertiary)
                .multilineTextAlignment(.center)
        }
        .padding(DesignSystem.Layout.marginMobile)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(DesignSystem.Colors.background)
    }
}

// MARK: — Connection strip

/// Slim strip under the Chat nav bar: which desktop this is, whether the link is live, and a one-tap
/// Reconnect when it isn't.
struct ContextBar: View {
    let deviceName: String
    @EnvironmentObject var connection: ConnectionService
    @EnvironmentObject var connectionStore: ConnectionStore
    @EnvironmentObject var usageStore: UsageStore

    var body: some View {
        HStack(spacing: DesignSystem.Spacing.sm) {
            if !deviceName.isEmpty {
                HStack(spacing: 6) {
                    Image(systemName: "desktopcomputer")
                    Text(deviceName).lineLimit(1)
                }
                .font(DesignSystem.Typography.captionFont.weight(.medium))
                .foregroundColor(DesignSystem.Colors.textSecondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(DesignSystem.Colors.surfaceSecondary, in: Capsule())
                .accessibilityLabel("Desktop \(deviceName)")
            }

            Spacer(minLength: 0)

            if connection.connectionStatus == .disconnected, connectionStore.hasDevice {
                Button("Reconnect") {
                    connection.connect(ip: connectionStore.deviceIP, pin: connectionStore.devicePIN)
                }
                .font(DesignSystem.Typography.captionFont.weight(.semibold))
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
            if let mode = UsageStore.permissionLabel(usageStore.permissionMode) {
                Text(mode.text)
                    .font(DesignSystem.Typography.captionFont.weight(.semibold))
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .foregroundColor(mode.isRisky ? .white : DesignSystem.Colors.textSecondary)
                    .background(mode.isRisky ? DesignSystem.Colors.danger : DesignSystem.Colors.surfaceSecondary,
                                in: Capsule())
                    .accessibilityLabel("Desktop permission mode: \(mode.text)")
            }
            StatusPill(status: connection.connectionStatus)
        }
        .padding(.horizontal, DesignSystem.Spacing.md)
        .padding(.vertical, DesignSystem.Spacing.xs)
        .background(DesignSystem.Colors.background)
        .overlay(alignment: .bottom) { Divider() }
    }
}

struct StatusPill: View {
    let status: ConnectionService.ConnectionStatus

    private var color: Color {
        switch status {
        case .connected:    return DesignSystem.Colors.success
        case .connecting:   return .orange
        case .disconnected: return DesignSystem.Colors.danger
        }
    }
    private var label: String {
        switch status {
        case .connected:    return "Live"
        case .connecting:   return "Connecting"
        case .disconnected: return "Offline"
        }
    }

    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(label)
                .font(DesignSystem.Typography.captionFont.weight(.medium))
                .foregroundColor(DesignSystem.Colors.textSecondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Connection \(label)")
    }
}
