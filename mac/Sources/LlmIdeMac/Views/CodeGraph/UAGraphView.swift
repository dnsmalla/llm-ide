// Three-panel Code Graph view (powered by the in-process GraphKit scanner
// via CodeNoteService — not an external CLI).
//
//  ┌──────────────────────┬────────────────────────┬───────────────────┐
//  │ Library tree         │ Generated artifacts    │ Graph canvas      │
//  │                      │                        │                   │
//  │ CODE / DATA          │ Code: files+symbols    │ Force-laid graph  │
//  │ (reused FileTreePanel│ Data: memory chunks    │ Pan/zoom/select   │
//  │  — same data the     │                        │ Double-click →    │
//  │  Library + Review    │                        │ open file         │
//  │  pages use)          │                        │                   │
//  │ Run / Cancel + status│                        │                   │
//  └──────────────────────┴────────────────────────┴───────────────────┘
//
// Mode is derived from the selected library item's Category:
//   .code → CodeNoteService (GraphKit scan) on the item's folder root
//   .data → MemoryGenerator on the selected file(s)
//
// All library data comes from LibraryItemStore — same source of truth as
// Library, Review Code, Review Doc, DocGen, etc. No NSOpenPanel here.

import SwiftUI
import GraphKit
import AppKit

@MainActor
struct UAGraphView: View {
    /// The two engines this view drives. User picks via the tab switcher
    /// at the top of panel 2; library-selection changes also nudge the
    /// tab to whichever engine matches the selected item's category.
    enum Mode: String, Identifiable, CaseIterable {
        case code            // → CodeNoteService generates code notes + graph
        case data            // → MemoryGenerator on docs

        var id: String { rawValue }

        var displayName: String {
            switch self {
            case .code: return "Code Graph"
            case .data: return "InfiniteBrain"
            }
        }

        var icon: String {
            switch self {
            case .code: return "chevron.left.forwardslash.chevron.right"
            case .data: return "brain.head.profile"
            }
        }

        /// Theme-driven accent — picks a role from the active palette so
        /// the tint stays consistent across light / dark / midnight modes
        /// instead of fighting them with literal colour values.
        func tint(_ theme: Theme) -> Color {
            switch self {
            case .code: return theme.accent   // brand teal
            case .data: return theme.accent2  // info blue
            }
        }

        /// Best-fit mode for a library item; defaults to .code so the
        /// run button still enables when there's nothing selected.
        static func suggested(for category: LibraryItem.Category?) -> Mode? {
            switch category {
            case .code:                    return .code
            case .data, .notes, .meetings: return .data
            case nil:                      return nil
            }
        }

        var runLabel: String {
            switch self {
            case .code: return "Generate Code Graph"
            case .data: return "Generate Memory"
            }
        }
        var description: String {
            switch self {
            case .code: return "Generate code notes + graph for the selected code folder."
            case .data: return "Build memory from the selected docs."
            }
        }
    }

    enum Status: Equatable {
        case idle
        case running
        case loaded(nodeCount: Int, edgeCount: Int)
        case error(String)
    }

    @Environment(LibraryItemStore.self) private var library
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @State private var selectedURL: URL?
    @State private var status: Status = .idle
    /// Active engine (also drives the tab UI in panel 2). Source of truth
    /// — changing the panel-1 selection nudges this to the matching mode,
    /// but the user can override via the tab switcher.
    @State private var mode: Mode = .code
    /// Collapse state for the two side panels. Mirrors how the rest of
    /// the app uses NavigationSplitView's column toggle — the user can
    /// hide either pane for more graph real-estate.
    @State private var showLibraryPanel: Bool = true
    @State private var showItemsPanel: Bool = true
    /// When true, the graph canvas is presented as a full-window overlay
    /// (side panels hidden) for distraction-free exploration.
    @State private var graphExpanded: Bool = false
    /// Full graph as produced by the GraphKit scan. We filter this into `displayData`
    /// based on `showSymbols` so the canvas doesn't have to draw 1k+ nodes
    /// when the user just wants the file-level view.
    @State private var fullData: CGData = .empty
    @State private var selectedNode: CGNode?
    @State private var runTask: Task<Void, Never>?
    @State private var showSymbols: Bool = false
    /// Double-click on canvas sets focus; dims non-neighbours.
    @State private var focusedNode: CGNode? = nil
    /// Show/hide node labels on the canvas.
    @State private var showLabels: Bool = true
    /// When set, dims all non-matching node kinds.
    @State private var filterKind: CGNodeKind? = nil

    @State private var codeArtifacts: [UAHelpers.CodeArtifact] = []
    @State private var memoryChunks: [MemoryChunk] = []
    @State private var memoryDocCount: Int = 0

    // ── Derived state (cached) ────────────────────────────────────────
    // Recomputing these in the view body is O(N²) over the graph or
    // library on every render — bad on 1k+ node graphs and frequent
    // SwiftUI re-evaluations (theme, hover, selection). Materialize them
    // into @State and refresh via the relevant onChange observers.
    @State private var displayData: CGData = .empty
    @State private var memoryChunkById: [String: MemoryChunk] = [:]
    @State private var availableCodeReposCache: [CodeRepo] = []
    @State private var libraryItemsByFolderOrigin: [String: [LibraryItem]] = [:]


    @StateObject private var codeNoteService = CodeNoteService(
        launcher: SystemProcessLauncher())

    /// Kinds shown in the files-only view (Code mode with `showSymbols`
    /// off). Includes the memory variants so the same filter logic is
    /// inert in Data mode without an extra branch.
    private static let filesOnlyKinds: Set<CGNodeKind> = [
        .file, .module, .docPage,
        .memoryDoc, .memoryChunk,
        .noteDecision, .noteTask, .noteQuestion, .noteFact,
        .noteConcept, .notePlaybook, .noteHypothesis,
        .noteEvent, .noteSource,
    ]

