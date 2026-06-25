import SwiftUI

/// Settings card that lets the user toggle which tool sections appear as
/// buttons in the top toolbar. Library, Live, and Settings are intentionally
/// absent — the first is the fallback landing, the second is condition-driven,
/// and the third is reached from the account menu.
struct SidebarVisibilitySection: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig

    var body: some View {
        SettingsSectionCard(icon: "sidebar.left", title: "Menu Bar") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                Text("Pick which menus appear in the top bar. Hidden menus stay reachable through deep links and keyboard shortcuts.")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, Spacing.xs)

                // Avoid recomputing .last per row; clearer and cheaper.
                let hideable = ShellState.Section.userHideable
                let last = hideable.last
                ForEach(hideable, id: \.self) { section in
                    row(for: section)
                    if section != last { Divider().opacity(0.4) }
                }

                // Always rendered (disabled when nothing's hidden) so
                // toggling the last item doesn't make the card height
                // shift — better visual stability than appearing /
                // disappearing on the last toggle.
                HStack {
                    Spacer()
                    Button("Show all") { config.hiddenSidebarSections = [] }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .disabled(config.hiddenSidebarSections.isEmpty)
                }
                .padding(.top, Spacing.xs)
            }
        }
    }

    @ViewBuilder
    private func row(for section: ShellState.Section) -> some View {
        let t = theme.current
        let binding = Binding<Bool>(
            get: { !config.hiddenSidebarSections.contains(section.rawValue) },
            set: { isVisible in
                if isVisible {
                    config.hiddenSidebarSections.remove(section.rawValue)
                } else {
                    config.hiddenSidebarSections.insert(section.rawValue)
                }
            }
        )
        HStack(spacing: Spacing.md) {
            Image(systemName: section.systemImage)
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(section.tint(t))
                .frame(width: 22, height: 22)
            Text(section.label)
                .font(Typography.body)
                .foregroundStyle(t.text)
            Spacer()
            Toggle("", isOn: binding)
                .toggleStyle(.switch)
                .controlSize(.small)
                .labelsHidden()
                .help(binding.wrappedValue ? "Hide \(section.label)" : "Show \(section.label)")
        }
        .padding(.vertical, 2)
    }
}
