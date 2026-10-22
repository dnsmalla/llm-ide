import SwiftUI

/// Reusable list — used by WelcomeView (and later QuickSwitcherSheet).
struct RecentProjectsList: View {
    @EnvironmentObject var theme: ThemeStore
    let entries: [ProjectStore.RecentEntry]
    let onPick: (ProjectStore.RecentEntry) -> Void

    var body: some View {
        let t = theme.current
        if entries.isEmpty {
            Text("No recent projects yet.")
                .font(Typography.caption)
                .foregroundStyle(t.textMuted)
        } else {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(entries) { entry in
                    Button { onPick(entry) } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(entry.displayName).font(Typography.body)
                                .foregroundStyle(t.text)
                            Text(entry.path)
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundStyle(t.textMuted)
                                .lineLimit(1).truncationMode(.middle)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                    .padding(.vertical, 4)
                }
            }
        }
    }
}
