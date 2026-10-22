import SwiftUI

/// The Explorer · Source Control · Search switcher that lives in the left
/// panel's header (Cursor-style), not in the top title bar. Rendered in
/// `ExplorerView` (after the panel-minimize toggle), `SourceControlView`, and
/// `SearchView`, so all three interconvert from any of them. Each button drives
/// `shell.section`.
struct PanelSectionTabs: View {
    @Environment(ShellState.self) private var shell
    @EnvironmentObject private var theme: ThemeStore
    @EnvironmentObject private var config: AppConfig
    @ObservedObject private var registry = FeatureRegistry.shared

    private static let tabs: [ShellState.Section] = [.explorer, .sourceControl, .search]

    /// The panel switcher respects the sidebar hide list, so Explorer / Source
    /// Control / Search can each be hidden from here too. Also drops a tab
    /// whose `backingFeature` isn't enabled (toggled off, or compiled out) —
    /// `isEnabled` already intersects compiled + active — so it never offers
    /// a switch into a section that would just render the "not installed"
    /// placeholder.
    private var visibleTabs: [ShellState.Section] {
        Self.tabs.filter { section in
            !config.hiddenSidebarSections.contains(section.rawValue)
                && (section.backingFeature.map { registry.isEnabled($0) } ?? true)
        }
    }

    var body: some View {
        HStack(spacing: 4) {
            ForEach(visibleTabs, id: \.self) { tab($0) }
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
