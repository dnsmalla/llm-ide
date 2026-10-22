import SwiftUI

/// Persists an HSplitView pane's width across launches. HSplitView has no
/// width binding, so we set the pane's `idealWidth` from the stored value and
/// read the *rendered* width back through a GeometryReader — when a drag
/// settles, the new width is written to the binding (an @AppStorage in the
/// caller). Extracted because the Explorer / Review / Visual chat columns all
/// repeated this exact block.
private struct PersistedPanelWidth: ViewModifier {
    @Binding var width: Double
    let minWidth: CGFloat
    /// Lower bound applied to the read-back width before persisting.
    let floor: Double

    func body(content: Content) -> some View {
        content
            .frame(minWidth: minWidth, idealWidth: CGFloat(width), maxWidth: .infinity)
            .background(
                GeometryReader { geo in
                    Color.clear
                        .onChange(of: geo.size.width) { _, w in
                            let clamped = max(floor, Double(w))
                            if abs(clamped - width) > 1 { width = clamped }
                        }
                }
            )
    }
}

extension View {
    /// Make this pane a width-persisting HSplitView column. `width` is the
    /// stored binding (typically an @AppStorage Double).
    func persistedPanelWidth(_ width: Binding<Double>, minWidth: CGFloat, floor: Double) -> some View {
        modifier(PersistedPanelWidth(width: width, minWidth: minWidth, floor: floor))
    }
}
