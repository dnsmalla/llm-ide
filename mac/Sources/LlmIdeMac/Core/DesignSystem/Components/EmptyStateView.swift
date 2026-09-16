import SwiftUI

/// Reusable empty / error / no-selection state view.
/// Usage: EmptyStateView(icon: "tray", title: "No issues", message: "Adjust filters")
struct EmptyStateView: View {
    let icon: String
    let title: String
    var message: String? = nil
    var actionLabel: String? = nil
    var action: (() -> Void)? = nil
    var iconColor: Color? = nil    // defaults to theme.current.textMuted.opacity(0.4)

    @EnvironmentObject var theme: ThemeStore

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 38, weight: .thin))
                .foregroundStyle(iconColor ?? theme.current.textMuted.opacity(0.4))

            Text(title)
                .font(Typography.title)
                .foregroundStyle(theme.current.text)

            if let message {
                Text(message)
                    .font(Typography.body)
                    .foregroundStyle(theme.current.textMuted)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 280)
            }

            if let actionLabel, let action {
                Button(actionLabel, action: action)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme.current.body)
    }
}
