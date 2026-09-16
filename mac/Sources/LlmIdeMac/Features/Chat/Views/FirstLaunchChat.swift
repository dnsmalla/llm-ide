import SwiftUI

/// One-time, first-launch reveal for a section's Code Assistant chat panel.
/// On the very first launch per machine (tracked by `flagKey`) the chat is
/// opened and widened so it reads as the primary surface; every launch after
/// that leaves the panel wherever the user last set it. The `visible` binding
/// is a persisted @AppStorage in the caller, so a manual close sticks across
/// launches — we never force it back open. Extracted because the Explorer /
/// Review / Visual / DocGen chat columns all want identical
/// open-on-first-launch behavior (the same reason `persistedPanelWidth` exists).
private struct FirstLaunchChat: ViewModifier {
    @AppStorage private var didAutoOpen: Bool
    @Binding private var width: Double
    @Binding private var visible: Bool

    init(flagKey: String, width: Binding<Double>, visible: Binding<Bool>) {
        _didAutoOpen = AppStorage(wrappedValue: false, flagKey)
        _width = width
        _visible = visible
    }

    func body(content: Content) -> some View {
        content.onAppear {
            guard !didAutoOpen else { return }
            didAutoOpen = true
            // Only widen if the user hasn't already chosen something larger,
            // so a re-run can never shrink their layout.
            if width < 460 { width = 460 }
            withAnimation(.easeInOut(duration: 0.25)) { visible = true }
        }
    }
}

extension View {
    /// Reveal + widen this section's chat panel once, on the first launch
    /// tracked by `flagKey`. `width` and `visible` are the caller's persisted
    /// @AppStorage bindings.
    func firstLaunchOpenChat(flagKey: String, width: Binding<Double>, visible: Binding<Bool>) -> some View {
        modifier(FirstLaunchChat(flagKey: flagKey, width: width, visible: visible))
    }
}
