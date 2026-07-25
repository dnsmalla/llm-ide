import Foundation
import Observation
import SharedProtocol

// MARK: - On-disk index schemas (Application Support/llm-ide/settings/)

struct MobileWorkspaceIndexFile: Codable, Equatable {
    static let currentVersion = 1
    let version: Int
    let updatedAt: Date
    /// Absolute path to the indexed workspace root.
    let workspaceRoot: String
    let entries: [MobileWorkspaceIndexEntry]
    /// True when the walk hit `maxWorkspaceEntries` before finishing the tree.
    let truncated: Bool

    init(workspaceRoot: String, entries: [MobileWorkspaceIndexEntry],
         truncated: Bool = false, updatedAt: Date = Date()) {
        version = Self.currentVersion
        self.updatedAt = updatedAt
        self.workspaceRoot = workspaceRoot
        self.entries = entries
        self.truncated = truncated
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decode(Int.self, forKey: .version)
        updatedAt = try c.decode(Date.self, forKey: .updatedAt)
        workspaceRoot = try c.decode(String.self, forKey: .workspaceRoot)
        entries = try c.decode([MobileWorkspaceIndexEntry].self, forKey: .entries)
        truncated = try c.decodeIfPresent(Bool.self, forKey: .truncated) ?? false
    }
}

struct MobileWorkspaceIndexEntry: Codable, Equatable {
    let path: String
    let name: String
    let isDirectory: Bool

    init(path: String, name: String, isDirectory: Bool) {
        self.path = path
        self.name = name
        self.isDirectory = isDirectory
    }

    init(from entry: ExploreWorkspaceEntry) {
        path = entry.path
        name = entry.name
        isDirectory = entry.isDirectory
    }

    var exploreEntry: ExploreWorkspaceEntry {
        ExploreWorkspaceEntry(path: path, name: name, isDirectory: isDirectory)
    }
}

struct MobileSkillsIndexFile: Codable, Equatable {
    static let currentVersion = 1
    let version: Int
    let updatedAt: Date
    let entries: [MobileSkillIndexEntry]

    init(entries: [MobileSkillIndexEntry], updatedAt: Date = Date()) {
        version = Self.currentVersion
        self.updatedAt = updatedAt
        self.entries = entries
    }
}

struct MobileSkillIndexEntry: Codable, Equatable {
    let id: String
    let name: String
    let description: String
    let kind: String
    let directive: String?

    init(id: String, name: String, description: String, kind: String, directive: String?) {
        self.id = id
        self.name = name
        self.description = description
        self.kind = kind
        self.directive = directive
    }

    init(from entry: ExploreSkillEntry) {
        id = entry.id
        name = entry.name
        description = entry.description
        kind = entry.kind
        directive = entry.directive
    }

    var exploreEntry: ExploreSkillEntry {
        ExploreSkillEntry(id: id, name: name, description: description, kind: kind, directive: directive)
    }
}

/// Persists iPhone Explore browse indexes under `settings/` and always serves
/// mobile `@file` / `/skill` search from those JSON files (refreshed when stale).
@MainActor
@Observable
final class MobileExploreIndexStore {

    nonisolated static let workspaceStaleInterval: TimeInterval = 300
    nonisolated static let skillsStaleInterval: TimeInterval = 300
    nonisolated static let maxWorkspaceEntries = 25_000

    private(set) var workspaceUpdatedAt: Date?
    private(set) var skillsUpdatedAt: Date?
    private(set) var workspaceEntryCount: Int = 0
    private(set) var skillsEntryCount: Int = 0
    private(set) var workspaceTruncated: Bool = false
    private(set) var lastWorkspaceRoot: String?
    private(set) var lastError: String?
    private(set) var isRefreshing: Bool = false

    private let fm = FileManager.default

    init() {
        bootstrapFromDisk()
    }

    var settingsDirectory: URL {
        AppIdentity.applicationSupportRoot(fileManager: fm)
            .appendingPathComponent("settings", isDirectory: true)
    }

    var workspaceIndexURL: URL {
        settingsDirectory.appendingPathComponent("mobile-explore-workspace.json")
    }

    var skillsIndexURL: URL {
        settingsDirectory.appendingPathComponent("mobile-explore-skills.json")
    }

    /// Load counts/timestamps from disk without rebuilding (Settings panel).
    func bootstrapFromDisk() {
        if let loaded = loadWorkspaceIndex() {
            applyWorkspaceMeta(loaded)
        }
        if let loaded = loadSkillsIndex() {
            applySkillsMeta(loaded)
        }
    }

    // MARK: - Refresh

