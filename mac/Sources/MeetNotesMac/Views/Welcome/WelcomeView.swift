import SwiftUI
import AppKit

/// Shown when no project is active. Open Folder + recent list.
struct WelcomeView: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var projectStore: ProjectStore

    @State private var error: String?

    var body: some View {
        let t = theme.current
        VStack(alignment: .leading, spacing: Spacing.lg) {
            Text("Meet Notes")
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(t.text)
            Text("Open a project folder to get started. Each folder becomes its own workspace.")
                .foregroundStyle(t.textMuted)
                .padding(.bottom, Spacing.md)

            Button {
                pickFolder()
            } label: {
                Label("Open Folder…", systemImage: "folder.badge.plus")
                    .padding(.horizontal, Spacing.md)
                    .padding(.vertical, Spacing.sm)
            }
            .buttonStyle(.borderedProminent)

            if !projectStore.recents.isEmpty {
                Divider().padding(.vertical, Spacing.md)
                Text("Recent projects")
                    .font(Typography.caption.bold())
                    .foregroundStyle(t.textMuted)
                RecentProjectsList(entries: projectStore.recents) { entry in
                    do { try projectStore.switchTo(recent: entry) }
                    catch let err { self.error = err.localizedDescription }
                }
            }

            if let err = error {
                Label(err, systemImage: "exclamationmark.triangle.fill")
                    .font(Typography.caption)
                    .foregroundStyle(t.danger)
            }
            Spacer()
        }
        .padding(Spacing.lg)
        .frame(maxWidth: 720, maxHeight: .infinity, alignment: .topLeading)
        .frame(maxWidth: .infinity, alignment: .center)
        .background(t.body)
    }

    private func pickFolder() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Open Project"
        if panel.runModal() == .OK, let url = panel.url {
            do { try projectStore.openFolder(at: url) }
            catch let err { self.error = err.localizedDescription }
        }
    }
}
