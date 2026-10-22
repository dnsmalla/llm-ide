import Foundation

/// One non-terminal NDJSON line of `GET /kb/export-all`: a legacy meeting and
/// its extracted entities.
///
/// Declared in Core (next to its decoder, `LlmIdeAPIClient.exportAll`) rather
/// than nested in Library's `LegacyExporter`, because Core must not name a
/// feature-owned type. The exporter itself stays in Library — it writes through
/// `MeetingFileStore` — and keeps `LegacyExporter.Record` as an alias of this.
struct LegacyExportRecord: Decodable {
    struct Meeting: Decodable {
        let id: String
        let title: String?
        let started_at: Int64
        let ended_at: Int64?
        let transcript: String?
        let notes: String?
        let language: String?
        let platform: String?
    }
    struct Entity: Decodable {
        let kind: String         // action | decision | blocker
        let owner: String?
        let text: String
        let due: String?
    }
    let meeting: Meeting
    let entities: [Entity]
}
