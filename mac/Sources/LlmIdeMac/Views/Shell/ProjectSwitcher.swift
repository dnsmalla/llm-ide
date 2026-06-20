import SwiftUI
import AppKit

/// Compact dropdown showing the active project; surfaces recent list,
/// open-folder, reveal-in-finder, export, and close actions.
struct ProjectSwitcher: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var projectStore: ProjectStore

    // Single alert state — prevents two alerts stacking unexpectedly.
    @State private var alert: AlertItem?

    struct AlertItem: Identifiable {
        enum Kind { case error(String), exportSuccess(String, folderPath: String) }
        let id = UUID()
        let kind: Kind
    }

    var body: some View {
        let t      = theme.current
        let active = projectStore.activeProject
        let busy   = projectStore.isExporting

        Menu {
            Section("Recent") {
                ForEach(projectStore.recents.filter { $0.id != active?.bundle.id }) { entry in
                    Button(entry.displayName) {
                        do { try projectStore.switchTo(recent: entry) }
                        catch { alert = AlertItem(kind: .error(error.localizedDescription)) }
                    }
                    .disabled(busy)
                }
            }
            Divider()
            Button("Open Folder…") { openFolderPanel() }
                .disabled(busy)

            if let active {
                Button("Reveal in Finder") {
                    NSWorkspace.shared.activateFileViewerSelecting(
                        [URL(fileURLWithPath: active.localPath)])
                }

                Divider()

                // Export without closing — periodic backup / manual snapshot.
                Button("Export Project Data…") {
                    Task {
                        do {
                            if let result = try await projectStore.exportCurrentProject() {
                                let msg =
                                    "Exported \(result.meetingsWritten) meeting(s)."
                                alert = AlertItem(kind: .exportSuccess(msg, folderPath: active.localPath))
                            }
                            // nil result means isExporting was already true — silently ignored
                        } catch {
                            alert = AlertItem(kind: .error("Export failed: \(error.localizedDescription)"))
                        }
                    }
                }
                .disabled(busy)

                // Close + export — the primary "proper close" path.
                Button("Close Project") {
                    Task { await projectStore.closeActiveWithExport() }
                }
                .disabled(busy)
            }
        } label: {
            HStack(spacing: 4) {
                if busy {
                    ProgressView()
                        .controlSize(.mini)
                        .scaleEffect(0.8)
                } else {
                    Image(systemName: "folder.fill")
                        .foregroundStyle(t.accent)
                }
                Text(busy
                     ? "Exporting…"
                     : (active?.bundle.displayName ?? "No project"))
                    .font(Typography.body)
                    .foregroundStyle(t.text)
                    .lineLimit(1).truncationMode(.middle)
                if !busy {
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9))
                        .foregroundStyle(t.textMuted)
                }
            }
            .padding(.horizontal, 8).padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 6).fill(t.surface))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(t.border, lineWidth: 1))
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        // Unified alert — one state variable prevents two sheets stacking.
        .alert(alertTitle, isPresented: Binding(
            get: { alert != nil },
            set: { if !$0 { alert = nil } }
        )) {
            if case .exportSuccess(_, let path) = alert?.kind {
                Button("Show in Finder") {
                    NSWorkspace.shared.activateFileViewerSelecting(
                        [URL(fileURLWithPath: path)])
                    alert = nil
                }
            }
            Button("OK", role: .cancel) { alert = nil }
        } message: {
            if let a = alert { Text(alertMessage(a)) }
        }
    }

    // MARK: - Alert helpers

    private var alertTitle: String {
        guard let a = alert else { return "" }
        switch a.kind {
        case .error:         return "Project error"
        case .exportSuccess: return "Export complete"
        }
    }

    private func alertMessage(_ a: AlertItem) -> String {
        switch a.kind {
        case .error(let msg):              return msg
        case .exportSuccess(let msg, _):  return msg
        }
    }

    // MARK: - Open panel

    private func openFolderPanel() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false; panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url {
            do { try projectStore.openFolder(at: url) }
            catch { alert = AlertItem(kind: .error(error.localizedDescription)) }
        }
    }
}
