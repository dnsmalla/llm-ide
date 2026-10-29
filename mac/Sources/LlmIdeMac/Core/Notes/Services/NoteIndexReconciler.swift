import CryptoKit
import Foundation
import os.log

// Feeds the server's derived note index (live-then-archive Phase 2, plan 3.8).
//
// The Mac note files are the only durable copy. This service reads them, sends
// a manifest (key, content hash) to `POST /kb/index/reconcile`, and upserts only
// the notes the server reports as missing or stale. Hidden notes are sent with
// `hidden: true` so the server drops them. Nothing here changes what the legacy
// meeting path reads or writes; a failure here never reaches the UI.

/// Server bounds the reconciler stays under (schema/http/index.schema.json and
/// extension/kb/note-index.mjs). A value above a bound fails the whole batch.
enum NoteIndexLimits {
    static let batchNotes = 50
    static let batchBytes = 900_000
    static let manifestBytes = 900_000
    static let manifestEntries = 20_000
    static let bodyBytes = 512 * 1024
    static let titleChars = 500
    static let dateChars = 64
    static let keyChars = 512
    static let participantChars = 200
    static let participantCount = 200
    static let metaChars = 200
}

/// The two calls the reconciler makes. `LlmIdeAPIClient` conforms; tests pass an
/// in-process fake that behaves like the server.
protocol NoteIndexRemote: Sendable {
    func indexUpsertNotes(projectId: String,
                          notes: [LlmIdeAPIClient.IndexNoteInput]) async throws -> LlmIdeAPIClient.IndexUpsertResult
    func indexReconcile(projectId: String,
                        manifest: [LlmIdeAPIClient.IndexManifestEntry],
                        prune: Bool) async throws -> LlmIdeAPIClient.IndexReconcileResult
}

extension LlmIdeAPIClient: NoteIndexRemote {}

/// What a file is, as far as the index is concerned.
enum NoteIndexKind: String, Sendable, Equatable {
    /// A meeting note the index can hold.
    case note
    /// Not a meeting note (no frontmatter). Ignored, as FolderIndexer ignores it.
    case notNote
    /// Frontmatter present but not decodable (for example no `platform`, F13).
    /// It cannot be indexed, and it blocks pruning for the run.
    case unparseable
    /// Larger than the server accepts for one body. Never sent.
    case oversize
}

struct NoteIndexCacheEntry: Sendable, Equatable {
    let mtimeMs: Int64
    let size: Int64
    let contentHash: String
    let kind: NoteIndexKind
}

struct NoteIndexFile: Sendable, Equatable {
    /// Relative path under the notes folder, forward slashes.
    let key: String
    let url: URL
    let contentHash: String
    let mtimeMs: Int64
}

struct NoteIndexScan: Sendable {
    var notes: [NoteIndexFile] = []
    var hidden: [NoteIndexFile] = []
    var unparseable: [String] = []
    var oversize: [String] = []
    var cache: [String: NoteIndexCacheEntry] = [:]
}

enum NoteIndexScanner {
    struct Failure: Error, Equatable {
        let reason: String
    }

