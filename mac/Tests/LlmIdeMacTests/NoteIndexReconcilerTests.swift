import Foundation
import Testing
@testable import LlmIdeMacLib

/// Phase 2 (T2.1) of docs/superpowers/plans/2026-10-29-live-then-archive.md.
///
/// The reconciler runs against `FakeNoteServer`, an in-process actor that applies
/// the server's rules (upsert, hidden removal, reconcile with optional prune), so
/// the assertions are about end state, not about call order.
@Suite("NoteIndexReconciler (lta Phase 2)")
@MainActor
struct NoteIndexReconcilerTests {

    /// Mirrors kb/note-index.mjs closely enough for the reconciler's contract.
    actor FakeNoteServer: NoteIndexRemote {
        private(set) var rows: [String: String] = [:]          // noteKey -> contentHash
        private(set) var upsertBatchSizes: [Int] = []
        private(set) var reconcileCalls: [(manifestCount: Int, prune: Bool)] = []
        private(set) var calls = 0
        private var failure: Error?
        private var upsertHook: (@Sendable () async -> Void)?

        func seed(_ key: String, _ hash: String) { rows[key] = hash }
        private(set) var scanCalls = 0
        private var scanDropIndex: Int?
        private var scanUnsupported = false
        private var scans: [String: (total: Int, received: Set<Int>, seen: Set<String>, seenCount: Int)] = [:]
        /// Acknowledges chunk `i` but never records it (a lost chunk).
        func dropScanChunk(_ i: Int?) { scanDropIndex = i }
        /// Answers 404 for the chunk route (an older server).
        func setScanUnsupported(_ on: Bool) { scanUnsupported = on }

        func indexScan(projectId: String, scanId: String, index: Int, total: Int, complete: Bool,
                       prune: Bool, entries: [LlmIdeAPIClient.IndexManifestEntry],
                       totalEntries: Int?, keep: [String]?, allowEmpty: Bool?) async throws -> LlmIdeAPIClient.IndexScanResult {
            calls += 1
            scanCalls += 1
            if scanUnsupported { throw APIError.http(status: 404, code: "NOT_FOUND", message: "", details: nil) }
            if let failure { throw failure }
            var st = scans[scanId] ?? (total: total, received: [], seen: [], seenCount: 0)
            st.seenCount += entries.count
            let keptKeys = Set(keep ?? [])
            var missing: [String] = [], stale: [String] = []
            for e in entries {
                st.seen.insert(e.noteKey)
                if let held = rows[e.noteKey] {
                    if held != e.contentHash { stale.append(e.noteKey) }
                } else {
                    missing.append(e.noteKey)
                }
            }
            if index != scanDropIndex { st.received.insert(index) }
            if !complete {
                scans[scanId] = st
                return .init(missing: missing, stale: stale, extra: [], pruned: 0,
                             received: st.received.count, total: total, complete: false)
            }
            scans[scanId] = nil
            guard st.received.count == total else {
                throw APIError.http(status: 409, code: "SCAN_INCOMPLETE", message: "", details: nil)
            }
            let declared = totalEntries ?? -1
            guard declared == st.seenCount else {
                throw APIError.http(status: 409, code: "SCAN_TOTAL_MISMATCH", message: "", details: nil)
            }
            if prune && st.seenCount == 0 && allowEmpty != true {
                throw APIError.http(status: 409, code: "EMPTY_SCAN_REFUSED", message: "", details: nil)
            }
            let extra = rows.keys.filter { !st.seen.contains($0) && !keptKeys.contains($0) }.sorted()
            var pruned = 0
            if prune {
                for k in extra { rows.removeValue(forKey: k); pruned += 1 }
            }
            return .init(missing: missing, stale: stale, extra: extra, pruned: pruned,
                         received: total, total: total, complete: true)
        }
        func setFailure(_ error: Error?) { failure = error }
        func setUpsertHook(_ hook: (@Sendable () async -> Void)?) { upsertHook = hook }

        func indexUpsertNotes(projectId: String,
                              notes: [LlmIdeAPIClient.IndexNoteInput]) async throws -> LlmIdeAPIClient.IndexUpsertResult {
            calls += 1
            if let failure { throw failure }
            if let upsertHook { await upsertHook() }
            upsertBatchSizes.append(notes.count)
            var upserted = 0, unchanged = 0, skipped = 0, removed = 0
            for n in notes {
                if n.hidden == true {
                    skipped += 1
                    if rows.removeValue(forKey: n.noteKey) != nil { removed += 1 }
                } else if rows[n.noteKey] == n.contentHash {
                    unchanged += 1
                } else {
                    rows[n.noteKey] = n.contentHash
                    upserted += 1
                }
            }
            return .init(upserted: upserted, unchanged: unchanged, skippedHidden: skipped,
                         truncated: 0, removed: removed)
        }

        func indexReconcile(projectId: String,
                            manifest: [LlmIdeAPIClient.IndexManifestEntry],
                            keep: [String],
                            prune: Bool,
                            allowEmpty: Bool) async throws -> LlmIdeAPIClient.IndexReconcileResult {
            calls += 1
            if let failure { throw failure }
            reconcileCalls.append((manifest.count, prune))
            if prune && manifest.isEmpty && !allowEmpty {
                throw APIError.http(status: 409, code: "EMPTY_MANIFEST_REFUSED", message: "", details: nil)
            }
            let named = Set(manifest.map(\.noteKey)).union(keep)
            var missing: [String] = [], stale: [String] = []
            for m in manifest {
                if let held = rows[m.noteKey] {
                    if held != m.contentHash { stale.append(m.noteKey) }
                } else {
                    missing.append(m.noteKey)
                }
            }
            let extra = rows.keys.filter { !named.contains($0) }.sorted()
            var pruned = 0
            if prune {
                for k in extra { rows.removeValue(forKey: k); pruned += 1 }
            }
            return .init(missing: missing.sorted(), stale: stale.sorted(), extra: extra, pruned: pruned)
        }
    }

