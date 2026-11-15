import SwiftUI

/// "Nothing here yet" placeholder. Caller picks the strings; uses `ContentUnavailableView` on iOS 17+ and the
/// original 34pt-icon / `callout` / `footnote` stack (60pt top padding) before that.
struct EmptyChatState: View {
    let icon: String
    let title: String
    let subtitle: String
    /// Scales with Dynamic Type so the glyph keeps its proportion to the text beside it.
    @ScaledMetric(relativeTo: .title) private var iconSize: CGFloat = 34

    var body: some View {
        if #available(iOS 17.0, *) {
            // The system empty-state layout and typography; older OSes fall back to the hand-built stack below.
            ContentUnavailableView {
                Label(title, systemImage: icon)
            } description: {
                Text(subtitle)
            }
            .padding(.top, DesignSystem.Spacing.lg)
        } else {
            legacyBody
        }
    }

    private var legacyBody: some View {
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
