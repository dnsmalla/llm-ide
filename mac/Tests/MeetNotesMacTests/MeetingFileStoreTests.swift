import Testing
@testable import MeetNotesMac
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
