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
    /// Indexable, but its encoded upsert exceeds one request (JSON escaping). Never sent.
    case unsendable
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
    /// Notes that are indexable but whose upsert would exceed one request (JSON escaping).
    var unsendable: [String] = []
    /// Placeholders (iCloud, Dropbox) whose bytes are not on disk. Never read; blocks pruning.
    var unavailable: [String] = []
    var cache: [String: NoteIndexCacheEntry] = [:]
}

/// One item a walk found. Metadata only: the scanner decides whether to read it.
struct NoteIndexEntry: Sendable, Equatable {
    let url: URL
    let isDirectory: Bool
    let mtimeMs: Int64?
    let size: Int64?
    /// An iCloud/Dropbox placeholder: the metadata is there, the bytes are not.
    let dataless: Bool
    /// A symlink whose target is gone. Not a note; skipped as FolderIndexer skips it.
    let danglingLink: Bool
}

/// The file-system seam the scanner uses. Disk in the app; a fake in tests.
protocol NoteIndexFileSystem: Sendable {
    /// Every item under `root`. Throws if any part of the walk failed: a partial
    /// listing must never look like a complete one.
    func entries(under root: URL) throws -> [NoteIndexEntry]
    func read(_ url: URL) throws -> Data
}

/// The real file system. The walk records every enumerator error (an unreadable
/// subdirectory, a TCC denial, an unmounted volume) instead of skipping it.
struct DiskNoteIndexFileSystem: NoteIndexFileSystem {
    /// Collects the first walk error from the enumerator's error handler.
    private final class WalkErrors {
        var first: String?
    }

    func entries(under root: URL) throws -> [NoteIndexEntry] {
        let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey, .isDirectoryKey,
                                      .isSymbolicLinkKey, .ubiquitousItemDownloadingStatusKey]
        let errors = WalkErrors()
        guard let enumerator = FileManager.default.enumerator(
            at: root, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles],
            errorHandler: { url, error in
                if errors.first == nil {
                    errors.first = "cannot read \(url.lastPathComponent): \(error.localizedDescription)"
                }
                return true
            }) else {
            throw NoteIndexScanner.Failure(reason: "cannot enumerate the notes folder")
        }
        var out: [NoteIndexEntry] = []
        for case let url as URL in enumerator {
            let values = try? url.resourceValues(forKeys: Set(keys))
            let dataless = values?.ubiquitousItemDownloadingStatus == .notDownloaded
            out.append(NoteIndexEntry(
                url: url,
                isDirectory: values?.isDirectory == true,
                mtimeMs: values?.contentModificationDate.map { Int64($0.timeIntervalSince1970 * 1000) },
                size: values?.fileSize.map { Int64($0) },
                dataless: dataless,
                // fileExists follows the link: a symlink whose target is gone is not a note.
                danglingLink: values?.isSymbolicLink == true && !FileManager.default.fileExists(atPath: url.path)))
        }
        if let reason = errors.first {
            throw NoteIndexScanner.Failure(reason: reason)
        }
        return out
    }

    func read(_ url: URL) throws -> Data {
        try Data(contentsOf: url)
    }
}

enum NoteIndexScanner {
    struct Failure: Error, Equatable {
        let reason: String
    }

    /// Walks `root` and returns the manifest material. Throws on ANY read or
    /// enumeration error, so callers prune only after a complete scan.
    static func scan(root: URL, hiddenKeys: Set<String>, previous: [String: NoteIndexCacheEntry],
                     fileSystem: NoteIndexFileSystem = DiskNoteIndexFileSystem()) throws -> NoteIndexScan {
        var out = NoteIndexScan()
        for item in try fileSystem.entries(under: root) {
            if item.isDirectory || item.danglingLink { continue }
            let url = item.url
            let name = url.lastPathComponent
            guard name.hasSuffix(".md"), !name.hasSuffix(".partial.md") else { continue }
            let key = FolderIndexer.relativePath(of: url, under: root)
            if item.dataless {
                // Never materialize a placeholder. Its key cannot be proven absent, so it blocks pruning.
                out.unavailable.append(key)
                if hiddenKeys.contains(key) {
                    out.hidden.append(NoteIndexFile(key: key, url: url,
                                                    contentHash: previous[key]?.contentHash ?? "unavailable",
                                                    mtimeMs: item.mtimeMs ?? 0))
                }
                continue
            }
            guard let mtimeMs = item.mtimeMs, let size = item.size else {
                throw NoteIndexScanner.Failure(reason: "no modification date or size for \(name)")
            }
            let entry: NoteIndexCacheEntry
            if let hit = previous[key], hit.mtimeMs == mtimeMs, hit.size == size {
                entry = hit
            } else {
                let data: Data
                do { data = try fileSystem.read(url) } catch {
                    throw NoteIndexScanner.Failure(reason: "cannot read \(name): \(error.localizedDescription)")
                }
                entry = NoteIndexCacheEntry(mtimeMs: mtimeMs, size: size,
                                            contentHash: sha256Hex(data),
                                            kind: kind(of: data, key: key, mtimeMs: mtimeMs))
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
            case .unsendable: out.unsendable.append(key)
            case .notNote: break
            }
        }
        out.notes.sort { $0.key < $1.key }
        out.hidden.sort { $0.key < $1.key }
        out.unparseable.sort()
        out.unavailable.sort()
        out.unsendable.sort()
        return out
    }

