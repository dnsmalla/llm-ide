// Settings → Paths. One workspace root at the top, named
// subfolders below. Each row shows its effective absolute path
// inline so the user sees what their setting resolves to.
//
//   ┌─ Paths ──────────────────────────────────────────────────┐
//   │ Root directory          ✓                                │
//   │ /Users/you/LLM IDE                                     │
//   │ [ /Users/you/LLM IDE              ] [ Choose… ]        │
//   │ ──────────────────────────────────────                   │
//   │ Workspace subfolders      [ Create missing folders ]     │
//   │ Notes               ✓                                    │
//   │ → /Users/you/LLM IDE/Notes                             │
//   │ [ Notes                                              ]   │
//   │ …Documents / Repo clones / InfiniteBrain follow the     │
//   │  same pattern…                                           │
//   │ ──────────────────────────────────────                   │
//   │ Per-repo memory         ⚠                                │
//   │ Lives inside each repo (not under root)                  │
//   │ [ .understand-anything/memory                      ]     │
//   │ ──────────────────────────────────────                   │
//   │ UA binary               ✓                                │
//   │ [ npx understand-anything           ] [ Choose… ]        │
//   └──────────────────────────────────────────────────────────┘
//
// Strictness: a row's Save stays disabled until the validator
// returns .ok or .warning. Bad values can never reach UserDefaults.

import SwiftUI
import AppKit

