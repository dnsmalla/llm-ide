import SwiftUI

/// Project-scoped Settings card surfacing the graph + memory state that the app
/// generates but never showed anywhere: whether a graph exists, its node counts,
/// when it was last generated, and which agent-facing memory files are present.
/// Status of the graph + memory the app generates (whether a graph exists, its
/// node counts, when it was last generated, which agent-facing memory files are
/// present), plus the auto-update cadence control — the interval the background
/// GraphAutoUpdater regenerates on. Generation itself happens in the Code Graph view.
struct GraphMemorySettingsSection: View {
    @EnvironmentObject private var projectStore: ProjectStore
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @EnvironmentObject var graphAutoUpdater: GraphAutoUpdater

    @State private var state: GraphMemoryState = .empty

    var body: some View {
        SettingsSectionCard(icon: "brain", title: "Graph & Memory") {
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
                    Text("Agent memory files (graphify-out/memory)")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                    ForEach(state.memoryFiles) { f in
                        memoryFileRow(f)
                    }
                }
                Divider().padding(.vertical, 2)
                HStack {
                    Text("Auto-update every")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                    Spacer()
                    Stepper(value: Binding(
                        get: { config.graphAutoUpdateMinutes },
                        set: { v in
                            let m = max(5, v)
                            config.graphAutoUpdateMinutes = m
                            graphAutoUpdater.setIntervalMinutes(m)   // live reschedule
                        }
                    ), in: 5...120, step: 5) {
                        Text("\(config.graphAutoUpdateMinutes) min")
                            .font(.system(size: 12, weight: .medium, design: .monospaced))
                            .foregroundStyle(theme.current.text)
                    }
                    .frame(maxWidth: 170)
                }

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

        let graphIndex = repo.appendingPathComponent("system/graph/index.md")
        s.hasGraph = fm.fileExists(atPath: graphIndex.path)

        let memDir = repo.appendingPathComponent("graphify-out/memory")
        let names = ["repo.md", "graph-notes.md", "doc-notes.md", "chat-memory.md"]
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

        // Node counts from repo.md's header line: "N code nodes · M doc nodes · E edges."
        if let repoBody = try? String(contentsOf: memDir.appendingPathComponent("repo.md"), encoding: .utf8) {
            s.counts = parseCounts(repoBody)
        }
        if let mtime = newestMtime { s.lastGenerated = relativeAge(mtime) }
        return s
    }

    private static func parseCounts(_ body: String) -> Counts? {
        // Tolerant scan for "<int> code nodes ... <int> doc nodes ... <int> edges".
        func firstInt(before keyword: String, in text: String) -> Int? {
            guard let r = text.range(of: keyword) else { return nil }
            let prefix = text[text.startIndex..<r.lowerBound]
            let digits = prefix.reversed().prefix { $0 == " " || $0.isNumber }
            let num = String(digits.reversed()).trimmingCharacters(in: .whitespaces)
            return Int(num)
        }
        guard let code = firstInt(before: "code node", in: body),
              let doc = firstInt(before: "doc node", in: body) else { return nil }
        let edges = firstInt(before: "edge", in: body) ?? 0
        return Counts(code: code, doc: doc, edges: edges)
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
