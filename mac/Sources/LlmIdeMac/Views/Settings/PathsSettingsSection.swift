// Settings → Paths.
//
// Display-only. A project's folder layout is fixed when the project is
// created (New Project) or read from disk (Open Existing). There are no
// global path settings to manage here.
//
//   ┌─ Paths ──────────────────────────────────────────────────┐
//   │ ℹ These folders belong to the active project.            │
//   │   source/ code/ data/ notes/ system/  [Reveal]           │
//   │   [ Rebuild missing folders ]                             │
//   └──────────────────────────────────────────────────────────┘

import SwiftUI
import AppKit

struct PathsSettingsSection: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var projectStore: ProjectStore
    @EnvironmentObject var templateStore: DocTemplateStore
    @Environment(AppEnvironment.self) private var env

    @State private var createStatus: String?
    @State private var createError: String?
    @State private var rebuildingIndex = false

    var body: some View {
        SettingsSectionCard(icon: "folder.badge.gearshape", title: "Paths") {
            VStack(alignment: .leading, spacing: Spacing.md) {
                if let ap = projectStore.activeProject {
                    SettingsHint("These folders belong to the active project. A project's location is set when you create or open it — there are no global path settings to manage here.")
                    projectPathsPanel(ap)
                } else {
                    noProjectHint
                }
            }
        }
    }

    @ViewBuilder
    private var noProjectHint: some View {
        let t = theme.current
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("No project open.")
                .font(Typography.body)
                .foregroundStyle(t.text)
            Text("Create a new project or open an existing one to see its folders. A project's root is chosen when you create it (or read from the folder you open) — there's nothing to configure here.")
                .font(Typography.caption)
                .foregroundStyle(t.textMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - Project-controlled paths panel

    /// Read-only folder tree derived from the active project.
    /// Replaces rootRow + subfoldersSection while a project is open so
    /// the user always sees paths that are coherent and actually in use.
    @ViewBuilder
    private func projectPathsPanel(_ ap: ProjectStore.ActiveProject) -> some View {
        let t = theme.current
        let projectURL = URL(fileURLWithPath: ap.localPath)
        let L = ProjectLayout(root: projectURL)

        VStack(alignment: .leading, spacing: Spacing.sm) {
            // Header
            HStack(spacing: 6) {
                Image(systemName: "lock.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(t.accent)
                Text("Folder paths are controlled by the active project.")
                    .font(Typography.captionStrong)
                    .foregroundStyle(t.text)
                Spacer()
                Button("Reveal in Finder") {
                    NSWorkspace.shared.activateFileViewerSelecting([projectURL])
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }

            // Project root
            projectFolderRow(label: "Project root",
                             icon: "folder.fill",
                             url: projectURL,
                             accent: t.accent)

            // Managed subfolders
            projectFolderRow(label: "source/", icon: "waveform",
                             url: L.sourceDir, note: "Meeting & email transcripts", accent: t.accent)
            projectFolderRow(label: "code/", icon: "chevron.left.forwardslash.chevron.right",
                             url: L.codeDir, note: "Code files", accent: t.textMuted)
            projectFolderRow(label: "data/", icon: "tablecells",
                             url: L.dataDir, note: "Documents, data, images", accent: t.textMuted)
            projectFolderRow(label: "notes/", icon: "note.text",
                             url: L.notesDir, note: "Generated notes", accent: t.textMuted)
            projectFolderRow(label: "templates/", icon: "doc.badge.gearshape",
                             url: L.templatesDir, note: "Doc Gen templates", accent: t.textMuted)
            projectFolderRow(label: "system/", icon: "gearshape",
                             url: L.systemDir, note: "Settings, faults, graph, index (managed)", accent: t.textMuted)

            // Actions strip for the meetings/ folder (index rebuild etc.)
            notesActionsStrip

            HStack {
                Spacer()
                Button {
                    rebuildProjectFolders()
                } label: {
                    Label("Rebuild missing folders", systemImage: "folder.badge.plus")
                        .font(Typography.captionStrong)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .help("Re-create missing project folders, seed Doc Gen templates, and refresh Claude / Cursor / Codex skills from the central kit.")
            }

            if let status = createStatus {
                Label(status, systemImage: "checkmark.circle.fill")
                    .font(Typography.caption)
                    .foregroundStyle(t.accent3)
            }
            if let err = createError {
                Label(err, systemImage: "exclamationmark.triangle.fill")
                    .font(Typography.caption)
                    .foregroundStyle(t.danger)
                    .lineLimit(3)
            }

            Text("These folders are managed by the project. To move the project, use File → Move Project.")
                .font(Typography.caption)
                .foregroundStyle(t.textMuted)
                .padding(.top, 2)
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(t.surface))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(t.border, lineWidth: 1))
    }

    @ViewBuilder
    private func projectFolderRow(label: String,
                                  icon: String,
                                  url: URL,
                                  note: String? = nil,
                                  accent: Color) -> some View {
        let t = theme.current
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 11))
                .foregroundStyle(accent)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(Typography.captionStrong)
                    .foregroundStyle(t.text)
                Text(url.path)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(t.textMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let note {
                    Text(note)
                        .font(Typography.caption)
                        .foregroundStyle(t.textMuted)
                }
            }
            Spacer(minLength: 4)
            Button {
                NSWorkspace.shared.activateFileViewerSelecting([url])
            } label: {
                Image(systemName: "arrow.right.circle")
                    .font(.system(size: 11))
            }
            .buttonStyle(.borderless)
            .foregroundStyle(t.textMuted)
            .help("Reveal \(label) in Finder")
        }
    }

    /// Re-create missing canonical folders and refresh the central
    /// skills kit (Claude / Cursor / Codex / …) into the project path.
    private func rebuildProjectFolders() {
        createError = nil
        createStatus = nil
        do {
            try projectStore.rebuildActiveProjectFolders()
            if let root = projectStore.activeProject.map({ URL(fileURLWithPath: $0.localPath) }) {
                templateStore.reloadProjectTemplates(at: root)
            }
            createStatus = "Project folders rebuilt. Agent skills refreshing…"
        } catch {
            createError = "Couldn't rebuild folders: \(error.localizedDescription)"
        }
    }

    // MARK: - Notes actions strip
    //
    // Reveal + Rebuild Index + cloud-sync badge for the Notes row.
    // Folded in here so a single card owns the Notes folder — no
    // more duplicate "Notes Folder" card sitting above Paths.

    @ViewBuilder
    private var notesActionsStrip: some View {
        let t = theme.current
        let notesURL = activeNotesURL
        let provider = NotesFolderConfig.detectSyncProvider(at: notesURL)
        HStack(spacing: Spacing.sm) {
            Image(systemName: "arrow.turn.down.right")
                .font(.system(size: 9))
                .foregroundStyle(t.textMuted)
            Text(notesURL.path)
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(t.textMuted)
                .lineLimit(1)
                .truncationMode(.middle)
            if let p = provider { syncBadge(p) }
            Spacer(minLength: 8)
            Button("Reveal") {
                NSWorkspace.shared.activateFileViewerSelecting([notesURL])
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            Button {
                Task { await rebuildIndex() }
            } label: {
                if rebuildingIndex {
                    HStack(spacing: 4) {
                        ProgressView().controlSize(.mini)
                        Text("Rebuilding…")
                    }
                } else {
                    Label("Rebuild Index", systemImage: "arrow.clockwise")
                }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(rebuildingIndex)
        }
    }

    /// What the rest of the app is currently using for notes —
    /// reads from the live AppEnvironment so the strip always reflects
    /// the active project folder, not just the unsaved Paths draft.
    private var activeNotesURL: URL {
        env.notesConfig.currentFolder
    }

    @ViewBuilder
    private func syncBadge(_ p: NotesFolderConfig.SyncProvider) -> some View {
        HStack(spacing: 4) {
            Image(systemName: syncIcon(p))
                .font(.system(size: 9))
            Text(p.label)
                .font(Typography.caption)
        }
        .padding(.horizontal, 5).padding(.vertical, 1)
        .background(Capsule().fill(theme.current.accent2.opacity(0.15)))
        .foregroundStyle(theme.current.accent2)
    }

    private func syncIcon(_ p: NotesFolderConfig.SyncProvider) -> String {
        switch p {
        case .icloudDrive: return "icloud"
        case .dropbox:     return "arrow.up.arrow.down.circle"
        case .googleDrive: return "externaldrive.connected.to.line.below"
        case .oneDrive:    return "cloud"
        }
    }

    private func rebuildIndex() async {
        rebuildingIndex = true
        defer { rebuildingIndex = false }
        try? await Task.detached(priority: .utility) { @MainActor in
            try env.indexer.fullScan()
        }.value
    }

}