struct PathsSettingsSection: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @EnvironmentObject var projectStore: ProjectStore
    @Environment(AppEnvironment.self) private var env

    @State private var createStatus: String?
    @State private var createError: String?
    @State private var rebuildingIndex = false

    var body: some View {
        SettingsSectionCard(icon: "folder.badge.gearshape", title: "Paths") {
            VStack(alignment: .leading, spacing: Spacing.md) {
                SettingsHint("Workspace root + named subfolders for every kind of file the app reads or writes. Invalid entries are rejected — the Save button stays disabled until validation passes.")

                if let ap = projectStore.activeProject {
                    // While a project is open, show its folders as read-only
                    // context — they're the source of truth for THIS project's
                    // data — but still let the user edit the global workspace
                    // defaults below (used for new projects / when no project
                    // is open, and where clones land).
                    projectPathsPanel(ap)

                    Divider().background(theme.current.border)

                    Text("GLOBAL WORKSPACE DEFAULTS")
                        .font(Typography.treeHeader)
                        .foregroundStyle(theme.current.textMuted)
                    Text("Editable any time. Applied to new projects and when no project is open; the active project's folders above take precedence for its own data.")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }

                // ── Global workspace paths (always editable) ──────────
                rootRow

                Divider().background(theme.current.border)

                subfoldersSection

                Divider().background(theme.current.border)

                perRepoMemoryRow

                Divider().background(theme.current.border)

                uaBinaryRow
            }
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
        let meetingsURL = projectURL.appendingPathComponent("meetings")
        let plansURL    = projectURL.appendingPathComponent("plans")
        let notesURL    = projectURL.appendingPathComponent("notes")
        let assetsURL   = projectURL.appendingPathComponent("assets")

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
            projectFolderRow(label: "meetings/",
                             icon: "calendar",
                             url: meetingsURL,
                             note: "Live captures + exported transcripts",
                             accent: t.accent)

            projectFolderRow(label: "plans/",
                             icon: "list.bullet.rectangle",
                             url: plansURL,
                             note: "Exported project plans (.md + .json)",
                             accent: t.textMuted)

            projectFolderRow(label: "notes/",
                             icon: "note.text",
                             url: notesURL,
                             note: "Free-form notes (yours to manage)",
                             accent: t.textMuted)

            projectFolderRow(label: "assets/",
                             icon: "photo",
                             url: assetsURL,
                             note: "Screenshots, diagrams, attachments",
                             accent: t.textMuted)

            // Actions strip for the meetings/ folder (index rebuild etc.)
            notesActionsStrip

            Text("These folders belong to the active project. Global defaults are editable below.")
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

    // MARK: - Root

    @ViewBuilder
    private var rootRow: some View {
        PathRow(
            label: "Root directory",
            help: "Absolute path. All workspace subfolders below resolve under it.",
            placeholder: "~/LLM IDE",
            initialValue: config.dataRoot,
            validate: PathValidator.absoluteDirectoryAllowMissing,
            onSave: { canonical in
                config.dataRoot = canonical
                applyNotesFolderFromPaths()
            },
            chooserKind: .directory
        )
    }

    // MARK: - Subfolders

    @ViewBuilder
    private var subfoldersSection: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            HStack {
                Text("Workspace subfolders")
                    .font(Typography.captionStrong)
                    .foregroundStyle(theme.current.text)
                Spacer()
                Button {
                    createMissingFolders()
                } label: {
                    Label("Create missing folders", systemImage: "folder.badge.plus")
                        .font(Typography.captionStrong)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(config.dataRootURL == nil)
                .help("mkdir -p every subfolder that doesn't exist yet under the root.")
            }
            if let status = createStatus {
                Label(status, systemImage: "checkmark.circle.fill")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.accent3)
            }
            if let err = createError {
                Label(err, systemImage: "exclamationmark.triangle.fill")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.danger)
                    .lineLimit(3)
            }

            subfolderRow(
                label: "Notes",
                help: "Meeting notes, transcripts, summaries. FolderIndexer + the rest of the app start using this path on save.",
                defaultName: AppConfig.defaultNotesSubdir,
                value: config.notesSubdir,
                onSave: { value in
                    config.notesSubdir = value
                    applyNotesFolderFromPaths()
                }
            )
            notesActionsStrip
            subfolderRow(
                label: "Documents",
                help: "Generated docs, plans, reviews. (Not yet consumed — DocGen/DocTemplateStore still use ~/Library/Application Support.)",
                defaultName: AppConfig.defaultDocsSubdir,
                value: config.docsSubdir,
                onSave: { config.docsSubdir = $0 }
            )
            subfolderRow(
                label: "Repo clones",
                help: "Where GitLab / GitHub repos clone into by default. Wired: Clone button uses this path.",
                defaultName: AppConfig.defaultClonesSubdir,
                value: config.clonesSubdir,
                onSave: { config.clonesSubdir = $0 }
            )
            subfolderRow(
                label: "InfiniteBrain",
                help: "Knowledge-graph store. (Not yet consumed — reserved for a future feature.)",
                defaultName: AppConfig.defaultInfiniteBrainSubdir,
                value: config.infiniteBrainSubdir,
                onSave: { config.infiniteBrainSubdir = $0 }
            )
        }
    }

    @ViewBuilder
    private func subfolderRow(label: String,
                              help: String,
                              defaultName: String,
                              value: String,
                              onSave: @escaping (String) -> Void) -> some View {
        PathRow(
            label: label,
            help: help,
            placeholder: defaultName,
            initialValue: value,
            validate: PathValidator.subfolderName,
            onSave: onSave,
            chooserKind: .none,
            effectivePath: effectiveSubfolderPath(value: value)
        )
    }

    private func effectiveSubfolderPath(value: String) -> String? {
        guard let root = config.dataRootURL else { return nil }
        let result = PathValidator.subfolderName(value)
        guard let segment = result.canonical else { return nil }
        return root.appendingPathComponent(segment, isDirectory: true).path
    }

    // MARK: - Per-repo memory

    @ViewBuilder
    private var perRepoMemoryRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text("Per-repo memory")
                    .font(Typography.body)
                    .foregroundStyle(theme.current.text)
                Text("(not under root)")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
            }
            Text("Lives inside each repo as faults/, q&a/, repo.md, graph-notes.md. Default `.understand-anything/memory` matches the convention the Understand-Anything skill expects.")
                .font(Typography.caption)
                .foregroundStyle(theme.current.textMuted)
        }
        PathRow(
            label: "Memory subdir",
            help: "",
            placeholder: AppConfig.defaultMemorySubdir,
            initialValue: config.memorySubdir,
            validate: PathValidator.memorySubdir,
            onSave: { config.memorySubdir = $0 },
            chooserKind: .none,
            hideLabel: true
        )
    }

    // MARK: - UA binary

    @ViewBuilder
    private var uaBinaryRow: some View {
        PathRow(
            label: "UA binary",
            help: "Absolute path to the `understand-anything` CLI. Leave empty to auto-discover from PATH or use `npx understand-anything`.",
            placeholder: "npx understand-anything (leave empty to auto-discover)",
            initialValue: config.uaBinaryOverride,
            validate: { PathValidator.executableFile($0, allowEmpty: true) },
            onSave: { config.uaBinaryOverride = $0 },
            chooserKind: .file
        )
    }

    // MARK: - Create-missing action

    private func createMissingFolders() {
        createError = nil
        createStatus = nil
        guard let root = config.dataRootURL else {
            createError = "Set a root directory first."
            return
        }
        let fm = FileManager.default
        var created: [String] = []
        var skipped: [String] = []
        // Root itself first — may not exist yet.
        do {
            if !fm.fileExists(atPath: root.path) {
                try fm.createDirectory(at: root, withIntermediateDirectories: true)
                created.append(root.lastPathComponent)
            }
        } catch {
            createError = "Couldn't create root: \(error.localizedDescription)"
            return
        }
        for url in config.allResolvedSubfolders {
            if fm.fileExists(atPath: url.path) {
                skipped.append(url.lastPathComponent)
                continue
            }
            do {
                try fm.createDirectory(at: url, withIntermediateDirectories: true)
                created.append(url.lastPathComponent)
            } catch {
                createError = "Couldn't create \(url.lastPathComponent): \(error.localizedDescription)"
                return
            }
        }
        let parts: [String] = [
            created.isEmpty ? nil : "Created \(created.joined(separator: ", "))",
            skipped.isEmpty ? nil : "Already existed: \(skipped.joined(separator: ", "))"
        ].compactMap { $0 }
        createStatus = parts.isEmpty ? "Nothing to do." : parts.joined(separator: " · ")
        // After creating, push the resolved notes folder into
        // NotesFolderConfig too — most users hitting "Create
        // missing folders" expect everything to start using the
        // new locations.
        applyNotesFolderFromPaths()
    }

    /// Push `config.resolvedNotesURL` into NotesFolderConfig so the
    /// rest of the app (Notes Folder card, FolderIndexer, AutoCode)
    /// starts reading/writing under the new path. Called whenever
    /// dataRoot or notesSubdir is saved, and on "Create missing
    /// folders". No-op when dataRoot isn't configured or when a
    /// project is open (it controls the notes folder).
    private func applyNotesFolderFromPaths() {
        // When a project is active it owns the notes folder.
        // Persist the setting in UserDefaults (AppConfig) so it's
        // remembered for when the project is closed, but don't
        // override NotesFolderConfig while the project is live.
        guard projectStore.activeProject == nil else { return }
        guard let target = config.resolvedNotesURL else { return }
        let cfg = NotesFolderConfig()
        // Skip if already pointed at the resolved URL — avoids
        // double-firing the notesFolderChanged notification and
        // wiping a still-good bookmark.
        if cfg.currentFolder.standardizedFileURL.path
            == target.standardizedFileURL.path {
            return
        }
        do {
            try cfg.setFolderFromPath(target)
            NotificationCenter.default.post(name: .notesFolderChanged, object: nil)
        } catch {
            createError = "Couldn't apply Notes folder: \(error.localizedDescription)"
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

// MARK: - PathRow

private enum PathChooserKind {
    case none, file, directory
}

private struct PathRow: View {
    let label: String
    let help: String
    let placeholder: String
    let initialValue: String
    let validate: (String) -> PathValidation
    let onSave: (String) -> Void
    let chooserKind: PathChooserKind
    /// Optional pre-computed "effective absolute path" string —
    /// shown above the field for relative-subfolder rows so the
    /// user always sees what their entry resolves to.
    var effectivePath: String? = nil
    /// When true, the header line (label + glyph + Save) is hidden
    /// — used by the per-repo memory section which provides its own
    /// header above the row.
    var hideLabel: Bool = false

    @EnvironmentObject var theme: ThemeStore
    @State private var draft: String = ""
    @State private var didLoad = false

    var body: some View {
        let t = theme.current
        let result = validate(draft)
        VStack(alignment: .leading, spacing: 6) {
            if !hideLabel {
                HStack(spacing: 6) {
                    Text(label)
                        .font(Typography.body)
                        .foregroundStyle(t.text)
                    statusGlyph(result)
                    Spacer()
                    if isDirty(result) {
                        Button("Save") {
                            if let c = result.canonical {
                                onSave(c)
                                draft = c
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .disabled(!result.isValid)
                        Button("Revert") { draft = initialValue }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                    }
                }
            }
            if !help.isEmpty {
                Text(help)
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
            }
            if let eff = effectivePath {
                HStack(spacing: 4) {
                    Image(systemName: "arrow.turn.down.right")
                        .font(.system(size: 9))
                        .foregroundStyle(t.textMuted)
                    Text(eff)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(t.textMuted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            HStack(spacing: 6) {
                TextField(placeholder, text: $draft)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12, design: .monospaced))
                if chooserKind != .none {
                    Button("Choose…") { chooseFile() }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
                if hideLabel && isDirty(result) {
                    Button("Save") {
                        if let c = result.canonical {
                            onSave(c)
                            draft = c
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(!result.isValid)
                }
            }
            if let reason = reasonText(result) {
                Text(reason)
                    .font(Typography.caption)
                    .foregroundStyle(reasonColor(result, t: t))
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .onAppear {
            if !didLoad {
                draft = initialValue
                didLoad = true
            }
        }
    }

    private func isDirty(_ result: PathValidation) -> Bool {
        if !result.isValid { return draft != initialValue }
        return (result.canonical ?? draft) != initialValue
    }

    private func chooseFile() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = chooserKind == .file
        panel.canChooseDirectories = chooserKind == .directory
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url {
            draft = url.path
        }
    }

    @ViewBuilder
    private func statusGlyph(_ result: PathValidation) -> some View {
        let t = theme.current
        switch result {
        case .ok:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(t.accent3)
                .font(.system(size: 11))
        case .warning:
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(t.accent4)
                .font(.system(size: 11))
        case .invalid:
            Image(systemName: "xmark.octagon.fill")
                .foregroundStyle(t.danger)
                .font(.system(size: 11))
        }
    }

    private func reasonText(_ result: PathValidation) -> String? {
        switch result {
        case .ok: return nil
        case .warning(let m, _): return m
        case .invalid(let r): return r
        }
    }

    private func reasonColor(_ result: PathValidation, t: Theme) -> Color {
        switch result {
        case .ok: return t.textMuted
        case .warning: return t.accent4
        case .invalid: return t.danger
        }
    }
}
