import CryptoKit
import Foundation

/// Persists a finished `LoopRunRecord`. The seam `LoopEngineRunner` depends on
/// so its tests can assert what would be written without touching the disk —
/// same idiom as `RegressionSweepRunning` and `LoopSkillExecuting`.
///
/// **Fail-open by contract.** Unlike the verify path (`RegressionSweepRunning`,
/// `VerifyApprovalStore`), which is deliberately fail-closed on ambiguity, a
/// journal write that fails must never fail the run: telemetry is an
/// observation of the work, not a gate on it, and a full disk or a read-only
/// checkout is not a reason to refuse to fix a failing test. Implementations
/// therefore return a diagnostic string rather than throwing.
protocol LoopRunJournaling: AnyObject {
    /// Persists `record` beneath `root`. Returns `nil` on success, or a
    /// human-readable reason on failure (which the caller logs and ignores).
    func write(_ record: LoopRunRecord, root: URL) -> String?

    /// Most recent runs first, capped at `limit`. Returns `[]` when no journal
    /// exists yet — an absent journal is the normal state for a fresh project,
    /// not an error.
    func recentRuns(root: URL, limit: Int) -> [LoopRunIndexEntry]

    /// Appends one event to the run's crash-safe log (flushed per event, off
    /// the calling thread). Fail-open like `write`. Default: no-op.
    func appendEvent(_ event: LoopRunEvent, runId: String, root: URL)

    /// Turns every run that has an event log but no final record — and is not
    /// live in this process — into an `.aborted` record. Returns how many.
    @discardableResult
    func reconcileInterrupted(root: URL) -> Int

    /// `reconcileInterrupted`, off the calling thread and at most once per
    /// project root per app launch. Returns how many runs were reconciled.
    func reconcileOncePerLaunch(root: URL) async -> Int

    /// The full record of a past run, or `nil` when it cannot be read.
    func loadRecord(id: String, startedAt: Date, root: URL) -> LoopRunRecord?
}

extension LoopRunJournaling {
    func appendEvent(_ event: LoopRunEvent, runId: String, root: URL) {}
    @discardableResult
    func reconcileInterrupted(root: URL) -> Int { 0 }
    func reconcileOncePerLaunch(root: URL) async -> Int { 0 }
    func loadRecord(id: String, startedAt: Date, root: URL) -> LoopRunRecord? { nil }
}

