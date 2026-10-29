import SwiftUI

/// The one header style used by EVERY section of the Library sidebar — the
/// notes/sources sections Library draws itself and the plugin / LLM source /
/// MCP sections Extensions contributes: a collapse chevron, an 18×18 tinted
/// icon chip, an uppercase label, a count pill, and an optional trailing
/// control (an "+" / install menu). `tint` is always palette-derived so the
/// whole sidebar adapts across Dark/Light/Midnight.
///
/// Tapping anywhere on the label area toggles the section (large hit
/// target); the trailing control sits outside the toggle button.
struct LibrarySectionHeader<Trailing: View>: View {
    let title: String
    let icon: String
    let tint: Color
    let count: Int
    let isExpanded: Binding<Bool>
    @ViewBuilder let trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.18)) {
                    isExpanded.wrappedValue.toggle()
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(isExpanded.wrappedValue ? 90 : 0))
                        .frame(width: 10)
                    Image(systemName: icon)
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(tint)
                        .frame(width: 18, height: 18)
                        .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 4))
                    Text(title)
                        .font(.system(size: 11, weight: .heavy))
                        .foregroundStyle(tint)
                        .textCase(.uppercase)
                        .tracking(0.5)
                    if count > 0 {
                        Text("\(count)")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(tint.opacity(0.6))
                    }
                    Spacer(minLength: 4)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(isExpanded.wrappedValue ? "Collapse \(title)" : "Expand \(title)")

            trailing()
        }
        // Breathing room above each section groups it visually (Finder-style)
        // and stops the colored uppercase label from crowding the rows beneath.
        .padding(.top, 12)
        .padding(.bottom, 3)
    }
}

/// Consistent muted empty/placeholder row used across every Library section.
struct LibraryEmptyRow: View {
    let text: String
    var icon: String = "tray"
    var leading: CGFloat = 0

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: icon)
                .font(Typography.fileMeta)
                .foregroundStyle(.tertiary)
            Text(text)
                .font(Typography.fileMeta)
                .foregroundStyle(.tertiary)
        }
        .listRowSeparator(.hidden)
        .padding(.vertical, 2)
        .padding(.leading, leading)
    }
}
