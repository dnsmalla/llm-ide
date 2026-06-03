import Foundation
import os.log

// Not actor-isolated — safe only when accessed from a single actor.
// AutoCodeUpdateService is @MainActor and is the sole caller.
final class ProcessedActionsRegistry {

    private let log = Logger(subsystem: "com.meetnotes.macapp", category: "ProcessedActionsRegistry")

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
        // Disk reads are deferred to `bootstrap()` so MeetNotesMacApp.init
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

    func isKnown(id: String) -> Bool {
        entries[id] != nil
    }

    func register(action: NoteAction, issueIid: Int?) {
        guard !isKnown(id: action.id) else { return }
        let entry = RegistryEntry(
            actionId: action.id,
            actionText: action.text,
            issueIid: issueIid,
            status: .pending,
            retryCount: 0,
            registeredAt: Date(),
            lastUpdated: Date()
        )
        entries[action.id] = entry
        save()
    }

    func markImplementing(id: String) {
        update(id: id) { $0.status = .implementing }
    }

    func markDone(id: String) {
        update(id: id) { $0.status = .done }
    }

    func markFailed(id: String) {
        update(id: id) {
            $0.retryCount += 1
            $0.status = .failed
        }
    }

    /// Returns entries eligible for a CLI implementation run.
    /// Includes `pending` and `failed` entries with fewer than 3 retries.
    func pendingEntries() -> [RegistryEntry] {
        entries.values.filter { entry in
            switch entry.status {
            case .pending:             return true
            case .failed:              return entry.retryCount < 3
            case .implementing, .done: return false
            }
        }
    }

    func allEntries() -> [RegistryEntry] {
        entries.values.sorted { $0.registeredAt > $1.registeredAt }
    }

    // MARK: - Private

    private func update(id: String, mutation: (inout RegistryEntry) -> Void) {
        guard var entry = entries[id] else { return }
        mutation(&entry)
        entry.lastUpdated = Date()
        entries[id] = entry
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
