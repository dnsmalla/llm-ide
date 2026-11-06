import SwiftUI

struct HelpView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DesignSystem.Spacing.lg) {
                VStack(alignment: .leading, spacing: DesignSystem.Spacing.xs) {
                    Text("Help & FAQ")
                        .font(DesignSystem.Typography.titleFont.weight(.bold))
                        .foregroundColor(DesignSystem.Colors.textPrimary)
                    Text("Get help with LLM-IDE")
                        .font(DesignSystem.Typography.bodyFont)
                        .foregroundColor(DesignSystem.Colors.textSecondary)
                }

                VStack(alignment: .leading, spacing: DesignSystem.Spacing.lg) {
                    HelpSection(
                        title: "Pair with your desktop",
                        content: """
                        1. On the desktop: LLM-IDE → Settings → Mobile Control → "Pair a phone or web client". It shows a QR code and a PIN.
                        2. On iPhone: tap Scan QR Code and point it at that QR. The QR carries the desktop's address and its security identity, which this iPhone pins.
                        3. When status shows Live, use the Chat tab. History lists the desktop's chats read-only.
                        """
                    )
                    HelpSection(
                        title: "Offline sync",
                        content: """
                        • On the desktop: Settings → Mobile Control → Phone and web sync → Add a phone or browser shows an enrollment QR.
                        • On iPhone: Settings → Sync → Scan a sync code. Chats, meetings and plans then arrive through the storage you chose (MEGA, your own server or Box), even while the desktop is off.
                        """
                    )
                    HelpSection(
                        title: "Permissions",
                        content: """
                        • Camera — to scan the pairing QR codes.
                        • Local Network — to reach the desktop on your Wi‑Fi. iOS asks the first time.
                        • Microphone and Speech Recognition — only to dictate chat messages.
                        """
                    )
                    HelpSection(
                        title: "Different networks",
                        content: "Install Tailscale on both devices. The desktop lists its Tailscale address first in the pairing QR, so a QR scanned on the tailnet keeps working away from home."
                    )
                    HelpSection(
                        title: "Can't connect?",
                        content: """
                        • LLM-IDE must be running on the desktop, on the same Wi‑Fi or Tailscale.
                        • "Security identity changed": the desktop's certificate changed — scan its pairing QR again.
                        • "Removed on the host": this iPhone was unpaired on the desktop — scan the QR again.
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
                .font(DesignSystem.Typography.bodyFont.weight(.semibold))
                .foregroundColor(DesignSystem.Colors.textPrimary)
            Text(content)
                .font(DesignSystem.Typography.bodyFont)
                .foregroundColor(DesignSystem.Colors.textSecondary)
            Divider()
        }
    }
}