    /// Walks `root` and returns the manifest material. Throws on ANY read or
    /// enumeration error: a partial scan must never look like a complete one,
    /// because callers prune only after a complete scan.
    static func scan(root: URL, hiddenKeys: Set<String>, previous: [String: NoteIndexCacheEntry]) throws -> NoteIndexScan {
        var out = NoteIndexScan()
        let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey, .isRegularFileKey]
        guard let enumerator = FileManager.default.enumerator(
            at: root, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]) else {
            throw Failure(reason: "cannot enumerate the notes folder")
        }
        for case let url as URL in enumerator {
            let name = url.lastPathComponent
            guard name.hasSuffix(".md"), !name.hasSuffix(".partial.md") else { continue }
            let values: URLResourceValues
            do { values = try url.resourceValues(forKeys: Set(keys)) } catch {
                throw Failure(reason: "cannot stat \(name): \(error.localizedDescription)")
            }
            guard values.isRegularFile == true else { continue }
            guard let mdate = values.contentModificationDate, let fsize = values.fileSize else {
                throw Failure(reason: "no modification date or size for \(name)")
            }
            let key = FolderIndexer.relativePath(of: url, under: root)
            let mtimeMs = Int64(mdate.timeIntervalSince1970 * 1000)
            let size = Int64(fsize)
            let entry: NoteIndexCacheEntry
            if let hit = previous[key], hit.mtimeMs == mtimeMs, hit.size == size {
                entry = hit
            } else {
                let data: Data
                do { data = try Data(contentsOf: url) } catch {
                    throw Failure(reason: "cannot read \(name): \(error.localizedDescription)")
                }
                entry = NoteIndexCacheEntry(mtimeMs: mtimeMs, size: size,
                                            contentHash: sha256Hex(data), kind: classify(data))
            }
            out.cache[key] = entry
            let file = NoteIndexFile(key: key, url: url, contentHash: entry.contentHash, mtimeMs: mtimeMs)
            if hiddenKeys.contains(key) {
                out.hidden.append(file)
                continue
            }
            switch entry.kind {
            case .note: out.notes.append(file)
            case .unparseable: out.unparseable.append(key)
            case .oversize: out.oversize.append(key)
            case .notNote: break
            }
        }
        out.notes.sort { $0.key < $1.key }
        out.hidden.sort { $0.key < $1.key }
        return out
    }

    /// Classifies bytes the same way FolderIndexer decides what to index.
    static func classify(_ data: Data) -> NoteIndexKind {
        if data.count > NoteIndexLimits.bodyBytes { return .oversize }
        guard data.starts(with: Array("---\n".utf8)) else { return .notNote }
        guard let text = String(data: data, encoding: .utf8),
              let split = FrontmatterCoder.split(file: text) else { return .unparseable }
        return (try? FrontmatterCoder.decode(split.yaml)) == nil ? .unparseable : .note
    }

    /// The upsert body for one note, read from disk now. Nil when the file can no
    /// longer be indexed (it changed to something else, or it is oversize).
    static func upsertInput(for file: NoteIndexFile) throws -> LlmIdeAPIClient.IndexNoteInput? {
        let data = try Data(contentsOf: file.url)
        guard data.count <= NoteIndexLimits.bodyBytes,
              let text = String(data: data, encoding: .utf8),
              let split = FrontmatterCoder.split(file: text),
              let fm = try? FrontmatterCoder.decode(split.yaml) else { return nil }
        let body = String(text[split.bodyStart...])
        return LlmIdeAPIClient.IndexNoteInput(
            noteKey: file.key,
            kind: "meeting",
            title: clip(fm.title, NoteIndexLimits.titleChars),
            date: clip(AppDateFormatter.isoString(fm.startedAt), NoteIndexLimits.dateChars),
            durationSec: max(0, fm.durationSeconds ?? 0),
            participants: fm.participants.prefix(NoteIndexLimits.participantCount)
                .map { clip($0, NoteIndexLimits.participantChars) },
            body: body,
            contentHash: sha256Hex(data),
            mtimeMs: file.mtimeMs,
            hidden: nil,
            meta: [
                "meetingId": clip(fm.id, NoteIndexLimits.metaChars),
                "platform": clip(fm.platform, NoteIndexLimits.metaChars),
                "language": clip(fm.language, NoteIndexLimits.metaChars),
            ])
    }

    /// A hidden note only needs its key: the server removes the row and ignores the rest.
    static func hiddenInput(for file: NoteIndexFile) -> LlmIdeAPIClient.IndexNoteInput {
        LlmIdeAPIClient.IndexNoteInput(
            noteKey: file.key, kind: nil, title: "", date: "", durationSec: nil,
            participants: nil, body: nil, contentHash: file.contentHash,
            mtimeMs: nil, hidden: true, meta: nil)
    }

    static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// `s` cut to at most `max` UTF-16 units, the unit the server measures.
    static func clip(_ s: String, _ max: Int) -> String {
        var t = String(s.prefix(max))
        while t.utf16.count > max { t.removeLast() }
        return t
    }
}

/// Splits upserts into batches the server accepts: at most `batchNotes` notes and
/// `batchBytes` of encoded JSON per request. A note that alone exceeds the byte
/// bound is dropped by the caller (it could never be sent).
enum NoteIndexBatching {
    static func encodedSize(_ n: LlmIdeAPIClient.IndexNoteInput) -> Int {
        (try? JSONEncoder().encode(n))?.count ?? Int.max
    }

    static func batches(_ inputs: [LlmIdeAPIClient.IndexNoteInput]) -> [[LlmIdeAPIClient.IndexNoteInput]] {
        var out: [[LlmIdeAPIClient.IndexNoteInput]] = []
        var current: [LlmIdeAPIClient.IndexNoteInput] = []
        var bytes = 0
        for n in inputs {
            let size = encodedSize(n)
            guard size <= NoteIndexLimits.batchBytes else { continue }
            if !current.isEmpty, current.count >= NoteIndexLimits.batchNotes || bytes + size > NoteIndexLimits.batchBytes {
                out.append(current)
                current = []
                bytes = 0
            }
            current.append(n)
            bytes += size
        }
        if !current.isEmpty { out.append(current) }
        return out
    }

