import SwiftUI

/// The Explorer · Source Control · Search switcher that lives in the left
/// panel's header (Cursor-style), not in the top title bar. Rendered in
/// `ExplorerView` (after the panel-minimize toggle), `SourceControlView`, and
/// `SearchView`, so all three interconvert from any of them. Each button drives
/// `shell.section`.
struct PanelSectionTabs: View {
    @Environment(ShellState.self) private var shell
    @EnvironmentObject private var theme: ThemeStore

    private static let tabs: [ShellState.Section] = [.explorer, .sourceControl, .search]

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Self.tabs, id: \.self) { tab($0) }
        }
    }

    private func tab(_ section: ShellState.Section) -> some View {
        let isActive = shell.section == section
        let tint = section.tint(theme.current)
        return Button { shell.section = section } label: {
            HStack(spacing: 5) {
                Image(systemName: section.systemImage)
                    .font(.system(size: 12, weight: .medium))
                    .symbolRenderingMode(.hierarchical)
                Text(section.label)
                    .font(.system(size: 12, weight: isActive ? .semibold : .regular))
            }
            .foregroundStyle(isActive ? tint : Color.primary.opacity(0.7))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(RoundedRectangle(cornerRadius: 6)
                .fill(isActive ? tint.opacity(0.16) : Color.clear))
            .contentShape(RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
        .help(section.label)
        .accessibilityLabel(section.label)
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }
}
