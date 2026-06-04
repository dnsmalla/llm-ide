import Testing
@testable import LlmIdeMac
import Foundation

final class MeetingFileStoreTests {

    let tempRoot: URL

    init() throws {
        tempRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("meetfs-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
    }

    deinit {
        try? FileManager.default.removeItem(at: tempRoot)
    }

    @Test func createPartialWritesFrontmatterAndTranscriptHeading() throws {
        let store = MeetingFileStore(root: tempRoot)
        let handle = try store.createPartial(
            id: "01HABC",
            startedAt: Date(timeIntervalSince1970: 1715184000),
            platform: "meet",
            language: "en"
        )
        let contents = try String(contentsOf: handle.url, encoding: .utf8)
        #expect(contents.hasPrefix("---\n"))
        #expect(contents.contains("id: 01HABC"))
        #expect(contents.contains("\n## Transcript\n"))
        #expect(handle.url.lastPathComponent.hasSuffix(".partial.md"))
        try handle.close()
    }

    @Test func appendCaptionAppearsInFile() throws {
        let store = MeetingFileStore(root: tempRoot)
        let handle = try store.createPartial(
            id: "01HABC", startedAt: Date(timeIntervalSince1970: 1715184000),
            platform: "meet", language: "en")
        try handle.appendCaption(timestamp: Date(timeIntervalSince1970: 1715184012),
                                 speaker: "alice", text: "Let's start.")
        try handle.flush()
        let contents = try String(contentsOf: handle.url, encoding: .utf8)
        #expect(contents.contains("**alice**: Let's start."))
        try handle.close()
    }

    @Test func allCaptionsSurviveFinalize() throws {
        // Data-integrity guard: every appended caption must be present, in
        // order, in the finalized file (no loss across the flush + rename).
        let store = MeetingFileStore(root: tempRoot)
        let handle = try store.createPartial(
            id: "01HDUR", startedAt: Date(timeIntervalSince1970: 1715184000),
            platform: "meet", language: "en")
        let n = 200
        for i in 0..<n {
            try handle.appendCaption(
                timestamp: Date(timeIntervalSince1970: 1715184000 + Double(i)),
                speaker: "spk\(i % 3)", text: "line-\(i)")
        }
        #expect(handle.failedSyncCount == 0)   // healthy fs: no swallowed sync errors
        let finalURL = try store.finalize(handle: handle, title: "Standup",
                                          endedAt: Date(timeIntervalSince1970: 1715184300),
                                          participants: ["spk0", "spk1", "spk2"])
        let contents = try String(contentsOf: finalURL, encoding: .utf8)
        for i in 0..<n {
            #expect(contents.contains("line-\(i)"), "missing caption line-\(i)")
        }
        // Order preserved: first appears before last.
        let first = contents.range(of: "line-0")
        let last = contents.range(of: "line-\(n - 1)")
        #expect(first != nil && last != nil && first!.lowerBound < last!.lowerBound)
    }

    @Test func finalizeRenamesAndUpdatesFrontmatter() throws {
        let store = MeetingFileStore(root: tempRoot)
        let handle = try store.createPartial(
            id: "01HABC", startedAt: Date(timeIntervalSince1970: 1715184000),
            platform: "meet", language: "en")
        try handle.appendCaption(timestamp: Date(timeIntervalSince1970: 1715184012),
                                 speaker: "alice", text: "Hi.")
        let finalURL = try store.finalize(
            handle: handle,
            title: "Q1 Planning",
            endedAt: Date(timeIntervalSince1970: 1715186520),
            participants: ["alice", "bob"]
        )
        #expect(!FileManager.default.fileExists(atPath: handle.url.path))
        #expect(FileManager.default.fileExists(atPath: finalURL.path))
        #expect(!finalURL.lastPathComponent.contains(".partial"))
        let contents = try String(contentsOf: finalURL, encoding: .utf8)
        #expect(contents.contains("title: Q1 Planning"))
        #expect(contents.contains("participants:"))
        #expect(contents.contains("**alice**: Hi."))
    }

    @Test func insertSummarySectionsAboveTranscript() throws {
        let store = MeetingFileStore(root: tempRoot)
        let handle = try store.createPartial(
            id: "01HABC", startedAt: Date(timeIntervalSince1970: 1715184000),
            platform: "meet", language: "en")
        try handle.appendCaption(timestamp: Date(timeIntervalSince1970: 1715184012),
                                 speaker: "alice", text: "Hi.")
        let finalURL = try store.finalize(handle: handle, title: "X",
                                          endedAt: Date(timeIntervalSince1970: 1715186520),
                                          participants: [])
        let summary = MeetingSummary(
            gist: "G", tldr: ["a", "b"],
            full: "## Summary\nbody\n",
            actions: [.init(owner: "alice", text: "ship it", due: nil)],
            decisions: [.init(text: "go")],
            blockers: [],
            model: "claude-opus-4-7",
            generatedAt: Date(timeIntervalSince1970: 1715186591)
        )
        try store.writeSummary(into: finalURL, summary: summary)
        let contents = try String(contentsOf: finalURL, encoding: .utf8)
        #expect(contents.contains("gist: G"))
        #expect(contents.contains("## Summary\nbody"))
        #expect(contents.contains("- [ ] **alice** — ship it"))
        #expect(contents.contains("- go"))
        let summaryIdx = contents.range(of: "## Summary")!.lowerBound
        let transcriptIdx = contents.range(of: "## Transcript")!.lowerBound
        #expect(summaryIdx < transcriptIdx)
    }
}
