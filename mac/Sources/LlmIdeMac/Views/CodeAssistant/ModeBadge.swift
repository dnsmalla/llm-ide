import SwiftUI

/// Small label shown above a non-Execute assistant turn, so the user can
/// tell at a glance why that reply didn't make any edits/run anything —
/// and catch a "sticky" mode selection (selectedMode carries over between
/// turns) that was meant for a different message. Never shown for
/// "execute" (the common case stays visually unchanged).
struct ModeBadge: View {
    let mode: CodeAssistMode
    @EnvironmentObject var theme: ThemeStore

    var body: some View {
        if mode != .execute && mode != .auto {
            Text(mode.label.uppercased())
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(theme.current.accent)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Capsule().fill(theme.current.accent.opacity(0.12)))
        }
    }
}
