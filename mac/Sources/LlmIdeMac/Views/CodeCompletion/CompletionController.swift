import Foundation

/// Drives the Code Assistant's "/" and "@" autocomplete: trigger detection,
/// candidate loading/caching, filtering, and selection. UI-free so it can be
/// reasoned about (and unit-tested) without a view; the menu view observes it.
///
/// Triggers (end-of-draft heuristic — the common "typing at the caret" case):
///   - "/"  at the START of the draft, with no space yet → command + skill menu
///     (matches the backend's expandSlashCommand, which requires a leading "/").
///   - "@token" as the last whitespace-delimited token → file menu.
@MainActor
final class CompletionController: ObservableObject {

    enum Kind { case command, skill, file }

    struct Item: Identifiable, Equatable {
        let id: String
        let kind: Kind
        let label: String      // "/summary", "search-kb", "Foo.swift"
        let detail: String     // description / repo-relative path
        let insert: String?    // command/skill: text the draft becomes
        let fileURL: URL?      // file: attach this
    }

    /// What the caller should do when the user accepts the selection.
    enum Accept: Equatable {
        case replaceDraft(String)
        case attachFile(url: URL, newDraft: String)
    }

    private enum Mode { case none, command, file }

    @Published private(set) var isOpen = false
    @Published private(set) var items: [Item] = []
    @Published var selected = 0

    private var mode: Mode = .none
    private var query = ""

    // Caches. Commands+skills load once; files reload when the repo root changes.
    private var commandItems: [Item] = []
    private var skillItems: [Item] = []
    private var fileItems: [Item] = []
    private var metaLoaded = false
    private var filesLoadedFor: URL?
    private var loadingFiles = false

    private weak var api: LlmIdeAPIClient?
    private var repoRoot: URL?

    private let maxItems = 50
    private let maxFilesScanned = 4000

    // MARK: Configuration

    func configure(api: LlmIdeAPIClient, repoRoot: URL?) {
        self.api = api
        if repoRoot?.standardizedFileURL != self.repoRoot?.standardizedFileURL {
            self.repoRoot = repoRoot?.standardizedFileURL
            fileItems = []
            filesLoadedFor = nil
        } else {
            self.repoRoot = repoRoot?.standardizedFileURL
        }
    }

    /// Load the "/" command + skill catalog once. Best-effort.
    func loadMetaIfNeeded() async {
        guard !metaLoaded, let api else { return }
        metaLoaded = true   // set first so a failure doesn't hammer the endpoint
        async let cmds = try? api.listAgentCommands()
        async let cat = try? api.listAgentSkillCatalog()
        let commands = await cmds ?? []
        commandItems = commands.map { c in
            Item(id: "cmd:\(c.trigger)", kind: .command,
                 label: "/\(c.trigger)", detail: c.description,
                 insert: Self.commandInsert(c), fileURL: nil)
        }
        if let catalog = await cat {
            var skills: [Item] = []
            let groups = catalog.skills.global + catalog.skills.internal
            for s in groups {
                skills.append(Item(id: "skill:\(s.name)", kind: .skill,
                                   label: s.name, detail: s.description,
                                   insert: "Use the \(s.name) skill: ", fileURL: nil))
            }
            for g in catalog.skills.plugins {
                for s in g.skills {
                    skills.append(Item(id: "skill:\(g.pluginName):\(s.name)", kind: .skill,
                                       label: s.name, detail: s.description,
                                       insert: "Use the \(s.name) skill: ", fileURL: nil))
                }
            }
            skillItems = skills
        }
        rebuild()
    }

    private static func commandInsert(_ c: LlmIdeAPIClient.AgentCommand) -> String {
        var s = "/\(c.trigger) "
        let required = c.args.filter { $0.required }
        if !required.isEmpty {
            s += required.map { "\($0.name)=" }.joined(separator: " ") + " "
        }
        return s
    }

    // MARK: Trigger detection (called on every draft change)

    func update(draft: String) {
        // Command/skill: a leading "/" still being typed (no whitespace yet).
        if draft.hasPrefix("/") {
            let after = String(draft.dropFirst())
            if !after.contains(where: \.isWhitespace) {
                mode = .command; query = after; rebuild(); return
            }
        }
        // File: the last token starts with "@".
        if let start = Self.lastTokenStart(draft) {
            let token = String(draft[start...])
            if token.hasPrefix("@") {
                mode = .file
                query = String(token.dropFirst())
                ensureFilesLoaded()
                rebuild(); return
            }
        }
        closeInternal()
    }

    // MARK: Navigation + accept