    /// Manifest size on the wire, estimated from the key and hash lengths.
    static func manifestFits(_ manifest: [LlmIdeAPIClient.IndexManifestEntry]) -> Bool {
        guard manifest.count <= NoteIndexLimits.manifestEntries else { return false }
        let bytes = manifest.reduce(0) { $0 + $1.noteKey.utf8.count + $1.contentHash.utf8.count + 48 }
        return bytes <= NoteIndexLimits.manifestBytes
    }
}

/// Runs one reconcile pass at a time against the server index for one project.
@MainActor
final class NoteIndexReconciler {
    struct Stats: Equatable {
        var hiddenSent = 0
        var removedHidden = 0
        var manifestEntries = 0
        var pruneAllowed = false
        var pruned = 0
        var missing = 0
        var stale = 0
        var upserted = 0
        var unchanged = 0
        var truncated = 0
        var skippedUnindexable = 0
        var rejectedBatches = 0
    }

    enum Outcome: Equatable {
        case ok(Stats)
        /// Another pass is running; this request is dropped (the running pass sees the same files).
        case busy
        /// The folder could not be read completely. Nothing was pruned or sent for the notes.
        case scanFailed(String)
        /// The manifest exceeds the server bound; hidden removals were still sent.
        case manifestTooLarge(Stats)
        /// The server did not answer. The loop retries with backoff.
        case failed(String)
        case cancelled
    }

    static let debounce: Duration = .seconds(5)
    static let interval: Duration = .seconds(15 * 60)
    private static let log = Logger(subsystem: "com.llmide.macapp", category: "NoteIndexReconciler")

    private let root: URL
    private let index: MeetingIndex
    private let projectId: String
    private let remote: NoteIndexRemote
    private var cache: [String: NoteIndexCacheEntry] = [:]
    private var running = false
    private(set) var consecutiveFailures = 0

    private var loopTask: Task<Void, Never>?
    private var periodicTask: Task<Void, Never>?
    private var debounceTask: Task<Void, Never>?
    private var wake: AsyncStream<Void>.Continuation?

    init(root: URL, index: MeetingIndex, projectId: String, remote: NoteIndexRemote) {
        self.root = root
        self.index = index
        self.projectId = projectId
        self.remote = remote
    }

    /// Backoff after `n` consecutive failures: 5 s, 10 s, 20 s ... capped at 5 min.
    static func retryDelay(afterFailures n: Int) -> Duration {
        let exponent = min(max(n, 1) - 1, 10)
        return .seconds(min(300, 5 * (1 << exponent)))
    }

