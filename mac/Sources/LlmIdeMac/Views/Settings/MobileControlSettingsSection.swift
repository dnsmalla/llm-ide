import SwiftUI

/// Mobile Control settings section - provides instructions and toggle for
/// the external auto_swift_aicontrol system that enables iPhone remote desktop
/// and chat with LLM IDE.
struct MobileControlSettingsSection: View {
    @EnvironmentObject var config: AppConfig
    @EnvironmentObject var theme: ThemeStore

    // Paths to the external mobile control system
    private let computerAgentPath = "~/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/services/computer-agent"
    private let iosAppPath = "~/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/apps/ios"

    var body: some View {
        SettingsSectionCard(icon: "iphone", title: "Mobile Control") {
            VStack(alignment: .leading, spacing: Spacing.sm) {

                // Enable/Disable toggle
                Toggle(isOn: $config.mobileControlEnabled) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Enable Mobile Control")
                            .font(Typography.body)
                            .foregroundStyle(theme.current.text)
                        Text("Allow iPhone remote desktop and chat access")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                    }
                }
                .toggleStyle(.switch)

                if config.mobileControlEnabled {
                    Divider().padding(.vertical, 4)

                    // Instructions
                    VStack(alignment: .leading, spacing: Spacing.sm) {
                        Text("Setup Instructions")
                            .font(Typography.section)
                            .foregroundStyle(theme.current.textMuted)

                        instructionStep(
                            number: "1",
                            title: "Start Computer Agent",
                            command: "cd \(computerAgentPath) && npm install && npm start",
                            description: "Starts WebSocket server on port 3006"
                        )

                        instructionStep(
                            number: "2",
                            title: "Open iOS App",
                            command: "open \(iosAppPath)/MyApp.xcodeproj",
                            description: "Run on iPhone (same Wi-Fi network)"
                        )

                        instructionStep(
                            number: "3",
                            title: "Connect",
                            command: "Use 6-digit PIN or QR code",
                            description: "Automatic Bonjour discovery"
                        )

                        Divider().padding(.vertical, 4)

                        // Features
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Features")
                                .font(Typography.section)
                                .foregroundStyle(theme.current.textMuted)

                            featureRow(icon: "app.dashed", title: "Remote Desktop", subtitle: "Screen streaming + touch control")
                            featureRow(icon: "bubble.left.and.bubble.right", title: "LLM IDE Chat", subtitle: "Ask questions, get responses")
                            featureRow(icon: "brain", title: "Code Assistant", subtitle: "File attachments, streaming")
                            featureRow(icon: "person.2", title: "Meeting Agent", subtitle: "AI co-pilot during meetings")
                        }

                        Divider().padding(.vertical, 4)

                        // Status info
                        VStack(alignment: .leading, spacing: 2) {
                            Text("System Status")
                                .font(Typography.section)
                                .foregroundStyle(theme.current.textMuted)

                            HStack(spacing: 8) {
                                Image(systemName: "info.circle")
                                    .font(.system(size: 12))
                                    .foregroundStyle(theme.current.textMuted)
                                Text("Computer Agent runs on :3006, requires same Wi-Fi as iPhone")
                                    .font(Typography.caption)
                                    .foregroundStyle(theme.current.textMuted)
                            }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func instructionStep(number: String, title: String, command: String, description: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(number)
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(theme.current.accent)
                    .frame(width: 20, height: 20)
                    .background(Circle().fill(theme.current.accent.opacity(0.12)))

                Text(title)
                    .font(Typography.body)
                    .foregroundStyle(theme.current.text)
            }

            Text(command)
                .font(Typography.mono)
                .foregroundStyle(theme.current.textMuted)
                .textSelection(.enabled)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(RoundedRectangle(cornerRadius: 4)
                    .fill(theme.current.surface)
                    .overlay(RoundedRectangle(cornerRadius: 4)
                        .stroke(theme.current.border.opacity(0.5), lineWidth: 1)))

            Text(description)
                .font(Typography.caption)
                .foregroundStyle(theme.current.textMuted)
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private func featureRow(icon: String, title: String, subtitle: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 12))
                .foregroundStyle(theme.current.accent)
                .frame(width: 20)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(Typography.body)
                    .foregroundStyle(theme.current.text)
                Text(subtitle)
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
            }

            Spacer()
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 2)
    }
}
