import Foundation

/// Renders a top-level `index.md` for a set of ``CodeNote`` records: a header,
/// a total count, and the note titles grouped by `kind`. Grouping and ordering
/// follow first-appearance order so output is deterministic for a given input.
public enum IndexWriter {
    public static func render(notes: [CodeNote]) -> String {
        var lines: [String] = ["# Code Notes Index", ""]
        lines.append("\(notes.count) notes")

        var order: [String] = []
        var byKind: [String: [CodeNote]] = [:]
        for note in notes {
            if byKind[note.kind] == nil { order.append(note.kind) }
            byKind[note.kind, default: []].append(note)
        }

        for kind in order {
            lines.append("")
            lines.append("## \(kind)")
            lines.append("")
            for note in byKind[kind] ?? [] {
                lines.append("- \(note.title)")
            }
        }

        return lines.joined(separator: "\n") + "\n"
    }
}
