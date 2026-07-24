import SwiftUI

/// The identical connection / error banner strips that sat above both chat
/// transcripts (`LlmIdeControlView.connectionBanner` / `errorBanner(_:)` and
/// the mirrors in `ExplorerChatView`). One component, two cases — the error
/// case carries an `onDismiss` so the caller controls how the message clears
/// (both views set `connection.errorMessage = nil`).
struct StatusBanner: View {
    enum Content {
        /// Gray "wifi.slash" strip. `isConnecting` toggles the copy.
        case connection(isConnecting: Bool)
        /// Red-tinted error strip with an × dismiss button.
        case error(message: String, onDismiss: () -> Void)
    }

    private let content: Content

    init(_ content: Content) { self.content = content }

    var body: some View {
        switch content {
        case .connection(let isConnecting):
            HStack(spacing: 8) {
                Image(systemName: "wifi.slash").font(.system(size: 13))
                Text(isConnecting ? "Connecting to your Mac…" : "Not connected to your Mac")
                    .font(.system(size: DesignSystem.Typography.footnote, weight: .medium))
                Spacer()
            }
            .foregroundColor(.white)
            .padding(.horizontal, DesignSystem.Spacing.md)
            .padding(.vertical, 8)
            .background(DesignSystem.Colors.textTertiary)
        case .error(let message, let onDismiss):
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 13))
                    .foregroundColor(DesignSystem.Colors.danger)
                Text(message)
                    .font(.system(size: DesignSystem.Typography.footnote))
                    .foregroundColor(DesignSystem.Colors.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(DesignSystem.Colors.textTertiary)
                }
            }
            .padding(.horizontal, DesignSystem.Spacing.md)
            .padding(.vertical, 8)
            .background(DesignSystem.Colors.danger.opacity(0.12))
        }
    }
}
