import SwiftUI

/// Small all-caps tracking label used as section/group headers in panels.
/// Usage: SectionLabel("Filters")  or  SectionLabel("ACTIVITY", size: 11)
struct SectionLabel: View {
    let text: String
    var size: CGFloat = 10
    var tracking: CGFloat = 0.5

    @EnvironmentObject var theme: ThemeStore

    init(_ text: String, size: CGFloat = 10, tracking: CGFloat = 0.5) {
        self.text = text
        self.size = size
        self.tracking = tracking
    }

    var body: some View {
        Text(text)
            .font(size == 10 ? Typography.treeHeader : .system(size: size, weight: .semibold))
            .foregroundStyle(theme.current.textMuted)
            .textCase(.uppercase)
            .tracking(tracking)
    }
}
