import SwiftUI

struct HelpView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DesignSystem.Spacing.lg) {
                VStack(alignment: .leading, spacing: DesignSystem.Spacing.xs) {
                    Text("Help & FAQ")
                        .font(.system(size: DesignSystem.Typography.title, weight: .bold))
                        .foregroundColor(DesignSystem.Colors.textPrimary)
                    Text("Get help with AI Control")
                        .font(.system(size: DesignSystem.Typography.body))
                        .foregroundColor(DesignSystem.Colors.textSecondary)
                }

                VStack(alignment: .leading, spacing: DesignSystem.Spacing.lg) {
                    HelpSection(
                        title: "Getting started",
                        content: "1. On your Mac, open the AI Control Agent app — a display icon appears in the menu bar.\n2. Click the icon and scan the QR code with this app — or tap your Mac when it appears in the list and enter the 6-digit PIN shown in the menu.\n3. Your Mac's screen appears. Tap to click, drag with the hand tool, and use the keyboard button to type."
                    )
                    HelpSection(
                        title: "Mac permissions",
                        content: "AI Control Agent needs two permissions in System Settings → Privacy & Security:\n• Screen Recording — to stream the screen\n• Accessibility — to move the mouse and type\nThe menu shows a Grant button if Screen Recording is missing. Stop and start the agent after granting."
                    )
                    HelpSection(
                        title: "Gestures",
                        content: "• Tap — click\n• Double-tap — double-click\n• Press and hold — right-click\n• Pinch or the +/− buttons — zoom in and out\n• While zoomed, drag with one finger to pan\n• Drag tool — drag windows or select text\n• Scroll tool — drag up/down to scroll the Mac"
                    )
                    HelpSection(
                        title: "AI prompts",
                        content: "Tap the chat bubble in the toolbar to send prompts to the AI agent on your Mac. Responses stream back live; tap the red stop button to cancel."
                    )
                    HelpSection(
                        title: "Different networks",
                        content: "Automatic discovery only works on the same Wi-Fi. To connect from anywhere, install Tailscale on both devices, then scan the QR code or enter your Mac's Tailscale IP (100.x.x.x) manually."
                    )
                    HelpSection(
                        title: "Mac not found?",
                        content: "• Check the menu bar icon — the agent status should say “Waiting for iPhone”\n• Make sure iPhone and Mac are on the same Wi-Fi\n• Use manual entry with an IP from the menu bar dropdown\n• Wrong PIN? The current PIN is always shown in the menu"
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
