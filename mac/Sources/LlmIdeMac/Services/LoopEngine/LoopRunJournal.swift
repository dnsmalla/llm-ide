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
}

/// File-system journal under `<root>/system/loop-runs/`:
///
/// ```
/// system/loop-runs/index.jsonl          — one LoopRunIndexEntry per line, append-only
/// system/loop-runs/2026-08/<runId>.json — the full LoopRunRecord
/// ```
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

    static func indexURL(root: URL) -> URL {
        runsDirectory(root: root).appendingPathComponent("index.jsonl")
    }

    func write(_ record: LoopRunRecord, root: URL) -> String? {
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
            try Self.append(line, to: Self.indexURL(root: root))
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    func recentRuns(root: URL, limit: Int) -> [LoopRunIndexEntry] {
        guard limit > 0,
              let data = try? Data(contentsOf: Self.indexURL(root: root)),
              let text = String(data: data, encoding: .utf8)
        else { return [] }
        let decoder = Self.decoder()
        // Newest last in an append-only file, so walk backwards and stop at
        // `limit` rather than decoding a year of history to show ten rows.
        var entries: [LoopRunIndexEntry] = []
        for line in text.split(separator: "\n", omittingEmptySubsequences: true).reversed() {
            // A partially-written final line is expected after a crash mid-append;
            // skip it rather than discarding the whole index.
            guard let entry = try? decoder.decode(LoopRunIndexEntry.self, from: Data(line.utf8))
            else { continue }
            entries.append(entry)
            if entries.count == limit { break }
        }
        return entries
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