    func moveUp()   { guard isOpen, !items.isEmpty else { return }; selected = (selected - 1 + items.count) % items.count }
    func moveDown() { guard isOpen, !items.isEmpty else { return }; selected = (selected + 1) % items.count }
    func close()    { closeInternal() }

    func acceptSelected(currentDraft: String) -> Accept? {
        guard isOpen, items.indices.contains(selected) else { return nil }
        let item = items[selected]
        switch item.kind {
        case .command, .skill:
            return .replaceDraft(item.insert ?? item.label)
        case .file:
            guard let url = item.fileURL else { return nil }
            let newDraft = Self.draftRemovingLastToken(currentDraft)
            return .attachFile(url: url, newDraft: newDraft)
        }
    }

    // MARK: Filtering

    private func rebuild() {
        let q = query.lowercased()
        switch mode {
        case .none:
            closeInternal(); return
        case .command:
            let pool = commandItems + skillItems
            // Match against the label without its leading "/" so typing "sum"
            // prefix-matches "/summary" (the query never includes the slash).
            items = Self.rank(pool, query: q, keys: {
                [$0.label.hasPrefix("/") ? String($0.label.dropFirst()) : $0.label, $0.detail]
            }, limit: maxItems)
        case .file:
            items = Self.rank(fileItems, query: q, keys: { [$0.label, $0.detail] }, limit: maxItems)
        }
        if items.isEmpty { closeInternal(); return }
        selected = min(selected, items.count - 1)
        isOpen = true
    }

    private func closeInternal() {
        mode = .none; query = ""; items = []; selected = 0; isOpen = false
    }

    /// Substring match across `keys`, ranking prefix hits first, then by label.
    private static func rank(_ pool: [Item], query q: String,
                             keys: (Item) -> [String], limit: Int) -> [Item] {
        if q.isEmpty { return Array(pool.prefix(limit)) }
        var prefix: [Item] = []
        var contains: [Item] = []
        for item in pool {
            let fields = keys(item).map { $0.lowercased() }
            if fields.contains(where: { $0.hasPrefix(q) }) { prefix.append(item) }
            else if fields.contains(where: { $0.contains(q) }) { contains.append(item) }
        }
        return Array((prefix + contains).prefix(limit))
    }

    // MARK: File walk

    private func ensureFilesLoaded() {
        guard let root = repoRoot, filesLoadedFor != root, !loadingFiles else { return }
        loadingFiles = true
        let cap = maxFilesScanned
        Task.detached(priority: .userInitiated) {
            let scanned = Self.walk(root: root, cap: cap)
            await MainActor.run {
                self.fileItems = scanned
                self.filesLoadedFor = root
                self.loadingFiles = false
                if self.mode == .file { self.rebuild() }
            }
        }
    }

    /// Bounded recursive file enumeration, skipping hidden + heavy build dirs.
    nonisolated private static func walk(root: URL, cap: Int) -> [Item] {
        let fm = FileManager.default
        let skipDirs: Set<String> = [".git", "node_modules", ".build", "DerivedData",
                                     "dist", "build", ".next", "Pods", "vendor", ".venv"]
        guard let en = fm.enumerator(
            at: root,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else { return [] }
        var out: [Item] = []
        let rootPath = root.standardizedFileURL.path
        for case let url as URL in en {
            if out.count >= cap { break }
            let isDir = (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
            if isDir {
                if skipDirs.contains(url.lastPathComponent) { en.skipDescendants() }
                continue
            }
            let full = url.standardizedFileURL.path
            let rel = full.hasPrefix(rootPath + "/") ? String(full.dropFirst(rootPath.count + 1)) : full
            out.append(Item(id: "file:\(full)", kind: .file,
                            label: url.lastPathComponent, detail: rel,
                            insert: nil, fileURL: url))
        }
        return out
    }

    // MARK: Token helpers (exposed for tests)

    /// Start index of the last whitespace-delimited token, or nil if the draft
    /// is empty or ends in whitespace (i.e. no token is being typed).
    static func lastTokenStart(_ s: String) -> String.Index? {
        guard let last = s.last, !last.isWhitespace else { return nil }
        if let wsIdx = s.lastIndex(where: { $0.isWhitespace }) {
            return s.index(after: wsIdx)
        }
        return s.startIndex
    }

    /// The draft with its last (in-progress) token removed — used to strip the
    /// "@query" once a file is chosen and becomes an attachment chip.
    static func draftRemovingLastToken(_ s: String) -> String {
        guard let start = lastTokenStart(s) else { return s }
        return String(s[s.startIndex..<start])
    }
}
