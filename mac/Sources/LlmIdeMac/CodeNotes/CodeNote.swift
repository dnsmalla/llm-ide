import Foundation

/// A round-trippable record of one code-graph node, persisted as a Markdown
/// file with a YAML-style frontmatter header (see `CodeNoteWriter`).
///
/// This is distinct from `CodeNoteGenerator.noteMarkdown`, which renders a
/// human-readable table view that is *not* meant to be parsed back. `CodeNote`
/// is the machine-readable form: write it, read it, get the same value back.
public struct CodeNote: Codable, Equatable {
    public struct SymbolRef: Codable, Equatable {
        public let name: String
        public let kind: String
        public let line: Int

        public init(name: String, kind: String, line: Int) {
            self.name = name
            self.kind = kind
            self.line = line
        }
    }

    public struct Link: Codable, Equatable {
        public let to: String
        public let kind: String

        public init(to: String, kind: String) {
            self.to = to
            self.kind = kind
        }
    }

    public let id: String
    public let kind: String
    public let title: String
    public let path: String
    public let language: String
    public let complexity: String
    public let tags: [String]
    public let contentHash: String
    public let symbols: [SymbolRef]
    public let links: [Link]
    public let body: String

    public init(
        id: String,
        kind: String,
        title: String,
        path: String = "",
        language: String = "unknown",
        complexity: String = "unknown",
        tags: [String] = [],
        contentHash: String = "",
        symbols: [SymbolRef] = [],
        links: [Link] = [],
        body: String = ""
    ) {
        self.id = id
        self.kind = kind
        self.title = title
        self.path = path
        self.language = language
        self.complexity = complexity
        self.tags = tags
        self.contentHash = contentHash
        self.symbols = symbols
        self.links = links
        self.body = body
    }
}