    /// Recompute `displayData` from `fullData` based on `showSymbols`
    /// and `mode`. Cheap when fullData is small; cached so the view
    /// body doesn't re-run it on every redraw.
    private func recomputeDisplayData() {
        if showSymbols || mode != .code {
            displayData = fullData
            return
        }
        let kept = fullData.nodes.filter { Self.filesOnlyKinds.contains($0.kind) }
        let keptIds = Set(kept.map(\.id))
        let edges = fullData.edges.filter { keptIds.contains($0.fromId) && keptIds.contains($0.toId) }
        displayData = CGData(nodes: kept, edges: edges)
    }

    /// Rebuild memory-chunk index after a generate run.
    private func rebuildMemoryIndex() {
        memoryChunkById = Dictionary(uniqueKeysWithValues: memoryChunks.map { ($0.id, $0) })
    }

    /// Rebuild library-folder groupings when LibraryItemStore changes.
    /// Replaces the previous `library.items.filter { … }` per body call.
    private func rebuildLibraryIndex() {
        let groups = Dictionary(grouping: library.items.filter { $0.folderOrigin != nil },
                                by: { $0.folderOrigin! })
        libraryItemsByFolderOrigin = groups

        var seen = Set<String>()
        var repos: [CodeRepo] = []
        for item in library.items where item.category == .code {
            guard let origin = item.folderOrigin, !seen.contains(origin) else { continue }
            seen.insert(origin)
            let group = groups[origin] ?? []
            let ancestor = UAHelpers.commonAncestor(group.map(\.path))
            repos.append(CodeRepo(folderOrigin: origin, root: URL(fileURLWithPath: ancestor)))
        }
        availableCodeReposCache = repos.sorted {
            $0.folderOrigin.localizedCaseInsensitiveCompare($1.folderOrigin) == .orderedAscending
        }
    }

    private var selectedItem: LibraryItem? {
        guard let url = selectedURL else { return nil }
        return library.items.first { $0.path == url.path }
    }

    /// Quick-pick targets shown at the top of panel 1. Each row is the
    /// root of a folder-imported library group plus its display name.
    /// Code mode runs against the folder root; selecting a file inside
    /// still works the same way via the file tree below.
    struct CodeRepo: Identifiable, Equatable {
        let folderOrigin: String
        let root: URL
        var id: String { folderOrigin + ":" + root.path }
    }

    /// Cached repo list. Refreshed by `rebuildLibraryIndex()` whenever
    /// `library.items` changes — see the body-level onChange observer.
    private var availableCodeRepos: [CodeRepo] { availableCodeReposCache }

    /// True when the active mode can actually run with the current
    /// library state. Drives the run button's enabled state.
    private var canRun: Bool {
        switch mode {
        case .code: return codeTargetFolder != nil
        case .data: return selectedItem?.category == .data || selectedItem?.category == .notes
        }
    }

    /// For Code mode, find the folder root the selected item belongs to.
    /// Folder-imported items share a `folderOrigin`; the root is the
    /// common ancestor of all paths in that group.
    private var codeTargetFolder: URL? {
        if let item = selectedItem, item.category == .code {
            if let folder = item.folderOrigin,
               let group = libraryItemsByFolderOrigin[folder] {
                return URL(fileURLWithPath: UAHelpers.commonAncestor(group.map(\.path)))
            }
            return item.url.deletingLastPathComponent()
        }
        // No explicit selection: if there's exactly one code repo, use it
        // so the user can just hit Run without drilling into the tree.
        if selectedItem == nil, availableCodeRepos.count == 1 {
            return availableCodeRepos[0].root
        }
        return nil
    }

    /// When the active code target sits outside the user's
    /// configured Paths → Clones folder, this returns the suggested
    /// destination. nil = either no repo selected, no Paths root
    /// configured, or the repo is already in the right place.
    /// Drives the migration banner above the body so users don't
    /// have to dig into GitLab/GitHub Settings to find the
    /// "Move here" button.
    private var clonesMigrationTarget: URL? {
        guard mode == .code,
              let current = codeTargetFolder,
              let clonesRoot = config.resolvedClonesURL else { return nil }
        let currentPath = current.standardizedFileURL.path
        let clonesPath = clonesRoot.standardizedFileURL.path
        // Already inside Clones → nothing to suggest.
        if currentPath.hasPrefix(clonesPath + "/") || currentPath == clonesPath {
            return nil
        }
        return clonesRoot.appendingPathComponent(current.lastPathComponent)
    }

    @State private var migrationError: String?
    @State private var migrating: Bool = false

