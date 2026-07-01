import SwiftUI

/// Tone of an input source's status badge. Mapped to a theme colour inside
/// the card so callers stay theme-agnostic.
enum SourceBadgeTone {
    case positive   // connected / on
    case neutral    // off / paused / coming soon
    case accent     // available but not yet set up
}

/// One uniform "add-on" card in the Inputs hub.
///
/// Every input source — Meetings, Email, future Slack/Calendar — renders
/// through this single card so they read as a consistent set of add-ons
/// (the config-layer parallel to the `CaptionScraper`/`PlatformDetector`
/// runtime registry). The card owns the chrome (icon, title, subtitle,
/// status badge); each source supplies its own controls as `content`.
struct InputSourceCard<Content: View>: View {
    @EnvironmentObject var theme: ThemeStore

    let icon: String
    let title: String
    let subtitle: String
    let badgeText: String
    let badgeTone: SourceBadgeTone
    /// Dimmed for not-yet-available (coming soon) sources.
    var isAvailable: Bool = true
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
                Image(systemName: icon)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(theme.current.accent2)
                    .frame(width: 18)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(Typography.bodyStrong)
                        .foregroundStyle(theme.current.text)
                    if !subtitle.isEmpty {
                        Text(subtitle)
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                    }
                }
                Spacer(minLength: Spacing.sm)
                badge
            }
            content
        }
        .card(padding: Spacing.lg)
        .opacity(isAvailable ? 1 : 0.55)
    }

    private var badgeColor: Color {
        switch badgeTone {
        case .positive: return theme.current.accent3
        case .accent:   return theme.current.accent2
        case .neutral:  return theme.current.textMuted
        }
    }

    private var badge: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(badgeColor)
                .frame(width: 6, height: 6)
            Text(badgeText)
                .font(Typography.caption)
                .foregroundStyle(badgeColor)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(
            Capsule().fill(badgeColor.opacity(0.12))
        )
        .fixedSize()
    }
}

extension InputSourceCard where Content == EmptyView {
    /// Chrome-only card (no controls) — used for the "coming soon" entries.
    init(icon: String, title: String, subtitle: String,
         badgeText: String, badgeTone: SourceBadgeTone, isAvailable: Bool = true) {
        self.init(icon: icon, title: title, subtitle: subtitle,
                  badgeText: badgeText, badgeTone: badgeTone,
                  isAvailable: isAvailable) { EmptyView() }
    }
}