    func refreshAll(workspaceRoot: URL?, api: LlmIdeAPIClient?, force: Bool = false) async {
        if isRefreshing, !force { return }
        isRefreshing = true
        defer { isRefreshing = false }
        if let root = workspaceRoot {
            await refreshWorkspaceIndex(root: root, force: force)
        }
        if let api {
            await refreshSkillsIndex(api: api, force: force)
        }
    }

    @discardableResult
    func refreshWorkspaceIndex(root: URL, force: Bool = false) async -> MobileWorkspaceIndexFile? {
        if !force, let loaded = loadWorkspaceIndex(), !workspaceIndexIsStale(loaded, root: root) {
            applyWorkspaceMeta(loaded)
            return loaded
        }
        let resolved = root.resolvingSymlinksInPath()
        let built = MobileWorkspaceSearch.buildIndex(in: resolved, limit: Self.maxWorkspaceEntries)
        let truncated = built.count >= Self.maxWorkspaceEntries
        let entries = built.map { MobileWorkspaceIndexEntry(from: $0) }
        let file = MobileWorkspaceIndexFile(
            workspaceRoot: resolved.path, entries: entries, truncated: truncated)
        do {
            try saveWorkspaceIndex(file)
            applyWorkspaceMeta(file)
            lastError = truncated
                ? "Workspace index truncated at \(Self.maxWorkspaceEntries) entries — narrow your project or refresh after cleanup."
                : nil
            return file
        } catch {
            lastError = "Workspace index save failed: \(error.localizedDescription)"
            return nil
        }
    }

    @discardableResult
    func refreshSkillsIndex(api: LlmIdeAPIClient, force: Bool = false) async -> MobileSkillsIndexFile? {
        if !force, let loaded = loadSkillsIndex(), !skillsIndexIsStale(loaded) {
            applySkillsMeta(loaded)
            return loaded
        }
        let built = await MobileSkillCatalog.buildEntries(api: api)
        if built.isEmpty, let cached = loadSkillsIndex(), !force {
            applySkillsMeta(cached)
            lastError = "Skills catalog unavailable — using cached index (\(cached.entries.count) entries)."
            return cached
        }
        let file = MobileSkillsIndexFile(entries: built.map { MobileSkillIndexEntry(from: $0) })
        do {
            try saveSkillsIndex(file)
            applySkillsMeta(file)
            if built.isEmpty {
                if !workspaceTruncated {
                    lastError = "Skills index is empty — ensure the LLM-IDE backend is running."
                }
            } else if !workspaceTruncated {
                lastError = nil
            }
            return file
        } catch {
            lastError = "Skills index save failed: \(error.localizedDescription)"
            return nil
        }
    }

    // MARK: - Search (always from settings JSON)

    func searchWorkspace(query: String, workspaceRoot: URL, limit: Int) async -> [ExploreWorkspaceEntry] {
        guard let index = await refreshWorkspaceIndex(root: workspaceRoot, force: false)
            ?? loadWorkspaceIndex() else { return [] }
        return Self.filterWorkspace(index.entries, query: query, limit: limit)
    }

    func searchSkills(query: String, api: LlmIdeAPIClient, limit: Int) async -> [ExploreSkillEntry] {
        guard let index = await refreshSkillsIndex(api: api, force: false)
            ?? loadSkillsIndex() else { return [] }
        return Self.filterSkills(index.entries, query: query, limit: limit)
    }

    // MARK: - Load / save

    func loadWorkspaceIndex() -> MobileWorkspaceIndexFile? {
        loadIndex(from: workspaceIndexURL, label: "workspace") { try AppJSON.iso8601Decoder.decode(MobileWorkspaceIndexFile.self, from: $0) }
    }

    func loadSkillsIndex() -> MobileSkillsIndexFile? {
        loadIndex(from: skillsIndexURL, label: "skills") { try AppJSON.iso8601Decoder.decode(MobileSkillsIndexFile.self, from: $0) }
    }

    func saveWorkspaceIndex(_ file: MobileWorkspaceIndexFile) throws {
        try fm.createDirectory(at: settingsDirectory, withIntermediateDirectories: true)
        let data = try AppJSON.iso8601Encoder.encode(file)
        try data.write(to: workspaceIndexURL, options: .atomic)
    }

    func saveSkillsIndex(_ file: MobileSkillsIndexFile) throws {
        try fm.createDirectory(at: settingsDirectory, withIntermediateDirectories: true)
        let data = try AppJSON.iso8601Encoder.encode(file)
        try data.write(to: skillsIndexURL, options: .atomic)
    }

    func invalidateWorkspaceIndex() {
        try? fm.removeItem(at: workspaceIndexURL)
        workspaceUpdatedAt = nil
        workspaceEntryCount = 0
        workspaceTruncated = false
        lastWorkspaceRoot = nil
    }

    func invalidateSkillsIndex() {
        try? fm.removeItem(at: skillsIndexURL)
        skillsUpdatedAt = nil
        skillsEntryCount = 0
    }

