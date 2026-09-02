import Foundation
import os.log

/// How an Auto Task execution was started — mirrors Loop journal triggers.
enum AutoTaskRunTrigger: String, Codable, CaseIterable {
    case manual
    case cron
    case pipeline
    case phone
}

enum AutoTaskRunStatus: String, Codable {
    case success
    case failed
    case cancelled
    case skipped
}

/// One completed (or aborted) Auto Task execution.
struct AutoTaskRunRecord: Codable, Identifiable, Equatable {
    let id: String
    let taskId: String
    let taskLabel: String
    let trigger: AutoTaskRunTrigger
    let startedAt: Date
    let finishedAt: Date
    let status: AutoTaskRunStatus
    let summary: String?
    /// Basename under `~/Library/Logs/<app>/`, e.g. `auto-task-reviewCode.log`.
    let logFileName: String?
    let projectId: String?
}

/// Append-only store of recent Auto Task runs. Not actor-isolated — only
/// `AutoCodeUpdateService` (@MainActor) mutates this.
final class AutoTaskRunHistory {

    private static let maxRecords = 200
    private let log = Logger(subsystem: "com.llmide.macapp", category: "AutoTaskRunHistory")
    private let storeURL: URL
    private var records: [AutoTaskRunRecord] = []

    var onSaveError: ((Error) -> Void)?
    private(set) var loadError: Error?

    init(storeURL: URL) {
        self.storeURL = storeURL
    }

    func bootstrap() {
        guard !hasBootstrapped else { return }
        hasBootstrapped = true
        load()
    }

    private var hasBootstrapped = false

    func record(_ entry: AutoTaskRunRecord) {
        // Read-before-write: Auto Tasks can run with the cron disabled, in which
        // case `AutoCodeUpdateService.start()` — the only explicit bootstrap —
        // never fired. Saving an unseeded array would truncate the stored file.
        bootstrap()
        records.insert(entry, at: 0)
        if records.count > Self.maxRecords {
            records = Array(records.prefix(Self.maxRecords))
        }
        save()
    }

    func recentEntries(limit: Int = 50) -> [AutoTaskRunRecord] {
        bootstrap()
        return Array(records.prefix(limit))
    }

    // MARK: - Persistence

    private struct HistoryFile: Codable {
        var storeVersion: Int = 1
        var records: [AutoTaskRunRecord]
    }

    private func load() {
        guard FileManager.default.fileExists(atPath: storeURL.path) else { return }
        do {
            let data = try Data(contentsOf: storeURL)
            if let file = try? AppJSON.decoder.decode(HistoryFile.self, from: data) {
                records = Array(file.records.prefix(Self.maxRecords))
            } else {
                let legacy = try AppJSON.decoder.decode([AutoTaskRunRecord].self, from: data)
                records = Array(legacy.prefix(Self.maxRecords))
            }
        } catch {
            log.error("auto_task_run_history_load_failed: \(error, privacy: .public)")
            loadError = error
            // The next `record()` would overwrite the unreadable file and destroy
            // the evidence — move it aside first so it stays recoverable.
            let quarantine = storeURL.appendingPathExtension("corrupt")
            try? FileManager.default.removeItem(at: quarantine)
            try? FileManager.default.moveItem(at: storeURL, to: quarantine)
        }
    }

    private func save() {
        do {
            let file = HistoryFile(records: records)
            let data = try AppJSON.encoder.encode(file)
            try FileManager.default.createDirectory(
                at: storeURL.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            try data.write(to: storeURL, options: .atomic)
        } catch {
            log.error("auto_task_run_history_save_failed: \(error, privacy: .public)")
            onSaveError?(error)
        }
    }
}
