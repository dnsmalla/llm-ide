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
import GraphCore
import AppKit
import os
import simd

@MainActor
struct UAGraphView: View {
    nonisolated private static let log = Logger(subsystem: "com.llmide.macapp", category: "UAGraphView")

    /// The two engines this view drives. User picks via the tab switcher
    /// at the top of panel 2; library-selection changes also nudge the
    /// tab to whichever engine matches the selected item's category.
    enum Mode: String, Identifiable, CaseIterable {
        case code            // → CodeNoteService generates code notes + graph
        case data            // → MemoryGenerator on docs (InfiniteBrain)
        case all             // → code + doc, merged into one graph

        var id: String { rawValue }

        var displayName: String {
            switch self {
            case .code: return "Code Graph"
            case .data: return "InfiniteBrain"
            case .all:  return "All"
            }
        }

        var icon: String {
            switch self {
            case .code: return "chevron.left.forwardslash.chevron.right"
            case .data: return "brain.head.profile"
            case .all:  return "square.grid.2x2"
            }
        }

        /// Theme-driven accent — picks a role from the active palette so
        /// the tint stays consistent across light / dark / midnight modes
        /// instead of fighting them with literal colour values.
        func tint(_ theme: Theme) -> Color {
            switch self {
            case .code: return theme.accent   // brand teal
            case .data: return theme.accent2  // info blue
            case .all:  return theme.accent3  // unified
            }
        }