    /// The kind of a file, decided from its bytes the way FolderIndexer decides what to index.
    /// A note whose upsert would not fit one request is `unsendable` (never silently dropped later).
    static func kind(of data: Data, key: String, mtimeMs: Int64) -> NoteIndexKind {
        let kind = classify(data)
        guard kind == .note else { return kind }
        guard let input = makeInput(data: data, key: key, mtimeMs: mtimeMs),
              NoteIndexBatching.encodedSize(input) <= NoteIndexLimits.batchBytes else { return .unsendable }
        return .note
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
    static func upsertInput(for file: NoteIndexFile,
                            fileSystem: NoteIndexFileSystem = DiskNoteIndexFileSystem()) throws -> LlmIdeAPIClient.IndexNoteInput? {
        let data = try fileSystem.read(file.url)
        return makeInput(data: data, key: file.key, mtimeMs: file.mtimeMs)
    }

    /// The upsert body built from bytes already in hand.
    static func makeInput(data: Data, key: String, mtimeMs: Int64) -> LlmIdeAPIClient.IndexNoteInput? {
        guard data.count <= NoteIndexLimits.bodyBytes,
              let text = String(data: data, encoding: .utf8),
              let split = FrontmatterCoder.split(file: text),
              let fm = try? FrontmatterCoder.decode(split.yaml) else { return nil }
        let body = String(text[split.bodyStart...])
        return LlmIdeAPIClient.IndexNoteInput(
            noteKey: key,
            kind: "meeting",
            title: clip(fm.title, NoteIndexLimits.titleChars),
            date: clip(AppDateFormatter.isoString(fm.startedAt), NoteIndexLimits.dateChars),
            durationSec: max(0, fm.durationSeconds ?? 0),
            participants: fm.participants.prefix(NoteIndexLimits.participantCount)
                .map { clip($0, NoteIndexLimits.participantChars) },
            body: body,
            contentHash: sha256Hex(data),
            mtimeMs: mtimeMs,
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

    /// The batches, and how many inputs could not be sent at all (larger than one request).
    static func batches(_ inputs: [LlmIdeAPIClient.IndexNoteInput]) -> (batches: [[LlmIdeAPIClient.IndexNoteInput]], dropped: Int) {
        var out: [[LlmIdeAPIClient.IndexNoteInput]] = []
        var current: [LlmIdeAPIClient.IndexNoteInput] = []
        var bytes = 0
        var dropped = 0
        for n in inputs {
            let size = encodedSize(n)
            guard size <= NoteIndexLimits.batchBytes else { dropped += 1; continue }
            if !current.isEmpty, current.count >= NoteIndexLimits.batchNotes || bytes + size > NoteIndexLimits.batchBytes {
                out.append(current)
                current = []
                bytes = 0
            }
            current.append(n)
            bytes += size
        }
        if !current.isEmpty { out.append(current) }
        return (out, dropped)
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
        /// Placeholders not read this pass. Their keys block pruning.
        var unavailable = 0
        /// Notes too large to upsert in one request. Their keys block pruning.
        var unsendable = 0
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
        /// The signed-in user is no longer the one this feed was started for. Nothing was sent
        /// after the change, and the reconciler has stopped.
        case identityChanged
    }

    /// Thrown before a request when the signed-in user has changed (never sent under another account).
    struct IdentityChanged: Error {}

    static let debounce: Duration = .seconds(5)
    static let interval: Duration = .seconds(15 * 60)
    private static let log = Logger(subsystem: "com.llmide.macapp", category: "NoteIndexReconciler")

    private let root: URL
    private let index: MeetingIndex
    private let projectId: String
    private let remote: NoteIndexRemote
    private let fileSystem: NoteIndexFileSystem
    /// The account this feed was started for, and how to read the account now. Every request
    /// is preceded by a check, so a sign-out or a switch to another user stops the feed.
    private let boundUserId: String?
    private let currentUserId: (@MainActor () -> String?)?
    private var cache: [String: NoteIndexCacheEntry] = [:]
    /// Hidden notes already removed on the server: key -> the hash sent. Re-sent only when
    /// the hidden set changes, or when the server reports one of them back (see runOnce).
    private var sentHidden: [String: String] = [:]
    private var running = false
    private(set) var consecutiveFailures = 0

    private var loopTask: Task<Void, Never>?
    private var periodicTask: Task<Void, Never>?
    private var debounceTask: Task<Void, Never>?
    private var wake: AsyncStream<Void>.Continuation?

    init(root: URL, index: MeetingIndex, projectId: String, remote: NoteIndexRemote,
         fileSystem: NoteIndexFileSystem = DiskNoteIndexFileSystem(),
         boundUserId: String? = nil, currentUserId: (@MainActor () -> String?)? = nil) {
        self.root = root
        self.index = index
        self.projectId = projectId
        self.remote = remote
        self.fileSystem = fileSystem
        self.boundUserId = boundUserId
        self.currentUserId = currentUserId
    }

    /// Throws if the signed-in user is not the bound one (or nobody is signed in).
    private func verifyIdentity() throws {
        guard let bound = boundUserId, let current = currentUserId else { return }
        guard current() == bound else { throw IdentityChanged() }
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
        do { try verifyIdentity() } catch {
            Self.log.notice("note index: signed-in user changed; feed stopped")
            stop()
            return .identityChanged
        }

        let root = self.root, index = self.index, previous = self.cache, fileSystem = self.fileSystem
        let scan: NoteIndexScan
        do {
            scan = try await Task.detached(priority: .utility) { () throws -> NoteIndexScan in
                let hidden = Set(try index.listAll().filter(\.hidden).map(\.path))
                return try NoteIndexScanner.scan(root: root, hiddenKeys: hidden, previous: previous,
                                                 fileSystem: fileSystem)
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
        stats.skippedUnindexable = scan.oversize.count + scan.unsendable.count
        stats.unavailable = scan.unavailable.count
        stats.unsendable = scan.unsendable.count
        do {
            // 1. Hidden notes leave the index first, so a later failure cannot keep them.
            let hiddenNow = Dictionary(uniqueKeysWithValues: scan.hidden.map { ($0.key, $0.contentHash) })
            sentHidden = sentHidden.filter { hiddenNow[$0.key] == $0.value }      // unhidden notes are forgotten
            let needHidden = scan.hidden.filter { sentHidden[$0.key] != $0.contentHash }
            stats.hiddenSent = needHidden.count
            try await sendHidden(needHidden, into: &stats)

            // 2. Manifest and reconcile. Prune only after a complete scan with a
            // non-empty manifest and no unindexable file (an unparseable note may
            // still be a note the server must keep).
            let manifest = scan.notes.map { LlmIdeAPIClient.IndexManifestEntry(noteKey: $0.key, contentHash: $0.contentHash) }
            stats.manifestEntries = manifest.count
            // Any file the index cannot prove absent blocks pruning: unparseable notes, placeholders
            // whose bytes are not here, and notes too large to upload.
            let prune = scan.unparseable.isEmpty && scan.unavailable.isEmpty
                && scan.unsendable.isEmpty && !manifest.isEmpty
            stats.pruneAllowed = prune
            guard NoteIndexBatching.manifestFits(manifest) else {
                Self.log.notice("note index manifest too large for one reconcile; skipped")
                return .manifestTooLarge(stats)
            }
            try Task.checkCancellation()
            try verifyIdentity()
            let result = try await remote.indexReconcile(projectId: projectId, manifest: manifest, prune: prune)
            stats.pruned = result.pruned
            // A hidden note the server still holds (it reappeared) is removed again.
            let reappeared = scan.hidden.filter { sentHidden[$0.key] != nil && result.extra.contains($0.key) }
            if !reappeared.isEmpty { try await sendHidden(reappeared, into: &stats) }
            stats.missing = result.missing.count
            stats.stale = result.stale.count

            // 3. Upsert what the server lacks or holds with another hash.
            let wanted = Set(result.missing).union(result.stale)
            let files = scan.notes.filter { wanted.contains($0.key) }
            let inputs: [LlmIdeAPIClient.IndexNoteInput] = try await Task.detached(priority: .utility) {
                files.compactMap { try? NoteIndexScanner.upsertInput(for: $0, fileSystem: fileSystem) }
            }.value
            stats.skippedUnindexable += files.count - inputs.count
            let uploads = NoteIndexBatching.batches(inputs)
            stats.skippedUnindexable += uploads.dropped
            for batch in uploads.batches {
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
        } catch is IdentityChanged {
            Self.log.notice("note index: signed-in user changed mid-pass; feed stopped")
            stop()
            return .identityChanged
        } catch {
            consecutiveFailures += 1
            Self.log.notice("note index pass failed (\(self.consecutiveFailures)): \(error.localizedDescription, privacy: .public)")
            return .failed(error.localizedDescription)
        }
    }

    /// Removes hidden notes on the server and remembers what was sent.
    private func sendHidden(_ files: [NoteIndexFile], into stats: inout Stats) async throws {
        let inputs = files.map(NoteIndexScanner.hiddenInput)
        for batch in NoteIndexBatching.batches(inputs).batches {
            try Task.checkCancellation()
            if let r = try await send(batch) {
                stats.removedHidden += r.removed
                for n in batch { sentHidden[n.noteKey] = n.contentHash }
            } else {
                stats.rejectedBatches += 1
            }
        }
    }

    /// Sends one batch. A 4xx that is not an auth or rate-limit answer means the
    /// server refused this content, so retrying it would fail the same way: the
    /// batch is counted as rejected and the pass goes on. Anything else is transient.
    private func send(_ batch: [LlmIdeAPIClient.IndexNoteInput]) async throws -> LlmIdeAPIClient.IndexUpsertResult? {
        try verifyIdentity()
        do {
            return try await remote.indexUpsertNotes(projectId: projectId, notes: batch)
        } catch APIError.http(let status, _, _, _) where (400..<500).contains(status)
                    && ![401, 403, 408, 429].contains(status) {
            Self.log.notice("note index batch of \(batch.count) refused (HTTP \(status)); skipped")
            return nil
        }
    }
}

/// The one reconciler the app runs. Shell starts it when a project environment opens
/// and `lta.mode` is not off. It stops on project close, on quit, and on sign-out
/// (SessionScoped), and it never sends under a user other than the one it started for.
@MainActor
final class NoteIndexHost: SessionScoped {
    static let shared = NoteIndexHost()

    /// The signed-in user id, read live. The composition root sets it once.
    var sessionUserId: @MainActor () -> String? = { nil }

    private var current: NoteIndexReconciler?
    private var sessionRegistered = false
    private var quitRegistered = false

    init() {}

    /// Whether a feed is running (for tests and diagnostics).
    var isRunning: Bool { current != nil }

    /// Starts (or replaces) the feed for `projectId`, bound to the user signed in now.
    /// Signed out: nothing starts.
    func start(root: URL, index: MeetingIndex, projectId: String, remote: NoteIndexRemote) {
        stop()
        guard let user = sessionUserId() else { return }
        let reconciler = NoteIndexReconciler(
            root: root, index: index, projectId: projectId, remote: remote,
            boundUserId: user, currentUserId: sessionUserId)
        current = reconciler
        reconciler.start()
        if !sessionRegistered {
            sessionRegistered = true
            SessionScopedRegistry.shared.register(self)
        }
        if !quitRegistered, self === NoteIndexHost.shared {
            quitRegistered = true
            AppTerminationHooks.register("note-index") { NoteIndexHost.shared.stop() }
        }
    }

    /// A notes folder changed (finalize, rename, hide): ask for a debounced pass.
    func folderChanged() {
        current?.requestRun()
    }

    /// Stops the feed: project close, quit, sign-out.
    func stop() {
        current?.stop()
        current = nil
    }

    /// SessionScoped: a definitive sign-out or account switch.
    func resetForSignOut() {
        stop()
    }
}
