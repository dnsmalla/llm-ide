import SwiftUI
import SharedProtocol

/// The paired-Mac shell: Chat first, everything project-related on its own tab.
/// Chat is the surface people open the app for, so it is the landing tab and
/// the only one that badges when the Mac needs an answer.
struct RootTabView: View {
    let deviceName: String
    @EnvironmentObject var connection: ConnectionService
    @EnvironmentObject var llmIdeStore: LlmIdeChatStore
    @EnvironmentObject var explorerStore: ExplorerChatStore
    @EnvironmentObject var autoTaskStore: AutoTaskStore
    @EnvironmentObject var loopStore: LoopStore
    @EnvironmentObject var macStatusStore: MacStatusStore

    enum Tab: Hashable { case chat, project, settings }
    @State private var selection: Tab = .chat

    private var isConnected: Bool { connection.connectionStatus == .connected }

    var body: some View {
        TabView(selection: $selection) {
            NavigationStack {
                LlmIdeControlView(embedded: true)
                    .safeAreaInset(edge: .top, spacing: 0) {
                        ContextBar(deviceName: deviceName) { selection = .project }
                    }
            }
            .tabItem { Label("Chat", systemImage: "bubble.left.and.bubble.right.fill") }
            .badge(llmIdeStore.pendingApproval == nil ? 0 : 1)
            .tag(Tab.chat)

            ProjectView(deviceName: deviceName)
                .tabItem { Label("Project", systemImage: "folder.fill") }
                .badge(explorerStore.pendingApproval == nil ? 0 : 1)
                .tag(Tab.project)

            NavigationStack { SettingsView() }
                .tabItem { Label("Settings", systemImage: "gearshape.fill") }
                .tag(Tab.settings)
        }
        .tint(DesignSystem.Colors.primary)
        .overlay(alignment: .bottom) {
            if let status = autoTaskStore.actionStatus {
                actionToast(status)
                    .padding(.bottom, 64)
                    .allowsHitTesting(false)
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: autoTaskStore.actionStatus)
        .onAppear { refreshMacData() }
        .onChange(of: connection.connectionStatus) { status in
            if status == .connected { refreshMacData() }
        }
    }

    private func refreshMacData() {
        guard isConnected else { return }
        macStatusStore.requestMacStatus()
        autoTaskStore.refreshAll()
        loopStore.refreshAll()
        explorerStore.exploreListSessions()
    }

    private func actionToast(_ message: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "checkmark.circle.fill")
                .foregroundColor(DesignSystem.Colors.success)
            Text(message)
                .font(DesignSystem.Typography.footnoteFont.weight(.medium))
                .foregroundColor(.white)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.ultraThinMaterial.opacity(0.9), in: Capsule())
        .overlay(Capsule().stroke(Color.white.opacity(0.12), lineWidth: 1))
    }
}

// MARK: — Connection / project strip

/// Slim strip under the Chat nav bar: which project the Mac is on, whether the
/// link is live, and a one-tap Reconnect when it isn't. Tapping the project
/// chip jumps to the Project tab.
struct ContextBar: View {
    let deviceName: String
    var onProjectTap: () -> Void
    @EnvironmentObject var connection: ConnectionService
    @EnvironmentObject var connectionStore: ConnectionStore
    @EnvironmentObject var macStatusStore: MacStatusStore

    private var projectLabel: String {
        if let name = macStatusStore.macStatus?.projectName, !name.isEmpty { return name }
        return deviceName
    }

    var body: some View {
        HStack(spacing: DesignSystem.Spacing.sm) {
            Button(action: onProjectTap) {
                HStack(spacing: 6) {
                    Image(systemName: "folder")
                    Text(projectLabel).lineLimit(1)
                    if let branch = macStatusStore.macStatus?.gitBranch, !branch.isEmpty {
                        Image(systemName: "arrow.triangle.branch")
                        Text(branch).lineLimit(1)
                    }
                }
                .font(DesignSystem.Typography.captionFont.weight(.medium))
                .foregroundColor(DesignSystem.Colors.textSecondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(DesignSystem.Colors.surfaceSecondary, in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Project \(projectLabel). Opens the Project tab")

            Spacer(minLength: 0)

            if connection.connectionStatus == .disconnected, !connection.isDemo {
                Button("Reconnect") {
                    connection.connectDirect(ip: connectionStore.deviceIP,
                                             port: connectionStore.devicePort,
                                             pin: connectionStore.devicePIN)
                }
                .font(DesignSystem.Typography.captionFont.weight(.semibold))
                .buttonStyle(.bordered)
                .controlSize(.small)
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
