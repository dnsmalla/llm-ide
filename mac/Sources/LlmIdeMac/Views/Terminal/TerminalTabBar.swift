import SwiftUI

/// Horizontal tab strip shown at the top of the terminal panel.
/// Left side: scrollable tab pills with titles and close buttons.
/// Right side: `+` to open a new tab.
struct TerminalTabBar: View {
    @Environment(TerminalPanelState.self) private var state
    @EnvironmentObject var theme: ThemeStore
    let projectDirectory: URL

    var body: some View {
        HStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2) {
                    ForEach(Array(state.sessions.enumerated()), id: \.element.id) { idx, session in
                        tabPill(session: session, index: idx)
                    }
                }
                .padding(.horizontal, 4)
            }

            Spacer(minLength: 0)

            Button {
                state.addTab(in: projectDirectory)
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(theme.current.textMuted)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
            }
            .buttonStyle(.plain)
            .help("New Terminal Tab")
        }
        .frame(height: 30)
        .background(theme.current.surface)
    }

    @ViewBuilder
    private func tabPill(session: TerminalSession, index: Int) -> some View {
        let isActive = index == state.activeIndex
        let isDead = session.status == .dead

        HStack(spacing: 4) {
            Text(session.title)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(isDead
                    ? theme.current.danger
                    : isActive ? theme.current.text : theme.current.textMuted)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: 120, alignment: .leading)

            Button {
                state.closeTab(at: index)
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(theme.current.textMuted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close \(session.title)")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(isActive ? theme.current.surface2 : Color.clear)
        .overlay(
            isActive
                ? Rectangle()
                    .frame(height: 2)
                    .foregroundStyle(theme.current.accent)
                    .padding(.horizontal, 2)
                : nil,
            alignment: .bottom
        )
        .clipShape(RoundedRectangle(cornerRadius: 3))
        .contentShape(Rectangle())
        .onTapGesture {
            state.activeIndex = index
        }
    }
}
