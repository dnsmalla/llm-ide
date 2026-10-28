import Foundation

/// On-disk snapshot of a project's graph + memory artifacts. Pure read; cheap
/// (a few stat calls + small file reads), recomputed on appear / Refresh.
///
/// Lives in Core (not in Settings' MemorySettingsSection) because two peers
/// read it — Settings' Memory card and Code Graph's GraphSettingsSection —
/// and a feature may not name another feature's type. It only touches
/// FileManager + `ProjectLayout`, so it also keeps working when Code Graph
/// is compiled out.
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
            fm.fileExists(atPath: GeneratedDataLocator.readableGraphDir(forRepo: root).appendingPathComponent("index.md").path)
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

        let graphIndex = GeneratedDataLocator.readableGraphDir(forRepo: repo).appendingPathComponent("index.md")
        s.hasGraph = fm.fileExists(atPath: graphIndex.path)

        // One directory, one file per artifact — see graphkit/paths.mjs. The
        // repo overview is NOT listed here: it is `system/graph/index.md`
        // (covered by `hasGraph` above), not a second copy in the memory dir.
        let memDir = GeneratedDataLocator.readableMemoryDir(forRepo: repo)
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