    @MainActor
    final class Harness {
        let base: URL
        let root: URL
        let index: MeetingIndex
        let server = FakeNoteServer()
        init() throws {
            base = FileManager.default.temporaryDirectory
                .appendingPathComponent("note-index-\(UUID().uuidString)", isDirectory: true)
            root = base.appendingPathComponent("meetings", isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            index = try MeetingIndex(url: base.appendingPathComponent("index.sqlite"))
        }
        func reconciler() -> NoteIndexReconciler {
            NoteIndexReconciler(root: root, index: index, projectId: "p1", remote: server)
        }
        func write(_ key: String, _ text: String) throws {
            let url = root.appendingPathComponent(key)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try text.write(to: url, atomically: true, encoding: .utf8)
        }
    }

    /// A meeting note as FrontmatterCoder reads it. `platform: nil` omits the key (F13).
    static func note(id: String, title: String, body: String = "We agreed to ship on Friday.",
                     platform: String? = "meet") -> String {
        var yaml = "id: \(id)\ntitle: \(title)\nstarted_at: '2026-10-29T09:00:00Z'\n"
        yaml += "ended_at: '2026-10-29T09:30:00Z'\nduration_seconds: 1800\n"
        yaml += "participants:\n- Ana\n- Ben\n"
        if let platform { yaml += "platform: \(platform)\n" }
        yaml += "language: en\ntldr: []\n"
        return "---\n\(yaml)---\n\n## Transcript\n\n\(body)\n"
    }

    static func hash(of text: String) -> String {
        NoteIndexScanner.sha256Hex(Data(text.utf8))
    }

    // MARK: - Reconcile semantics

    @Test func syncsNewChangedDeletedAndHiddenNotes() async throws {
        let h = try Harness()
        try h.write("a.md", Self.note(id: "a", title: "Alpha"))
        try h.write("b.md", Self.note(id: "b", title: "Beta"))
        try h.write("c.md", Self.note(id: "c", title: "Gamma"))
        let r = h.reconciler()
        guard case .ok = await r.runOnce() else { Issue.record("first pass should be ok"); return }
        #expect(await h.server.rows.keys.sorted() == ["a.md", "b.md", "c.md"])

        // Changed (b), new (d), deleted on disk (c), hidden in the Library (a).
        let bNew = Self.note(id: "b", title: "Beta", body: "Changed body.")
        try h.write("b.md", bNew)
        try h.write("d.md", Self.note(id: "d", title: "Delta"))
        try FileManager.default.removeItem(at: h.root.appendingPathComponent("c.md"))
        try h.index.upsert(Self.row(id: "a", path: "a.md"))
        try h.index.hide(id: "a")

        let outcome = await r.runOnce()
        guard case .ok(let stats) = outcome else { Issue.record("expected ok, got \(outcome)"); return }
        #expect(stats.pruneAllowed)
        #expect(stats.pruned == 1)
        #expect(stats.removedHidden == 1)
        #expect(await h.server.rows.keys.sorted() == ["b.md", "d.md"])
        #expect(await h.server.rows["b.md"] == Self.hash(of: bNew))
    }

    @Test func emptyManifestNeverPrunes() async throws {
        let h = try Harness()
        await h.server.seed("a.md", "held")
        let r = h.reconciler()
        let outcome = await r.runOnce()
        guard case .ok(let stats) = outcome else { Issue.record("expected ok, got \(outcome)"); return }
        #expect(!stats.pruneAllowed)
        #expect(stats.pruned == 0)
        #expect(await h.server.rows.keys.sorted() == ["a.md"])
        #expect(await h.server.reconcileCalls.allSatisfy { !$0.prune })
    }