/// File-system journal under `<root>/system/loop-runs/`:
///
/// ```
/// system/loop-runs/index-2026-08.jsonl — one LoopRunIndexEntry per line, append-only,
///                                          one file per month (legacy single
///                                          index.jsonl is still read, as the oldest)
/// system/loop-runs/2026-08/<runId>.json — the full LoopRunRecord
/// ```
///
/// While a run is in flight its events go to an append-only log OUTSIDE the
/// project (`<Application Support>/loop-events/<root hash>/<runId>.jsonl`, see
/// `eventsDirectory`); the final record supersedes it.
///
/// `<root>/system/` is the same per-project directory `RegressionRunner`
/// already owns for `system/faults/` and `faults.csv`, so a project's harness
/// state stays in one place and travels with the repo.
final class FileLoopRunJournal: LoopRunJournaling {
    /// Month-bucketed subdirectories keep any single directory small on a
    /// project that loops on a cron for months.
    private static let monthFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM"
        f.timeZone = TimeZone.current
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    /// ISO-8601 **with fractional seconds**, i.e. millisecond resolution.
    ///
    /// `JSONEncoder`'s built-in `.iso8601` truncates to whole seconds, which would
    /// silently round every timestamp and make `LoopRunRecord.durationSeconds`
    /// (derived from `startedAt`/`endedAt`) off by up to a second. A text
    /// timestamp is kept — rather than an epoch number — because these files are
    /// meant to be greppable by hand.
    ///
    /// Millisecond resolution is the deliberate floor: a written timestamp
    /// round-trips to within 1 ms, not bit-exactly, and nothing the journal
    /// measures is finer than that (per-stage timings are stored separately as
    /// full-precision `Double` seconds).
    private static let iso8601: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static func encoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(iso8601.string(from: date))
        }
        e.outputFormatting = [.sortedKeys]
        return e
    }

    static func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            guard let date = iso8601.date(from: text) else {
                throw DecodingError.dataCorrupted(.init(
                    codingPath: decoder.codingPath,
                    debugDescription: "not an ISO-8601 timestamp: \(text)"))
            }
            return date
        }
        return d
    }

    static func runsDirectory(root: URL) -> URL {
        root.appendingPathComponent("system", isDirectory: true)
            .appendingPathComponent("loop-runs", isDirectory: true)
    }

    /// The legacy single-file index. Still READ (oldest entries); new entries
    /// go to the month-rotated file from `indexURL(root:for:)`.
    static func legacyIndexURL(root: URL) -> URL {
        runsDirectory(root: root).appendingPathComponent("index.jsonl")
    }

    static func indexURL(root: URL, for date: Date = Date()) -> URL {
        runsDirectory(root: root)
            .appendingPathComponent("index-\(monthFormatter.string(from: date)).jsonl")
    }

    /// Index files newest first: `index-YYYY-MM.jsonl` descending, then the
    /// legacy `index.jsonl` (older than anything rotated).
    static func indexFilesNewestFirst(root: URL) -> [URL] {
        let dir = runsDirectory(root: root)
        let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        let rotated = names.filter { $0.hasPrefix("index-") && $0.hasSuffix(".jsonl") }
            .sorted(by: >).map { dir.appendingPathComponent($0) }
        let legacy = legacyIndexURL(root: root)
        return FileManager.default.fileExists(atPath: legacy.path) ? rotated + [legacy] : rotated
    }

    /// Event logs live OUTSIDE the project tree (Application Support, one
    /// folder per project root), not under `system/loop-runs/`: that path is a
    /// protected path for `RepairScopeGuard`, so a log appended to while a
    /// repair runs would read as the repair rigging the harness's own state.
    private let eventsBase: URL

    init(eventsBase: URL? = nil) {
        self.eventsBase = eventsBase
            ?? AppIdentity.applicationSupportRoot().appendingPathComponent("loop-events", isDirectory: true)
    }

    func eventsDirectory(root: URL) -> URL {
        let key = SHA256.hash(data: Data(root.resolvingSymlinksInPath().standardizedFileURL.path.utf8))
            .prefix(8).map { String(format: "%02x", $0) }.joined()
        return eventsBase.appendingPathComponent(key, isDirectory: true)
    }

    func eventLogURL(runId: String, root: URL) -> URL {
        eventsDirectory(root: root).appendingPathComponent("\(runId).jsonl")
    }

    /// Month-bucketed JSON path for a run — matches `write(_:root:)`.
    static func recordFileURL(id: String, startedAt: Date, root: URL) -> URL {
        runsDirectory(root: root)
            .appendingPathComponent(monthFormatter.string(from: startedAt), isDirectory: true)
            .appendingPathComponent("\(id).json")
    }

    /// Resolves the on-disk file for a run listed in `index.jsonl`.
    /// Uses `startedAt` for the month bucket first, then scans all buckets —
    /// the index is authoritative for identity, but `monthFormatter` is
    /// `TimeZone.current`, so a record written near a month boundary can land
    /// in a different bucket than a later read computes.
    func resolveRecordURL(id: String, startedAt: Date, root: URL) -> URL? {
        let primary = Self.recordFileURL(id: id, startedAt: startedAt, root: root)
        if FileManager.default.fileExists(atPath: primary.path) { return primary }
        let runsDir = Self.runsDirectory(root: root)
        let wanted = "\(id).json"
        guard let subpaths = try? FileManager.default.subpathsOfDirectory(atPath: runsDir.path),
              // Compare the last component, not a suffix: `hasSuffix` would let
              // id "me" match "load-me.json".
              let match = subpaths.first(where: { ($0 as NSString).lastPathComponent == wanted })
        else { return nil }
        return runsDir.appendingPathComponent(match)
    }

    /// Loads the full journal record for a run listed in `index.jsonl`.
    func loadRecord(id: String, startedAt: Date, root: URL) -> LoopRunRecord? {
        guard let url = resolveRecordURL(id: id, startedAt: startedAt, root: root) else { return nil }
        return Self.decodeRecord(at: url)
    }

    private static func decodeRecord(at url: URL) -> LoopRunRecord? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? decoder().decode(LoopRunRecord.self, from: data)
    }

    // MARK: - Crash-safe event log

    /// Serial, so events land in call order and the log writes never touch the
    /// main actor. `flushEvents()` is the barrier the final write waits on.
    private static let eventQueue = DispatchQueue(label: "llmide.loop.journal.events", qos: .utility)
    private static let liveLock = NSLock()
    private static var liveRunIds: Set<String> = []

    private static func markLive(_ id: String, _ live: Bool) {
        liveLock.lock(); defer { liveLock.unlock() }
        if live { liveRunIds.insert(id) } else { liveRunIds.remove(id) }
    }

    private static func isLive(_ id: String) -> Bool {
        liveLock.lock(); defer { liveLock.unlock() }
        return liveRunIds.contains(id)
    }

