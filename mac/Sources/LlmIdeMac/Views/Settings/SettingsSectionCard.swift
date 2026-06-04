import SwiftUI

/// Reusable section wrapper used by every Settings sub-view.
///
/// Sections start **collapsed** so the Settings page is a scannable
/// index — the user clicks the header to expand the one they want
/// to edit. The expanded/collapsed state is persisted per-section
/// in UserDefaults (keyed by title) so it survives across launches:
/// once you open Backend / Paths once, it stays open next time.
struct SettingsSectionCard<Content: View>: View {
    @EnvironmentObject var theme: ThemeStore

    let icon: String
    let title: String
    private let content: Content
    @AppStorage private var isExpanded: Bool

    init(icon: String, title: String, @ViewBuilder content: () -> Content) {
        self.icon = icon
        self.title = title
        self.content = content()
        // Runtime-keyed @AppStorage — each section gets its own
        // bool persisted under `settings.section.<title>.expanded`.
        // Default `false` = first launch shows the full index
        // collapsed; users click into what they need.
        self._isExpanded = AppStorage(
            wrappedValue: false,
            "settings.section.\(title).expanded"
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            header
            if isExpanded {
                content.card(padding: Spacing.lg)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .animation(.easeInOut(duration: 0.18), value: isExpanded)
    }

    private var header: some View {
        Button {
            isExpanded.toggle()
        } label: {
            HStack(spacing: Spacing.sm) {
                Image(systemName: icon)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(theme.current.accent2)
                SectionLabel(title, size: 12)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(theme.current.textMuted)
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(isExpanded ? "Collapse \(title)" : "Expand \(title)")
    }
}

/// Styled hint / caption row used inside settings sections.
struct SettingsHint: View {
    let text: String
    @EnvironmentObject var theme: ThemeStore

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(Typography.caption)
            .foregroundStyle(theme.current.textMuted)
            .fixedSize(horizontal: false, vertical: true)
    }
}
