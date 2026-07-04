// mac/Sources/LlmIdeMac/Models/EmailNoteFrontmatter.swift
import Foundation

/// Frontmatter shape written by `EmailFileStore` for email-derived to-do
/// notes. `date` is decoded as a plain `String` to avoid coupling this
/// reader to a specific date-decoding strategy. `todos` defaults to `[]`
/// so skipped notes (which omit the `todos` key entirely) decode cleanly.
struct EmailNoteFrontmatter: Codable, Equatable {
    var source: String
    var from: String
    var date: String
    var category: String
    var noteWorthy: Bool
    var todos: [Todo] = []

    struct Todo: Codable, Equatable {
        var title: String
        var detail: String
        var due: String?
        var priority: String
        var issue: String?
    }

    enum CodingKeys: String, CodingKey {
        case source, from, date, category, noteWorthy, todos
    }

    init(source: String, from: String, date: String, category: String, noteWorthy: Bool, todos: [Todo] = []) {
        self.source = source
        self.from = from
        self.date = date
        self.category = category
        self.noteWorthy = noteWorthy
        self.todos = todos
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        source = try container.decode(String.self, forKey: .source)
        from = try container.decode(String.self, forKey: .from)
        date = try container.decode(String.self, forKey: .date)
        category = try container.decode(String.self, forKey: .category)
        noteWorthy = try container.decode(Bool.self, forKey: .noteWorthy)
        todos = try container.decodeIfPresent([Todo].self, forKey: .todos) ?? []
    }
}
