import SwiftUI

/// A single named tool button for the title-bar toolbar: icon + label, so new
/// users can read what each one is. Hosted as an individual `ToolbarItem` in
/// AppShell, which lets AppKit collapse the ones that don't fit into the
/// native `»` overflow menu automatically. Selecting it drives `shell.section`.
struct ToolbarToolButton: View {
    let section: ShellState.Section
    @Environment(ShellState.self) private var shell
    @EnvironmentObject private var theme: ThemeStore

    var body: some View {
        let isActive = shell.section == section
        let tint = section.tint(theme.current)
        Button {
            shell.section = section
        } label: {
            Label(section.label, systemImage: section.systemImage)
                // Force icon + title; macOS toolbars otherwise hide the title
                // until the user opts into "Icon and Text" via customization.
                .labelStyle(.titleAndIcon)
                .font(.system(size: 12, weight: isActive ? .semibold : .regular))
                .foregroundStyle(isActive ? tint : Color.primary.opacity(0.82))
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(RoundedRectangle(cornerRadius: 7)
                    .fill(isActive ? tint.opacity(0.16) : Color.clear))
        }
        .buttonStyle(.plain)
        .help(section.label)
        .accessibilityLabel(section.label)
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }
}
