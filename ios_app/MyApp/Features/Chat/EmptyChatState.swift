import SwiftUI

/// Centered "no messages yet" placeholder for a chat transcript. Caller picks the strings; the layout (34pt icon, `callout` title,
/// `footnote` subtitle, 60pt top padding) is the shared design.
struct EmptyChatState: View {
    let icon: String
    let title: String
    let subtitle: String
    /// Scales with Dynamic Type so the glyph keeps its proportion to the text beside it.
    @ScaledMetric(relativeTo: .title) private var iconSize: CGFloat = 34

    var body: some View {
        VStack(spacing: DesignSystem.Spacing.sm) {
            Image(systemName: icon)
                .font(.system(size: iconSize))
                .foregroundColor(DesignSystem.Colors.textTertiary)
            Text(title)
                .font(DesignSystem.Typography.calloutFont.weight(.medium))
                .foregroundColor(DesignSystem.Colors.textSecondary)
            Text(subtitle)
                .font(DesignSystem.Typography.footnoteFont)
                .foregroundColor(DesignSystem.Colors.textTertiary)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 60)
    }
}
