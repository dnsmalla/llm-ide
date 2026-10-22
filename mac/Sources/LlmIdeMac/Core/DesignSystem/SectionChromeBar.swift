import SwiftUI

/// One panel toggle for `SectionChromeBar`.
struct SectionToggle: Identifiable {
    var id: String { icon }
    let icon: String
    let isOn: Bool
    let helpOn: String
    let helpOff: String
    let action: () -> Void
}

/// A thin, consistent control bar shown at the top of a section's content
/// (NOT the window title bar) so every section's window header stays
/// identical (just the activity icons + account). Hosts left-aligned panel
/// toggles plus optional right-aligned trailing controls.
struct SectionChromeBar<Leading: View, Trailing: View>: View {
    let toggles: [SectionToggle]
    /// Left-aligned accessory placed right after the panel toggles (before the
    /// spacer) — e.g. Explorer's Explorer ⇄ Source Control switcher. Defaults
    /// to nothing so the common `toggles + trailing` call sites are unchanged.
    @ViewBuilder var leading: () -> Leading
    @ViewBuilder var trailing: () -> Trailing

    /// Common case: panel toggles + optional right-aligned trailing controls.
    /// A single trailing closure binds unambiguously to `trailing`.
    init(toggles: [SectionToggle],
         @ViewBuilder trailing: @escaping () -> Trailing = { EmptyView() }) where Leading == EmptyView {
        self.toggles = toggles
        self.leading = { EmptyView() }
        self.trailing = trailing
    }

    /// With a left-aligned accessory (e.g. Explorer's section switcher). Both
    /// closures are required here so a lone trailing closure can never match
    /// this overload ambiguously against the common initializer above.
    init(toggles: [SectionToggle],
         @ViewBuilder leading: @escaping () -> Leading,
         @ViewBuilder trailing: @escaping () -> Trailing) {
        self.toggles = toggles
        self.leading = leading
        self.trailing = trailing
    }

    var body: some View {
        HStack(spacing: 6) {
            ForEach(toggles) { t in
                Button(action: t.action) {
                    Image(systemName: t.icon)
                        .symbolVariant(t.isOn ? .fill : .none)
                }
                .buttonStyle(.borderless)
                .help(t.isOn ? t.helpOn : t.helpOff)
            }
            leading()
            Spacer(minLength: 0)
            trailing()
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .frame(height: 30)
        .background(.bar)
    }
}
