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

                    if connectionStore.hasDevice {
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
                                    Text(connectionStore.deviceIP)
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
                                Text(connectionStore.hostApiPort > 0 ? ":\(connectionStore.hostApiPort)" : "")
                                    .font(DesignSystem.Typography.footnoteFont.monospaced())
                                    .foregroundColor(DesignSystem.Colors.textTertiary)
                            }
                            .padding(DesignSystem.Spacing.md)

                            Divider().padding(.horizontal, DesignSystem.Spacing.md)

                            hostFeatures

                            Divider().padding(.horizontal, DesignSystem.Spacing.md)

                            Button {
                                if connection.connectionStatus == .disconnected {
                                    connection.connect(ip: connectionStore.deviceIP, pin: connectionStore.devicePIN)
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
                                    Text("Forget this desktop")
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

                SyncSettingsCard()

                SourceReadSettingsCard()

                if connection.servesV1Read {
                    NavigationLink { UsageView() } label: {
                        HStack(spacing: DesignSystem.Spacing.md) {
                            Image(systemName: "gauge.with.dots.needle.67percent")
                                .font(.system(size: 20))
                                .foregroundColor(DesignSystem.Colors.primary)
                            Text("Usage & limits")
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

                    Text("LLM-IDE connects directly to your desktop over an encrypted, certificate-pinned link on Wi‑Fi or Tailscale. Offline sync and Box / GitLab reads go straight to the storage you chose — no LLM-IDE cloud.")
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

    /// What the paired desktop says it serves, so a missing feature is explained rather than mysterious.
    @ViewBuilder
    private var hostFeatures: some View {
        if let caps = connection.hostCapabilities {
            let labels: [(String, String)] = [
                (HostApiCommand.chatSend.capability, "Chat"), (HostApiCommand.approvalsAnswer.capability, "Questions"),
                (HostApiCommand.toolApprovalsAnswer.capability, "Tool approvals"),
                (HostApiCommand.chatSessions.capability, "History & usage"),
            ]
            let missing = labels.filter { !caps.contains($0.0) }.map(\.1)
            VStack(alignment: .leading, spacing: 4) {
                Text("Desktop features")
                    .font(DesignSystem.Typography.footnoteFont.weight(.semibold))
                    .foregroundColor(DesignSystem.Colors.textSecondary)
                Text(labels.filter { caps.contains($0.0) }.map(\.1).joined(separator: " · "))
                    .font(DesignSystem.Typography.footnoteFont)
                    .foregroundColor(DesignSystem.Colors.textPrimary)
                if !missing.isEmpty {
                    Text("Off or not supported on this desktop: \(missing.joined(separator: ", ")).")
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