        /// Library categories shown for this mode: Code Graph → code only,
        /// InfiniteBrain → docs/data, All → everything.
        var libraryCategories: [LibraryItem.Category] {
            switch self {
            case .code: return [.code]
            case .data: return [.data, .notes]
            case .all:  return [.code, .data, .notes]
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
            case .data: return "Generate InfiniteBrain"
            case .all:  return "Generate Graph"
            }
        }
        var description: String {
            switch self {
            case .code: return "Generate code notes + graph for the selected code folder."
            case .data: return "Build an InfiniteBrain doc graph from the project's docs."
            case .all:  return "One graph from all code + docs, with cross-links."
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
    /// When true, the graph canvas is presented as a full-window overlay
    /// (side panels hidden) for distraction-free exploration.
    @State private var graphExpanded: Bool = false
    /// Full graph as produced by the GraphKit scan. We filter this into `displayData`
    /// based on `showSymbols` so the canvas doesn't have to draw 1k+ nodes
    /// when the user just wants the file-level view.
    @State private var fullData: CGData = .empty
    /// The structural signals `GraphLayoutEngine` derived alongside the
    /// positions — cluster, importance, radius and per-edge weight.
    ///
    /// The canvas needs these to encode anything beyond node kind. Without
    /// them it recomputed adjacency on every redraw just to size a node, and
    /// the importance signals the app already computed in three other places
    /// (upload truncation, dependency-hub notes, high-impact files) never
    /// reached the drawing code at all.
    @State private var layout: GraphLayout = .empty
    /// Monotonic token identifying the most recent layout request.
    ///
    /// `mode == expectedMode` alone let the OLDER of two same-mode requests win
    /// whenever it happened to finish second: a manual generate of a small
    /// graph (~0.1s) racing a background hydrate of a large one (~3s)
    /// overwrote `fullData`, `layout` AND the session cache with the stale
    /// result.
    @State private var layoutGeneration: Int = 0
    @State private var selectedNode: CGNode?
    /// 3D rendering toggle + per-mode cache of settled 3D positions, so
    /// flipping 2D⇄3D (or revisiting a mode) doesn't re-run the 3D settle.
    @State private var render3D = false
    @State private var positions3DByMode: [Mode: [String: SIMD3<Float>]] = [:]
    @State private var runTask: Task<Void, Never>?
    /// The layout task, distinct from the generate task so Cancel can stop the
    /// right one and a new layout supersedes the previous one.
    @State private var layoutTask: Task<Void, Never>?
    /// Guards against `hydrateFromStore` launching several identical layouts.
    ///
    /// `GraphAutoUpdater.publishToSession` stores three modes, so
    /// `objectWillChange` fires three times; with only an `isEmpty` check on
    /// `fullData`, all three passed and started concurrent multi-second layouts
    /// of the same graph.
    @State private var hydrating = false
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

    /// Produces graphs. nil when no engine is installed, in which case the view
    /// still renders whatever is already cached or on disk — the model and the
    /// layout engine are always present — but cannot generate anything new.
    private let engine: GraphEngine? = GraphEngines.resolveDefault()

    /// Process-lifetime graph cache (per repo+mode). Lives above the view so a
    /// generated graph survives this view being torn down and rebuilt on
    /// navigation (AppShell re-instantiates `UAGraphView()`), instead of being
    /// lost with the view's `@State`. Replaces the old per-view `graphCache`.
    @EnvironmentObject private var graphSessionStore: GraphSessionStore
    // The background generator (GraphAutoUpdater) and the project store: the
    // view reads these so it can anchor its graph on the SAME repo the
    // auto-updater graphs (see `graphRepoRoot`). Both are app-level environment
    // objects already injected for AppShell, so they're satisfied here too.
    @EnvironmentObject private var projectStore: ProjectStore
    @EnvironmentObject private var graphAutoUpdater: GraphAutoUpdater

    /// The repo whose graph THIS page should display. When the active project
    /// already has a generated graph on disk (`system/graph/index.md`), use the
    /// repo the auto-updater resolves to — so the view reads/writes the SAME
    /// `repo#mode` key the background generator writes. Without this the view
    /// keyed by the Library-selected code folder (e.g. `code/<repo>`) while the
    /// auto-updater keyed by the project root, so an auto-maintained graph was
    /// stored under one key and looked up under another → "No code graph yet"
    /// even though a graph existed. Falls back to the Library-selected repo when
    /// no project graph exists yet.
    private var graphRepoRoot: URL? {
        if let ap = projectStore.activeProject {
            let projectRoot = URL(fileURLWithPath: ap.localPath)
            // Resolve via the auto-updater's `repoToGraph` — the same repo (a
            // `code/<child>` git repo for a clone-into-code layout) the
            // generator publishes the graph under — so the page reads the same
            // `repo#mode` entry even before the first run, instead of guessing
            // from a stale on-disk graph at the project root.
            if let graphed = GraphAutoUpdater.repoToGraph(projectRoot: projectRoot) {
                return graphed
            }
        }
        return activeRepoRoot
    }

    // Cache accessors — key by the graph repo (see `graphRepoRoot`) so the page
    // reads the same entry the auto-updater writes, and by mode so each engine
    // keeps its own.
    private func cachedGraph(_ m: Mode) -> CGData? {
        graphSessionStore.entry(repo: graphRepoRoot, mode: m.rawValue)?.graph
    }
    private func cacheGraph(_ m: Mode, _ graph: CGData,
                            chunks: [MemoryChunk]? = nil, docCount: Int? = nil,
                            fingerprint: String? = nil) {
        graphSessionStore.store(repo: graphRepoRoot, mode: m.rawValue,
                                graph: graph, chunks: chunks, docCount: docCount,
                                docFingerprint: fingerprint)
    }

    /// Restore the current mode's graph from the session store when the view
    /// re-appears after navigation — so a once-generated graph shows instantly
    /// instead of requiring a regenerate.
    private func hydrateFromStore() {
        guard !hydrating,
              fullData.nodes.isEmpty,
              let entry = graphSessionStore.entry(repo: graphRepoRoot, mode: mode.rawValue),
              !entry.graph.nodes.isEmpty
        else { return }
        memoryChunks = entry.chunks
        memoryDocCount = entry.docCount
        if mode == .code { codeArtifacts = UAHelpers.collectCodeArtifacts(entry.graph) }

        if entry.laidOut {
            // The view's own generate stored a positioned graph — show it as-is,
            // then recover the derived signals for THIS graph.
            fullData = entry.graph
            status = .loaded(nodeCount: entry.graph.nodes.count, edgeCount: entry.graph.edges.count)
            adoptLayout(for: entry.graph, mode: mode)
        } else {
            // The background GraphAutoUpdater stored a RAW graph (no positions).
            // Lay it out with the same single entry point a manual generate
            // uses, which re-caches the finished result (`laidOut == true`) so a
            // later re-appear skips this step.
            //
            // There is no longer a per-mode canvas size to match. Layout is
            // canvas-independent: the engine places clusters in its own
            // coordinate space and the canvas fits the result. Previously the
            // code path sized its canvas by node count (up to 8000×5600) while
            // the simulation pulled everything to a hardcoded (600, 400) — so
            // the settled code graph landed far off-screen, and the doc graph
            // only looked right because its fixed 1200×800 canvas happened to
            // centre near that point.
            status = .running
            // Cleared by `applyLayout`'s completion, whichever way it exits.
            hydrating = true
            applyLayout(entry.graph, for: mode,
                        chunks: entry.chunks, docCount: entry.docCount)
        }
    }

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
        // Draw exactly the edges the LAYOUT used.
        //
        // Two reasons, both real. Correctness: a sub-threshold edge drawn over
        // positions computed without it connects two nodes placed with no
        // regard for each other, so the hairball comes back as pure noise.
        // Cost: removing `GraphPrune.capDegree(6)` left the canvas walking the
        // full edge set every frame, and the doc graph reaches ~700k edges at
        // average degree 124 — the cap was the only thing bounding that, so
        // dropping it without a draw-side filter traded a bad picture for a
        // frozen one.
        //
        // `layout.edgeWeight` holds the links that survived weight filtering,
        // in both orientations, so this tracks the layout rather than
        // re-deriving a threshold. With no layout yet — the hydrate path —
        // fall back to the same threshold the engine applies.
        //
        // Two known divergences, both deliberate: the key is per COLLAPSED
        // PAIR, so once any strong edge exists between A and B every parallel
        // edge of that pair is drawn (the dozens of per-call-site `calls`
        // segments included); and a self-edge is never in the map at all
        // (`GraphTopology` skips `source == target`), so it is drawn during the
        // hydrate window and then disappears. Neither draws an edge between
        // nodes the layout ignored, which is the property that matters.
        // The map must actually belong to THIS graph. `layout` is written only
        // when a layout or a signal recovery lands, so between assigning
        // `fullData` for a new mode and those signals arriving it still holds
        // the previous mode's map — and code and doc node ids are disjoint by
        // construction, so filtering doc edges through the code map dropped
        // every single one. The canvas drew the graph as a field of
        // unconnected dots for a second or more.
        //
        // Sampling a few ids is enough to tell a foreign map from a current
        // one, and is O(1) where comparing key sets would not be.
        let survives: (CGEdge) -> Bool
        // ALL, not ANY. `merge` emits code nodes before doc nodes, so the
        // first 8 ids of the merged graph are all code ids — and a stale Code
        // layout does contain those, so an any-match claimed coverage of the
        // All graph and filtered it through the code map, dropping every
        // doc–doc edge. `layout.positions` is built from `topology.idByIndex`,
        // which covers every unique id of the graph it was computed for, so a
        // genuinely matching layout always satisfies all 8.
        let sample = fullData.nodes.prefix(8)
        let layoutCoversGraph = !layout.positions.isEmpty
            && sample.allSatisfy { layout.positions[$0.id] != nil }
        if layout.edgeWeight.isEmpty || !layoutCoversGraph {
            // Same rule the engine applies, so the interim frame is right
            // rather than merely non-empty.
            survives = { EdgeWeight.weight(of: $0) >= EdgeWeight.defaultMinWeight }
        } else {
            let weights = layout.edgeWeight
            survives = { weights[GraphLayout.edgeKey($0.fromId, $0.toId)] != nil }
        }

        // The files-only filter applies to modes that HAVE code symbols
        // (.code and .all); .data has no symbols so every node is kept.
        let keptNodes = (showSymbols || mode == .data)
            ? fullData.nodes
            : fullData.nodes.filter { Self.filesOnlyKinds.contains($0.kind) }
        let keptIds = Set(keptNodes.map(\.id))
        let edges = fullData.edges.filter {
            keptIds.contains($0.fromId) && keptIds.contains($0.toId) && survives($0)
        }
        // Carry layers/tour through. Every transform in this pipeline used to
        // drop them by constructing `CGData(nodes:edges:)`, so a producer that
        // populated either found them erased before anything could render them.
        displayData = CGData(nodes: keptNodes, edges: edges,
                             layers: fullData.layers, tour: fullData.tour)
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
            // One entry per TOP-LEVEL repo (the first path component under
            // code/), not per parent-folder name — so the picker lists
            // "InfiniteBrain" once instead of each inner folder (App, Client,
            // CodeGraph, improve-note, …).
            guard let repoName = item.treePath?.first, !seen.contains(repoName) else { continue }
            seen.insert(repoName)
            // Repo root: strip the filename + all treePath components back to
            // the scan root (code/), then append the repo name.
            var scanRoot = item.url.deletingLastPathComponent()
            for _ in 0..<(item.treePath?.count ?? 0) { scanRoot.deleteLastPathComponent() }
            repos.append(CodeRepo(folderOrigin: repoName,
                                  root: scanRoot.appendingPathComponent(repoName)))
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
        case .data: return selectedItem?.category == .data || selectedItem?.category == .notes || activeRepoRoot != nil
        case .all:  return activeRepoRoot != nil
        }
    }

