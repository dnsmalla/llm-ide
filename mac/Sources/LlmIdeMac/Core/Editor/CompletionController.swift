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

    enum Kind { case command, skill, subagent, librarySkill, hook, mcpServer, file }

    /// Menu section header for a kind — the "/" menu groups its rows the way
    /// Claude Code's own menu does, instead of one undifferentiated list.
    /// nil (files) means "no header" (the "@" menu is single-purpose).
    static func sectionTitle(_ kind: Kind) -> String? {
        switch kind {
        case .command:      return "Commands"
        case .skill:        return "Skills"
        case .subagent:     return "Subagents"
        case .librarySkill: return "Skill Library"
        case .hook:         return "Hooks"
        case .mcpServer:    return "MCP Servers"
        case .file:         return nil
        }
    }

    struct Item: Identifiable, Equatable {
        let id: String
        let kind: Kind
        let label: String      // "/summary", "search-kb", "Foo.swift"
        let detail: String     // description / repo-relative path
        let insert: String?    // command/skill: text the draft becomes
        let fileURL: URL?      // file: attach this
        let skillId: String?   // librarySkill: "<family>/<dir>" sent to the server
        let target: ShellState.LibrarySelection?  // hook/mcp: row to select in the Library
        // Search keys, precomputed at build time (items are built once per
        // catalog load / file walk) so per-keystroke ranking allocates nothing:
        // lowercased label without its leading "/" (typing "sum" must
        // prefix-match "/summary" — the query never includes the slash), and
        // the lowercased detail.
        let searchLabel: String
        let searchDetail: String

        init(id: String, kind: Kind, label: String, detail: String,
             insert: String?, fileURL: URL?, skillId: String? = nil,
             target: ShellState.LibrarySelection? = nil) {
            self.id = id; self.kind = kind; self.label = label; self.detail = detail
            self.insert = insert; self.fileURL = fileURL; self.skillId = skillId
            self.target = target
            self.searchLabel = (label.hasPrefix("/") ? String(label.dropFirst()) : label).lowercased()
            self.searchDetail = detail.lowercased()
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
        /// Jump to an app section, pre-selecting `target` there — hook/MCP rows
        /// aren't invocable from chat (a hook fires on events; an MCP server is
        /// managed in the Library), so accepting one lands on that exact row's
        /// detail instead of an undifferentiated Library root.
        case navigate(section: ShellState.Section, target: ShellState.LibrarySelection?, newDraft: String)
    }

    private enum Mode { case none, command, file }

    @Published private(set) var isOpen = false
    @Published private(set) var items: [Item] = []
    /// Section title to draw ABOVE the row at each index — computed here, in
    /// the same pass that orders `items`, so the view never re-derives (or
    /// worse, re-indexes live state to derive) the grouping invariant.
    @Published private(set) var headers: [Int: String] = [:]
    @Published var selected = 0

    private var mode: Mode = .none
    private var query = ""
    /// Draft text whose next `update` should NOT re-open the menu: accepting a
    /// no-argument command row rewrites the draft to exactly that command,
    /// which would otherwise re-trigger the "/" menu on the row just accepted
    /// and swallow the next Return.
    private var suppressedDraft: String?

    // Caches, one per source, each overwritten only by ITS OWN successful
    // fetch — a failed fetch keeps the previous candidates instead of wiping
    // them. Files reload when the repo root changes.
    private var commandItems: [Item] = CompletionController.builtinItems
    private var skillItems: [Item] = []
    private var subagentItems: [Item] = []
    private var libraryItems: [Item] = []
    private var hookItems: [Item] = []
    private var mcpItems: [Item] = []
    private var fileItems: [Item] = []
    /// When the catalog last loaded IN FULL. NOT a one-shot latch: plugins can
    /// be installed/enabled/trusted mid-session, so the "/" menu refreshes on
    /// open once the snapshot is older than `metaRefreshInterval`. Only
    /// stamped when every fetch succeeded — a partial success updates the
    /// caches it can but stays "stale" so the failed sources retry soon
    /// (bounded by `lastMetaAttempt`) instead of freezing empty for a minute.
    private var lastMetaLoad: Date?
    /// Failure backoff: without it, a down backend would re-fire all five
    /// fetches on every menu open.
    private var lastMetaAttempt: Date?
    private var loadingMeta = false
    private let metaRefreshInterval: TimeInterval = 60
    private let metaRetryInterval: TimeInterval = 5
    private var filesLoadedFor: URL?
    private var loadingFiles = false

    private weak var api: LlmIdeAPIClient?
    private var repoRoot: URL?

    /// "@" file menu cap — one flat list, 50 is plenty to scan visually. The
    /// "/" menu is deliberately uncapped: its whole point is that EVERYTHING
    /// discoverable (commands, skills, hooks, MCP) is in it, the sections are
    /// ordered, and the menu view renders lazily.
    private let maxFileItems = 50
    private let maxFilesScanned = 4000

    // MARK: Configuration

    func configure(api: LlmIdeAPIClient, repoRoot: URL?) {
        if let old = self.api, old !== api {
            // A different client means a different server/account — the meta
            // caches describe someone else's plugins. Invalidate so the next
            // loadMetaIfNeeded (the panel calls it right after configure)
            // refetches instead of trusting the freshness stamp.
            lastMetaLoad = nil
            lastMetaAttempt = nil
        }
        self.api = api
        if repoRoot?.standardizedFileURL != self.repoRoot?.standardizedFileURL {
            self.repoRoot = repoRoot?.standardizedFileURL
            fileItems = []
            filesLoadedFor = nil
        } else {
            self.repoRoot = repoRoot?.standardizedFileURL
        }
    }

    /// Load (or refresh) the "/" catalog: plugin commands, agent skills,
    /// plugin subagents, the central skill library, plugin hooks, and MCP
    /// servers. Best-effort and retryable: `lastMetaLoad` is only stamped on
    /// a fully successful round, so a fetch that hit the backend during a
    /// restart/cold-start window is retried (after a short backoff) the next
    /// time the menu opens. The `loadingMeta` guard prevents overlapping
    /// fetches.
    func loadMetaIfNeeded() async {
        if let last = lastMetaLoad, Date().timeIntervalSince(last) < metaRefreshInterval { return }
        if let attempt = lastMetaAttempt, Date().timeIntervalSince(attempt) < metaRetryInterval { return }
        guard !loadingMeta, let api else { return }
        loadingMeta = true
        lastMetaAttempt = Date()
        defer { loadingMeta = false }
        async let cmds = try? api.listAgentCommands()
        async let cat = try? api.listAgentSkillCatalog()
        async let lib = try? api.skillLibrary()
        async let plug = try? api.listPlugins()
        async let mcp = try? api.listMcpPlugins()
        let (commands, catalog, library, plugins, mcpPlugins) = await (cmds, cat, lib, plug, mcp)
        if commands != nil, catalog != nil, library != nil, plugins != nil, mcpPlugins != nil {
            lastMetaLoad = Date()
        }
        // Plugin slash-commands (server-side prompt expansion) — annotated
        // with the owning plugin. Triggers that collide with a built-in are
        // dropped: submit() dispatches built-ins BEFORE the server sees the
        // text, so a shadowed plugin command could never run, and listing a
        // second identical "/name" row would be a lie.
        if let commands {
            let pluginCommands: [Item] = commands.compactMap { c in
                guard !ChatSlashCommands.reservedNames.contains("/\(c.trigger.lowercased())") else { return nil }
                return Item(id: "cmd:\(c.trigger)", kind: .command,
                            label: "/\(c.trigger)",
                            detail: Self.ownedDetail(c.pluginName, c.description),
                            insert: Self.commandInsert(c), fileURL: nil)
            }
            commandItems = Self.builtinItems + pluginCommands
        }
        // Central skills-repo catalog (the skills the IDE agent can't itself
        // run): selecting one invokes it via the server's skill channel — we
        // carry the skill id and the server reads its SKILL.md and frames it as
        // instructions to FOLLOW (NOT a file attachment, which the assistant
        // would treat as data to edit). sourceName tells which registered
        // skills repo it came from.
        if let library {
            libraryItems = library.map { s in
                Item(id: "lib:\(s.id)", kind: .librarySkill,
                     label: s.name, detail: Self.ownedDetail(s.sourceName, s.description),
                     insert: nil, fileURL: nil, skillId: s.id)
            }
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
                                       label: s.name, detail: Self.ownedDetail(g.pluginName, s.description),
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
                                     label: s.name, detail: Self.ownedDetail(g.pluginName, s.description),
                                     insert: "Use the \(s.name) subagent: ", fileURL: nil))
                }
            }
            subagentItems = subs
        }
        // Hooks — one row per hook-bearing plugin (llm-ide has no free-floating
        // hooks; every hook belongs to a plugin, and its handlers + trust
        // toggle live in the Library's plugin detail). Discovery rows, not
        // invocations: accepting navigates to that plugin's detail.
        if let plugins {
            hookItems = plugins.plugins.filter { $0.hookCount > 0 }.map { p in
                Item(id: "hook:\(p.name)", kind: .hook,
                     label: p.title, detail: p.hookSummary,
                     insert: nil, fileURL: nil, target: .plugin(p.name))
            }
        }
        // MCP servers — same idea: discovery rows that land on that server's
        // detail in Library → MCP Plugins, where consent/enable/credentials
        // are managed.
        if let mcpPlugins {
            mcpItems = mcpPlugins.map { m in
                Item(id: "mcp:\(m.id)", kind: .mcpServer,
                     label: m.name, detail: "\(m.statusSummary) · \(m.endpointSummary)",
                     insert: nil, fileURL: nil, target: .mcpPlugin(m.id))
            }
        }
        // Re-rank with the fresh caches. If the menu is open under the user's
        // arrow keys, re-anchor the selection to the same ROW (by id), not the
        // same index — fresh data may have shifted everything.
        let selectedId = (isOpen && items.indices.contains(selected)) ? items[selected].id : nil
        rebuild()
        if let selectedId, let idx = items.firstIndex(where: { $0.id == selectedId }) {
            selected = idx
        }
    }

    /// Built-in commands are a real client-side UI action (ChatSlashCommands
    /// in ChatComposer.submit()), not server-side prompt expansion like
    /// plugin commands. The catalog lives in ChatSlashCommands next to the
    /// recognizers so the menu can't drift from the behavior.
    private static let builtinItems: [Item] = ChatSlashCommands.builtins.map { b in
        Item(id: "cmd:\(b.label)", kind: .command, label: b.label,
             detail: b.detail, insert: b.insert, fileURL: nil)
    }

    /// "<owner> · <description>", dropping a nil/empty owner — the one
    /// spelling of the annotation every plugin-/source-owned row uses.
    private static func ownedDetail(_ owner: String?, _ description: String) -> String {
        guard let owner, !owner.isEmpty else { return description }
        return "\(owner) · \(description)"
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
        // A draft we just wrote ourselves by accepting a command row — don't
        // re-open the menu on it (one-shot; the user's next edit re-triggers
        // normally).
        if let suppressed = suppressedDraft {
            suppressedDraft = nil
            if draft == suppressed { closeInternal(); return }
        }
        // Command/skill: a leading "/" still being typed (no whitespace yet).
        if draft.hasPrefix("/") {
            let after = String(draft.dropFirst())
            if !after.contains(where: \.isWhitespace) {
                let entering = mode != .command
                mode = .command; query = after
                // Fetch/refresh the catalog when the menu OPENS (not on every
                // keystroke — a landed refresh re-ranks the open menu, so keep
                // that window to the moment of opening): recovers from a
                // cold-start failure the moment the user reaches for "/", and
                // picks up plugins installed/enabled since the last load.
                // loadMetaIfNeeded itself no-ops while the snapshot is fresh.
                if entering { Task { await loadMetaIfNeeded() } }
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
            let insert = item.insert ?? item.label
            // A no-argument command (no trailing space) would immediately
            // re-trigger the "/" menu via the caller's draft onChange —
            // suppress that one echo so Return-to-accept → Return-to-act works.
            if !insert.hasSuffix(" ") { suppressedDraft = insert }
            return .replaceDraft(insert)
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
        case .hook, .mcpServer:
            // Not invocable from chat — jump to the exact row in the Library.
            return .navigate(section: .library, target: item.target,
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
            // Everything discoverable from "/": built-in + plugin commands, the
            // agent's own skills, plugin subagents, the central skills-repo
            // library, plugin hooks, and MCP servers — comprehensive, nothing
            // capped away. Ranked WITHIN each group (label-prefix, then
            // label-contains, then detail-contains), with group order fixed so
            // the menu renders stable Claude-style sections instead of
            // interleaving kinds.
            let groups: [[Item]] = [commandItems, skillItems, subagentItems,
                                    libraryItems, hookItems, mcpItems]
            items = groups.flatMap { Self.rank($0, query: q) }
        case .file:
            items = Array(Self.rank(fileItems, query: q).prefix(maxFileItems))
        }
        if items.isEmpty { closeInternal(); return }
        // Anchor the selection to the best GLOBAL match: a label-prefix hit in
        // a later group (e.g. the `design` skill) must win over an earlier
        // group's weaker detail-substring hit, or Return would accept the
        // wrong row. Empty query → first row ("".hasPrefix everywhere).
        selected = items.firstIndex { $0.searchLabel.hasPrefix(q) } ?? 0
        headers = Self.headerIndex(for: items)
        isOpen = true
    }

    private func closeInternal() {
        mode = .none; query = ""; items = []; headers = [:]; selected = 0; isOpen = false
    }

    /// Tiered match against the precomputed search keys: label-prefix hits
    /// first, then label-contains, then detail-contains. Pure comparisons —
    /// no per-keystroke string allocation.
    private static func rank(_ pool: [Item], query q: String) -> [Item] {
        if q.isEmpty { return pool }
        var labelPrefix: [Item] = []
        var labelContains: [Item] = []
        var detailContains: [Item] = []
        for item in pool {
            if item.searchLabel.hasPrefix(q) { labelPrefix.append(item) }
            else if item.searchLabel.contains(q) { labelContains.append(item) }
            else if item.searchDetail.contains(q) { detailContains.append(item) }
        }
        return labelPrefix + labelContains + detailContains
    }

    /// Section header positions for an ordered item list: an entry at each
    /// index where the section title changes. Exposed for the menu view.
    private static func headerIndex(for items: [Item]) -> [Int: String] {
        var out: [Int: String] = [:]
        var previous: String?
        for (i, item) in items.enumerated() {
            let title = sectionTitle(item.kind)
            if let title, title != previous { out[i] = title }
            previous = title
        }
        return out
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
