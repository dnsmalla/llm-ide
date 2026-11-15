import SwiftUI

/// The connection / error banner above a screen's content. One component, two cases — the error
/// case carries an `onDismiss` so the caller controls how the message clears
/// (`connection.errorMessage = nil`).
///
/// Rendered as an inset rounded pill rather than a full-bleed strip, and it carries its own
/// insertion/removal transition so any caller that animates the `if` around it gets a slide-and-fade.
struct StatusBanner: View {
    enum Content {
        /// Amber "wifi.slash" capsule. `isConnecting` toggles the copy.
        case connection(isConnecting: Bool)
        /// Red-tinted error pill with an × dismiss button.
        case error(message: String, onDismiss: () -> Void)
    }

    private let content: Content

    init(_ content: Content) { self.content = content }

    var body: some View {
        banner
            .padding(.horizontal, DesignSystem.Spacing.md)
            .padding(.vertical, 4)
            .transition(.move(edge: .top).combined(with: .opacity))
    }

    @ViewBuilder
    private var banner: some View {
        switch content {
        case .connection(let isConnecting):
            HStack(spacing: 8) {
                Image(systemName: "wifi.slash")
                    .font(.footnote)
                    .foregroundColor(DesignSystem.Colors.warning)
                Text(isConnecting ? "Connecting to your desktop…" : "Not connected to your desktop")
                    .font(DesignSystem.Typography.footnoteFont.weight(.medium))
                    .foregroundColor(DesignSystem.Colors.textPrimary)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, DesignSystem.Spacing.md)
            .padding(.vertical, 8)
            .background(DesignSystem.Colors.warning.opacity(0.14), in: Capsule())
            .overlay(Capsule().stroke(DesignSystem.Colors.warning.opacity(0.35), lineWidth: 0.5))
            .accessibilityElement(children: .combine)
        case .error(let message, let onDismiss):
            HStack(alignment: .center, spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundColor(DesignSystem.Colors.danger)
                Text(message)
                    .font(DesignSystem.Typography.footnoteFont)
                    .foregroundColor(DesignSystem.Colors.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.caption2.weight(.semibold))
                        .foregroundColor(DesignSystem.Colors.textSecondary)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Dismiss")
            }
            .padding(.leading, DesignSystem.Spacing.md)
            .padding(.vertical, 2)
            // Multi-line messages would look wrong in a full capsule, so the error pill is a rounded rect.
            .background(DesignSystem.Colors.danger.opacity(0.12),
                        in: RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusL, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusL, style: .continuous)
                .stroke(DesignSystem.Colors.danger.opacity(0.35), lineWidth: 0.5))
        }
    }
}