    /// The repo to scan for a project-level generate (Code / InfiniteBrain /
    /// All): the selected code folder, else the single/first available repo.
    /// InfiniteBrain and All walk this repo ON DISK for docs/code — they do not
    /// rely on `library.items`, which only indexes code files (so the project's
    /// README.md / docs/ wouldn't appear there and the doc graph never ran).
    private var activeRepoRoot: URL? {
        codeTargetFolder ?? availableCodeRepos.first?.root
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

    private var graphChromeBar: some View {
        SectionChromeBar(toggles: [
            SectionToggle(icon: "sidebar.left", isOn: showLibraryPanel,
                          helpOn: "Hide Library", helpOff: "Show Library") {
                withAnimation(.easeInOut(duration: 0.18)) { showLibraryPanel.toggle() }
            },
        ])
    }

    var body: some View {
        VStack(spacing: 0) {
            graphChromeBar
            Divider()
            // Fixed-width left panels (HSplitView overrides a child's width
            // frame); the canvas fills the rest.
            HStack(spacing: 0) {
                if showLibraryPanel {
                    controlsPanel
                        .frame(width: 280)
                        .transition(.move(edge: .leading).combined(with: .opacity))
                    Divider()
                }
                canvasArea
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme.current.body)
        .overlay {
            if graphExpanded { expandedGraphOverlay }
        }
        .animation(.easeInOut(duration: 0.18), value: showLibraryPanel)
        .animation(.easeInOut(duration: 0.2), value: graphExpanded)
        .onAppear {
            rebuildLibraryIndex()
            hydrateFromStore()
        }
        .onReceive(graphSessionStore.objectWillChange) { _ in
            // The auto-updater can publish a freshly generated graph into the
            // session store AFTER this page is already on screen (its first run
            // completes a few seconds after launch). objectWillChange fires just
            // before `entries` mutates, so hop one tick then re-hydrate — a
            // no-op unless `fullData` is still empty, so it only fills a blank
            // page and never clobbers a graph the user is already viewing.
            DispatchQueue.main.async { hydrateFromStore() }
        }
        .onDisappear { runTask?.cancel(); layoutTask?.cancel() }
        .onChange(of: library.items) { _, _ in rebuildLibraryIndex() }
        .onChange(of: fullData)      { _, _ in
            recomputeDisplayData()
            positions3DByMode[mode] = nil          // 3D layout is stale for this mode
            if render3D { settle3DIfNeeded() }
        }
        .onChange(of: showSymbols)   { _, _ in
            recomputeDisplayData()
            positions3DByMode[mode] = nil          // 3D positions are keyed to the old node set
            if render3D { settle3DIfNeeded() }
        }
        .onReceive(codeNoteService.$graph) { rawGraph in
            guard mode == .code, !rawGraph.nodes.isEmpty else { return }
            // "md is doc": markdown files (.docPage) belong to InfiniteBrain, not
            // the Code graph — strip them before display/cache.
            let newGraph = FileClassifier.strippingDocNodes(from: rawGraph)
            guard !newGraph.nodes.isEmpty else { return }
            self.selectedNode = self.selectedNode  // keep selection
            self.codeArtifacts = UAHelpers.collectCodeArtifacts(newGraph)
            // No edge pruning. `GraphPrune.capDegree(6)` used to run here, and
            // because `StructureGraphBuilder` emits every `contains` edge before
            // the first `imports` edge, any file with more than six symbols
            // spent its whole budget on containment — measured against a real
            // repo it kept 0 of 684 import edges and shattered the graph into
            // 867 components. The layout engine filters by edge *weight*
            // instead, which removes title-match noise without touching a
            // single extracted dependency, and nothing is deleted.
            self.applyLayout(newGraph, for: .code)
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
        // Restore the active mode's last graph from the cache rather than
        // blanking — so switching tabs / picking a repo reuses an already-
        // generated graph, and a reset that races a fresh generation can't
        // wipe it (the cache holds the latest result).
        //
        // Only reuse a LAID-OUT entry directly. A raw entry (the auto-updater
        // stores doc/All graphs unpositioned) must go through
        // hydrateFromStore so it gets the same layout a manual generate
        // applies — otherwise it renders as a collapsed pile of nodes at the
        // origin instead of the clean spread the generate path produces. This
        // is what made "saved" data look different from a fresh generate.
        let entry = graphSessionStore.entry(repo: graphRepoRoot, mode: mode.rawValue)
        if let entry, entry.laidOut, !entry.graph.nodes.isEmpty {
            fullData = entry.graph
            memoryChunks = entry.chunks
            status = .loaded(nodeCount: entry.graph.nodes.count, edgeCount: entry.graph.edges.count)
            adoptLayout(for: entry.graph, mode: mode)
        } else {
            fullData = .empty
            codeArtifacts = []
            memoryChunks = []
            memoryDocCount = 0
            status = .idle
            recomputeDisplayData()
            // Raw cached graph (or none): lay it out + cap via the shared path.
            hydrateFromStore()
        }
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
                categories: mode.libraryCategories,
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
                    mode = .code        // quick-pick is a code-graph action; the
                                        // $graph observer only publishes in .code
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
            modeButtons
            Text(modeHelpText)
                .font(Typography.caption)
                .foregroundStyle(t.textMuted)
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
            case .code, .all:
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
            if let item = selectedItem, item.category == .data || item.category == .notes {
                if let origin = item.folderOrigin { return "Generate InfiniteBrain from \(origin)" }
                return "Generate InfiniteBrain from \(item.name)"
            }
            if let repo = activeRepoRoot { return "Generate InfiniteBrain for \(repo.lastPathComponent)" }
            return "Generate InfiniteBrain — pick a Code repo"
        case .all:
            if let repo = activeRepoRoot { return "Generate Graph for \(repo.lastPathComponent)" }
            return "Generate Graph — pick a Code repo"
        }
    }

    /// Two-button mode switcher in the left panel (Code Graph / InfiniteBrain).
    /// Picking a mode clears the node selection (the inspector belonged to the
    /// previous graph) and tints the matching library section via the active
    /// accent, so it's clear which part each mode operates on.
    /// A joined, branded segmented control for the three modes — active segment
    /// filled with that mode's accent, inactive segments quiet. One container
    /// (not three loose buttons) so it reads as a proper control.
    private var modeButtons: some View {
        let t = theme.current
        return HStack(spacing: 0) {
            ForEach(Array(Mode.allCases.enumerated()), id: \.element) { (idx, m) in
                let active = (m == mode)
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) {
                        mode = m
                        selectedNode = nil
                    }
                } label: {
                    Text(m.displayName)
                        .font(Typography.captionStrong)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                        .foregroundStyle(active ? Color.white : t.textMuted)
                        .background(active ? m.tint(t) : Color.clear)
                }
                .buttonStyle(.plain)
                .help(m.displayName)
                if idx < Mode.allCases.count - 1 && !active {
                    Divider().frame(height: 14)
                }
            }
        }
        .background(t.textMuted.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 7))
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(t.border, lineWidth: 0.5))
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
            if let repo = activeRepoRoot {
                return "Builds a doc graph from the .md / .txt docs in \(repo.lastPathComponent) — or pick a file in DATA."
            }
            return "Add a code repo (Settings) or .md / .txt files to build a doc graph."
        case .all:
            if let repo = activeRepoRoot {
                return "Builds one graph from all code + docs in \(repo.lastPathComponent), with cross-links."
            }
            return "Add a code repo (Settings) to build the combined graph."
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
                    case .data: return "Generating InfiniteBrain…"
                    case .all:  return "Generating graph…"
                    }
                }())
                    .font(Typography.caption).foregroundStyle(t.textMuted)
            }
        case .loaded(let n, let e):
            let split = FileClassifier.nodeCounts(fullData.nodes)
            HStack(spacing: 8) {
                Label("\(n) nodes · \(e) edges", systemImage: "checkmark.circle.fill")
                    .font(Typography.caption).foregroundStyle(t.accent3)
                // Code + doc unification badge: surface the code/doc split when
                // the graph carries docs (data/all modes) — on a pure code graph
                // doc == 0 and the breakdown would just be noise.
                if split.doc > 0 {
                    Text("\(split.code) code · \(split.doc) doc")
                        .font(Typography.caption).foregroundStyle(t.textMuted)
                }
            }
        case .error(let m):
            Label(m, systemImage: "exclamationmark.triangle.fill")
                .font(Typography.caption).foregroundStyle(t.danger)
                .lineLimit(3).truncationMode(.tail)
        }
    }

    // MARK: - Panel 3: Canvas

    /// The graph fills the area; when a node is selected, a resizable detail
    /// inspector slides in on the RIGHT (HSplitView → user-draggable divider)
    /// and disappears on deselect. Replaces the old always-on bottom pane.
    @ViewBuilder
    private var canvasArea: some View {
        if selectedNode != nil && !displayData.nodes.isEmpty {
            HSplitView {
                canvasPanel
                    .frame(minWidth: 360, maxWidth: .infinity)
                inspectorPanel
                    .frame(minWidth: 280, idealWidth: 360, maxWidth: 620)
            }
        } else {
            canvasPanel
                .frame(minWidth: 360, maxWidth: .infinity)
        }
    }

    /// Right-side detail inspector (node content) with a close button that
    /// deselects — which collapses the split back to a single graph pane.
    private var inspectorPanel: some View {
        let t = theme.current
        return VStack(spacing: 0) {
            HStack(spacing: Spacing.sm) {
                Image(systemName: "doc.text.magnifyingglass")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(t.textMuted)
                Text("Inspector").font(Typography.captionStrong).foregroundStyle(t.text)
                Spacer()
                Button { selectedNode = nil } label: {
                    Image(systemName: "xmark").font(.system(size: 11, weight: .semibold))
                }
                .buttonStyle(.plain)
                .foregroundStyle(t.textMuted)
                .help("Close inspector")
            }
            .padding(.horizontal, Spacing.md)
            .padding(.vertical, Spacing.sm)
            Divider().background(t.border)
            detailPanel
        }
        .background(t.surface)
    }

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
                            case .data: return "No InfiniteBrain graph yet"
                            case .all:  return "No graph yet"
                            }
                        }(),
                        message: {
                            switch mode {
                            case .code: return "Pick a repo on the left, then click Generate Code Graph."
                            case .data:
                                return activeRepoRoot == nil
                                    ? "Add a code repo (or .md / .txt docs), then Generate InfiniteBrain."
                                    : "Click Generate InfiniteBrain to build a doc graph from the project's docs — or pick a single file in DATA."
                            case .all:
                                return activeRepoRoot == nil
                                    ? "Add a code repo, then Generate Graph."
                                    : "Click Generate Graph to build one graph from all code + docs."
                            }
                        }()
                    )
                } else if render3D {
                    Graph3DView(data: displayData,
                                positions: positions3DByMode[mode] ?? [:],
                                selected: $selectedNode)
                } else {
                    CodeGraphCanvas(data: displayData, layout: layout,
                                    selected: $selectedNode,
                                    focusedNode: $focusedNode,
                                    showLabels: showLabels,
                                    highlightKind: filterKind,
                                    onNodeOpen: openNode)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(t.body)
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
            // Card-style header: type swatch + title + kind badge + Open, with
            // the heading / source path beneath — set apart from the body.
            VStack(alignment: .leading, spacing: 6) {
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
            }
            .padding(Spacing.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8).fill(t.surface2))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(t.border, lineWidth: 0.5))
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

            if !fullData.nodes.isEmpty {
                // Symbols toggle only where there ARE code symbols (code / all).
                if mode != .data {
                    Divider().frame(height: 14)
                    Toggle(isOn: $showSymbols) {
                        Label("Symbols", systemImage: showSymbols ? "function" : "doc")
                            .font(Typography.caption)
                    }
                    .toggleStyle(.switch)
                    .controlSize(.small)
                }
                Divider().frame(height: 14)
                Picker("", selection: $render3D) {
                    Text("2D").tag(false)
                    Text("3D").tag(true)
                }
                .pickerStyle(.segmented)
                .fixedSize()
                .onChange(of: render3D) { _, on in if on { settle3DIfNeeded() } }
                .help("Switch between the 2D canvas and the 3D scene")
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
                        case .data: return "Generating InfiniteBrain…"
                        case .all:  return "Generating graph…"
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
            if render3D {
                Graph3DView(data: displayData,
                            positions: positions3DByMode[mode] ?? [:],
                            selected: $selectedNode)
            } else {
                CodeGraphCanvas(data: displayData, layout: layout,
                                selected: $selectedNode,
                                focusedNode: $focusedNode,
                                showLabels: showLabels,
                                highlightKind: filterKind,
                                onNodeOpen: openNode)
            }
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

    // MARK: - Actions

    private func run() {
        switch mode {
        case .code: if let folder = codeTargetFolder { generateCodeNotes(target: folder) }
        case .data: generateMemory()
        case .all:  generateAll()
        }
    }

    /// Generate from selected Data item. If the item is a folder-origin
    /// group, chunk every file in that group. If it's a single file,
    /// chunk just that file. Source of truth is LibraryItemStore.
    private func generateMemory() {
        // From the selected DATA/NOTES item (or its folder group) when one is
        // chosen; otherwise from the whole project's docs — so InfiniteBrain has
        // a project-level generate, not just a per-file one.
        // A selected DATA/NOTES item (or its folder group) chunks just those
        // files; otherwise walk the active repo ON DISK for all its .md/.txt
        // docs — the project's README/docs/, which aren't in library.items.
        let selectedFiles: [URL]?
        if let item = selectedItem, item.category == .data || item.category == .notes {
            if let origin = item.folderOrigin {
                // Same category only: folderOrigin values are per-category
                // labels (llm-doc/plans and data/plans both yield "plans"),
                // so an unguarded match would chunk unrelated files.
                selectedFiles = library.items
                    .filter { $0.category == item.category && $0.folderOrigin == origin }
                    .map(\.url)
            } else {
                selectedFiles = [item.url]
            }
        } else {
            selectedFiles = nil
        }
        let repo = activeRepoRoot
        guard selectedFiles != nil || repo != nil else { return }

        // Reuse: a whole-repo InfiniteBrain generate is skipped when the doc set
        // is unchanged since the cached, laid-out .data graph (same stat
        // fingerprint the auto-updater uses) — so re-clicking Generate on
        // unchanged docs is instant instead of re-chunking every file. Only the
        // repo-walk case is fingerprinted; explicit file-scoped generates always
        // recompute. (Requires laidOut so we never display a raw graph.)
        if selectedFiles == nil, let repo,
           let entry = graphSessionStore.entry(repo: activeRepoRoot, mode: Mode.data.rawValue),
           entry.laidOut, !entry.graph.nodes.isEmpty,
           let cachedFp = entry.docFingerprint,
           cachedFp == (engine?.docSetFingerprint(roots: [repo]) ?? cachedFp) {
            selectedNode = nil
            memoryChunks = entry.chunks
            memoryDocCount = entry.docCount
            fullData = entry.graph
            status = .loaded(nodeCount: entry.graph.nodes.count, edgeCount: entry.graph.edges.count)
            // The third `fullData =` site. Without this, `layout` could stay
            // empty permanently on this path, so nothing was ever labelled at
            // fit zoom — the defect the importance gating exists to fix.
            adoptLayout(for: entry.graph, mode: .data)
            return
        }

        status = .running
        // Fingerprint only the repo-walk case so an unchanged re-generate can be
        // skipped next time; nil for file-scoped generates.
        let fingerprintRepo = selectedFiles == nil ? repo : nil
        runTask = Task.detached(priority: .userInitiated) {
            guard let engine else {
                await MainActor.run { self.status = .error(Self.noEngineMessage) }
                return
            }
            let mem: GeneratedMemory
            do {
                if let files = selectedFiles {
                    mem = try await engine.generateDocMemory(files: files)
                } else if let repo {
                    mem = try await engine.generateDocMemory(roots: [repo])
                } else {
                    await MainActor.run { self.status = .idle }
                    return
                }
            } catch {
                // Never swallow this. `status` is already `.running`, so an
                // ignored failure left the spinner turning forever — and
                // `applyLayout`'s empty-graph guard meant even an empty success
                // did the same.
                await MainActor.run { self.status = .error(error.localizedDescription) }
                return
            }
            guard !mem.graph.nodes.isEmpty else {
                await MainActor.run {
                    self.status = .error("the graph engine produced no nodes")
                }
                return
            }
            if Task.isCancelled { await MainActor.run { self.status = .idle }; return }
            let fp = fingerprintRepo.map { engine.docSetFingerprint(roots: [$0]) }
            if Task.isCancelled { await MainActor.run { self.status = .idle }; return }
            await MainActor.run {
                self.selectedNode = nil
                self.memoryChunks = mem.chunks
                self.memoryDocCount = mem.docCount
                // The doc graph's edge volume (a real repo produced ~700k edges
                // at average degree 124) is handled by weight filtering, not by
                // pruning: `MemoryGenerator`'s title-match fallback emits
                // `relatedTo`/`AMBIGUOUS` edges that weigh 0.11 against a
                // structural edge's 1.0, so they fall below the layout
                // threshold while every authored reference survives.
                self.applyLayout(mem.graph, for: .data,
                                 chunks: mem.chunks, docCount: mem.docCount,
                                 fingerprint: fp)
            }
        }
    }

    /// "All" mode — generate the code graph + the InfiniteBrain doc graph for
    /// the active repo and merge them into one (via the engine's `merge`,
    /// which adds doc→code cross-links), then render the unified graph.
    private func generateAll() {
        guard let repo = activeRepoRoot else { return }
        status = .running
        // Reuse the cached doc index when its fingerprint is unchanged, so "All"
        // combines the already-built code + doc indexes instead of re-scanning
        // the docs. (Code reuse is handled below via the cache fallback.)
        guard let engine else {
            status = .error(Self.noEngineMessage)
            return
        }
        let docFp = engine.docSetFingerprint(roots: [repo])
        let cachedDoc = graphSessionStore.entry(repo: activeRepoRoot, mode: Mode.data.rawValue)
        let reusedDoc: (graph: CGData, chunks: [MemoryChunk], docs: Int)? =
            (cachedDoc?.docFingerprint == docFp && !(cachedDoc?.graph.nodes.isEmpty ?? true))
            ? (cachedDoc!.graph, cachedDoc!.chunks, cachedDoc!.docCount)
            : nil
        runTask = Task {
            // Inspect the result. Discarding it meant a contended or failed
            // scan silently produced a doc-only "All" graph that looked like a
            // legitimate result, then got cached as such for the session.
            switch await codeNoteService.generate(repoRoot: repo) {
            case .success, .failure(.busy):
                break   // `.busy` falls back to the cached code graph below
            case .failure(.cancelled):
                self.status = .idle
                return
            case .failure(let error):
                self.status = .error(error.localizedDescription)
                return
            }
            if Task.isCancelled { await MainActor.run { self.status = .idle }; return }
            // "md is doc": strip code-track markdown so it isn't merged twice.
            var code = FileClassifier.strippingDocNodes(from: codeNoteService.graph)
            var codeFromCache = false
            // The live scan returns an empty graph if it lost the cross-instance
            // scan lock (CodeNoteService.inFlightPaths — e.g. the background
            // GraphAutoUpdater scanning the same repo); fall back to the cached
            // code graph so "All" still shows the code side instead of merging empty.
            if code.nodes.isEmpty, let cachedCode = cachedGraph(.code), !cachedCode.nodes.isEmpty {
                code = cachedCode   // already markdown-free (stripped when cached)
                codeFromCache = true
            }
            let result: (data: CGData, chunks: [MemoryChunk], docs: Int)
            do {
                result = try await Task.detached(priority: .userInitiated) { () -> (data: CGData, chunks: [MemoryChunk], docs: Int) in
                let doc: (graph: CGData, chunks: [MemoryChunk], docs: Int)
                if let reusedDoc {
                    doc = reusedDoc                                   // combine the cached doc index
                } else {
                    // Build it if the cached index is not fresh. A failure is
                    // rethrown rather than turned into an empty graph, so the
                    // caller can report it instead of hanging.
                    let docMem = try await engine.generateDocMemory(roots: [repo])
                    doc = (docMem.graph, docMem.chunks, docMem.docCount)
                }
                // Merge only — no pruning, and no layout here. Layout is a
                // single step applied to the merged graph below, so the code and
                // doc sides are positioned relative to each other by the same
                // clustering rather than being laid out under different rules.
                let merged = try await engine.merge(code: code, doc: doc.graph,
                                                    chunks: doc.chunks)
                return (merged, doc.chunks, doc.docs)
                }.value
            } catch {
                self.status = .error(error.localizedDescription)
                return
            }
            if Task.isCancelled { await MainActor.run { self.status = .idle }; return }
            // Generation telemetry (mirrors KnowledgeGraphService's count log):
            // records the code/doc contributions to the merged "All" graph, which
            // also pinpoints a code-vs-doc shortfall if the graph ever looks short.
            Self.log.info("generateAll[\(repo.lastPathComponent, privacy: .public)]: code=\(code.nodes.count, privacy: .public)\(codeFromCache ? " (cache)" : "", privacy: .public)\(reusedDoc != nil ? " doc(cache)" : "", privacy: .public) docFiles=\(result.docs, privacy: .public) docChunks=\(result.chunks.count, privacy: .public) merged=\(result.data.nodes.count, privacy: .public)")
            self.selectedNode = nil
            self.memoryChunks = result.chunks
            self.memoryDocCount = result.docs
            self.applyLayout(result.data, for: .all,
                             chunks: result.chunks, docCount: result.docs)
        }
    }

    /// Lay out `graph` and publish the finished result — the single layout
    /// entry point for every mode.
    ///
    /// This replaces a two-phase pipeline that was the direct cause of the
    /// reported "sometimes a circle, sometimes a round blob". Phase 1 published
    /// a pie-slice **circle** to the screen immediately and cached it via
    /// `cacheGraph`, whose `laidOut` flag defaults to `true` — so the circle was
    /// recorded as a finished layout. Phase 2's force-directed result was then
    /// dropped whenever the user switched tabs, whenever a concurrent publish
    /// changed the node count, or whenever the background auto-updater
    /// re-stored a raw graph mid-settle. Which of the two the user ended up
    /// looking at came down to timing.
    ///
    /// Now nothing partial is ever published or cached: the canvas shows the
    /// running state until one finished, deterministic layout arrives. The same
    /// graph therefore always produces the same picture, so the user's mental
    /// map survives a reload.
    ///
    /// Runs off the main actor — a 4k-node graph takes ~1.8s and an 8k-node
    /// graph ~2.9s in the release build the app ships (`Scripts/build.sh` uses
    /// `-c release`).
    /// Recover the derived layout signals for an already-positioned graph.
    ///
    /// `layout` is only written by `applyLayout`, so every path that assigned
    /// `fullData` from the cache left the PREVIOUS mode's clusters, radii and
    /// importance in place. Switching Code → Data then coloured any id present
    /// in both graphs (guaranteed in All mode, which merges them) by the wrong
    /// cluster and sized it by the wrong importance. Worse, on a hydrate the
    /// map was empty, so `alwaysLabel` was never true and a fitted graph came
    /// up completely unlabelled — exactly the defect the importance-gated
    /// labelling was added to fix, on the commonest path there is: navigate
    /// away and back.
    ///
    /// The positions are kept as cached; only the signals are recomputed, so
    /// the picture does not move.
    private func adoptLayout(for graph: CGData, mode expectedMode: Mode) {
        // Same monotonic token `applyLayout` uses. Without it a stale recovery
        // could land after a fresh layout and overwrite it whenever the node
        // counts happened to match — a rescan that only added an `import`, or
        // two modes whose cached graphs are the same size. Because
        // `recomputeDisplayData` filters edges by `layout.edgeWeight`, that did
        // not merely mis-colour: the newly added edge stopped being drawn.
        layoutGeneration += 1
        let generation = layoutGeneration
        // Deliberately does NOT clear `layout` first: blanking it triggered a
        // second `recomputeDisplayData` with a different edge count, which
        // changed the canvas fingerprint and re-fitted the viewport, throwing
        // away the user's zoom and popping the labels in a beat later.
        Task.detached(priority: .userInitiated) {
            let recovered = GraphLayoutEngine.signals(of: graph)
            await MainActor.run {
                guard self.mode == expectedMode,
                      self.layoutGeneration == generation else { return }
                self.layout = recovered
                self.recomputeDisplayData()
            }
        }
    }

    /// Shown when no engine is installed. Existing graphs still render — only
    /// generation is unavailable — which is what the split exists to guarantee.
    private static let noEngineMessage =
        "No graph engine installed. Add one from Library → Plugins. "
        + "Graphs already generated still open."

    private func applyLayout(_ graph: CGData, for expectedMode: Mode,
                             chunks: [MemoryChunk]? = nil,
                             docCount: Int? = nil,
                             fingerprint: String? = nil) {
        guard !graph.nodes.isEmpty else {
            // Reaching here with `status == .running` used to leave the spinner
            // turning with no explanation.
            hydrating = false
            status = .error("nothing to lay out — the graph has no nodes")
            return
        }
        layoutGeneration += 1
        let generation = layoutGeneration
        // Held SEPARATELY from `runTask`. Sharing one handle meant whichever
        // ran last won it: a doc scan started by Generate was orphaned the
        // moment a layout replaced the handle, so Cancel stopped the layout
        // while the scan carried on and published its result anyway.
        layoutTask?.cancel()
        layoutTask = Task.detached(priority: .userInitiated) {
            let computed = GraphLayoutEngine.layout(graph)
            if Task.isCancelled {
                await MainActor.run {
                    self.hydrating = false
                    // Only if nothing newer has already finished. A cancelled
                    // 8k-node layout landing 1.5s late used to overwrite the
                    // `.loaded` status of the small graph that replaced it.
                    if case .running = self.status { self.status = .idle }
                }
                return
            }
            let positioned = GraphLayoutEngine.applying(computed, to: graph)
            await MainActor.run {
                self.hydrating = false
                // Drop the result if the user moved to another mode, or if a
                // newer request has since been made. The old code instead
                // required the node count to match what was already on screen,
                // which silently discarded a correct layout whenever anything
                // else had published in the meantime — and left the circle
                // standing.
                guard self.mode == expectedMode,
                      self.layoutGeneration == generation else {
                    // Never return with `status` still `.running`. This exit
                    // was only rescued by the undocumented invariant that
                    // every mode change also runs `resetDerivedState`, which
                    // writes a terminal status; any future early return there
                    // would have reopened the hang.
                    if case .running = self.status { self.status = .idle }
                    return
                }
                self.layout = computed
                self.fullData = positioned
                self.cacheGraph(expectedMode, positioned, chunks: chunks,
                                docCount: docCount, fingerprint: fingerprint)
                self.status = .loaded(nodeCount: positioned.nodes.count,
                                      edgeCount: positioned.edges.count)
                if let quality = computed.quality {
                    Self.log.info("""
                        layout[\(expectedMode.rawValue, privacy: .public)]: \
                        \(positioned.nodes.count, privacy: .public) nodes, \
                        \(computed.communityCount, privacy: .public) clusters — \
                        \(quality.summary, privacy: .public)
                        """)
                }
            }
        }
    }

    /// Compute 3D positions for the current mode's displayData in the
    /// background, once, and cache them. Mirrors settlePhysics's guard so a
    /// stale run can't overwrite a newer mode's cache.
    private func settle3DIfNeeded() {
        let expectedMode = mode
        guard positions3DByMode[expectedMode] == nil else { return }
        let data = displayData
        guard data.nodes.count > 2 else {
            positions3DByMode[expectedMode] = [:]   // trivial graph: nothing to settle
            return
        }
        let iterations: Int
        switch data.nodes.count {
        case ..<300:   iterations = 220
        case ..<700:   iterations = 180
        case ..<1200:  iterations = 150
        default:       iterations = 120
        }
        Task.detached(priority: .userInitiated) {
            let sim = CGSimulation3D(data: data)
            sim.settle(maxIterations: iterations)
            if Task.isCancelled { await MainActor.run { self.status = .idle }; return }
            let pos = sim.positions()
            await MainActor.run {
                guard self.mode == expectedMode,
                      self.displayData.nodes.count == data.nodes.count else { return }
                self.positions3DByMode[expectedMode] = pos
            }
        }
    }

    private func generateCodeNotes(target: URL) {
        status = .running
        // Store the Task so Cancel / onDisappear can actually stop it — the
        // memory path already does this; the code path previously used a bare
        // Task that leaked past view dismissal and ignored Cancel.
        runTask = Task {
            let result = await codeNoteService.generate(repoRoot: target)
            await MainActor.run {
                switch result {
                case .success(let graph) where graph.nodes.isEmpty:
                    // MUST be handled here. Success rendering is driven by the
                    // `codeNoteService.$graph` observer, which returns silently
                    // on an empty graph — so this path span forever. It is not
                    // an edge case: the scanner only handles
                    // ts/tsx/js/jsx/mjs/cjs/swift/kt/py/md, and markdown is
                    // stripped from the code graph, so a docs-only repository
                    // or any Go, Rust, Java, C++ or Ruby repository lands here.
                    self.status = .error(
                        "No code found. The scanner handles TypeScript, JavaScript, "
                        + "Swift, Kotlin and Python; other languages need a graph "
                        + "engine plugin that supports them.")
                case .success:
                    // The observer publishes and lays out; it also carries the
                    // later background-enrichment updates.
                    break
                case .failure(.cancelled):
                    // User-initiated. Every other path lands on `.idle`; this
                    // one used to render a red error for a deliberate action.
                    self.status = .idle
                case .failure(.busy):
                    // Routine contention with the background updater, not a
                    // fault. Keep whatever is on screen rather than shouting.
                    self.status = self.fullData.nodes.isEmpty
                        ? .idle
                        : .loaded(nodeCount: self.fullData.nodes.count,
                                  edgeCount: self.fullData.edges.count)
                case .failure(let error):
                    // `localizedDescription`, not `"\(error)"` — raw enum
                    // interpolation surfaced `busy` and
                    // `engineFailed("exit 1")` to the user.
                    self.status = .error(error.localizedDescription)
                }
            }
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
            Text(msg).font(Typography.caption).foregroundStyle(theme.current.danger)
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

    /// Compact inline legend / colour key — one pill per kind actually present,
    /// click a pill to highlight only those nodes; click again to clear. Resets
    /// automatically via onChange(of: mode).
    ///
    /// Shows EVERY present kind: it used to intersect with a code-only set
    /// (file/module/class/function/…), so the InfiniteBrain / All doc graph —
    /// whose nodes are memoryChunk / memoryDoc / note* — got an empty legend and
    /// no colour key at all. Driving it off the present kinds gives every mode
    /// (incl. 3D, which shares this toolbar) a legend.
    @ViewBuilder
    private func kindFilterBar(t: Theme) -> some View {
        let presentKinds = Array(Set(displayData.nodes.map(\.kind)))
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
