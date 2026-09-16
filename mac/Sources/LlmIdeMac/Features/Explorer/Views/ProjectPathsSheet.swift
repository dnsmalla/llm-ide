import SwiftUI

/// Sheet wrapper for `ProjectPathsPanel` — opened from Explorer.
struct ProjectPathsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject var theme: ThemeStore

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Project folders")
                    .font(Typography.title)
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
            .padding(Spacing.lg)
            Divider()
            ScrollView {
                ProjectPathsPanel()
                    .padding(Spacing.lg)
                    .frame(maxWidth: 640, alignment: .leading)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(theme.current.body)
        .frame(minWidth: 520, minHeight: 420)
    }
}
