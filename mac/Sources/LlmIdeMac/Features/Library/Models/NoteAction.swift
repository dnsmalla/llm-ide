import Foundation
import CryptoKit

struct NoteAction: Identifiable, Equatable, Hashable, Sendable {
    let id: String           // SHA256 of normalized text — stable across runs
    let text: String         // raw bullet text
    let meetingId: String
    let meetingTitle: String
}

/// One note file to scan for action items — an absolute path plus enough
/// identity to attribute the extracted `NoteAction`s. Deliberately doesn't
/// name `MeetingIndex.Row` or `ProjectNoteRef`: both a real meeting transcript
/// (global meetings folder, via `MeetingIndex`) and a source-connector note
/// (`<project>/llm-doc/…`, via `ProjectNotesProviding`) convert into this
/// same shape so `NoteActionExtractor` doesn't care which store a row came
/// from.
struct ActionSourceRow: Equatable {
    let id: String
    let title: String
    let fileURL: URL
}

enum NoteActionExtractor {
    /// Headings that mark the action-item list across the note templates in
    /// use: raw meeting transcripts write `## Actions` (`MeetingFileStore`),
    /// the generic ingest template writes `## Action items`, and the email
    /// template writes `## To-dos` (`IngestTemplateRenderer`). Checked in
    /// order; the first one present in the file wins.
    private static let actionHeadings = ["## Actions", "## Action items", "## To-dos"]

    /// Reads each row's .md file and returns all action-list bullet items
    /// across all provided rows.
    static func extract(from rows: [ActionSourceRow]) -> [NoteAction] {
        var result: [NoteAction] = []
        for row in rows {
            guard let contents = try? String(contentsOf: row.fileURL, encoding: .utf8),
                  let split = FrontmatterCoder.split(file: contents),
                  split.bodyStart <= contents.endIndex else { continue }
            let body = String(contents[split.bodyStart...])
            let items = actionsSection(in: body)
            for text in items {
                let normalized = normalize(text)
                guard !normalized.isEmpty else { continue }
                let id = sha256(normalized)
                result.append(NoteAction(id: id, text: text,
                                         meetingId: row.id,
                                         meetingTitle: row.title))
            }
        }
        return result
    }

    static func normalize(_ text: String) -> String {
        text.lowercased()
            .components(separatedBy: .punctuationCharacters).joined(separator: " ")
            .components(separatedBy: .whitespaces).filter { !$0.isEmpty }.joined(separator: " ")
    }

    private static func actionsSection(in body: String) -> [String] {
        guard let heading = actionHeadings.first(where: { body.range(of: $0) != nil }),
              let range = body.range(of: heading) else { return [] }
        let after = String(body[range.upperBound...])
        let nextHeading = after.range(of: "\n## ")?.lowerBound ?? after.endIndex
        let section = after[..<nextHeading]
        return section.split(separator: "\n")
            .filter { $0.hasPrefix("- ") }
            .compactMap { line -> String? in
                guard line.count >= 2 else { return nil }
                var s = String(line.dropFirst(2)).trimmingCharacters(in: .whitespaces)
                if s.hasPrefix("[ ] ") || s.hasPrefix("[x] ") || s.hasPrefix("[X] ") {
                    s = String(s.dropFirst(4))
                }
                return s.isEmpty ? nil : s
            }
    }

    private static func sha256(_ string: String) -> String {
        let data = Data(string.utf8)
        let hash = SHA256.hash(data: data)
        return hash.map { String(format: "%02x", $0) }.joined()
    }
}
