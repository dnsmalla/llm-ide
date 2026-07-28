import SwiftUI

struct HelpView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DesignSystem.Spacing.lg) {
                VStack(alignment: .leading, spacing: DesignSystem.Spacing.xs) {
                    Text("Help & FAQ")
                        .font(.system(size: DesignSystem.Typography.title, weight: .bold))
                        .foregroundColor(DesignSystem.Colors.textPrimary)
                    Text("Get help with LLM-IDE")
                        .font(.system(size: DesignSystem.Typography.body))
                        .foregroundColor(DesignSystem.Colors.textSecondary)
                }

                VStack(alignment: .leading, spacing: DesignSystem.Spacing.lg) {
                    HelpSection(
                        title: "Getting started",
                        content: """
                        1. On your Mac: LLM-IDE → Settings → Mobile Control → Start.
                        2. Note the IP, port (:3006), and PIN (or scan the pairing QR).
                        3. On iPhone: pick your Mac from the list, or enter IP + PIN manually.
                        4. When status shows Live, tap Chat, Explore, or Auto in the toolbar — the iPhone is a companion, not a screen mirror.
                        """
                    )
                    HelpSection(
                        title: "Permissions",
                        content: """
                        • iPhone: Local Network (for Bonjour discovery) — iOS prompts on first launch.
                        • Mac: Screen Recording and Accessibility are for meeting caption capture in the Mac app, not for iPhone pairing. You do not need to grant them to use Chat / Explore / Auto from your phone.
                        """
                    )
                    HelpSection(
                        title: "Chat, Explore, Auto",
                        content: """
                        • Chat — ask LLM-IDE questions; replies stream from your Mac's local server.
                        • Explore — browse and chat with Mac explorer sessions.
                        • Auto — toggle and inspect scheduled auto-code tasks.
                        """
                    )
                    HelpSection(
                        title: "Different networks",
                        content: "Automatic discovery only works on the same Wi-Fi. For remote access, install Tailscale on both devices, then use your Mac's Tailscale IP (100.x.x.x) or scan the QR from Mobile Control settings."
                    )
                    HelpSection(
                        title: "Mac not found?",
                        content: """
                        • Mobile Control must show Running on the Mac (Settings → Mobile Control).
                        • Same Wi-Fi or Tailscale; guest/corporate Wi-Fi often blocks Bonjour — use Direct IP + PIN.
                        • Wrong PIN? Copy it again from Mac Settings → Mobile Control.
                        • Port :3006 busy? Another process may be using it — on the Mac run `lsof -i :3006`, quit it, then restart Mobile Control.
                        """
                    )
                }
                .padding(DesignSystem.Spacing.lg)
                .background(DesignSystem.Colors.surface)
                .cornerRadius(DesignSystem.Layout.cornerRadiusL)
                .shadow(color: .black.opacity(DesignSystem.Layout.shadowOpacity), radius: DesignSystem.Layout.shadowRadius, x: 0, y: 2)
            }
            .padding(DesignSystem.Layout.marginMobile)
        }
        .background(DesignSystem.Colors.background)
        .navigationTitle("Help")
        .navigationBarTitleDisplayMode(.large)
    }
}

private struct HelpSection: View {
    let title: String
    let content: String

    var body: some View {
        VStack(alignment: .leading, spacing: DesignSystem.Spacing.sm) {
            Text(title)
                .font(.system(size: DesignSystem.Typography.body, weight: .semibold))
                .foregroundColor(DesignSystem.Colors.textPrimary)
            Text(content)
                .font(.system(size: DesignSystem.Typography.body))
                .foregroundColor(DesignSystem.Colors.textSecondary)
            Divider()
        }
    }
}