    @Test func scanErrorNeverPrunesOrSends() async throws {
        let h = try Harness()
        try h.write("a.md", Self.note(id: "a", title: "Alpha"))
        let file = h.root.appendingPathComponent("a.md")
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: file.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path) }
        await h.server.seed("kept.md", "held")

        let outcome = await h.reconciler().runOnce()
        guard case .scanFailed = outcome else { Issue.record("expected scanFailed, got \(outcome)"); return }
        #expect(await h.server.calls == 0)
        #expect(await h.server.rows.keys.sorted() == ["kept.md"])
    }

    @Test func danglingSymlinkDoesNotStopTheScan() async throws {
        let h = try Harness()
        try h.write("a.md", Self.note(id: "a", title: "Alpha"))
        let link = h.root.appendingPathComponent("broken.md")
        try FileManager.default.createSymbolicLink(
            atPath: link.path, withDestinationPath: h.base.appendingPathComponent("missing.md").path)
        await h.server.seed("gone.md", "held")
        let outcome = await h.reconciler().runOnce()
        guard case .ok(let stats) = outcome else { Issue.record("expected ok, got \(outcome)"); return }
        #expect(stats.pruneAllowed)
        #expect(await h.server.rows["a.md"] != nil)
        #expect(await h.server.rows["gone.md"] == nil)
    }

    /// A file system with metadata only for placeholders, so a test can prove they are never read.
    final class FakeFileSystem: NoteIndexFileSystem, @unchecked Sendable {
        var items: [NoteIndexEntry] = []
        var volume: String? = "vol-A"
        func volumeIdentifier(of root: URL) -> String? { volume }
        var files: [URL: Data] = [:]
        var reads: [URL] = []
        func entries(under root: URL) throws -> [NoteIndexEntry] { items }
        func read(_ url: URL) throws -> Data {
            reads.append(url)
            guard let data = files[url] else { throw CocoaError(.fileNoSuchFile) }
            return data
        }
    }

    @Test func dataAtPlaceholderIsNeverReadAndBlocksPrune() async throws {
        let h = try Harness()
        let root = h.root
        let good = root.appendingPathComponent("good.md")
        let cloud = root.appendingPathComponent("cloud.md")
        let fake = FakeFileSystem()
        let text = Data(Self.note(id: "g", title: "Good").utf8)
        fake.files[good] = text
        fake.items = [
            NoteIndexEntry(url: good, isDirectory: false, mtimeMs: 1, size: Int64(text.count),
                           dataless: false, danglingLink: false),
            NoteIndexEntry(url: cloud, isDirectory: false, mtimeMs: 1, size: 100,
                           dataless: true, danglingLink: false),
        ]
        await h.server.seed("gone.md", "held")
        await h.server.seed("cloud.md", "held")
        let r = NoteIndexReconciler(root: root, index: h.index, projectId: "p1", remote: h.server, fileSystem: fake)
        let outcome = await r.runOnce()
        guard case .ok(let stats) = outcome else { Issue.record("expected ok, got \(outcome)"); return }
        #expect(stats.unavailable == 1)
        #expect(stats.kept == 1)
        #expect(stats.keptByReason["unavailable"] == 1)
        #expect(stats.pruneAllowed)
        #expect(fake.reads.allSatisfy { $0.lastPathComponent != "cloud.md" })
        #expect(await h.server.rows["good.md"] != nil)
        #expect(await h.server.rows["cloud.md"] == "held", "a placeholder's key is kept, never pruned")
        #expect(await h.server.rows["gone.md"] == nil, "a deleted note still prunes")
    }

    @Test func unreadableSubdirectoryFailsTheScanInsteadOfPruning() async throws {
        let h = try Harness()
        try h.write("a.md", Self.note(id: "a", title: "Alpha"))
        try h.write("locked/inner.md", Self.note(id: "in", title: "Inner"))
        let locked = h.root.appendingPathComponent("locked", isDirectory: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: locked.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: locked.path) }
        await h.server.seed("kept.md", "held")
        let outcome = await h.reconciler().runOnce()
        guard case .scanFailed = outcome else { Issue.record("expected scanFailed, got \(outcome)"); return }
        #expect(await h.server.calls == 0)
        #expect(await h.server.rows["kept.md"] == "held")
    }

    @Test func directoryNamedLikeANoteIsSkipped() async throws {
        let h = try Harness()
        try h.write("folder.md/inner.md", Self.note(id: "in", title: "Inner"))
        try FileManager.default.createDirectory(
            at: h.root.appendingPathComponent("empty.md", isDirectory: true), withIntermediateDirectories: true)
        let outcome = await h.reconciler().runOnce()
        guard case .ok(let stats) = outcome else { Issue.record("expected ok, got \(outcome)"); return }
        #expect(stats.manifestEntries == 1)
        #expect(await h.server.rows.keys.sorted() == ["folder.md/inner.md"])
    }

    @Test func hiddenNoteIsSentOnceAndAgainOnlyWhenTheServerReportsItBack() async throws {
        let h = try Harness()
        try h.write("a.md", Self.note(id: "a", title: "Alpha"))
        try h.write("b.md", Self.note(id: "b", title: "Beta"))
        try h.index.upsert(Self.row(id: "a", path: "a.md"))
        try h.index.hide(id: "a")
        let r = h.reconciler()
        guard case .ok(let first) = await r.runOnce() else { Issue.record("pass 1"); return }
        #expect(first.hiddenSent == 1)
        guard case .ok(let second) = await r.runOnce() else { Issue.record("pass 2"); return }
        #expect(second.hiddenSent == 0)
        // The server gets the row back (a restore, or an old client): the next pass removes it again.
        await h.server.seed("a.md", "back")
        guard case .ok = await r.runOnce() else { Issue.record("pass 3"); return }
        #expect(await h.server.rows["a.md"] == nil)
        #expect(await h.server.rows["b.md"] != nil)
    }

    @Test func noteTooLargeOnceEscapedIsUnsendableAndBlocksPrune() async throws {
        let h = try Harness()
        // 400 KiB of control characters: under the raw 512 KiB bound, but each one is
        // six bytes of JSON escape, so the encoded upsert is over one 900 KB request.
        try h.write("escaped.md", Self.note(id: "e", title: "Escaped", body: String(repeating: "\u{1}", count: 400 * 1024)))
        try h.write("ok.md", Self.note(id: "o", title: "Ok"))
        await h.server.seed("gone.md", "held")
        await h.server.seed("escaped.md", "held")
        let outcome = await h.reconciler().runOnce()
        guard case .ok(let stats) = outcome else { Issue.record("expected ok, got \(outcome)"); return }
        #expect(stats.unsendable == 1)
        #expect(stats.pruneAllowed)
        #expect(await h.server.rows["escaped.md"] == "held", "an unsendable note's key is kept")
        #expect(await h.server.rows["ok.md"] != nil)
        #expect(await h.server.rows["gone.md"] == nil)
    }

    /// A mutable signed-in user for the identity tests.
    final class Identity {
        var user: String?
        init(_ user: String?) { self.user = user }
    }

    @Test func closingTheProjectStopsTheFeed() async throws {
        let h = try Harness()
        let identity = Identity("user-a")
        let host = NoteIndexHost()
        host.sessionUserId = { identity.user }
        host.start(root: h.root, index: h.index, projectId: "p1", remote: h.server)
        #expect(host.isRunning)
        host.stop()
        #expect(!host.isRunning)
    }

    @Test func signOutStopsTheFeedThroughTheSessionRegistry() async throws {
        let h = try Harness()
        let identity = Identity("user-a")
        let host = NoteIndexHost()
        host.sessionUserId = { identity.user }
        host.start(root: h.root, index: h.index, projectId: "p1", remote: h.server)
        #expect(host.isRunning)
        SessionScopedRegistry.shared.resetAll()
        #expect(!host.isRunning)
    }

    @Test func aStaleReconcilerSendsNothingForAnotherUser() async throws {
        let h = try Harness()
        try h.write("a.md", Self.note(id: "a", title: "Alpha"))
        let identity = Identity("user-a")
        let r = NoteIndexReconciler(root: h.root, index: h.index, projectId: "p1", remote: h.server,
                                    boundUserId: "user-a", currentUserId: { identity.user })
        identity.user = "user-b"
        #expect(await r.runOnce() == .identityChanged)
        #expect(await h.server.calls == 0)
        identity.user = nil
        #expect(await r.runOnce() == .identityChanged)
        #expect(await h.server.calls == 0)
    }

    @Test func aFeedStartedWhileSignedOutDoesNotStart() async throws {
        let h = try Harness()
        let host = NoteIndexHost()
        host.sessionUserId = { nil }
        host.start(root: h.root, index: h.index, projectId: "p1", remote: h.server)
        #expect(!host.isRunning)
    }

    /// Writes the same note under `count` names, without touching the disk (metadata seam).
    static func bigLibrary(_ count: Int, root: URL) throws -> (files: FakeFileSystem, hash: String) {
        let text = note(id: "big", title: "Library note")
        let data = Data(text.utf8)
        let fake = FakeFileSystem()
        for i in 0..<count {
            let url = root.appendingPathComponent(String(format: "lib/n%05d.md", i))
            fake.files[url] = data
            fake.items.append(NoteIndexEntry(url: url, isDirectory: false, mtimeMs: 1,
                                             size: Int64(data.count), dataless: false, danglingLink: false))
        }
        return (fake, NoteIndexScanner.sha256Hex(data))
    }

    @Test func twentyThousandNoteLibraryIsChunkedAndPrunesOnlyItsRemovedNotes() async throws {
        let h = try Harness()
        let (fake, hash) = try Self.bigLibrary(20_000, root: h.root)
        for i in 0..<20_000 { await h.server.seed(String(format: "lib/n%05d.md", i), hash) }
        // Two notes were removed from disk: they are the rows to prune, nothing else.
        fake.items.removeAll { $0.url.lastPathComponent == "n00007.md" || $0.url.lastPathComponent == "n19999.md" }
        let r = NoteIndexReconciler(root: h.root, index: h.index, projectId: "p1", remote: h.server, fileSystem: fake)
        let outcome = await r.runOnce()
        guard case .ok(let stats) = outcome else { Issue.record("expected ok, got \(outcome)"); return }
        #expect(stats.manifestEntries == 19_998)
        #expect(stats.pruned == 2)
        #expect(stats.missing == 0 && stats.stale == 0)
        #expect(await h.server.scanCalls == 40)
        #expect(await h.server.rows.count == 19_998)
    }

    @Test func aLostChunkPrunesNothing() async throws {
        let h = try Harness()
        let (fake, hash) = try Self.bigLibrary(8_000, root: h.root)
        for i in 0..<8_000 { await h.server.seed(String(format: "lib/n%05d.md", i), hash) }
        fake.items.removeLast()                       // one row is gone on disk ...
        await h.server.dropScanChunk(1)               // ... and a chunk never reaches the server (16 chunks in all)
        let r = NoteIndexReconciler(root: h.root, index: h.index, projectId: "p1", remote: h.server, fileSystem: fake)
        let outcome = await r.runOnce()
        guard case .failed = outcome else { Issue.record("expected failed, got \(outcome)"); return }
        #expect(await h.server.rows.count == 8_000, "a scan with a missing chunk must not prune")
    }

    @Test func anOlderServerWithoutTheChunkRouteNeverPrunes() async throws {
        let h = try Harness()
        let (fake, hash) = try Self.bigLibrary(8_000, root: h.root)
        for i in 0..<8_000 { await h.server.seed(String(format: "lib/n%05d.md", i), hash) }
        fake.items.removeLast()
        await h.server.setScanUnsupported(true)
        let r = NoteIndexReconciler(root: h.root, index: h.index, projectId: "p1", remote: h.server, fileSystem: fake)
        let outcome = await r.runOnce()
        guard case .manifestTooLarge = outcome else { Issue.record("expected manifestTooLarge, got \(outcome)"); return }
        #expect(await h.server.rows.count == 8_000)
    }

    @Test func anEmptiedFolderPrunesOnlyAfterTwoEmptyPassesOnTheSameVolume() async throws {
        let h = try Harness()
        try h.write("a.md", Self.note(id: "a", title: "Alpha"))
        let first = h.reconciler()
        guard case .ok = await first.runOnce() else { Issue.record("seed pass"); return }
        #expect(await h.server.rows["a.md"] != nil)
        try FileManager.default.removeItem(at: h.root.appendingPathComponent("a.md"))

        // interval 0: the first empty pass only starts the confirmation, the second may prune.
        let confirmer = NoteIndexReconciler(root: h.root, index: h.index, projectId: "p1", remote: h.server,
                                            emptyConfirmInterval: 0)
        guard case .ok(let one) = await confirmer.runOnce() else { Issue.record("first empty pass"); return }
        #expect(!one.pruneAllowed)
        #expect(one.emptyPending)
        #expect(await h.server.rows["a.md"] != nil, "one empty pass deletes nothing")

        guard case .ok(let two) = await confirmer.runOnce() else { Issue.record("second empty pass"); return }
        #expect(two.pruneAllowed)
        #expect(two.pruned == 1)
        #expect(await h.server.rows["a.md"] == nil, "two empty passes on the same volume may prune")
    }

    @Test func anEmptyPassWithTheDefaultIntervalWaitsForTheConfirmationWindow() async throws {
        let h = try Harness()
        try h.write("b.md", Self.note(id: "b", title: "Beta"))
        guard case .ok = await h.reconciler().runOnce() else { Issue.record("seed"); return }
        try FileManager.default.removeItem(at: h.root.appendingPathComponent("b.md"))
        let r = h.reconciler()          // default interval: 15 minutes
        for _ in 0..<3 {
            guard case .ok(let s) = await r.runOnce() else { Issue.record("pass"); return }
            #expect(!s.pruneAllowed)
        }
        #expect(await h.server.rows["b.md"] != nil)
    }

    @Test func aVolumeChangeNeverPrunesAnEmptyFolder() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("vol-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let h = try Harness()
        let fake = FakeFileSystem()
        let note = root.appendingPathComponent("n.md")
        let text = Data(Self.note(id: "n", title: "Notes").utf8)
        fake.files[note] = text
        fake.items = [NoteIndexEntry(url: note, isDirectory: false, mtimeMs: 1, size: Int64(text.count), dataless: false, danglingLink: false)]
        fake.volume = "vol-A"
        await h.server.seed("n.md", NoteIndexScanner.sha256Hex(text))
        let r = NoteIndexReconciler(root: root, index: h.index, projectId: "p1", remote: h.server, fileSystem: fake,
                                    emptyConfirmInterval: 0)
        guard case .ok = await r.runOnce() else { Issue.record("non-empty pass"); return }
        // the folder is now empty, but on another volume (an unmounted share, a different disk)
        fake.items = []
        fake.volume = "vol-B"
        for _ in 0..<2 {
            guard case .ok(let s) = await r.runOnce() else { Issue.record("empty pass"); return }
            #expect(!s.pruneAllowed)
        }
        #expect(await h.server.rows["n.md"] != nil)
    }

    @Test func aMissingFolderIsAScanFailureNotAnEmptyFolder() async throws {
        let h = try Harness()
        try h.write("c.md", Self.note(id: "c", title: "Gamma"))
        guard case .ok = await h.reconciler().runOnce() else { Issue.record("seed"); return }
        try FileManager.default.removeItem(at: h.root)
        let outcome = await h.reconciler().runOnce()
        guard case .scanFailed = outcome else { Issue.record("expected scanFailed, got \(outcome)"); return }
        #expect(await h.server.rows["c.md"] != nil)
    }

    @Test func aNoteDeletedThenRestoredIsCountedAsAFlap() async throws {
        let h = try Harness()
        try h.write("a.md", Self.note(id: "a", title: "Alpha"))
        try h.write("b.md", Self.note(id: "b", title: "Beta"))
        let r = h.reconciler()
        guard case .ok = await r.runOnce() else { Issue.record("seed"); return }
        try FileManager.default.removeItem(at: h.root.appendingPathComponent("b.md"))
        guard case .ok(let gone) = await r.runOnce() else { Issue.record("prune pass"); return }
        #expect(gone.pruned == 1)
        #expect(gone.flaps == 0)
        try Self.note(id: "b", title: "Beta").write(to: h.root.appendingPathComponent("b.md"), atomically: true, encoding: .utf8)
        guard case .ok(let back) = await r.runOnce() else { Issue.record("restore pass"); return }
        #expect(back.flaps == 1, "a pruned note the folder names again within the window is a flap")
    }

    @Test func theStatusLineNamesWhatCouldNotBeIndexed() async throws {
        let h = try Harness()
        try h.write("ok.md", Self.note(id: "ok", title: "Fine"))
        try h.write("legacy.md", Self.note(id: "lg", title: "Legacy", platform: nil))
        guard case .ok = await h.reconciler().runOnce() else { Issue.record("pass"); return }
        let summary = NoteIndexStatusCenter.shared.summary
        #expect(summary == "1 note could not be indexed: 1 with unreadable frontmatter")
    }

    @Test func aSymlinkToAFolderIsSkippedNotAScanFailure() async throws {
        let h = try Harness()
        try h.write("a.md", Self.note(id: "a", title: "Alpha"))
        let dir = h.base.appendingPathComponent("elsewhere", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(atPath: h.root.appendingPathComponent("link.md").path,
                                                   withDestinationPath: dir.path)
        let outcome = await h.reconciler().runOnce()
        guard case .ok(let stats) = outcome else { Issue.record("expected ok, got \(outcome)"); return }
        #expect(stats.manifestEntries == 1)
        #expect(await h.server.rows.keys.sorted() == ["a.md"])
    }

    @Test func anICloudPlaceholderNameIsHeldAndNeverRead() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("icl-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let h = try Harness()
        let fake = FakeFileSystem()
        let placeholder = root.appendingPathComponent("sub/.cloud.md.icloud")
        fake.items = [NoteIndexEntry(url: placeholder, isDirectory: false, mtimeMs: 1, size: 120,
                                     dataless: false, danglingLink: false)]
        await h.server.seed("sub/cloud.md", "held")
        let r = NoteIndexReconciler(root: root, index: h.index, projectId: "p1", remote: h.server, fileSystem: fake)
        let outcome = await r.runOnce()
        guard case .ok(let stats) = outcome else { Issue.record("expected ok, got \(outcome)"); return }
        #expect(stats.keptByReason["unavailable"] == 1)
        #expect(fake.reads.isEmpty, "a placeholder is never read")
        #expect(await h.server.rows["sub/cloud.md"] == "held", "its key is held, not pruned")
    }

    @Test func theAllocatedSizeHeuristicTreatsZeroBlocksAsNotMaterialized() {
        #expect(NoteIndexFileSystemHeuristics.isDataless(status: nil, downloading: nil, size: 120, allocated: 0))
        #expect(!NoteIndexFileSystemHeuristics.isDataless(status: nil, downloading: nil, size: 120, allocated: 4096))
        #expect(!NoteIndexFileSystemHeuristics.isDataless(status: nil, downloading: nil, size: 0, allocated: 0))
        #expect(NoteIndexFileSystemHeuristics.isDataless(status: .notDownloaded, downloading: nil, size: 1, allocated: 1))
        #expect(NoteIndexFileSystemHeuristics.isDataless(status: nil, downloading: true, size: nil, allocated: nil))
        #expect(NoteIndexFileSystemHeuristics.iCloudPlaceholderTarget(".note.md.icloud") == "note.md")
        #expect(NoteIndexFileSystemHeuristics.iCloudPlaceholderTarget(".note.txt.icloud") == nil)
        #expect(NoteIndexFileSystemHeuristics.iCloudPlaceholderTarget("note.md") == nil)
    }

    @Test func aSignInRestartsTheFeedForTheSameProjectWithoutAReopen() async throws {
        let h = try Harness()
        let identity = Identity("user-a")
        let host = NoteIndexHost()
        host.sessionUserId = { identity.user }
        host.start(root: h.root, index: h.index, projectId: "p1", remote: h.server)
        #expect(host.isRunning)
        host.resetForSignOut()
        #expect(!host.isRunning)
        // signed out: a sign-in with a new user brings the feed back for the same project
        identity.user = "user-b"
        host.sessionAuthenticationChanged(true)
        #expect(host.isRunning)
        host.stop()
    }

    @Test func platformLessNoteBlocksPruneButOthersStillSync() async throws {
        let h = try Harness()
        try h.write("good.md", Self.note(id: "g", title: "Good"))
        try h.write("no-platform.md", Self.note(id: "p", title: "Legacy", platform: nil))
        await h.server.seed("gone.md", "held")
        await h.server.seed("no-platform.md", "held")
        let outcome = await h.reconciler().runOnce()
        guard case .ok(let stats) = outcome else { Issue.record("expected ok, got \(outcome)"); return }
        #expect(stats.pruneAllowed)
        #expect(stats.pruned == 1)
        #expect(await h.server.rows["good.md"] != nil)
        #expect(await h.server.rows["no-platform.md"] == "held", "a key the Mac cannot index is kept")
        #expect(await h.server.rows["gone.md"] == nil, "other deleted notes still prune")
    }

    @Test func oversizeBodyIsNeverSentOrManifested() async throws {
        let h = try Harness()
        try h.write("big.md", Self.note(id: "big", title: "Big", body: String(repeating: "x", count: 600 * 1024)))
        try h.write("small.md", Self.note(id: "small", title: "Small"))
        let outcome = await h.reconciler().runOnce()
        guard case .ok(let stats) = outcome else { Issue.record("expected ok, got \(outcome)"); return }
        #expect(stats.skippedUnindexable == 1)
        #expect(stats.manifestEntries == 1)
        #expect(await h.server.rows.keys.sorted() == ["small.md"])
    }

    // MARK: - Batching, failure, single flight

    @Test func batchesStayWithinServerLimits() async throws {
        let h = try Harness()
        for i in 0..<120 {
            try h.write("n\(String(format: "%03d", i)).md", Self.note(id: "id\(i)", title: "Note \(i)"))
        }
        let outcome = await h.reconciler().runOnce()
        guard case .ok(let stats) = outcome else { Issue.record("expected ok, got \(outcome)"); return }
        #expect(stats.upserted == 120)
        #expect(await h.server.upsertBatchSizes == [50, 50, 20])
    }

    @Test func serverDownBacksOffAndRecovers() async throws {
        let h = try Harness()
        try h.write("a.md", Self.note(id: "a", title: "Alpha"))
        let r = h.reconciler()
        await h.server.setFailure(URLError(.cannotConnectToHost))
        let first = await r.runOnce()
        guard case .failed = first else { Issue.record("expected failed, got \(first)"); return }
        #expect(r.consecutiveFailures == 1)
        _ = await r.runOnce()
        #expect(r.consecutiveFailures == 2)
        #expect(NoteIndexReconciler.retryDelay(afterFailures: 1) == .seconds(5))
        #expect(NoteIndexReconciler.retryDelay(afterFailures: 2) == .seconds(10))

        await h.server.setFailure(nil)
        guard case .ok = await r.runOnce() else { Issue.record("expected ok after recovery"); return }
        #expect(r.consecutiveFailures == 0)
        #expect(await h.server.rows["a.md"] != nil)
    }

    @Test func singleFlightDropsAnOverlappingPass() async throws {
        let h = try Harness()
        try h.write("a.md", Self.note(id: "a", title: "Alpha"))
        let r = h.reconciler()
        let (entered, enteredContinuation) = AsyncStream<Void>.makeStream()
        let (release, releaseContinuation) = AsyncStream<Void>.makeStream()
        await h.server.setUpsertHook {
            enteredContinuation.yield(())
            for await _ in release { break }
        }
        let first = Task { await r.runOnce() }
        for await _ in entered { break }
        #expect(await r.runOnce() == .busy)
        releaseContinuation.yield(())
        await h.server.setUpsertHook(nil)
        guard case .ok = await first.value else { Issue.record("first pass should finish ok"); return }
    }

    @Test func retryDelayDoublesAndCaps() {
        #expect(NoteIndexReconciler.retryDelay(afterFailures: 3) == .seconds(20))
        #expect(NoteIndexReconciler.retryDelay(afterFailures: 7) == .seconds(300))
        #expect(NoteIndexReconciler.retryDelay(afterFailures: 40) == .seconds(300))
    }

    // MARK: - Mode switch

    @Test func ltaModeDefaultsOffAndIgnoresTypos() {
        let suite = "lta-mode-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        #expect(LiveThenArchiveMode.current(defaults) == .off)
        defaults.set("shadow", forKey: LiveThenArchiveMode.defaultsKey)
        #expect(LiveThenArchiveMode.current(defaults) == .shadow)
        defaults.set("Shadow ", forKey: LiveThenArchiveMode.defaultsKey)
        #expect(LiveThenArchiveMode.current(defaults) == .off)
    }

    /// The feed payload built from a small Mac notes folder through the real scanner and encoder.
    /// Deterministic: fixed mtimes, fixed names, fixed bodies.
    static func buildFeedPayload(root: URL, base: URL) throws -> Data {
        let h = try Harness()
        let fixedMtime = Date(timeIntervalSince1970: 1_785_578_400)     // 2026-08-01T10:00:00Z
        let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let withPlatform = try String(contentsOf: here.appendingPathComponent("Fixtures/lta/meeting-with-platform.md"),
                                      encoding: .utf8)
        try h.write("2026/08/budget-review.md", withPlatform)
        let synthetic: [(String, String, String)] = [
            ("2026/09/standup.md", "Daily standup", "We agreed to ship on Friday."),
            ("2026/09/review-ja.md", "予算レビュー", "来月の予算を確認しました。設計の見積もりは未定です。"),
            ("2026/09/rollback.md", "Rollback plan", "The rollback plan uses a feature flag."),
            ("2026/10/planning.md", "Quarterly planning", "Roadmap for the next quarter, including the index work."),
            ("2026/10/config.md", "Config review", "The key is sk-ant-api03-EXAMPLEKEY1234567890 and must not leak."),
            ("2026/10/long.md", "Long meeting", String(repeating: "Discussion point. ", count: 2000)),
        ]
        for (key, title, body) in synthetic {
            try h.write(key, Self.note(id: key.replacingOccurrences(of: "/", with: "-"), title: title, body: body))
        }
        let files = FileManager.default.enumerator(at: h.root, includingPropertiesForKeys: nil)?.allObjects ?? []
        for case let url as URL in files where url.pathExtension == "md" {
            try FileManager.default.setAttributes([.modificationDate: fixedMtime], ofItemAtPath: url.path)
        }
        let scan = try NoteIndexScanner.scan(root: h.root, hiddenKeys: [], previous: [:])
        let notes = try scan.notes.compactMap { try NoteIndexScanner.upsertInput(for: $0) }
        precondition(notes.count == synthetic.count + 1)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(LlmIdeAPIClient.IndexUpsertRequest(projectId: "lta-proof", notes: notes))
    }

    static var committedFeedURL: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("extension/tests/fixtures/lta/note-index-feed.json")
    }

    /// Regenerates the committed feed when asked (`LLMIDE_REGEN_LTA_FIXTURES=1`).
    @Test func regenerateNoteIndexFeedWhenAsked() throws {
        guard ProcessInfo.processInfo.environment["LLMIDE_REGEN_LTA_FIXTURES"] == "1" else { return }
        let data = try Self.buildFeedPayload(root: URL(fileURLWithPath: NSTemporaryDirectory()),
                                             base: URL(fileURLWithPath: NSTemporaryDirectory()))
        try data.write(to: Self.committedFeedURL)
    }

    /// Staleness guard: the committed feed must be exactly what the real scanner and encoder
    /// produce today. If a change alters the payload, regenerate and review the diff.
    @Test func committedFeedIsWhatTheScannerProduces() throws {
        let built = try Self.buildFeedPayload(root: URL(fileURLWithPath: NSTemporaryDirectory()),
                                              base: URL(fileURLWithPath: NSTemporaryDirectory()))
        let committed = try Data(contentsOf: Self.committedFeedURL)
        #expect(built == committed, "note-index-feed.json is stale: regenerate it with LLMIDE_REGEN_LTA_FIXTURES=1")
    }

    // MARK: - Helpers

    static func row(id: String, path: String) -> MeetingIndex.Row {
        MeetingIndex.Row(id: id, path: path, title: id, startedAt: 0, endedAt: nil, durationSec: 0,
                         gist: nil, tldrJSON: nil, actionsCount: 0, decisionsCount: 0, blockersCount: 0,
                         fileMtime: 0, fileSize: 0, indexedAt: 0, platform: "meet")
    }
}
