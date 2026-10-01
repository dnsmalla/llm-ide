import Foundation
import OSLog

/// One os_log entry, decoupled from `OSLogEntryLog` so it can be constructed
/// directly in tests without touching the real log store.
public struct LogLine: Sendable {
    public var date: Date
    public var subsystem: String
    public var category: String
    public var message: String

    public init(date: Date, subsystem: String, category: String, message: String) {
        self.date = date
        self.subsystem = subsystem
        self.category = category
        self.message = message
    }
}

/// Polls the unified log for this process's own error/fault lines and turns
/// them into incidents — category "Incidents" is skipped so the recorder
/// never feeds itself.
public enum OSLogIncidentSource {
    public static let subsystems: Set<String> = ["com.llmide.macapp", "LlmIdeMac"]
    private static let pollInterval: Duration = .seconds(60)
    @MainActor private static var task: Task<Void, Never>?

    @MainActor
    public static func ingest(_ lines: [LogLine], into store: IncidentStore, eligible: Bool) {
        for line in lines where subsystems.contains(line.subsystem) && line.category != "Incidents" {
            IncidentRecorder.record(source: .log, category: line.category, message: line.message, stack: nil,
                                    at: line.date, into: store, eligible: eligible)
        }
    }

    @MainActor
    public static func start() {
        guard task == nil, AppSourceRoot.gitRoot != nil else { return }
        task = Task { @MainActor in
            var cursor = Date()
            while !Task.isCancelled {
                try? await Task.sleep(for: pollInterval)
                let since = cursor
                cursor = Date()
                let lines = await Task.detached(priority: .utility) { readErrors(since: since) }.value
                ingest(lines, into: .shared, eligible: SelfHealSettings.isEnabled())
            }
        }
    }

    // Reads only error/fault level entries for our own subsystems — never
    // logs anything itself, so it cannot feed the recorder it serves.
    private static func readErrors(since: Date) -> [LogLine] {
        guard let store = try? OSLogStore(scope: .currentProcessIdentifier),
              let entries = try? store.getEntries(at: store.position(date: since)) else { return [] }
        return entries.compactMap { entry in
            guard let log = entry as? OSLogEntryLog, log.date > since,
                  log.level == .error || log.level == .fault,
                  subsystems.contains(log.subsystem) else { return nil }
            return LogLine(date: log.date, subsystem: log.subsystem, category: log.category,
                           message: log.composedMessage)
        }
    }
}
