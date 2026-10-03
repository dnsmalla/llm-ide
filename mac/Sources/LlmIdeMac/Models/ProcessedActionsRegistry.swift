import Foundation
import os.log

// Not actor-isolated — safe only when accessed from a single actor.
// AutoCodeUpdateService is @MainActor and is the sole caller.
final class ProcessedActionsRegistry {

    private let log = Logger(subsystem: "com.llmide.macapp", category: "ProcessedActionsRegistry")

    // MARK: - Types

    enum EntryStatus: String, Codable {
        case pending, implementing, done, failed
    }

    struct RegistryEntry: Codable {
        let actionId: String
        var actionText: String
        var issueIid: Int?
        var status: EntryStatus
        var retryCount: Int
        var registeredAt: Date
        var lastUpdated: Date
        var taskType: String?
        /// Repo the action was registered against ("<kind>/<projectId>").
        /// nil for legacy entries written before this field existed (they
        /// decode as nil and keep the old match-everything behaviour).
        var repoKey: String?
        /// The "starting work" issue comment was already posted (survives a
        /// Stop, which leaves retryCount at 0). nil for legacy entries.
        var startAnnounced: Bool?
    }

    // MARK: - State

    private let storeURL: URL
    private var entries: [String: RegistryEntry] = [:]

    var onSaveError: ((Error) -> Void)? = nil
    private(set) var loadError: Error? = nil
    private(set) var initSaveError: Error? = nil

    // MARK: - Init

    init(storeURL: URL) {
        self.storeURL = storeURL
        // Disk reads are deferred to `bootstrap()` so LlmIdeMacApp.init
        // doesn't pay the JSON-decode cost before the first SwiftUI frame.
        // AutoCodeUpdateService is the sole consumer and it doesn't query
        // the registry until its own start() is called from a .task tick.
    }

    /// Perform the initial JSON load + stuck-implementing reset.
    /// Safe to call multiple times; subsequent calls are no-ops after the
    /// first load attempt (the file's existence check + decoder cost are
    /// the only non-idempotent part, and the registry's in-memory state
    /// is the source of truth once populated).
    func bootstrap() {
        guard !hasBootstrapped else { return }
        hasBootstrapped = true
        load()
        resetStuckImplementing()
    }

    private var hasBootstrapped = false

    // MARK: - Public API

    /// Dictionary key: the registry file is global across projects and the same
    /// meeting action can surface in several repos, so a repo-scoped entry is
    /// keyed by repo AND id (one repo's entry must never overwrite another's).
    /// Legacy entries (no repo key) keep the bare id.
    private static func storageKey(id: String, repoKey: String?) -> String {
        repoKey.map { "\($0)|\(id)" } ?? id
    }

    /// Whether this repo already handled `id`. A legacy (no-repo-key) entry
    /// counts as known everywhere: its origin is unknowable, and re-creating an
    /// issue for an action that may well be done is the worse error.
    func isKnown(id: String, repoKey: String? = nil) -> Bool {
        if entries[Self.storageKey(id: id, repoKey: repoKey)] != nil { return true }
        return entries[id]?.repoKey == nil && entries[id] != nil
    }

    func register(action: NoteAction, issueIid: Int?, repoKey: String? = nil) {
        let key = Self.storageKey(id: action.id, repoKey: repoKey)
        guard !isKnown(id: action.id, repoKey: repoKey) else { return }
        let entry = RegistryEntry(
            actionId: action.id,
            actionText: action.text,
            issueIid: issueIid,
            status: .pending,
            retryCount: 0,
            registeredAt: Date(),
            lastUpdated: Date(),
            repoKey: repoKey
        )
        entries[key] = entry
        save()
    }

    func markImplementing(id: String, repoKey: String? = nil) {
        update(id: id, repoKey: repoKey) { $0.status = .implementing }
    }

    /// Back to `pending` WITHOUT touching retryCount — for a user Stop, which
    /// must not count toward the 3-strike limit.
    func markPending(id: String, repoKey: String? = nil) {
        update(id: id, repoKey: repoKey) { $0.status = .pending }
    }

    func markStartAnnounced(id: String, repoKey: String? = nil) {
        update(id: id, repoKey: repoKey) { $0.startAnnounced = true }
    }

    func markDone(id: String, repoKey: String? = nil) {
        update(id: id, repoKey: repoKey) { $0.status = .done }
    }

