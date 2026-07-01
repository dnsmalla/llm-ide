import Foundation

/// Serializes a ``CodeNote`` to / from a Markdown file with a YAML-style
/// frontmatter header. Scalar fields are emitted as `key: value` lines (so the
/// header stays human-readable); collection fields (`tags`, `symbols`, `links`)
/// are JSON-encoded on a single line so arbitrary values round-trip without an
/// ambiguous delimiter. The Markdown body follows the closing `---` fence.
public enum CodeNoteWriter {
    private static let fence = "---"

    /// Frontmatter scalar keys, emitted in this fixed order for deterministic output.
    private enum Key: String {
        case id, kind, title, path, language, complexity, contentHash
    }

    private static func makeEncoder() -> JSONEncoder {
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys]
        return enc
    }

    private static func encodeJSON<T: Encodable>(_ value: T) throws -> String {
        let data = try makeEncoder().encode(value)
        guard let str = String(data: data, encoding: .utf8) else {
            throw CodeNoteError.parseFailed(message: "could not encode frontmatter value as UTF-8")
        }
        return str
    }

    private static func decodeJSON<T: Decodable>(_ type: T.Type, from line: String) throws -> T {
        guard let data = line.data(using: .utf8) else {
            throw CodeNoteError.parseFailed(message: "frontmatter value is not valid UTF-8")
        }
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw CodeNoteError.parseFailed(message: "invalid JSON frontmatter value: \(error.localizedDescription)")
        }
    }

    // MARK: - Render

    public static func render(_ note: CodeNote) throws -> String {
        var lines: [String] = [fence]
        lines.append("\(Key.id.rawValue): \(note.id)")
        lines.append("\(Key.kind.rawValue): \(note.kind)")
        lines.append("\(Key.title.rawValue): \(note.title)")
        lines.append("\(Key.path.rawValue): \(note.path)")
        lines.append("\(Key.language.rawValue): \(note.language)")
        lines.append("\(Key.complexity.rawValue): \(note.complexity)")
        lines.append("\(Key.contentHash.rawValue): \(note.contentHash)")
        lines.append("tags: \(try encodeJSON(note.tags))")
        lines.append("symbols: \(try encodeJSON(note.symbols))")
        lines.append("links: \(try encodeJSON(note.links))")
        lines.append(fence)
        // Body follows the closing fence on its own region; preserve it verbatim.
        return lines.joined(separator: "\n") + "\n" + note.body
    }

    // MARK: - Parse

    public static func parse(_ markdown: String) throws -> CodeNote {
        let lines = markdown.components(separatedBy: "\n")
        guard lines.first == fence else {
            throw CodeNoteError.parseFailed(message: "missing frontmatter: file must begin with '---'")
        }
        guard let closingIndex = lines.dropFirst().firstIndex(of: fence) else {
            throw CodeNoteError.parseFailed(message: "missing frontmatter: no closing '---' fence")
        }

        var scalars: [String: String] = [:]
        var tags: [String] = []
        var symbols: [CodeNote.SymbolRef] = []
        var links: [CodeNote.Link] = []

        for line in lines[1..<closingIndex] {
            if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
            guard let sep = line.range(of: ": ") else {
                throw CodeNoteError.parseFailed(message: "malformed frontmatter line: '\(line)'")
            }
            let key = String(line[..<sep.lowerBound])
            let value = String(line[sep.upperBound...])
            switch key {
            case "tags": tags = try decodeJSON([String].self, from: value)
            case "symbols": symbols = try decodeJSON([CodeNote.SymbolRef].self, from: value)
            case "links": links = try decodeJSON([CodeNote.Link].self, from: value)
            default: scalars[key] = value
            }
        }

        func require(_ key: Key) throws -> String {
            guard let value = scalars[key.rawValue] else {
                throw CodeNoteError.parseFailed(message: "frontmatter is missing required key '\(key.rawValue)'")
            }
            return value
        }

        let body = lines[(closingIndex + 1)...].joined(separator: "\n")

        return CodeNote(
            id: try require(.id),
            kind: try require(.kind),
            title: try require(.title),
            path: try require(.path),
            language: try require(.language),
            complexity: try require(.complexity),
            tags: tags,
            contentHash: try require(.contentHash),
            symbols: symbols,
            links: links,
            body: body
        )
    }

    // MARK: - Disk

    public static func write(_ note: CodeNote, to url: URL) throws {
        let markdown = try render(note)
        try markdown.write(to: url, atomically: true, encoding: .utf8)
    }

    public static func read(from url: URL) throws -> CodeNote {
        let markdown = try String(contentsOf: url, encoding: .utf8)
        return try parse(markdown)
    }
}
