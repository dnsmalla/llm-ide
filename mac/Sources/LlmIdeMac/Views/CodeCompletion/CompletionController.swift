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

    enum Kind { case command, skill, subagent, librarySkill, file }

    struct Item: Identifiable, Equatable {
        let id: String
        let kind: Kind
        let label: String      // "/summary", "search-kb", "Foo.swift"
        let detail: String     // description / repo-relative path
        let insert: String?    // command/skill: text the draft becomes
        let fileURL: URL?      // file: attach this
        let skillId: String?   // librarySkill: "<family>/<dir>" sent to the server

        init(id: String, kind: Kind, label: String, detail: String,
             insert: String?, fileURL: URL?, skillId: String? = nil) {
            self.id = id; self.kind = kind; self.label = label; self.detail = detail
            self.insert = insert; self.fileURL = fileURL; self.skillId = skillId
        }
    }

    /// What the caller should do when the user accepts the selection.
    enum Accept: Equatable {
        case replaceDraft(String)
        case attachFile(url: URL, newDraft: String)
        /// Invoke a central-library skill: send its id to the server (which reads
        /// the SKILL.md and frames it as instructions to FOLLOW). `newDraft`
        /// strips the in-progress "/query".
        case useSkill(id: String, name: String, newDraft: String)
        /// Invoke an in-built skill/subagent the agent runs by name → becomes a
        /// chip whose `directive` ("Use the X skill:") is prepended to the
        /// message on send, so the composer stays clean (same UX as useSkill).
        case useDirective(id: String, name: String, directive: String, newDraft: String)
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
    private var subagentItems: [Item] = []
    private var libraryItems: [Item] = []
    private var fileItems: [Item] = []
    private var metaLoaded = false
    private var loadingMeta = false
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

    /// Load the "/" command + skill catalog. Best-effort, retryable: latches
    /// `metaLoaded` only on a successful fetch, so a fetch that hit the backend
    /// during a restart/cold-start window can be retried (e.g. the next time the
    /// user types "/"). The `loadingMeta` guard prevents overlapping fetches.
    func loadMetaIfNeeded() async {
        guard !metaLoaded, !loadingMeta, let api else { return }
        loadingMeta = true
        defer { loadingMeta = false }
        async let cmds = try? api.listAgentCommands()
        async let cat = try? api.listAgentSkillCatalog()
        async let lib = try? api.skillLibrary()
        let commands = await cmds
        let catalog = await cat
        let library = await lib
        // Only latch as loaded once a fetch actually succeeds — otherwise a
        // cold-start failure (server not up yet) would permanently disable the
        // "/" menu; leaving metaLoaded false lets a later .task retry.
        guard commands != nil || catalog != nil || library != nil else { return }
        metaLoaded = true
        // Central skills-repo catalog (the skills the IDE agent can't itself
        // run): selecting one invokes it via the server's skill channel — we
        // carry the skill id and the server reads its SKILL.md and frames it as
        // instructions to FOLLOW (NOT a file attachment, which the assistant
        // would treat as data to edit).
        libraryItems = (library ?? []).map { s in
            Item(id: "lib:\(s.id)", kind: .librarySkill,
                 label: s.name, detail: "\(s.family) · \(s.description)",
                 insert: nil, fileURL: nil, skillId: s.id)
        }
        commandItems = (commands ?? []).map { c in
            Item(id: "cmd:\(c.trigger)", kind: .command,
                 label: "/\(c.trigger)", detail: c.description,
                 insert: Self.commandInsert(c), fileURL: nil)
        }
        if let catalog {
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
            // Plugin-defined named subagents — the "other" delegates. Discovery
            // only (the agent invokes them via ask-subagent), so accepting
            // inserts a mention like a skill does.
            var subs: [Item] = []
            for g in catalog.subagents.plugins {
                for s in g.subagents {
                    subs.append(Item(id: "sub:\(g.pluginName):\(s.name)", kind: .subagent,
                                     label: s.name, detail: s.description,
                                     insert: "Use the \(s.name) subagent: ", fileURL: nil))
                }
            }
            subagentItems = subs
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
                mode = .command; query = after
                // Retry the catalog fetch on demand: if the initial load (on
                // panel appear) failed — e.g. the backend was mid-restart — this
                // recovers the menu the moment the user reaches for it, instead
                // of leaving "/" permanently empty until the panel reappears.
                if !metaLoaded { Task { await loadMetaIfNeeded() } }
                rebuild(); return
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
        case .command:
            // Slash command: replace the draft so the user can fill in args.
            return .replaceDraft(item.insert ?? item.label)
        case .skill, .subagent:
            // In-built skill/subagent the agent runs by name → a chip whose
            // directive ("Use the X skill:") is prepended to the message on send,
            // keeping the composer clean (consistent with library-skill chips).
            let directive = (item.insert ?? item.label).trimmingCharacters(in: .whitespacesAndNewlines)
            return .useDirective(id: item.id, name: item.label, directive: directive,
                                 newDraft: Self.draftRemovingLastToken(currentDraft))
        case .librarySkill:
            // Invoke the skill via the server channel — do NOT attach its
            // SKILL.md as a file (the assistant would edit it instead of
            // following it). Strip the in-progress "/query" from the draft.
            guard let id = item.skillId else { return nil }
            return .useSkill(id: id, name: item.label,
                             newDraft: Self.draftRemovingLastToken(currentDraft))
        case .file:
            // A file attaches itself; strip the in-progress "@token".
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
            // Everything discoverable from "/": commands, the agent's own
            // skills, plugin subagents, and the full central skills-repo library
            // — comprehensive, nothing filtered out.
            let pool = commandItems + skillItems + subagentItems + libraryItems
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
