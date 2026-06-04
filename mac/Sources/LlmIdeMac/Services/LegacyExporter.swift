import Foundation

final class LegacyExporter {
    struct LegacyMeeting: Decodable {
        let id: String
        let title: String?
        let started_at: Int64
        let ended_at: Int64?
        let transcript: String?
        let notes: String?
        let language: String?
        let platform: String?
    }
    struct LegacyEntity: Decodable {
        let kind: String         // action | decision | blocker
        let owner: String?
        let text: String
        let due: String?
    }
    struct Record: Decodable {
        let meeting: LegacyMeeting
        let entities: [LegacyEntity]
    }
    struct Report {
        var exported = 0
        var skipped = 0
        var failed: [(id: String, error: String)] = []
    }

    private let store: MeetingFileStore
    private let index: MeetingIndex
    init(store: MeetingFileStore, index: MeetingIndex) {
        self.store = store; self.index = index
    }

    func export<S: AsyncSequence>(records: S) async throws -> Report
            where S.Element == Record {
        var report = Report()
        for try await rec in records {
            if (try? index.get(id: rec.meeting.id)) != nil {
                report.skipped += 1; continue
            }
            do {
                let url = try await writeOne(rec)
                _ = url
                report.exported += 1
            } catch {
                report.failed.append((rec.meeting.id, error.localizedDescription))
            }
        }
        return report
    }

    private func writeOne(_ r: Record) async throws -> URL {
        let started = Date(timeIntervalSince1970: TimeInterval(r.meeting.started_at) / 1000)
        let ended = r.meeting.ended_at.map {
            Date(timeIntervalSince1970: TimeInterval($0) / 1000)
        }
        let handle = try store.createPartial(
            id: r.meeting.id, startedAt: started,
            platform: r.meeting.platform ?? "meet",
            language: r.meeting.language ?? "en")
        if let t = r.meeting.transcript, !t.isEmpty {
            for line in t.split(separator: "\n") {
                try handle.fileHandle.write(contentsOf: Data((line + "\n").utf8))
            }
        }
        let title = r.meeting.title ?? "Untitled"
        let finalURL = try store.finalize(handle: handle, title: title,
                                          endedAt: ended ?? started,
                                          participants: [])
        let summary = MeetingSummary(
            gist: "",
            tldr: [],
            full: r.meeting.notes ?? "",
            actions: r.entities.filter { $0.kind == "action" }.map {
                .init(owner: $0.owner, text: $0.text, due: $0.due)
            },
            decisions: r.entities.filter { $0.kind == "decision" }.map {
                .init(text: $0.text)
            },
            blockers: r.entities.filter { $0.kind == "blocker" }.map {
                .init(text: $0.text)
            },
            model: "legacy-import",
            generatedAt: ended ?? started
        )
        try store.writeSummary(into: finalURL, summary: summary)
        return finalURL
    }
}