    /// Starts the background loop: one pass now, then on every `requestRun()`
    /// (debounced) and every `interval`. Failed passes retry with backoff.
    func start() {
        guard loopTask == nil else { return }
        let (stream, continuation) = AsyncStream.makeStream(of: Void.self, bufferingPolicy: .bufferingNewest(1))
        wake = continuation
        loopTask = Task { [weak self] in
            for await _ in stream {
                guard let owner = self, !Task.isCancelled else { return }
                let outcome = await owner.runOnce()
                guard !Task.isCancelled else { return }
                if case .failed = outcome {
                    try? await Task.sleep(for: Self.retryDelay(afterFailures: owner.consecutiveFailures))
                    continuation.yield(())
                }
            }
        }
        periodicTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.interval)
                guard self != nil, !Task.isCancelled else { return }
                continuation.yield(())
            }
        }
        continuation.yield(())
    }

    /// Asks for a pass soon. Several requests within `debounce` become one pass
    /// (a finalize writes a file, then the watcher reports it).
    func requestRun() {
        debounceTask?.cancel()
        debounceTask = Task { [weak self] in
            try? await Task.sleep(for: Self.debounce)
            guard !Task.isCancelled else { return }
            self?.wake?.yield(())
        }
    }

    /// Cancels the loop and any pending request. A pass already on the wire finishes
    /// its current request; the next batch checks cancellation and stops.
    func stop() {
        loopTask?.cancel()
        periodicTask?.cancel()
        debounceTask?.cancel()
        wake?.finish()
        wake = nil
        loopTask = nil
        periodicTask = nil
        debounceTask = nil
    }

    /// One full pass. Public to the module so tests drive it without the loop.
    func runOnce() async -> Outcome {
        guard !running else { return .busy }
        running = true
        defer { running = false }

        let root = self.root, index = self.index, previous = self.cache
        let scan: NoteIndexScan
        do {
            scan = try await Task.detached(priority: .utility) { () throws -> NoteIndexScan in
                let hidden = Set(try index.listAll().filter(\.hidden).map(\.path))
                return try NoteIndexScanner.scan(root: root, hiddenKeys: hidden, previous: previous)
            }.value
        } catch let failure as NoteIndexScanner.Failure {
            Self.log.notice("note index scan skipped: \(failure.reason, privacy: .public)")
            return .scanFailed(failure.reason)
        } catch {
            Self.log.notice("note index scan skipped: \(error.localizedDescription, privacy: .public)")
            return .scanFailed(error.localizedDescription)
        }
        cache = scan.cache

        var stats = Stats()
        stats.skippedUnindexable = scan.oversize.count
        do {
            // 1. Hidden notes leave the index first, so a later failure cannot keep them.
            stats.hiddenSent = scan.hidden.count
            for batch in NoteIndexBatching.batches(scan.hidden.map(NoteIndexScanner.hiddenInput)) {
                try Task.checkCancellation()
                if let r = try await send(batch) { stats.removedHidden += r.removed }
                else { stats.rejectedBatches += 1 }
            }

            // 2. Manifest and reconcile. Prune only after a complete scan with a
            // non-empty manifest and no unindexable file (an unparseable note may
            // still be a note the server must keep).
            let manifest = scan.notes.map { LlmIdeAPIClient.IndexManifestEntry(noteKey: $0.key, contentHash: $0.contentHash) }
            stats.manifestEntries = manifest.count
            let prune = scan.unparseable.isEmpty && !manifest.isEmpty
            stats.pruneAllowed = prune
            guard NoteIndexBatching.manifestFits(manifest) else {
                Self.log.notice("note index manifest too large for one reconcile; skipped")
                return .manifestTooLarge(stats)
            }
            try Task.checkCancellation()
            let result = try await remote.indexReconcile(projectId: projectId, manifest: manifest, prune: prune)
            stats.pruned = result.pruned
            stats.missing = result.missing.count
            stats.stale = result.stale.count

            // 3. Upsert what the server lacks or holds with another hash.
            let wanted = Set(result.missing).union(result.stale)
            let files = scan.notes.filter { wanted.contains($0.key) }
            let inputs: [LlmIdeAPIClient.IndexNoteInput] = try await Task.detached(priority: .utility) {
                files.compactMap { try? NoteIndexScanner.upsertInput(for: $0) }
            }.value
            stats.skippedUnindexable += files.count - inputs.count
            for batch in NoteIndexBatching.batches(inputs) {
                try Task.checkCancellation()
                if let r = try await send(batch) {
                    stats.upserted += r.upserted
                    stats.unchanged += r.unchanged
                    stats.truncated += r.truncated
                } else {
                    stats.rejectedBatches += 1
                }
            }
            consecutiveFailures = 0
            return .ok(stats)
        } catch is CancellationError {
            return .cancelled
        } catch {
            consecutiveFailures += 1
            Self.log.notice("note index pass failed (\(self.consecutiveFailures)): \(error.localizedDescription, privacy: .public)")
            return .failed(error.localizedDescription)
        }
    }

    /// Sends one batch. A 4xx that is not an auth or rate-limit answer means the
    /// server refused this content, so retrying it would fail the same way: the
    /// batch is counted as rejected and the pass goes on. Anything else is transient.
    private func send(_ batch: [LlmIdeAPIClient.IndexNoteInput]) async throws -> LlmIdeAPIClient.IndexUpsertResult? {
        do {
            return try await remote.indexUpsertNotes(projectId: projectId, notes: batch)
        } catch APIError.http(let status, _, _, _) where (400..<500).contains(status)
                    && ![401, 403, 408, 429].contains(status) {
            Self.log.notice("note index batch of \(batch.count) refused (HTTP \(status)); skipped")
            return nil
        }
    }
}

/// The one reconciler the app runs. Shell starts it when an environment opens and
/// `lta.mode` is not off; the termination hook stops it on quit.
@MainActor
enum NoteIndexHost {
    private static var current: NoteIndexReconciler?
    private static var hookRegistered = false

    static func start(root: URL, index: MeetingIndex, projectId: String, remote: NoteIndexRemote) {
        current?.stop()
        let reconciler = NoteIndexReconciler(root: root, index: index, projectId: projectId, remote: remote)
        current = reconciler
        reconciler.start()
        if !hookRegistered {
            hookRegistered = true
            AppTerminationHooks.register("note-index") { NoteIndexHost.stop() }
        }
    }

    /// A notes folder changed (finalize, rename, hide): ask for a debounced pass.
    static func folderChanged() {
        current?.requestRun()
    }

    static func stop() {
        current?.stop()
        current = nil
    }
}
