import SwiftUI

/// Project-scoped Settings card surfacing the graph + memory state that the app
/// generates but never showed anywhere: whether a graph exists, its node counts,
/// when it was last generated, and which agent-facing memory files are present.
/// Graph-specific controls (auto-update cadence, upload-truncation banner) live
/// in `Graph/Views/GraphSettingsSection.swift` instead — this file stays free of
/// any graph type so it (and `GraphMemoryState`) keep working when the Code
/// Graph feature is compiled out.
struct MemorySettingsSection: View {
    @EnvironmentObject private var projectStore: ProjectStore
    @EnvironmentObject var theme: ThemeStore

    @State private var state: GraphMemoryState = .empty

    var body: some View {
        SettingsSectionCard(icon: "brain", title: "Memory") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                if !state.hasGraph && !state.anyMemoryFile {
                    Text("No graph or memory generated for this project yet. Open the Code Graph view and generate a Code Graph / InfiniteBrain to populate it.")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    statusRow("Knowledge graph", state.hasGraph ? "generated" : "not generated", ok: state.hasGraph)
                    if let counts = state.counts {
                        statusRow("Nodes", "\(counts.code) code · \(counts.doc) doc · \(counts.edges) edges", ok: true)
                    }
                    if let when = state.lastGenerated {
                        statusRow("Last generated", when, ok: true)
                    }
                    Divider().padding(.vertical, 2)
                    Text("Agent memory files (system/memory)")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                    ForEach(state.memoryFiles) { f in
                        memoryFileRow(f)
                    }
                }
                Divider().padding(.vertical, 2)
                HStack {
                    Text(state.repoLabel)
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer()
                    Button("Refresh") { refresh() }
                        .controlSize(.small)
                }
                .padding(.top, 2)
            }
        }
        .task(id: projectStore.activeProject?.bundle.id) { refresh() }
    }

    private func statusRow(_ label: String, _ value: String, ok: Bool) -> some View {
        HStack(spacing: Spacing.sm) {
            Image(systemName: ok ? "checkmark.circle.fill" : "xmark.circle")
                .font(.system(size: 11))
                .foregroundStyle(ok ? theme.current.accent : theme.current.textMuted)
            Text(label).font(Typography.body).foregroundStyle(theme.current.textMuted)
            Spacer()
            Text(value).font(Typography.body).foregroundStyle(theme.current.text)
        }
    }

    private func memoryFileRow(_ f: GraphMemoryState.MemFile) -> some View {
        HStack(spacing: Spacing.sm) {
            Image(systemName: f.present ? "doc.text.fill" : "doc")
                .font(.system(size: 10))
                .foregroundStyle(f.present ? theme.current.accent : theme.current.textMuted)
            Text(f.name).font(.system(size: 11, design: .monospaced)).foregroundStyle(theme.current.text)
            Spacer()
            Text(f.detail).font(Typography.caption).foregroundStyle(theme.current.textMuted)
        }
    }

    private func refresh() {
        let root = projectStore.activeProject.map { URL(fileURLWithPath: $0.localPath) }
        state = GraphMemoryState.read(projectRoot: root)
    }
}

/// On-disk snapshot of a project's graph + memory artifacts. Pure read; cheap
/// (a few stat calls + small file reads), recomputed on appear / Refresh.
struct GraphMemoryState {
    struct Counts { let code: Int; let doc: Int; let edges: Int }
    struct MemFile: Identifiable { let id = UUID(); let name: String; let present: Bool; let detail: String }

    var hasGraph = false
    var counts: Counts?
    var lastGenerated: String?
    var memoryFiles: [MemFile] = []
    var repoLabel = "No project open"
    /// Standardized path of the graphed repo — matches `CodeGraphUploadTruncation.repoPath`.
    var repoPath = ""
    var anyMemoryFile: Bool { memoryFiles.contains { $0.present } }

    static let empty = GraphMemoryState()

