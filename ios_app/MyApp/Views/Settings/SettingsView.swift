import SwiftUI
import SharedProtocol

struct SettingsView: View {
    @EnvironmentObject var connectionStore: ConnectionStore
    @EnvironmentObject var connection: ConnectionService

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DesignSystem.Spacing.lg) {

                // Connection card
                VStack(alignment: .leading, spacing: DesignSystem.Spacing.sm) {
                    Text("CONNECTION")
                        .font(DesignSystem.Typography.footnoteFont.weight(.semibold))
                        .foregroundColor(DesignSystem.Colors.textTertiary)
                        .padding(.leading, DesignSystem.Spacing.xs)

                    if connectionStore.hasDevice || connection.isDemo {
                        VStack(spacing: 0) {
                            HStack(spacing: DesignSystem.Spacing.md) {
                                ZStack {
                                    Circle()
                                        .fill(statusColor.opacity(0.12))
                                        .frame(width: 40, height: 40)
                                    Image(systemName: "desktopcomputer")
                                        .font(.system(size: 18))
                                        .foregroundColor(statusColor)
                                }
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(connection.isDemo ? "Demo Mac" : connectionStore.deviceIP)
                                        .font(DesignSystem.Typography.bodyFont
                                            .weight(.semibold).monospaced())
                                        .foregroundColor(DesignSystem.Colors.textPrimary)
                                    HStack(spacing: 4) {
                                        Circle()
                                            .fill(statusColor)
                                            .frame(width: 6, height: 6)
                                        Text(statusLabel)
                                            .font(DesignSystem.Typography.footnoteFont)
                                            .foregroundColor(DesignSystem.Colors.textSecondary)
                                    }
                                }
                                Spacer()
                                Text(connection.isDemo ? "sample data" : ":\(connectionStore.devicePort)")
                                    .font(DesignSystem.Typography.footnoteFont.monospaced())
                                    .foregroundColor(DesignSystem.Colors.textTertiary)
                            }
                            .padding(DesignSystem.Spacing.md)

                            Divider().padding(.horizontal, DesignSystem.Spacing.md)

                            macFeatures

                            Divider().padding(.horizontal, DesignSystem.Spacing.md)

                            Button {
                                if connection.connectionStatus == .disconnected {
                                    connection.connectDirect(ip: connectionStore.deviceIP,
                                                             port: connectionStore.devicePort,
                                                             pin: connectionStore.devicePIN)
                                } else {
                                    connection.closeConnection()
                                }
                            } label: {
                                HStack {
                                    Image(systemName: connection.connectionStatus == .disconnected
                                          ? "arrow.clockwise" : "wifi.slash")
                                    Text(connection.connectionStatus == .disconnected
                                         ? "Reconnect" : "Close connection")
                                        .font(DesignSystem.Typography.bodyFont.weight(.medium))
                                }
                                .frame(maxWidth: .infinity)
                                .padding(DesignSystem.Spacing.md)
                                .foregroundColor(DesignSystem.Colors.primary)
                            }
                            .buttonStyle(.plain)

                            Divider().padding(.horizontal, DesignSystem.Spacing.md)

                            Button(role: .destructive) {
                                connection.disconnect()
                                connectionStore.clear()
                                connection.resetStoresForNewDevice()
                            } label: {
                                HStack {
                                    Image(systemName: "xmark.circle")
                                    Text("Forget this Mac")
                                        .font(DesignSystem.Typography.bodyFont.weight(.medium))
                                }
                                .frame(maxWidth: .infinity)
                                .padding(DesignSystem.Spacing.md)
                                .foregroundColor(DesignSystem.Colors.danger)
                            }
                            .buttonStyle(.plain)
                        }
                        .background(DesignSystem.Colors.surface)
                        .cornerRadius(DesignSystem.Layout.cornerRadiusL)
                        .shadow(color: .black.opacity(DesignSystem.Layout.shadowOpacity),
                                radius: DesignSystem.Layout.shadowRadius, x: 0, y: 2)
                    }
                }

                // Help
                NavigationLink {
                    HelpView()
                } label: {
                    HStack(spacing: DesignSystem.Spacing.md) {
                        Image(systemName: "questionmark.circle.fill")
                            .font(.system(size: 20))
                            .foregroundColor(DesignSystem.Colors.primary)
                        Text("Help & FAQ")
                            .font(DesignSystem.Typography.bodyFont.weight(.medium))
                            .foregroundColor(DesignSystem.Colors.textPrimary)
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundColor(DesignSystem.Colors.textTertiary)
                    }
                    .padding(DesignSystem.Spacing.md)
                    .background(DesignSystem.Colors.surface)
                    .cornerRadius(DesignSystem.Layout.cornerRadiusL)
                }
                .buttonStyle(.plain)

                // About
                VStack(spacing: 0) {
                    HStack(spacing: DesignSystem.Spacing.md) {
                        Image(systemName: "info.circle.fill")
                            .font(.system(size: 20))
                            .foregroundColor(DesignSystem.Colors.primary)
                        Text("Version")
                            .font(DesignSystem.Typography.bodyFont.weight(.medium))
                            .foregroundColor(DesignSystem.Colors.textPrimary)
                        Spacer()
                        Text(appVersion)
                            .font(DesignSystem.Typography.subheadlineFont.monospaced())
                            .foregroundColor(DesignSystem.Colors.textTertiary)
                    }
                    .padding(DesignSystem.Spacing.md)

                    Divider().padding(.horizontal, DesignSystem.Spacing.md)

                    Text("LLM-IDE connects directly to your Mac over Wi‑Fi or Tailscale. No cloud, no account — your screen never leaves your network.")
                        .font(DesignSystem.Typography.footnoteFont)
                        .foregroundColor(DesignSystem.Colors.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(DesignSystem.Spacing.md)
                }
                .background(DesignSystem.Colors.surface)
                .cornerRadius(DesignSystem.Layout.cornerRadiusL)
            }
            .padding(DesignSystem.Layout.marginMobile)
        }
        .background(DesignSystem.Colors.background)
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.large)
    }

    /// What the paired Mac says it can do, so a missing tab is explained rather than mysterious.
    @ViewBuilder
    private var macFeatures: some View {
        if let caps = connection.macCapabilities {
            let labels: [(String, String)] = [
                (MobileProtocol.Capability.chat, "Chat"), (MobileProtocol.Capability.explorer, "Explorer"),
                (MobileProtocol.Capability.autoTasks, "Auto Tasks"), (MobileProtocol.Capability.loop, "Loop"),
                (MobileProtocol.Capability.generation, "Doc Gen"), (MobileProtocol.Capability.llmDoc, "Docs"),
            ]
            let missing = labels.filter { !caps.contains($0.0) }.map(\.1)
            VStack(alignment: .leading, spacing: 4) {
                Text("Mac features")
                    .font(DesignSystem.Typography.footnoteFont.weight(.semibold))
                    .foregroundColor(DesignSystem.Colors.textSecondary)
                Text(labels.filter { caps.contains($0.0) }.map(\.1).joined(separator: " · "))
                    .font(DesignSystem.Typography.footnoteFont)
                    .foregroundColor(DesignSystem.Colors.textPrimary)
                if !missing.isEmpty {
                    Text("Not available on this Mac: \(missing.joined(separator: ", ")). Update LLM-IDE on the Mac to unlock them.")
                        .font(DesignSystem.Typography.captionFont)
                        .foregroundColor(DesignSystem.Colors.textTertiary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(DesignSystem.Spacing.md)
        }
    }

    private var appVersion: String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
        return "\(version) (\(build))"
    }

    private var statusColor: Color {
        switch connection.connectionStatus {
        case .connected:    return DesignSystem.Colors.success
        case .connecting:   return DesignSystem.Colors.primary
        case .disconnected: return DesignSystem.Colors.textTertiary
        }
    }

    private var statusLabel: String {
        switch connection.connectionStatus {
        case .connected:    return "Connected"
        case .connecting:   return "Connecting…"
        case .disconnected: return "Disconnected"
        }
    }
}
