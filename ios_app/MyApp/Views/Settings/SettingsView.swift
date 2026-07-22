import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var connectionStore: ConnectionStore
    @EnvironmentObject var controlService: ControlService

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DesignSystem.Spacing.lg) {

                // Connection card
                VStack(alignment: .leading, spacing: DesignSystem.Spacing.sm) {
                    Text("Connection")
                        .font(.system(size: DesignSystem.Typography.title, weight: .bold))
                        .foregroundColor(DesignSystem.Colors.textPrimary)

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
                                        .font(.system(size: DesignSystem.Typography.body,
                                                      weight: .semibold, design: .monospaced))
                                        .foregroundColor(DesignSystem.Colors.textPrimary)
                                    HStack(spacing: 4) {
                                        Circle()
                                            .fill(statusColor)
                                            .frame(width: 6, height: 6)
                                        Text(statusLabel)
                                            .font(.system(size: DesignSystem.Typography.footnote))
                                            .foregroundColor(DesignSystem.Colors.textSecondary)
                                    }
                                }
                                Spacer()
                                Text(":\(connectionStore.devicePort)")
                                    .font(.system(size: DesignSystem.Typography.footnote,
                                                  design: .monospaced))
                                    .foregroundColor(DesignSystem.Colors.textTertiary)
                            }
                            .padding(DesignSystem.Spacing.md)

                            Divider().padding(.horizontal, DesignSystem.Spacing.md)

                            Button(role: .destructive) {
                                controlService.stopViewing()
                                controlService.disconnect()
                                connectionStore.clear()
                            } label: {
                                HStack {
                                    Image(systemName: "xmark.circle")
                                    Text("Forget this Mac")
                                        .font(.system(size: DesignSystem.Typography.body,
                                                      weight: .medium))
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
                    } else {
                        Text("No Mac connected. Open the main screen to connect.")
                            .font(.system(size: DesignSystem.Typography.body))
                            .foregroundColor(DesignSystem.Colors.textSecondary)
                            .padding(DesignSystem.Spacing.md)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(DesignSystem.Colors.surface)
                            .cornerRadius(DesignSystem.Layout.cornerRadiusL)
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
                            .font(.system(size: DesignSystem.Typography.body, weight: .medium))
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
                            .font(.system(size: DesignSystem.Typography.body, weight: .medium))
                            .foregroundColor(DesignSystem.Colors.textPrimary)
                        Spacer()
                        Text(appVersion)
                            .font(.system(size: DesignSystem.Typography.subheadline, design: .monospaced))
                            .foregroundColor(DesignSystem.Colors.textTertiary)
                    }
                    .padding(DesignSystem.Spacing.md)

                    Divider().padding(.horizontal, DesignSystem.Spacing.md)

                    Text("LLM IDE connects directly to your Mac over Wi‑Fi or Tailscale. No cloud, no account — your screen never leaves your network.")
                        .font(.system(size: DesignSystem.Typography.footnote))
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

    private var appVersion: String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
        return "\(version) (\(build))"
    }

    private var statusColor: Color {
        switch controlService.connectionStatus {
        case .connected:    return DesignSystem.Colors.success
        case .connecting:   return DesignSystem.Colors.primary
        case .disconnected: return DesignSystem.Colors.textTertiary
        }
    }

    private var statusLabel: String {
        switch controlService.connectionStatus {
        case .connected:    return "Connected"
        case .connecting:   return "Connecting…"
        case .disconnected: return "Disconnected"
        }
    }
}
