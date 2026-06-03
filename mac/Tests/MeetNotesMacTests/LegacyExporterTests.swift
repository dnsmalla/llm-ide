import Testing
@testable import MeetNotesMac
import Foundation

final class LegacyExporterTests {

    let tempRoot: URL

    init() throws {
        tempRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("le-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
    }

    deinit {
        try? FileManager.default.removeItem(at: tempRoot)
    }

    @Test func exportWritesOneMarkdownPerMeeting() async throws {
        let records: [LegacyExporter.Record] = [
            .init(meeting: .init(id: "m1", title: "A", started_at: 1715184000,
                                 ended_at: 1715186520, transcript: "alice: hi",
                                 notes: "## Summary\nok", language: "en", platform: "meet"),
                  entities: []),
            .init(meeting: .init(id: "m2", title: "B", started_at: 1715270400,
                                 ended_at: 1715272000, transcript: "bob: hey",
                                 notes: "", language: "en", platform: "meet"),
                  entities: [.init(kind: "action", owner: "bob", text: "do it", due: nil)]),
        ]
        let store = MeetingFileStore(root: tempRoot)
        let idx = try MeetingIndex(url: tempRoot.appendingPathComponent(".meetnotes/index.sqlite"))
        let exporter = LegacyExporter(store: store, index: idx)

        let report = try await exporter.export(records: asAsync(records))
        #expect(report.failed.isEmpty)
        #expect(report.exported == 2)
        #expect(report.skipped == 0)

        for r in records {
            try idx.upsert(.init(id: r.meeting.id, path: "x", title: r.meeting.title,
                startedAt: r.meeting.started_at, endedAt: r.meeting.ended_at,
                durationSec: nil, gist: nil, tldrJSON: nil,
                actionsCount: 0, decisionsCount: 0, blockersCount: 0,
                fileMtime: 1, fileSize: 1, indexedAt: 1))
        }
        let again = try await exporter.export(records: asAsync(records))
        #expect(again.exported == 0)
        #expect(again.skipped == 2)
    }

    private func asAsync(_ records: [LegacyExporter.Record]) -> AsyncStream<LegacyExporter.Record> {
        AsyncStream { cont in
            for x in records { cont.yield(x) }
            cont.finish()
        }
    }
}