    static func read(projectRoot: URL?) -> GraphMemoryState {
        guard let projectRoot else { return GraphMemoryState() }
        let fm = FileManager.default
        // Resolve the repo that actually holds the graph, code/<child>-first to
        // match GraphAutoUpdater.repoToGraph (the auto-updater graphs the child
        // git repo, not the workspace root). A stale root-level graph can still
        // sit on disk from before that change, so only fall back to the project
        // root when no code/<child> has a graph. Inlined via ProjectLayout (a
        // plain struct) to stay nonisolated.
        func graphed(_ root: URL) -> Bool {
            fm.fileExists(atPath: ProjectLayout(root: root).graphDir.appendingPathComponent("index.md").path)
        }
        let repo: URL = {
            let codeDir = ProjectLayout(root: projectRoot).codeDir
            let children = (try? fm.contentsOfDirectory(at: codeDir,
                includingPropertiesForKeys: [.isDirectoryKey])) ?? []
            if let child = children.first(where: graphed) { return child }
            return projectRoot   // a root-level graph, or nothing graphed yet
        }()
        var s = GraphMemoryState()
        s.repoLabel = repo.path.replacingOccurrences(of: NSHomeDirectory(), with: "~")
        s.repoPath = repo.standardizedFileURL.path

        let layout = ProjectLayout(root: repo)
        let graphIndex = layout.graphDir.appendingPathComponent("index.md")
        s.hasGraph = fm.fileExists(atPath: graphIndex.path)

        // One directory, one file per artifact — see graphkit/paths.mjs. The
        // repo overview is NOT listed here: it is `system/graph/index.md`
        // (covered by `hasGraph` above), not a second copy in the memory dir.
        let memDir = layout.memoryDir
        let names = ["graph-notes.md", "doc-notes.md", "chat-memory.md"]
        var newestMtime: Date?
        for name in names {
            let url = memDir.appendingPathComponent(name)
            let attrs = try? fm.attributesOfItem(atPath: url.path)
            if let attrs, let size = attrs[.size] as? Int {
                let mtime = attrs[.modificationDate] as? Date
                if let mtime, name != "chat-memory.md" { // graph artifacts drive "last generated"
                    if newestMtime == nil || mtime > newestMtime! { newestMtime = mtime }
                }
                var detail = byteLabel(size)
                if name == "chat-memory.md", let body = try? String(contentsOf: url, encoding: .utf8) {
                    let facts = body.split(separator: "\n").filter { $0.trimmingCharacters(in: .whitespaces).hasPrefix("- ") }.count
                    detail = "\(facts) fact\(facts == 1 ? "" : "s")"
                }
                s.memoryFiles.append(.init(name: name, present: true, detail: detail))
            } else {
                s.memoryFiles.append(.init(name: name, present: false, detail: "—"))
            }
        }

        // Node counts come from graph-notes.md, which always carries
        // "- Code nodes: N / - Doc nodes: M / - Edges: E". (This used to parse
        // repo.md, which in the normal case was a copy of index.md — "# Codebase
        // Index", no node counts — so the card read blank on exactly the repos
        // that DID have a graph.)
        if let body = try? String(contentsOf: memDir.appendingPathComponent("graph-notes.md"),
                                  encoding: .utf8) {
            s.counts = parseCounts(body)
        }
        if let mtime = newestMtime { s.lastGenerated = relativeAge(mtime) }
        return s
    }

    /// Reads counts written in either of the two shapes the memory artifact
    /// produces, case-insensitively:
    ///   • graph-notes.md — "- Code nodes: 12"  (number AFTER the label)
    ///   • repo.md fallback — "12 code nodes · 3 doc nodes · 45 edges."
    ///     (number BEFORE the label)
    static func parseCounts(_ body: String) -> Counts? {
        func intAfter(_ keyword: String) -> Int? {
            guard let r = body.range(of: keyword, options: .caseInsensitive) else { return nil }
            let rest = body[r.upperBound...].drop { $0 == "s" || $0 == ":" || $0 == " " }
            let digits = rest.prefix { $0.isNumber }
            return digits.isEmpty ? nil : Int(digits)
        }
        func intBefore(_ keyword: String) -> Int? {
            guard let r = body.range(of: keyword, options: .caseInsensitive) else { return nil }
            let digits = body[body.startIndex..<r.lowerBound].reversed().prefix { $0 == " " || $0.isNumber }
            return Int(String(digits.reversed()).trimmingCharacters(in: .whitespaces))
        }
        func count(_ keyword: String) -> Int? { intAfter(keyword) ?? intBefore(keyword) }

        guard let code = count("code node"), let doc = count("doc node") else { return nil }
        // Plural deliberately: the fallback body opens with "# Repository
        // knowledge graph", and the singular "edge" matches inside "knowledge"
        // — which is why the edge count always read 0 there. "edges" doesn't.
        return Counts(code: code, doc: doc, edges: count("edges") ?? 0)
    }

    private static func byteLabel(_ bytes: Int) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        if bytes < 1024 * 1024 { return String(format: "%.1f KB", Double(bytes) / 1024) }
        return String(format: "%.1f MB", Double(bytes) / (1024 * 1024))
    }

    private static func relativeAge(_ date: Date) -> String {
        let secs = Date().timeIntervalSince(date)
        if secs < 60 { return "just now" }
        if secs < 3600 { return "\(Int(secs / 60)) min ago" }
        if secs < 86400 { return "\(Int(secs / 3600)) h ago" }
        return "\(Int(secs / 86400)) d ago"
    }
}
