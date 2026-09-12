import SwiftUI

/// Small label shown above an assistant turn naming the mode that reply was
/// produced in, so the user can tell at a glance why it didn't make any
/// edits/run anything — and catch a "sticky" mode selection (selectedMode
/// carries over between turns) that was meant for a different message.
///
/// Shown for EVERY mode, including execute and auto. It used to render
/// nothing for those two on the grounds that they are the common case and a
/// badge would be noise — but the mode a turn ran in is the server's
/// decision, not the picker's, and "the agent quietly chose execute" is
/// exactly as worth seeing as the rest. The two default modes are drawn
/// muted instead of hidden, so the unusual ones still stand out.
struct ModeBadge: View {
    let mode: CodeAssistMode
    @EnvironmentObject var theme: ThemeStore

    /// Execute/Auto are what most turns are; they state the fact without
    /// competing with the reply for attention.
    private var isDefaultMode: Bool { mode == .execute || mode == .auto }

    var body: some View {
        Text(mode.label.uppercased())
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(isDefaultMode ? theme.current.textMuted : theme.current.accent)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(
                isDefaultMode
                    ? theme.current.textMuted.opacity(0.10)
                    : theme.current.accent.opacity(0.12)))
    }
}
