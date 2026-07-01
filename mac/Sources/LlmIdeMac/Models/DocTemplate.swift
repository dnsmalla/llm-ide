import Foundation

struct DocTemplate: Identifiable, Codable, Equatable {
    let id: UUID
    var name: String
    var sections: [String]
    /// Raw markdown content of the source .md file, if imported from one.
    var rawContent: String?
    let isBuiltin: Bool

    /// Parse `## ` headings from a Markdown string into section names.
    static func sections(from markdown: String) -> [String] {
        let headings = markdown
            .components(separatedBy: .newlines)
            .filter { $0.hasPrefix("## ") }
            .map { String($0.dropFirst(3)).trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        return headings.isEmpty ? ["Content"] : headings
    }
}

enum DocGenSource: Hashable {
    case meeting(id: String, title: String)
    case file(url: URL, name: String)

    var displayName: String {
        switch self {
        case .meeting(_, let title): return title
        case .file(_, let name): return name
        }
    }

    func hash(into hasher: inout Hasher) {
        switch self {
        case .meeting(let id, _): hasher.combine(0); hasher.combine(id)
        case .file(let url, _): hasher.combine(1); hasher.combine(url)
        }
    }

    static func == (lhs: DocGenSource, rhs: DocGenSource) -> Bool {
        switch (lhs, rhs) {
        case (.meeting(let a, _), .meeting(let b, _)): return a == b
        case (.file(let a, _), .file(let b, _)): return a == b
        default: return false
        }
    }
}
