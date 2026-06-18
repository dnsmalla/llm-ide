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
struct SectionChromeBar<Trailing: View>: View {
    let toggles: [SectionToggle]
    @ViewBuilder var trailing: () -> Trailing

    init(toggles: [SectionToggle], @ViewBuilder trailing: @escaping () -> Trailing = { EmptyView() }) {
        self.toggles = toggles
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
            Spacer(minLength: 0)
            trailing()
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .frame(height: 30)
        .background(.bar)
    }
}