    // MARK: - Private

    private func loadIndex<T>(
        from url: URL,
        label: String,
        decode: (Data) throws -> T
    ) -> T? {
        guard fm.fileExists(atPath: url.path) else { return nil }
        guard let data = try? Data(contentsOf: url) else { return nil }
        do {
            let value = try decode(data)
            if label == "workspace", let file = value as? MobileWorkspaceIndexFile,
               file.version != MobileWorkspaceIndexFile.currentVersion {
                stashCorrupt(data, url: url, label: label, reason: "unsupported version \(file.version)")
                try? fm.removeItem(at: url)
                return nil
            }
            if label == "skills", let file = value as? MobileSkillsIndexFile,
               file.version != MobileSkillsIndexFile.currentVersion {
                stashCorrupt(data, url: url, label: label, reason: "unsupported version \(file.version)")
                try? fm.removeItem(at: url)
                return nil
            }
            return value
        } catch {
            stashCorrupt(data, url: url, label: label, reason: error.localizedDescription)
            try? fm.removeItem(at: url)
            lastError = "\(label.capitalized) index was corrupt and was reset."
            return nil
        }
    }

    private func stashCorrupt(_ data: Data, url: URL, label: String, reason: String) {
        let ts = Int(Date().timeIntervalSince1970)
        let backup = url.deletingLastPathComponent()
            .appendingPathComponent("\(url.lastPathComponent).corrupt-\(ts)")
        try? data.write(to: backup, options: .atomic)
        lastError = "\(label.capitalized) index corrupt (\(reason)) — stashed to \(backup.lastPathComponent)."
    }

    private func workspaceIndexIsStale(_ file: MobileWorkspaceIndexFile, root: URL) -> Bool {
        let resolved = root.resolvingSymlinksInPath()
        if file.workspaceRoot != resolved.path { return true }
        return Date().timeIntervalSince(file.updatedAt) > Self.workspaceStaleInterval
    }

    private func skillsIndexIsStale(_ file: MobileSkillsIndexFile) -> Bool {
        Date().timeIntervalSince(file.updatedAt) > Self.skillsStaleInterval
    }

    private func applyWorkspaceMeta(_ file: MobileWorkspaceIndexFile) {
        workspaceUpdatedAt = file.updatedAt
        workspaceEntryCount = file.entries.count
        workspaceTruncated = file.truncated
        lastWorkspaceRoot = file.workspaceRoot
    }

    private func applySkillsMeta(_ file: MobileSkillsIndexFile) {
        skillsUpdatedAt = file.updatedAt
        skillsEntryCount = file.entries.count
    }

    nonisolated static func filterWorkspace(
        _ entries: [MobileWorkspaceIndexEntry],
        query: String,
        limit: Int
    ) -> [ExploreWorkspaceEntry] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return [] }
        let cap = min(max(limit, 1), 80)
        return entries
            .map { (score: rankWorkspace($0, query: q), entry: $0) }
            .filter { $0.score > 0 }
            .sorted { lhs, rhs in
                if lhs.score != rhs.score { return lhs.score > rhs.score }
                return lhs.entry.path.count < rhs.entry.path.count
            }
            .prefix(cap)
            .map { $0.entry.exploreEntry }
    }

    nonisolated static func filterSkills(
        _ entries: [MobileSkillIndexEntry],
        query: String,
        limit: Int
    ) -> [ExploreSkillEntry] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return [] }
        let cap = min(max(limit, 1), 80)
        return entries
            .map { (score: rankSkill($0, query: q), entry: $0) }
            .filter { $0.score > 0 }
            .sorted { lhs, rhs in
                if lhs.score != rhs.score { return lhs.score > rhs.score }
                return lhs.entry.name.localizedCaseInsensitiveCompare(rhs.entry.name) == .orderedAscending
            }
            .prefix(cap)
            .map { $0.entry.exploreEntry }
    }

    nonisolated private static func rankWorkspace(_ entry: MobileWorkspaceIndexEntry, query: String) -> Int {
        let name = entry.name.lowercased()
        let path = entry.path.lowercased()
        if name == query { return 100 }
        if name.hasPrefix(query) { return 90 }
        if name.contains(query) { return 70 }
        if path.contains(query) { return 40 }
        return 0
    }

    nonisolated private static func rankSkill(_ entry: MobileSkillIndexEntry, query: String) -> Int {
        let name = entry.name.lowercased()
        let id = entry.id.lowercased()
        if name == query { return 100 }
        if name.hasPrefix(query) { return 90 }
        if name.contains(query) { return 75 }
        if id.contains(query) { return 50 }
        if entry.description.lowercased().contains(query) { return 30 }
        return 0
    }
}
