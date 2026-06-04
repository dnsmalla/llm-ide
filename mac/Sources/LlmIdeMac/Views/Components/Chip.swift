import SwiftUI

/// Generic icon + label pill. Used for filter chips, model pickers,
/// status badges, and any small toggleable/selectable token. Replaces
/// ~10 ad-hoc Capsule() + HStack rewrites across the app.
struct Chip: View {
    let icon: String?
    let label: String
    var trailing: String? = nil  // e.g. "chevron.down" for menus
    var active: Bool = false
    var compact: Bool = false
    /// Optional override for the VoiceOver / tooltip description used
    /// when `label` is empty (icon-only mode). Falls back to `label`,
    /// then to a generic "Chip" so the element is never unlabeled.
    var accessibilityDescription: String? = nil

    @EnvironmentObject var theme: ThemeStore

    private var resolvedDescription: String {
        if let d = accessibilityDescription, !d.isEmpty { return d }
        if !label.isEmpty { return label }
        return "Chip"
    }

    var body: some View {
        HStack(spacing: 4) {
            if let icon { Image(systemName: icon).font(.system(size: 10, weight: .medium)) }
            if !label.isEmpty {
                Text(label)
                    .font(.system(size: 11, weight: active ? .medium : .regular))
                    .lineLimit(1)
            }
            if let trailing { Image(systemName: trailing).font(.system(size: 8, weight: .medium)) }
        }
        .padding(.horizontal, compact ? 5 : 8)
        .padding(.vertical, 4)
        .background(active ? theme.current.accent.opacity(0.10) : theme.current.surface)
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(active ? theme.current.accent.opacity(0.35) : theme.current.border, lineWidth: 1)
        )
        .clipShape(Capsule())
        .foregroundStyle(active ? theme.current.accent : theme.current.textMuted)
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(resolvedDescription)
        .help(label.isEmpty ? resolvedDescription : "")
    }
}
