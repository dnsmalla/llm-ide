// Settings → Plans Folder.
//
// The global default folder where KB plans are written as Markdown. Plans are
// exported here automatically when a project is exported/closed, and on demand
// via "Save Plans to Folder…". Each project gets its own subfolder, so one
// Plans folder holds every project's plans in a single browsable place.

import SwiftUI
import AppKit

struct PlansFolderSettingsSection: View {
    @EnvironmentObject var theme: ThemeStore

    @State private var plansPath: String = PlansFolderConfig().currentFolder.path
    @State private var status: String?
    @State private var statusIsError = false

    var body: some View {
        let t = theme.current
        SettingsSectionCard(icon: "checklist", title: "Plans Folder") {
            VStack(alignment: .leading, spacing: Spacing.md) {
                SettingsHint("KB plans are saved here as Markdown whenever you export/close a project, or when you use “Save Plans to Folder…”. Each project gets its own subfolder.")

                HStack(spacing: 8) {
                    Image(systemName: "arrow.turn.down.right")
                        .font(.system(size: 9))
                        .foregroundStyle(t.textMuted)
                    Text(plansPath)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(t.textMuted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 8)
                    Button("Choose…") { chooseFolder() }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    Button("Reveal") { revealFolder() }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }

                if let status {
                    Label(status,
                          systemImage: statusIsError
                              ? "exclamationmark.triangle.fill"
                              : "checkmark.circle.fill")
                        .font(Typography.caption)
                        .foregroundStyle(statusIsError ? t.danger : t.accent3)
                        .lineLimit(3)
                }
            }
        }
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose Plans Folder"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            // setFolder captures a security-scoped bookmark so the folder
            // survives relaunches and stays usable if sandbox is enabled.
            try PlansFolderConfig().setFolder(url)
            plansPath = PlansFolderConfig().currentFolder.path
            statusIsError = false
            status = "Plans folder updated."
        } catch {
            statusIsError = true
            status = "Couldn't set folder: \(error.localizedDescription)"
        }
    }

    private func revealFolder() {
        let url = PlansFolderConfig().currentFolder
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }
}
