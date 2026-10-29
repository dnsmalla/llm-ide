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
                            prune: Bool) async throws -> LlmIdeAPIClient.IndexReconcileResult {
            calls += 1
            if let failure { throw failure }
            reconcileCalls.append((manifest.count, prune))
            let named = Set(manifest.map(\.noteKey))
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
        let r = NoteIndexReconciler(root: root, index: h.index, projectId: "p1", remote: h.server, fileSystem: fake)
        let outcome = await r.runOnce()
        guard case .ok(let stats) = outcome else { Issue.record("expected ok, got \(outcome)"); return }
        #expect(stats.unavailable == 1)
        #expect(!stats.pruneAllowed)
        #expect(fake.reads.allSatisfy { $0.lastPathComponent != "cloud.md" })
        #expect(await h.server.rows["good.md"] != nil)
        #expect(await h.server.rows["gone.md"] == "held")
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
        let outcome = await h.reconciler().runOnce()
        guard case .ok(let stats) = outcome else { Issue.record("expected ok, got \(outcome)"); return }
        #expect(stats.unsendable == 1)
        #expect(!stats.pruneAllowed)
        #expect(await h.server.rows["escaped.md"] == nil)
        #expect(await h.server.rows["ok.md"] != nil)
        #expect(await h.server.rows["gone.md"] == "held")
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

    @Test func platformLessNoteBlocksPruneButOthersStillSync() async throws {
        let h = try Harness()
        try h.write("good.md", Self.note(id: "g", title: "Good"))
        try h.write("no-platform.md", Self.note(id: "p", title: "Legacy", platform: nil))
        await h.server.seed("gone.md", "held")
        let outcome = await h.reconciler().runOnce()
        guard case .ok(let stats) = outcome else { Issue.record("expected ok, got \(outcome)"); return }
        #expect(!stats.pruneAllowed)
        #expect(stats.pruned == 0)
        #expect(await h.server.rows["good.md"] != nil)
        #expect(await h.server.rows["no-platform.md"] == nil)
        #expect(await h.server.rows["gone.md"] == "held")
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

    /// Writes extension/tests/fixtures/lta/note-index-feed.json: the upsert payload the
    /// reconciler builds from a small Mac notes folder (Swift-fed, plan T2.3). Regenerate with
    /// `LLMIDE_REGEN_LTA_FIXTURES=1 swift test --filter NoteIndexReconciler`.
    @Test func regenerateNoteIndexFeedWhenAsked() throws {
        guard ProcessInfo.processInfo.environment["LLMIDE_REGEN_LTA_FIXTURES"] == "1" else { return }
        let h = try Harness()
        let fixedMtime = Date(timeIntervalSince1970: 1_785_578_400)     // 2026-08-01T10:00:00Z
        let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let repo = here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
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
        #expect(notes.count == synthetic.count + 1)
        let payload = LlmIdeAPIClient.IndexUpsertRequest(projectId: "lta-proof", notes: notes)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let out = repo.appendingPathComponent("extension/tests/fixtures/lta/note-index-feed.json")
        try encoder.encode(payload).write(to: out)
    }

    // MARK: - Helpers

    static func row(id: String, path: String) -> MeetingIndex.Row {
        MeetingIndex.Row(id: id, path: path, title: id, startedAt: 0, endedAt: nil, durationSec: 0,
                         gist: nil, tldrJSON: nil, actionsCount: 0, decisionsCount: 0, blockersCount: 0,
                         fileMtime: 0, fileSize: 0, indexedAt: 0, platform: "meet")
    }
}
