import SwiftUI

/// Centered "no messages yet" placeholder for a chat transcript. Factored from
/// `LlmIdeControlView.emptyState` and `ExplorerChatView.emptyState(title:)`,
/// which shared the same icon + title + subtitle stack and only differed in
/// copy. Caller picks the strings; the layout (34pt icon, `callout` title,
/// `footnote` subtitle, 60pt top padding) is the shared design.
struct EmptyChatState: View {
    let icon: String
    let title: String
    let subtitle: String

    var body: some View {
        VStack(spacing: DesignSystem.Spacing.sm) {
            Image(systemName: icon)
                .font(.system(size: 34))
                .foregroundColor(DesignSystem.Colors.textTertiary)
            Text(title)
                .font(.system(size: DesignSystem.Typography.callout, weight: .medium))
                .foregroundColor(DesignSystem.Colors.textSecondary)
            Text(subtitle)
                .font(.system(size: DesignSystem.Typography.footnote))
                .foregroundColor(DesignSystem.Colors.textTertiary)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 60)
    }
}