    @ViewBuilder
    private func migrationBanner(target: URL) -> some View {
        let t = theme.current
        guard let current = codeTargetFolder else { return AnyView(EmptyView()) }
        return AnyView(
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: Spacing.sm) {
                    Image(systemName: "arrow.right.arrow.left.circle.fill")
                        .foregroundStyle(t.accent2)
                        .font(.system(size: 13))
                    VStack(alignment: .leading, spacing: 1) {
                        Text("This repo is outside your Clones folder")
                            .font(Typography.captionStrong)
                            .foregroundStyle(t.text)
                        Text("\(current.path) → \(target.path)")
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(t.textMuted)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Spacer(minLength: 8)
                    Button {
                        Task { await migrateCloneToPaths(current: current, target: target) }
                    } label: {
                        if migrating {
                            HStack(spacing: 4) {
                                ProgressView().controlSize(.mini)
                                Text("Moving…")
                            }
                        } else {
                            Label("Move to Clones folder", systemImage: "folder.fill.badge.gearshape")
                                .font(Typography.captionStrong)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(migrating)
                }
                if let err = migrationError {
                    Text(err)
                        .font(Typography.caption)
                        .foregroundStyle(t.danger)
                        .lineLimit(2)
                }
            }
            .padding(.horizontal, Spacing.lg)
            .padding(.vertical, Spacing.sm)
            .background(t.accent2.opacity(0.08))
            .overlay(Rectangle().frame(height: 1).foregroundStyle(t.border), alignment: .bottom)
        )
    }

    /// Physically `mv` the repo into the Paths-configured Clones
    /// folder, update the matching GitLab/GitHub saved-project's
    /// localPath, prune+reindex the Library, and invalidate the
    /// stale UA cache. Mirrors what
    /// GitLab/GitHubSettingsSection.moveClone does — folded in here
    /// so the user can do the migration from the surface where
    /// they're actually seeing the mismatch.
    private func migrateCloneToPaths(current: URL, target: URL) async {
        migrationError = nil
        migrating = true
        defer { migrating = false }
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: target.deletingLastPathComponent(),
                                   withIntermediateDirectories: true)
            if fm.fileExists(atPath: target.path) {
                migrationError = "Target already exists: \(target.path)"
                return
            }
            try fm.moveItem(at: current, to: target)
        } catch {
            migrationError = "Move failed: \(error.localizedDescription)"
            return
        }
        // Update saved-project records pointing at the old path.
        for idx in config.gitLabSavedProjects.indices
        where config.gitLabSavedProjects[idx].localPath == current.path {
            config.gitLabSavedProjects[idx].localPath = target.path
        }
        for idx in config.gitHubSavedRepos.indices
        where config.gitHubSavedRepos[idx].localPath == current.path {
            config.gitHubSavedRepos[idx].localPath = target.path
        }
        // Re-index the Library and clear the on-screen graph so the user
        // sees the empty state + run CTA. Next Generate builds a fresh
        // graph at the new path with correct fileURLs.
        library.removeFolder(folderOrigin: target.lastPathComponent)
        library.addFolder(url: target, category: .code)
        await MainActor.run {
            self.selectedNode = nil
            self.fullData = CGData.empty
            self.codeArtifacts = []
            self.status = .idle
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            if let target = clonesMigrationTarget {
                migrationBanner(target: target)
            }
            HSplitView {
                if showLibraryPanel {
                    controlsPanel
                        .frame(minWidth: 220, idealWidth: 260, maxWidth: 340)
                        .transition(.move(edge: .leading).combined(with: .opacity))
                }
                if showItemsPanel {
                    itemsPanel
                        .frame(minWidth: 240, idealWidth: 300, maxWidth: 420)
                        .transition(.move(edge: .leading).combined(with: .opacity))
                }
                canvasPanel
                    .frame(minWidth: 360, maxWidth: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme.current.body)
        .overlay {
            if graphExpanded { expandedGraphOverlay }
        }
        .animation(.easeInOut(duration: 0.18), value: showLibraryPanel)
        .animation(.easeInOut(duration: 0.18), value: showItemsPanel)
        .animation(.easeInOut(duration: 0.2), value: graphExpanded)
        .toolbar {
            // Standard system sidebar toggles — matches Review / Library
            // where the column toggle lives in the window toolbar.
            ToolbarItemGroup(placement: .navigation) {
                Button {
                    withAnimation(.easeInOut(duration: 0.18)) { showLibraryPanel.toggle() }
                } label: {
                    Image(systemName: "sidebar.left")
                        .symbolVariant(showLibraryPanel ? .fill : .none)
                }
                .help(showLibraryPanel ? "Hide Library" : "Show Library")

                Button {
                    withAnimation(.easeInOut(duration: 0.18)) { showItemsPanel.toggle() }
                } label: {
                    Image(systemName: "sidebar.squares.left")
                        .symbolVariant(showItemsPanel ? .fill : .none)
                }
                .help(showItemsPanel ? "Hide \(mode.displayName) panel" : "Show \(mode.displayName) panel")
            }
        }
        .onAppear {
            rebuildLibraryIndex()
        }
        .onDisappear { runTask?.cancel() }
        .onChange(of: library.items) { _, _ in rebuildLibraryIndex() }
        .onChange(of: fullData)      { _, _ in recomputeDisplayData() }
        .onChange(of: showSymbols)   { _, _ in recomputeDisplayData() }
        .onReceive(codeNoteService.$graph) { newGraph in
            guard mode == .code, !newGraph.nodes.isEmpty else { return }
            self.selectedNode = self.selectedNode  // keep selection
            // Phase 1: type-clustered circular layout — publish immediately so
            // the canvas isn't blank while physics runs.
            let initial = CodeGraphLayout.compute(
                newGraph, canvasSize: UAHelpers.layoutSize(for: newGraph.nodes.count))
            self.fullData = initial
            self.codeArtifacts = UAHelpers.collectCodeArtifacts(newGraph)
            // Flip to .loaded straight from the published graph — don't gate
            // on `progress == .complete`. `@Published` emits `graph` (in
            // CodeNoteService) before `progress` is set, so reading progress
            // here races and leaves the spinner stuck. The graph carries the
            // counts we need.
            self.status = .loaded(nodeCount: newGraph.nodes.count,
                                  edgeCount: newGraph.edges.count)
            // Phase 2: force-directed settle in the background, then republish
            // the organic layout — matches InfiniteBrain's Code Graph look.
            self.settlePhysics(from: initial, expectedMode: .code)
        }
        .onChange(of: memoryChunks)  { _, _ in rebuildMemoryIndex() }
        .onChange(of: selectedURL) { _, _ in
            // New selection: nudge the tab to match the item's category,
            // then drop derived state.
            if let cat = selectedItem?.category,
               let suggested = Mode.suggested(for: cat),
               suggested != mode {
                mode = suggested
            }
            resetDerivedState()
        }
        .onChange(of: mode) { _, _ in
            // Manual tab switch — clear any state from the previous mode.
            resetDerivedState()
        }
    }

    private func resetDerivedState() {
        selectedNode = nil
        fullData = .empty
        codeArtifacts = []
        memoryChunks = []
        memoryDocCount = 0
        status = .idle
    }

    // MARK: - Panel 1: Library tree + run controls

    private var controlsPanel: some View {
        let t = theme.current
        return VStack(spacing: 0) {
            if !availableCodeRepos.isEmpty {
                quickPickRepos
                Divider().background(t.border)
            }
            FileTreePanel(
                title: "Library",
                categories: [.code, .data],
                selectedURL: $selectedURL
            )
            Divider().background(t.border)
            runFooter
        }
        .background(t.surface)
    }

    /// Compact one-click row per code repo. Lets the user kick off
    /// a GraphKit scan against a whole repo without drilling into the file
    /// tree. Highlighted state mirrors `codeTargetFolder` so it stays
    /// in sync with the file-tree selection.
    @ViewBuilder
    private var quickPickRepos: some View {
        let t = theme.current
        VStack(alignment: .leading, spacing: Spacing.sm) {
            SectionLabel("QUICK PICK")
            ForEach(availableCodeRepos) { repo in
                let isTarget = codeTargetFolder?.path == repo.root.path
                Button {
                    selectedURL = nil   // clear file selection; quick-pick is repo-level
                    generateCodeNotes(target: repo.root)
                } label: {
                    HStack(spacing: Spacing.sm) {
                        Image(systemName: Mode.code.icon)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(t.accent)
                        Text(repo.folderOrigin)
                            .font(Typography.bodyStrong)
                            .foregroundStyle(t.text)
                            .lineLimit(1).truncationMode(.middle)
                        Spacer()
                        Image(systemName: "play.fill")
                            .font(.system(size: 10))
                            .foregroundStyle(isTarget ? t.accent : t.textMuted)
                    }
                    .padding(.horizontal, Spacing.md).padding(.vertical, Spacing.sm)
                    .background(RoundedRectangle(cornerRadius: Radius.sm)
                        .fill(isTarget ? t.accent.opacity(0.10) : t.surface2.opacity(0.6)))
                    .overlay(RoundedRectangle(cornerRadius: Radius.sm)
                        .strokeBorder(isTarget ? t.accent.opacity(0.40) : t.border, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .disabled(status == .running)
                .help("Load graph for \(repo.folderOrigin)")
            }
        }
        .padding(.horizontal, Spacing.md).padding(.vertical, Spacing.md)
        .background(t.surface)
    }

    private var runFooter: some View {
        let t = theme.current
        return VStack(alignment: .leading, spacing: Spacing.sm) {
            modeBadge
            HStack(spacing: Spacing.sm) {
                Button(action: run) {
                    Label(currentRunButtonLabel, systemImage: "play.fill")
                        .font(Typography.button)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.regular)
                .tint(mode.tint(t))
                .disabled(!canRun || status == .running)
                if status == .running {
                    Button("Cancel") { runTask?.cancel() }
                        .buttonStyle(.bordered)
                        .controlSize(.regular)
                }
            }
            statusBlock
            switch mode {
            case .code:
                codeNotesProgressView
            case .data:
                Text("Scans .md / .txt files,\nchunks by headings.")
                    .font(Typography.caption).foregroundStyle(t.textMuted)
            }
        }
        .padding(Spacing.md)
        .background(t.surface)
    }

    private var currentRunButtonLabel: String {
        switch mode {
        case .code:
            if let folder = codeTargetFolder {
                return "Generate Code Graph for \(folder.lastPathComponent)"
            }
            return "Generate Code Graph — pick a Code item"
        case .data:
            if let item = selectedItem {
                if let origin = item.folderOrigin { return "Generate Memory from \(origin)" }
                return "Generate Memory from \(item.name)"
            }
            return "Generate Memory — pick a Data item"
        }
    }

    @ViewBuilder
    private var modeBadge: some View {
        let t = theme.current
        HStack(spacing: 6) {
            Image(systemName: mode.icon)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(mode.tint(t))
            Text("\(mode.displayName) mode")
                .font(Typography.captionStrong)
                .foregroundStyle(t.text)
            Spacer()
        }
        Text(modeHelpText)
            .font(Typography.caption)
            .foregroundStyle(t.textMuted)
    }

    /// Hint shown under the mode badge. Tailored to what the user
    /// currently has selected (or could click) so it's actionable.
    private var modeHelpText: String {
        switch mode {
        case .code:
            if selectedItem == nil, let target = codeTargetFolder {
                return "Will generate graph for \(target.lastPathComponent) — or click any file in the tree."
            }
            if codeTargetFolder == nil {
                return "Add a repo in Settings → GitLab/GitHub, then pick it here."
            }
            return mode.description
        case .data:
            if selectedItem?.category == .data || selectedItem?.category == .notes {
                return mode.description
            }
            return "Pick a .md or .txt file from DATA."
        }
    }

    @ViewBuilder
    private var statusBlock: some View {
        let t = theme.current
        switch status {
        case .idle:
            EmptyView()
        case .running:
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text({
                    switch mode {
                    case .code: return "Generating code graph…"
                    case .data: return "Generating memory…"
                    }
                }())
                    .font(Typography.caption).foregroundStyle(t.textMuted)
            }
        case .loaded(let n, let e):
            Label("\(n) nodes · \(e) edges", systemImage: "checkmark.circle.fill")
                .font(Typography.caption).foregroundStyle(t.accent3)
        case .error(let m):
            Label(m, systemImage: "exclamationmark.triangle.fill")
                .font(Typography.caption).foregroundStyle(t.danger)
                .lineLimit(3).truncationMode(.tail)
        }
    }

    // MARK: - Panel 2: Items

    private var itemsPanel: some View {
        let t = theme.current
        return VStack(alignment: .leading, spacing: 0) {
            modeTabs
            Divider().background(t.border)
            itemsSubheader
            Divider().background(t.border)
            switch mode {
            case .code:
                codeItemsList
            case .data:
                memoryItemsList
            }
        }
        .background(t.surface)
    }

    /// Tab switcher at the very top of panel 2. The active tab is the
    /// source of truth for which engine runs and which artifacts list
    /// shows below. Library selection (panel 1) nudges this via the
    /// `onChange(of: selectedURL)` observer.
    private var modeTabs: some View {
        let t = theme.current
        return HStack(spacing: 0) {
            ForEach(Mode.allCases) { tab in
                let active = (tab == mode)
                let tint = tab.tint(t)
                Button {
                    if mode != tab { mode = tab }
                } label: {
                    VStack(spacing: 4) {
                        HStack(spacing: 6) {
                            Image(systemName: tab.icon).font(.system(size: 12, weight: .medium))
                            Text(tab.displayName).font(Typography.bodyStrong)
                        }
                        .foregroundStyle(active ? tint : t.textMuted)
                        Rectangle()
                            .fill(active ? tint : Color.clear)
                            .frame(height: 2)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, Spacing.sm)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(tab.description)
            }
        }
        .frame(height: 40)
        .background(t.surface)
    }

    /// Sub-header under the tabs: artifact-count summary on the right,
    /// human-readable label of what's listed below on the left.
    private var itemsSubheader: some View {
        let t = theme.current
        return HStack {
            SectionLabel(mode == .code ? "FILES & SYMBOLS" : "MEMORY")
            Spacer()
            if mode == .data, memoryDocCount > 0 {
                Text("\(memoryDocCount) docs")
                    .font(Typography.caption).foregroundStyle(t.textMuted)
            } else if mode == .code, !codeArtifacts.isEmpty {
                Text("\(codeArtifacts.count) items")
                    .font(Typography.caption).foregroundStyle(t.textMuted)
            }
        }
        .padding(.horizontal, Spacing.lg).padding(.vertical, Spacing.sm)
    }

    @ViewBuilder
    private var codeItemsList: some View {
        let t = theme.current
        if codeArtifacts.isEmpty {
            placeholderText("Generate graph to populate.")
        } else {
            List(selection: nodeSelectionBinding) {
                ForEach(codeArtifacts) { artifact in
                    Section {
                        ForEach(artifact.symbols) { sym in
                            HStack(spacing: Spacing.sm) {
                                Circle().fill(CGPalette.color(for: sym.node.kind))
                                    .frame(width: 7, height: 7)
                                Text(sym.node.title)
                                    .font(Typography.filename)
                                    .foregroundStyle(t.text)
                                    .lineLimit(1).truncationMode(.middle)
                                Spacer()
                                if let line = sym.node.metadata["line"] {
                                    Text(line)
                                        .font(Typography.mono)
                                        .foregroundStyle(t.textMuted.opacity(0.7))
                                }
                            }
                            .tag(sym.node.id)
                        }
                    } header: {
                        HStack(spacing: 6) {
                            Image(systemName: "doc.text")
                                .font(.system(size: 10))
                                .foregroundStyle(t.textMuted)
                            Text(artifact.fileNode.title)
                                .font(Typography.bodyStrong)
                                .foregroundStyle(t.text)
                                .tag(artifact.fileNode.id)
                        }
                    }
                }
            }
            .listStyle(.sidebar)
        }
    }

    @ViewBuilder
    private var memoryItemsList: some View {
        let t = theme.current
        if memoryChunks.isEmpty {
            placeholderText("Generate Memory to populate.")
        } else {
            List(selection: nodeSelectionBinding) {
                ForEach(groupedChunks, id: \.doc) { group in
                    Section {
                        ForEach(group.chunks) { chunk in
                            VStack(alignment: .leading, spacing: 3) {
                                HStack(spacing: 6) {
                                    Circle().fill(CGPalette.color(for: chunk.kind))
                                        .frame(width: 7, height: 7)
                                    Text(chunk.displayHeading)
                                        .font(Typography.bodyStrong)
                                        .foregroundStyle(t.text)
                                        .lineLimit(1).truncationMode(.tail)
                                    Spacer()
                                    if chunk.kind != .memoryChunk {
                                        Text(chunk.kind.displayName.uppercased())
                                            .font(Typography.captionStrong)
                                            .foregroundStyle(CGPalette.color(for: chunk.kind))
                                            .padding(.horizontal, 5).padding(.vertical, 1)
                                            .background(Capsule()
                                                .fill(CGPalette.color(for: chunk.kind).opacity(0.15)))
                                    }
                                }
                                Text(chunk.body.trimmingCharacters(in: .whitespacesAndNewlines))
                                    .font(Typography.caption)
                                    .foregroundStyle(t.textMuted)
                                    .lineLimit(2)
                            }
                            .padding(.vertical, 2)
                            .tag(chunk.id)
                        }
                    } header: {
                        HStack(spacing: 6) {
                            Image(systemName: "doc.richtext")
                                .font(.system(size: 10))
                                .foregroundStyle(t.textMuted)
                            Text(group.doc)
                                .font(Typography.bodyStrong)
                                .foregroundStyle(t.text)
                        }
                    }
                }
            }
            .listStyle(.sidebar)
        }
    }

    @ViewBuilder
    private func placeholderText(_ s: String) -> some View {
        VStack {
            Spacer()
            Text(s).foregroundStyle(theme.current.textMuted).font(Typography.emptyHint)
                .multilineTextAlignment(.center)
                .padding(.horizontal, Spacing.lg)
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Panel 3: Canvas

    private var canvasPanel: some View {
        let t = theme.current
        return VStack(spacing: 0) {
            canvasToolbar
            // Top: the graph itself, taking as much space as available.
            ZStack {
                t.body
                if displayData.nodes.isEmpty {
                    EmptyStateView(
                        icon: "point.3.connected.trianglepath.dotted",
                        title: {
                            switch mode {
                            case .code: return "No code graph yet"
                            case .data: return "No memory yet"
                            }
                        }(),
                        message: {
                            switch mode {
                            case .code: return "Pick a repo on the left, then click Generate Code Graph."
                            case .data: return "Pick a .md / .txt file in the DATA section, then Generate Memory."
                            }
                        }()
                    )
                } else {
                    CodeGraphCanvas(data: displayData, selected: $selectedNode,
                                    focusedNode: $focusedNode,
                                    showLabels: showLabels,
                                    highlightKind: filterKind,
                                    onNodeOpen: openNode)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            // Detail inspector only when there's a graph to inspect.
            // Suppressing it on an empty canvas removes one of the
            // three "nothing here" panels users would otherwise see
            // before they've run an analysis — the canvas's empty
            // state is enough on its own.
            if !displayData.nodes.isEmpty {
                Divider().background(t.border)
                detailPanel
                    .frame(minHeight: 140,
                           idealHeight: detailPaneIdealHeight,
                           maxHeight: detailPaneIdealHeight)
            }
        }
        .background(t.body)
    }

    /// 220pt for the lightweight summary states, 420pt when an actual
    /// file is being rendered via FileDetailView. Coupled with a 140pt
    /// minimum so SwiftUI can shrink it on small windows.
    private var detailPaneIdealHeight: CGFloat {
        guard let node = selectedNode else { return 220 }
        return shouldRenderFileDetail(for: node) ? 420 : 220
    }

    /// True when the selected node has a real on-disk file we can hand
    /// to FileDetailView. Memory chunks render their own body text
    /// inline because they're a *section* of a doc, not the whole file.
    private func shouldRenderFileDetail(for node: CGNode) -> Bool {
        guard node.kind != .memoryChunk, node.kind != .memoryDoc,
              let urlString = node.metadata["fileURL"],
              let url = URL(string: urlString) else { return false }
        return FileManager.default.fileExists(atPath: url.path)
    }

    /// Bottom pane: details for the currently-selected node. For code
    /// symbols this is title + file path + line; for memory chunks it's
    /// title + heading path + body text. Empty state nudges the user
    /// toward clicking something.
    @ViewBuilder
    private var detailPanel: some View {
        if let node = selectedNode {
            detailContent(for: node)
        } else {
            detailEmpty
        }
    }

    private var detailEmpty: some View {
        let t = theme.current
        return VStack(spacing: Spacing.sm) {
            Image(systemName: "cursorarrow.rays")
                .font(.system(size: 22, weight: .light))
                .foregroundStyle(t.textMuted.opacity(0.5))
            Text("Select a node to inspect")
                .font(Typography.emptyTitle)
                .foregroundStyle(t.text)
            Text("Click a node in the graph, or a row in the \(mode.displayName) panel.")
                .font(Typography.caption).foregroundStyle(t.textMuted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(t.surface)
    }

    @ViewBuilder
    private func detailContent(for node: CGNode) -> some View {
        let t = theme.current
        let nodeColor = CGPalette.color(for: node.kind)
        VStack(alignment: .leading, spacing: Spacing.sm) {
            // Header row: type swatch + title + type badge + Open button.
            HStack(spacing: Spacing.sm) {
                Circle().fill(nodeColor).frame(width: 10, height: 10)
                Text(node.title)
                    .font(Typography.title)
                    .foregroundStyle(t.text)
                    .lineLimit(1).truncationMode(.middle)
                Text(node.kind.displayName.uppercased())
                    .font(Typography.captionStrong)
                    .foregroundStyle(nodeColor)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Capsule().fill(nodeColor.opacity(0.15)))
                Spacer()
                if node.metadata["fileURL"] != nil {
                    Button("Open") { openNode(node) }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
            }

            // Sub-row: heading path (memory) OR file path + line (code).
            if let heading = node.metadata["heading"] {
                Label(heading, systemImage: "list.bullet.indent")
                    .font(Typography.caption).foregroundStyle(t.textMuted)
                    .lineLimit(1).truncationMode(.middle)
            }
            if let source = node.metadata["source_file"] ?? prettyPath(from: node.metadata["fileURL"]) {
                HStack(spacing: 6) {
                    Image(systemName: "doc.text")
                        .font(.system(size: 10))
                        .foregroundStyle(t.textMuted.opacity(0.7))
                    Text(source)
                        .font(Typography.mono).foregroundStyle(t.textMuted)
                        .lineLimit(1).truncationMode(.middle)
                    if let line = node.metadata["line"] {
                        Text(line)
                            .font(Typography.mono)
                            .foregroundStyle(t.textMuted.opacity(0.7))
                    }
                    if let lang = node.metadata["language"] {
                        Text(lang).font(Typography.caption)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Capsule().fill(t.surface2))
                            .foregroundStyle(t.textMuted)
                    }
                    Spacer()
                }
            }

            Divider().background(t.border)
            // Body: in priority order:
            //   1. Memory chunk → show its chunked body inline.
            //   2. Real on-disk file → embed FileDetailView so the
            //      user sees the same markdown / code / PDF viewer
            //      the Library uses.
            //   3. fileURL points at a missing file → stale-graph
            //      hint + connectivity summary + re-run CTA. The
            //      old "← 1 incoming"-only fallback was uselessly
            //      sparse when the agent emitted paths that no
            //      longer exist (common after a repo move).
            //   4. Code symbol with no fileURL → connectivity only.
            if let chunk = memoryChunkById[node.id] {
                ScrollView {
                    Text(chunk.body.trimmingCharacters(in: .whitespacesAndNewlines))
                        .font(Typography.mono)
                        .foregroundStyle(t.text)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else if shouldRenderFileDetail(for: node),
                      let urlString = node.metadata["fileURL"],
                      let url = URL(string: urlString) {
                FileDetailView(url: url)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let urlString = node.metadata["fileURL"],
                      let url = URL(string: urlString),
                      !FileManager.default.fileExists(atPath: url.path) {
                staleFileDetail(for: node, url: url)
            } else {
                ScrollView {
                    Text(detailBodyForCodeNode(node))
                        .font(Typography.caption).foregroundStyle(t.textMuted)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(Spacing.md)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(t.surface)
    }

    /// Compact body for code-graph nodes (we don't have full source bodies
    /// — understand-anything only emits structural metadata). Shows neighbour counts
    /// so the user can gauge "how connected" the node is at a glance.
    /// Detail body when the node's fileURL points at a file that
    /// doesn't exist on disk. Happens after a repo move when the
    /// staleness sampler missed a particular node, or when the
    /// graph indexed a file that's since been deleted. Surfaces
    /// what we *do* know (heading path, line, connectivity) plus a
    /// clear "graph is out of date" CTA — better than the bare
    /// "← N incoming" string that used to render here.
    @ViewBuilder
    private func staleFileDetail(for node: CGNode, url: URL) -> some View {
        let t = theme.current
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(t.accent4)
                        .font(.system(size: 12))
                    Text("File not found on disk")
                        .font(Typography.captionStrong)
                        .foregroundStyle(t.text)
                }
                Text("The graph indexed this file at:")
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
                Text(url.path)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(t.textMuted)
                    .textSelection(.enabled)
                    .lineLimit(2).truncationMode(.middle)
                Text("…but nothing's there now. The repo likely moved or the file was deleted. Re-generate the code graph to refresh.")
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: Spacing.sm) {
                    Button {
                        run()
                    } label: {
                        Label("Regenerate Graph", systemImage: "arrow.clockwise")
                            .font(Typography.captionStrong)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(!canRun)
                    Spacer()
                }
                Divider().background(t.border)
                // Show whatever else we know — connectivity, heading
                // path, line range — so a stale node isn't a dead
                // end. Often a heading path alone is enough for the
                // user to find the doc manually.
                if let heading = node.metadata["heading"] {
                    Label(heading, systemImage: "list.bullet.indent")
                        .font(Typography.caption)
                        .foregroundStyle(t.text)
                }
                Text(detailBodyForCodeNode(node))
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func detailBodyForCodeNode(_ node: CGNode) -> String {
        let outgoing = fullData.edges.filter { $0.fromId == node.id }
        let incoming = fullData.edges.filter { $0.toId == node.id }
        var parts: [String] = []
        if !outgoing.isEmpty { parts.append("→ \(outgoing.count) outgoing") }
        if !incoming.isEmpty { parts.append("← \(incoming.count) incoming") }
        if let kind = node.metadata["ua_kind"] { parts.append("kind: \(kind)") }
        return parts.isEmpty ? "No additional details for this node." : parts.joined(separator: " · ")
    }

    private func prettyPath(from absoluteURLString: String?) -> String? {
        guard let s = absoluteURLString, let url = URL(string: s) else { return nil }
        let abs = url.path
        if let root = codeTargetFolder?.standardizedFileURL.path,
           abs.hasPrefix(root + "/") {
            return String(abs.dropFirst(root.count + 1))
        }
        return abs
    }

    /// Top-of-canvas toolbar with view filters. Files-only by default;
    /// flip the toggle to include class/function/method symbols (heavier
    /// but more detailed). Hidden when there's no graph yet.
    @ViewBuilder
    private var canvasToolbar: some View {
        let t = theme.current
        HStack(spacing: Spacing.md) {
            // Mode icon + name on the left so the canvas header always
            // identifies the active engine, even when both side panels
            // are collapsed.
            HStack(spacing: 6) {
                Image(systemName: mode.icon)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(mode.tint(t))
                Text(mode.displayName)
                    .font(Typography.bodyStrong)
                    .foregroundStyle(t.text)
            }

            if !fullData.nodes.isEmpty, mode == .code {
                Divider().frame(height: 14)
                Toggle(isOn: $showSymbols) {
                    Label("Symbols", systemImage: showSymbols ? "function" : "doc")
                        .font(Typography.caption)
                }
                .toggleStyle(.switch)
                .controlSize(.small)
                Divider().frame(height: 14)
                Toggle(isOn: $showLabels) {
                    Label("Labels", systemImage: showLabels ? "text.bubble.fill" : "text.bubble")
                        .font(Typography.caption)
                }
                .toggleStyle(.switch)
                .controlSize(.small)
                Divider().frame(height: 14)
                Text("\(displayData.nodes.count) / \(fullData.nodes.count) nodes")
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)

                // Kind filter legend — clickable pills
                if !displayData.nodes.isEmpty {
                    Divider().frame(height: 14)
                    kindFilterBar(t: t)
                }

                // Focus mode indicator
                if focusedNode != nil {
                    Divider().frame(height: 14)
                    Button {
                        withAnimation(.easeInOut(duration: 0.15)) { focusedNode = nil }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "scope").font(Typography.caption)
                            Text("Focus").font(Typography.caption)
                            Image(systemName: "xmark").font(.system(size: 8))
                        }
                        .foregroundStyle(t.accent)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Capsule().fill(t.accent.opacity(0.12)))
                    }
                    .buttonStyle(.plain)
                    .help("Clear focus (or double-click empty space)")
                }
            }
            Spacer()
            if status == .running {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small).scaleEffect(0.75)
                    Text({
                        switch mode {
                        case .code: return "Generating code graph…"
                        case .data: return "Generating memory…"
                        }
                    }())
                        .font(Typography.caption)
                        .foregroundStyle(t.textMuted)
                }
            }
            if !displayData.nodes.isEmpty {
                Button {
                    graphExpanded = true
                } label: {
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                        .font(.system(size: 12, weight: .semibold))
                }
                .buttonStyle(.plain)
                .foregroundStyle(t.textMuted)
                .help("Expand graph to full page")
            }
        }
        .padding(.horizontal, Spacing.lg).padding(.vertical, Spacing.sm)
        .frame(height: 40)
        .background(t.surface)
        Divider().background(t.border)
    }

    /// Full-window overlay presenting just the graph canvas, with a close
    /// button. Reuses the same canvas + selection bindings so zoom/pan and
    /// node selection behave identically to the embedded view.
    private var expandedGraphOverlay: some View {
        let t = theme.current
        return ZStack(alignment: .topTrailing) {
            t.body.ignoresSafeArea()
            CodeGraphCanvas(data: displayData, selected: $selectedNode,
                                    focusedNode: $focusedNode,
                                    showLabels: showLabels,
                                    highlightKind: filterKind,
                                    onNodeOpen: openNode)
            Button {
                graphExpanded = false
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 22))
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(t.textMuted)
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.escape, modifiers: [])
            .help("Close full-page graph (Esc)")
            .padding(Spacing.lg)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(t.body)
        .transition(.opacity)
    }

    // (selectionFooter removed — superseded by the permanent detailPanel
    //  in the bottom half of the canvas split.)

    // MARK: - Bindings & grouping

    /// Resolves a List-row id to the node in the *currently rendered*
    /// graph. If the user picks a symbol while showSymbols is off, we
    /// auto-flip it so the centre-on-select animation has something to
    /// land on — otherwise the symbol wouldn't be in displayData.
    private var nodeSelectionBinding: Binding<String?> {
        Binding(
            get: { selectedNode?.id },
            set: { newID in
                guard let id = newID,
                      let node = fullData.nodes.first(where: { $0.id == id }) else {
                    selectedNode = nil; return
                }
                if !showSymbols, node.kind == .symbol { showSymbols = true }
                selectedNode = node
            }
        )
    }

    private var groupedChunks: [(doc: String, chunks: [MemoryChunk])] {
        let groups = Dictionary(grouping: memoryChunks, by: \.docTitle)
        return groups.keys.sorted().map { ($0, groups[$0] ?? []) }
    }

    // MARK: - Actions

    private func run() {
        switch mode {
        case .code: if let folder = codeTargetFolder { generateCodeNotes(target: folder) }
        case .data: generateMemory()
        }
    }

    /// Generate from selected Data item. If the item is a folder-origin
    /// group, chunk every file in that group. If it's a single file,
    /// chunk just that file. Source of truth is LibraryItemStore.
    private func generateMemory() {
        guard let item = selectedItem else { return }
        let urls: [URL]
        if let origin = item.folderOrigin {
            urls = library.items
                .filter { $0.folderOrigin == origin }
                .map(\.url)
        } else {
            urls = [item.url]
        }
        status = .running
        runTask = Task.detached(priority: .userInitiated) {
            let mem = MemoryGenerator.generate(files: urls)
            if Task.isCancelled { return }
            let initial = CodeGraphLayout.compute(mem.graph,
                                                  canvasSize: CGSize(width: 1200, height: 800))
            if Task.isCancelled { return }
            await MainActor.run {
                self.selectedNode = nil
                self.memoryChunks = mem.chunks
                self.memoryDocCount = mem.docCount
                self.fullData = initial
                self.status = .loaded(nodeCount: mem.graph.nodes.count,
                                      edgeCount: mem.graph.edges.count)
                // Settle into the same organic layout as the code graph.
                self.settlePhysics(from: initial, expectedMode: .data)
            }
        }
    }

    /// Phase 2 of layout: run the force-directed `CGSimulation` off the main
    /// actor, then republish the settled positions. Mirrors InfiniteBrain's
    /// `CodeGraphView` so both graphs show an organic cluster instead of the
    /// raw circular rings. No-op for trivially small graphs. The `expectedMode`
    /// guard drops the result if the user switched tabs mid-settle.
    private func settlePhysics(from initial: CGData, expectedMode: Mode) {
        let count = initial.nodes.count
        guard count > 2 else { return }
        // Each tick is O(n log n) (Barnes-Hut). Scale iterations down for large
        // graphs so a 1k-node settle doesn't run hundreds of heavy ticks — the
        // early-exit on low velocity usually stops sooner anyway.
        let maxIterations: Int
        switch count {
        case ..<300:   maxIterations = 200
        case ..<700:   maxIterations = 140
        case ..<1200:  maxIterations = 90
        default:       maxIterations = 60
        }
        Task.detached(priority: .userInitiated) {
            let sim = CGSimulation(data: initial)
            sim.settle(maxIterations: maxIterations)
            if Task.isCancelled { return }
            let settled = sim.appliedData(to: initial)
            await MainActor.run {
                guard self.mode == expectedMode,
                      self.fullData.nodes.count == settled.nodes.count else { return }
                self.fullData = settled
            }
        }
    }

    private func generateCodeNotes(target: URL) {
        status = .running
        Task {
            let result = await codeNoteService.generate(repoRoot: target)
            if case .failure(let err) = result {
                await MainActor.run { self.status = .error("\(err)") }
            }
            // Success rendering is driven by the codeNoteService.$graph observer
            // (set up in Step 2), so the background enrichment updates also flow in.
        }
    }

    @ViewBuilder
    private var codeNotesProgressView: some View {
        let t = theme.current
        switch codeNoteService.progress {
        case .idle:
            EmptyView()
        case .scanning:
            Text("Scanning files…")
                .font(Typography.caption).foregroundStyle(t.textMuted)
        case .buildingGraph:
            Text("Building graph + notes…")
                .font(Typography.caption).foregroundStyle(t.textMuted)
        case .complete(let f, let e, let reused):
            Text("\(f) files · \(e) edges" + (reused > 0 ? " · \(reused) cached" : ""))
                .font(Typography.caption).foregroundStyle(t.accent3)
        case .failed(let msg):
            Text(msg).font(Typography.caption).foregroundStyle(.red)
        }
    }

    private func openNode(_ node: CGNode) {
        guard let urlString = node.metadata["fileURL"],
              let fileURL = URL(string: urlString) else { return }
        // Containment: only open files under the selected code folder, or
        // any path matching a known library item.
        if let root = codeTargetFolder {
            let rootPath = root.standardizedFileURL.path
            let filePath = fileURL.standardizedFileURL.path
            if filePath.hasPrefix(rootPath + "/") || filePath == rootPath {
                NSWorkspace.shared.activateFileViewerSelecting([fileURL]); return
            }
        }
        if library.items.contains(where: { $0.path == fileURL.path }) {
            NSWorkspace.shared.activateFileViewerSelecting([fileURL])
        }
    }

    // MARK: - Kind filter bar

    /// Compact inline legend — click a kind pill to highlight only those nodes;
    /// click again to clear. Resets automatically via onChange(of: mode).
    @ViewBuilder
    private func kindFilterBar(t: Theme) -> some View {
        let filterableKinds: Set<CGNodeKind> = [.file, .module, .classType, .function,
                                                 .service, .endpoint, .table, .config]
        let presentKinds = Array(Set(displayData.nodes.map(\.kind))
            .intersection(filterableKinds))
            .sorted { $0.rawValue < $1.rawValue }

        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(presentKinds, id: \.self) { kind in
                    let isActive = filterKind == kind
                    Button {
                        withAnimation(.easeInOut(duration: 0.15)) {
                            filterKind = isActive ? nil : kind
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Circle()
                                .fill(CGPalette.color(for: kind))
                                .frame(width: 7, height: 7)
                            Text(kind.displayName)
                                .font(Typography.caption)
                                .foregroundStyle(isActive ? t.text : t.textMuted)
                        }
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(
                            RoundedRectangle(cornerRadius: 4)
                                .fill(isActive
                                      ? CGPalette.color(for: kind).opacity(0.15)
                                      : Color.clear)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 4)
                                .strokeBorder(isActive
                                              ? CGPalette.color(for: kind).opacity(0.4)
                                              : Color.clear, lineWidth: 1)
                        )
                    }
                    .buttonStyle(.plain)
                    .help(isActive ? "Showing only \(kind.displayName) — click to clear"
                                   : "Highlight \(kind.displayName) nodes")
                }
            }
        }
        .frame(height: 22)
        .onChange(of: mode) { _, _ in filterKind = nil }
    }

}