    func markFailed(id: String, repoKey: String? = nil) {
        update(id: id, repoKey: repoKey) {
            $0.retryCount += 1
            $0.status = .failed
        }
    }

    /// Returns entries eligible for a CLI implementation run.
    /// Includes `pending` and `failed` entries with fewer than 3 retries.
    /// With a `repoKey`, only that repo's entries: a legacy (no-key) entry's
    /// `issueIid` would be looked up in whichever repo is active now, i.e.
    /// implemented as an unrelated issue, so it is skipped. nil matches all.
    /// Ordered oldest-first so runs are deterministic, not dictionary-order.
    func pendingEntries(repoKey: String? = nil) -> [RegistryEntry] {
        entries.values.filter { entry in
            if let repoKey, entry.repoKey != repoKey { return false }
            switch entry.status {
            case .pending:             return true
            case .failed:              return entry.retryCount < 3
            case .implementing, .done: return false
            }
        }.sorted { $0.registeredAt < $1.registeredAt }
    }

    func allEntries() -> [RegistryEntry] {
        entries.values.sorted { $0.registeredAt > $1.registeredAt }
    }

    // MARK: - Private

    private func update(id: String, repoKey: String?, mutation: (inout RegistryEntry) -> Void) {
        let key = Self.storageKey(id: id, repoKey: repoKey)
        guard var entry = entries[key] else { return }
        mutation(&entry)
        entry.lastUpdated = Date()
        entries[key] = entry
        save()
    }

    private func resetStuckImplementing() {
        var changed = false
        for key in entries.keys where entries[key]?.status == .implementing {
            guard var entry = entries[key] else { continue }
            entry.retryCount += 1
            if entry.retryCount >= 3 {
                entry.status = .failed
                entry.actionText = "[max retries] \(entry.actionText)"
            } else {
                entry.status = .pending
            }
            entry.lastUpdated = Date()
            entries[key] = entry
            changed = true
        }
        if changed { save() }
    }

    /// On-disk envelope. New writes always use this shape; legacy
    /// bare-dict files still decode through the fallback in `load()`.
    /// See `docs/reference/persistence.md`.
    private struct RegistryFile: Codable {
        var storeVersion: Int = 1
        var entries: [String: RegistryEntry]
    }

    private func load() {
        guard FileManager.default.fileExists(atPath: storeURL.path) else { return }
        do {
            let data = try Data(contentsOf: storeURL)
            if let file = try? AppJSON.decoder.decode(RegistryFile.self, from: data) {
                entries = file.entries
            } else {
                entries = try AppJSON.decoder.decode([String: RegistryEntry].self, from: data)
            }
        } catch {
            log.error("processed_actions_registry_load_failed: \(error, privacy: .public)")
            loadError = error
            // Archive the corrupt file so the next save() doesn't silently
            // overwrite it with an empty registry — losing every prior
            // processed-action record and causing the auto-update loop
            // to re-run all past actions. The .corrupt.<unix>.json file
            // is human-readable JSON that the user can hand-edit or
            // restore from.
            archiveCorruptFile()
        }
    }

    private func archiveCorruptFile() {
        let stamp = Int(Date().timeIntervalSince1970)
        let archive = storeURL.deletingLastPathComponent()
            .appendingPathComponent("\(storeURL.deletingPathExtension().lastPathComponent).corrupt.\(stamp).json")
        do {
            try FileManager.default.moveItem(at: storeURL, to: archive)
            log.error("processed_actions_registry archived corrupt file to \(archive.lastPathComponent, privacy: .public)")
        } catch {
            // If we can't archive, prefer to keep the bad file in place
            // over losing it. The loadError flag still surfaces in the
            // service-level UI so the user knows something is off.
            log.error("processed_actions_registry archive failed: \(error, privacy: .public)")
        }
    }

    private func save() {
        do {
            let file = RegistryFile(entries: entries)
            let data = try AppJSON.encoder.encode(file)
            try FileManager.default.createDirectory(
                at: storeURL.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            try data.write(to: storeURL, options: .atomic)
        } catch {
            log.error("processed_actions_registry_save_failed: \(error, privacy: .public)")
            if onSaveError == nil {
                initSaveError = error
            }
            onSaveError?(error)
        }
    }
}


extension ProcessedActionsRegistry.RegistryEntry: Identifiable {
    /// Same shape as the registry's storage key: one action can have an entry
    /// per repo, so `actionId` alone is not unique in a list.
    var id: String { repoKey.map { "\($0)|\(actionId)" } ?? actionId }
}