#if DEBUG
    /// Test seam: pretend the process restarted (no run is live any more).
    static func forgetLiveRuns() {
        liveLock.lock(); defer { liveLock.unlock() }
        liveRunIds.removeAll()
    }
#endif

    /// Blocks until every queued event has been written.
    static func flushEvents() { eventQueue.sync {} }

    func appendEvent(_ event: LoopRunEvent, runId: String, root: URL) {
        if event.kind == LoopRunEvent.Kind.started { Self.markLive(runId, true) }
        guard var line = try? Self.encoder().encode(event) else { return }
        line.append(0x0A)
        let url = eventLogURL(runId: runId, root: root)
        Self.eventQueue.async {
            // Open-append-close per event: closing flushes it to the OS, so a
            // crash of this process (not of the machine) loses nothing.
            try? Self.append(line, to: url)
        }
    }

    private static var reconciledRoots: Set<String> = []

    func reconcileOncePerLaunch(root: URL) async -> Int {
        let key = root.resolvingSymlinksInPath().standardizedFileURL.path
        Self.liveLock.lock()
        let first = Self.reconciledRoots.insert(key).inserted
        Self.liveLock.unlock()
        guard first else { return 0 }
        return await withCheckedContinuation { cont in
            DispatchQueue.global(qos: .utility).async { cont.resume(returning: self.reconcileInterrupted(root: root)) }
        }
    }

    /// Appends the index line for `record` unless its month file already has it
    /// (checked over the tail only): a crash between the record write and the
    /// index append leaves exactly that gap.
    private func repairIndexLine(for record: LoopRunRecord, root: URL) {
        let file = Self.indexURL(root: root, for: record.startedAt)
        let decoder = Self.decoder()
        let present = Self.tailLines(of: file, max: 200).lines.contains {
            (try? decoder.decode(LoopRunIndexEntry.self, from: $0))?.id == record.id
        }
        guard !present, var line = try? Self.encoder().encode(LoopRunIndexEntry(record)) else { return }
        line.append(0x0A)
        try? Self.append(line, to: file)
    }

    @discardableResult
    func reconcileInterrupted(root: URL) -> Int {
        Self.flushEvents()
        let dir = eventsDirectory(root: root)
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return 0 }
        let decoder = Self.decoder()
        var count = 0
        for name in names where name.hasSuffix(".jsonl") {
            let runId = String(name.dropLast(".jsonl".count))
            guard !Self.isLive(runId) else { continue }
            let url = dir.appendingPathComponent(name)
            guard let data = try? Data(contentsOf: url) else { continue }
            let events = data.split(separator: 0x0A).compactMap {
                try? decoder.decode(LoopRunEvent.self, from: Data($0))
            }
            guard let start = events.first(where: { $0.kind == LoopRunEvent.Kind.started })?.start else {
                // No readable start: nothing to reconstruct; drop the stub.
                try? FileManager.default.removeItem(at: url)
                continue
            }
            if let existing = resolveRecordURL(id: runId, startedAt: start.startedAt, root: root) {
                // Finished (record exists) — but make sure it is also indexed
                // before the log, the only other trace, is dropped.
                if let record = Self.decodeRecord(at: existing) { repairIndexLine(for: record, root: root) }
                try? FileManager.default.removeItem(at: url)
            } else {
                // `write` removes the log on success; on failure it stays for
                // the next launch to retry.
                if let record = LoopRunEvent.reconstruct(from: events), write(record, root: root) == nil {
                    count += 1
                }
            }
        }
        return count
    }

    func write(_ record: LoopRunRecord, root: URL) -> String? {
        Self.flushEvents()
        let dir = Self.runsDirectory(root: root)
            .appendingPathComponent(Self.monthFormatter.string(from: record.startedAt), isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let encoder = Self.encoder()
            try encoder.encode(record)
                .write(to: dir.appendingPathComponent("\(record.id).json"), options: .atomic)

            // The index is append-only: one line per run, never rewritten. A
            // torn append costs one unparseable line (skipped on read), whereas
            // rewriting the whole file would risk losing every prior run.
            var line = try encoder.encode(LoopRunIndexEntry(record))
            line.append(0x0A)   // "\n"
            try Self.append(line, to: Self.indexURL(root: root, for: record.startedAt))
            // The record supersedes the event log.
            try? FileManager.default.removeItem(at: eventLogURL(runId: record.id, root: root))
            Self.markLive(record.id, false)
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    func recentRuns(root: URL, limit: Int) -> [LoopRunIndexEntry] {
        guard limit > 0 else { return [] }
        let decoder = Self.decoder()
        var entries: [LoopRunIndexEntry] = []
        for file in Self.indexFilesNewestFirst(root: root) {
            // Tail-read: seek from the end and stop once enough lines parse,
            // so a year of history is never read to show ten rows.
            var want = limit + 8
            while true {
                let (lines, reachedStart) = Self.tailLines(of: file, max: want)
                var parsed: [LoopRunIndexEntry] = []
                for line in lines {
                    // A torn final line after a crash is skipped, not fatal.
                    if let e = try? decoder.decode(LoopRunIndexEntry.self, from: line) { parsed.append(e) }
                }
                if parsed.count >= limit - entries.count || reachedStart {
                    entries.append(contentsOf: parsed.prefix(limit - entries.count))
                    break
                }
                want *= 2
            }
            if entries.count >= limit { break }
        }
        return entries
    }

    /// Up to `max` non-empty lines from the end of `url`, newest first, plus
    /// whether the read reached the start of the file (nothing older exists).
    static func tailLines(of url: URL, max: Int) -> (lines: [Data], reachedStart: Bool) {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return ([], true) }
        defer { try? handle.close() }
        guard let size = try? handle.seekToEnd(), size > 0 else { return ([], true) }
        var offset = size
        var buffer = Data()
        let chunk: UInt64 = 64 * 1024
        var lines: [Data] = []
        while true {
            let step = min(chunk, offset)
            offset -= step
            guard (try? handle.seek(toOffset: offset)) != nil,
                  let piece = try? handle.read(upToCount: Int(step)) else { return (lines, true) }
            buffer = piece + buffer
            var parts = buffer.split(separator: 0x0A, omittingEmptySubsequences: false)
            // Bytes before the first newline may be a partial line unless the
            // read reached the file start; carry them into the next round.
            let head: Data? = offset > 0 ? Data(parts.removeFirst()) : nil
            lines += parts.reversed().filter { !$0.isEmpty }.map { Data($0) }
            if lines.count >= max { return (Array(lines.prefix(max)), false) }
            if offset == 0 { return (lines, true) }
            buffer = head ?? Data()
        }
    }

    /// Appends to `url`, creating it (and its parent) if absent. `FileHandle`
    /// rather than read-modify-write so two runs finishing close together
    /// cannot clobber each other's line.
    private static func append(_ data: Data, to url: URL) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !fm.fileExists(atPath: url.path) {
            try data.write(to: url, options: .atomic)
            return
        }
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: data)
    }
}
