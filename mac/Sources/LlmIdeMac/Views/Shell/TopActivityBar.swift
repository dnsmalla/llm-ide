import SwiftUI

/// The horizontal section icons shown in the window's unified title bar
/// (hosted as a `.principal` toolbar item by AppShell). Selecting an icon
/// drives `shell.section`; the section's content renders below. Account and
/// Record live elsewhere (top-right account menu / Settings).
struct TopActivityBar: View {
    let api: LlmIdeAPIClient
    @Environment(ShellState.self) private var shell
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var capture: CaptionOrchestrator
    @EnvironmentObject var liveMirror: LiveSessionMirror
    @EnvironmentObject var config: AppConfig

    /// Coding/dev sections first, then the rest. `.settings` is reached from
    /// the account menu; `.live` appears only while a session is active.
    private static let order: [ShellState.Section] = [
        .explorer, .search, .sourceControl, .codeGraph, .autoCode,
        .plans, .conflicts, .issues, .gantt, .regression,
        .docGen, .visual, .library, .live,
    ]

    private var liveActive: Bool { capture.isRunning || liveMirror.activeSession != nil }
    private var sections: [ShellState.Section] {
        Self.order.filter { section in
            // .live is condition-driven; every user-hideable section honors the
            // Settings → Sidebar visibility toggles. library/settings aren't
            // hideable so they're never in hiddenSidebarSections.
            if section == .live { return liveActive }
            return !config.hiddenSidebarSections.contains(section.rawValue)
        }
    }

    var body: some View {
        HStack(spacing: 2) {
            ForEach(sections, id: \.self) { sectionIcon($0) }
        }
    }

    private func sectionIcon(_ section: ShellState.Section) -> some View {
        let isActive = shell.section == section
        let tint = section.tint(theme.current)
        return Button { shell.section = section } label: {
            ZStack(alignment: .topTrailing) {
                Image(systemName: section.systemImage)
                    .font(.system(size: 16, weight: .medium))
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(isActive ? tint : Color.primary.opacity(0.7))
                    .frame(width: 32, height: 28)
                    .background(RoundedRectangle(cornerRadius: 7)
                        .fill(isActive ? tint.opacity(0.16) : Color.clear))
                if section == .live && liveActive {
                    Circle().fill(theme.current.danger)
                        .frame(width: 6, height: 6).offset(x: -4, y: 4)
                }
            }
            .contentShape(RoundedRectangle(cornerRadius: 7))
        }
        .buttonStyle(.plain)
        .help(section.label)
        .accessibilityLabel(section.label)
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }
}
