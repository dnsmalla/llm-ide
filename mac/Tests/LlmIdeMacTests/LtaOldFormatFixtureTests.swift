import Foundation
import Testing
@testable import LlmIdeMacLib

/// Phase 0 (T0.4) of docs/superpowers/plans/2026-10-29-live-then-archive.md.
///
/// Old-format fixtures for the migration tests of later phases. The committed
/// files under `Fixtures/lta/` were WRITTEN BY THE REAL ENCODERS
/// (`AppJSON.encoder` for sessions, `FrontmatterCoder` for meeting notes) from
/// synthetic values; regenerate with
/// `LLMIDE_REGEN_LTA_FIXTURES=1 swift test --filter LtaOldFormatFixtureTests`.
/// The tests then decode them with the real decoders and pin the behaviours the
/// plan relies on (optional keys, dropped unknown keys, the required `platform`).
@Suite("LTA old-format fixtures (Phase 0)")
struct LtaOldFormatFixtureTests {

    private static var fixtureDir: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("Fixtures/lta", isDirectory: true)
    }
    private func fixture(_ name: String) -> URL { Self.fixtureDir.appendingPathComponent(name) }

    // Synthetic values (fixed so the committed files are reproducible).
    private static let started = Date(timeIntervalSinceReferenceDate: 807_271_200)   // 2026-08-01T10:00:00Z
    private static let sessionFullID = UUID(uuidString: "aaaaaaaa-0000-4000-8000-000000000001")!
    private static let sessionBareID = UUID(uuidString: "aaaaaaaa-0000-4000-8000-000000000002")!

    private static func message(_ role: ChatMessage.Role, _ text: String) -> ChatMessage {
        ChatMessage.migrate(role: role == .user ? .user : .assistant, content: text, sessionDate: started)
    }

    @Test func regenerateFixturesWhenAsked() throws {
        guard ProcessInfo.processInfo.environment["LLMIDE_REGEN_LTA_FIXTURES"] == "1" else { return }
        try FileManager.default.createDirectory(at: Self.fixtureDir, withIntermediateDirectories: true)
        let msgs = [Self.message(.user, "why is search slow?"), Self.message(.assistant, "the index scans the whole table")]
        // with engine + projectId (a current chat)
        let full = ChatSession(id: Self.sessionFullID, scope: .quick, title: "Search latency",
                               createdAt: Self.started, lastUsedAt: Self.started.addingTimeInterval(60),
                               messages: msgs, engine: "agentV2", projectId: "proj-a")
        // without engine / projectId (a chat written before either existed)
        let bare = ChatSession(id: Self.sessionBareID, scope: .explorer, title: "Old chat",
                               createdAt: Self.started, lastUsedAt: Self.started.addingTimeInterval(60),
                               messages: msgs)
        try AppJSON.encoder.encode(full).write(to: fixture("session-v2-engine-project.json"))
        try AppJSON.encoder.encode(bare).write(to: fixture("session-v2-no-engine-no-project.json"))

        // Meeting notes through the real store + coder.
        let withPlatform = MeetingFrontmatter(id: "m-fixture-1", title: "Budget review", startedAt: Self.started,
                                              endedAt: Self.started.addingTimeInterval(1800), durationSeconds: 1800,
                                              participants: ["Alice", "Bob"], platform: "chrome-extension", language: "en")
        let yaml = try FrontmatterCoder.encode(withPlatform)
        let body = "\n## Transcript\n\n[10:00:01] **Alice**: we should raise the budget\n"
        try "---\n\(yaml)---\n\(body)".write(to: fixture("meeting-with-platform.md"), atomically: true, encoding: .utf8)
        let stripped = yaml.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.hasPrefix("platform:") }.joined(separator: "\n")
        try "---\n\(stripped)---\n\(body)".write(to: fixture("meeting-without-platform.md"), atomically: true, encoding: .utf8)
    }

    // MARK: sessions

    @Test func sessionWithEngineAndProjectDecodes() throws {
        let s = try AppJSON.decoder.decode(ChatSession.self, from: Data(contentsOf: fixture("session-v2-engine-project.json")))
        #expect(s.id == Self.sessionFullID)
        #expect(s.scope == .quick)
        #expect(s.engine == "agentV2")
        #expect(s.projectId == "proj-a")
        #expect(s.messages.count == 2)
        #expect(s.storeVersion == 2)
    }

    @Test func sessionWithoutEngineAndProjectDecodesAsLegacyAndUnassigned() throws {
        let s = try AppJSON.decoder.decode(ChatSession.self, from: Data(contentsOf: fixture("session-v2-no-engine-no-project.json")))
        #expect(s.engine == nil)
        #expect(s.projectId == nil)
        #expect(s.scope == .explorer)
        #expect(s.messages.count == 2)
    }

    /// N-1 risk recorded in the plan (3.10): keys a newer build adds (here
    /// `meetingId`, `ownerUserId`) are ignored on decode and DROPPED when this
    /// build re-saves the file, so an old Mac that saves a session strips them.
    @Test func unknownKeysAreDroppedOnResave() throws {
        let raw = try String(contentsOf: fixture("session-v2-engine-project.json"), encoding: .utf8)
        let withExtra = raw.replacingOccurrences(of: "{", with: "{\"meetingId\":\"m-1\",\"ownerUserId\":\"u-1\",", options: [], range: raw.range(of: "{"))
        let decoded = try AppJSON.decoder.decode(ChatSession.self, from: Data(withExtra.utf8))
        let reencoded = try String(data: AppJSON.encoder.encode(decoded), encoding: .utf8) ?? ""
        #expect(!reencoded.contains("meetingId"))
        #expect(!reencoded.contains("ownerUserId"))
    }

    // MARK: meeting notes

    @Test func meetingWithPlatformDecodes() throws {
        let text = try String(contentsOf: fixture("meeting-with-platform.md"), encoding: .utf8)
        let split = try #require(FrontmatterCoder.split(file: text))
        let fm = try FrontmatterCoder.decode(split.yaml)
        #expect(fm.id == "m-fixture-1")
        #expect(fm.platform == "chrome-extension")
        #expect(fm.durationSeconds == 1800)
    }

    /// Finding: `platform` is a REQUIRED frontmatter key. A note without it does
    /// not decode, so `FolderIndexer.upsert` (swallowed by `try?`) never indexes it.
    @Test func meetingWithoutPlatformFailsToDecode() throws {
        let text = try String(contentsOf: fixture("meeting-without-platform.md"), encoding: .utf8)
        let split = try #require(FrontmatterCoder.split(file: text))
        #expect(throws: (any Error).self) { try FrontmatterCoder.decode(split.yaml) }
    }

    @Test func folderScanIndexesOnlyTheNoteWithPlatform() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lta-scan-\(UUID().uuidString)", isDirectory: true)
        let dir = root.appendingPathComponent("meetings/2026/08", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.copyItem(at: fixture("meeting-with-platform.md"), to: dir.appendingPathComponent("a.md"))
        try FileManager.default.copyItem(at: fixture("meeting-without-platform.md"), to: dir.appendingPathComponent("b.md"))
        let index = try MeetingIndex(url: root.appendingPathComponent("system/index.sqlite"))
        try FolderIndexer(root: root, index: index).fullScan()
        #expect(try index.count() == 1)
        #expect(try index.list().first?.platform == "chrome-extension")
    }

    /// Optional throwaway timing (plan T0.3): LTA_BENCH_NOTES=5000 swift test --filter scanTiming
    @Test func scanTiming() throws {
        guard let n = ProcessInfo.processInfo.environment["LTA_BENCH_NOTES"].flatMap(Int.init) else { return }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lta-bench-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let yaml = try FrontmatterCoder.encode(MeetingFrontmatter(id: "x", title: "t", startedAt: Self.started, participants: ["a"], platform: "meet", language: "en"))
        let filler = String(repeating: "alpha budget review rollback 予算 ", count: 600) // ~20 KB
        for i in 0..<n {
            let dir = root.appendingPathComponent("meetings/2026/\(String(format: "%02d", i % 12 + 1))", isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let y = yaml.replacingOccurrences(of: "id: x", with: "id: bench-\(i)")
            try "---\n\(y)---\n\n## Transcript\n\n\(filler)\n".write(to: dir.appendingPathComponent("n-\(i).md"), atomically: true, encoding: .utf8)
        }
        let index = try MeetingIndex(url: root.appendingPathComponent("system/index.sqlite"))
        let indexer = FolderIndexer(root: root, index: index)
        let t0 = Date(); try indexer.fullScan(); let cold = Date().timeIntervalSince(t0)
        let t1 = Date(); try indexer.fullScan(); let warm = Date().timeIntervalSince(t1)
        print("LTA_BENCH notes=\(n) coldScanSec=\(cold) unchangedRescanSec=\(warm) indexed=\(try index.count())")
    }
}
