import SwiftUI

/// Colored pill badge for a GitLab label name.
/// Color is resolved from labels array (by label.color hex) or falls back to palette.
struct LabelChip: View {
    let name: String
    var color: Color? = nil     // explicit color overrides palette lookup
    var small: Bool = false     // true → font 9pt/padding 5×2, false → 10pt/7×3

    @EnvironmentObject var theme: ThemeStore

    var body: some View {
        let resolvedColor = color ?? ColorPalette.color(for: name)
        Text(name)
            .font(.system(size: small ? 9 : 10, weight: .medium))
            .foregroundStyle(resolvedColor)
            .padding(.horizontal, small ? 5 : 7)
            .padding(.vertical, small ? 2 : 3)
            .background(
                Capsule()
                    .fill(resolvedColor.opacity(0.12))
            )
            .overlay(
                Capsule()
                    .strokeBorder(resolvedColor.opacity(0.25), lineWidth: 0.5)
            )
    }
}

// MARK: - FlowLayout

/// Custom Layout that wraps children like a text run — left-to-right, new row when full.
struct FlowLayout: Layout {
    var spacing: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxW = proposal.width ?? .infinity
        var x: CGFloat = 0; var y: CGFloat = 0; var rowH: CGFloat = 0
        for sv in subviews {
            let s = sv.sizeThatFits(.unspecified)
            if x + s.width > maxW && x > 0 { y += rowH + spacing; x = 0; rowH = 0 }
            rowH = max(rowH, s.height); x += s.width + spacing
        }
        return .init(width: maxW, height: y + rowH)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX; var y = bounds.minY; var rowH: CGFloat = 0
        for sv in subviews {
            let s = sv.sizeThatFits(.unspecified)
            if x + s.width > bounds.maxX && x > bounds.minX { y += rowH + spacing; x = bounds.minX; rowH = 0 }
            sv.place(at: .init(x: x, y: y), proposal: .init(s))
            rowH = max(rowH, s.height); x += s.width + spacing
        }
    }
}
