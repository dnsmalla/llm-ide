// mac/Sources/LlmIdeMac/Services/NotesFolder/EmailNoteStore.swift
import Foundation
import Yams
import os

/// A single open (not-yet-issued) to-do parsed out of an email note.
struct OpenTodo: Identifiable, Equatable {
    let id: String
    let file: URL
    let todoIndex: Int
    let from: String
    let subject: String
    let title: String
    let detail: String
    let due: String?
    let priority: String
}

/// Reads email-derived to-do notes (written by `EmailFileStore`) back out
/// of `<notesRoot>/Email` and surfaces the to-dos that haven't yet been
/// turned into an issue (`issue == nil`).
struct EmailNoteStore {
    let root: URL
    init(root: URL) { self.root = root }

    private static let log = Logger(subsystem: "LlmIdeMac", category: "EmailNoteStore")

    /// Recursively scans `root` for `.md` notes and returns one `OpenTodo`
    /// per to-do item that has not yet been linked to an issue. Files that
    /// fail to parse (missing/invalid frontmatter, bad YAML, etc.) are
    /// logged and skipped — this never throws.
    func scanOpenTodos() -> [OpenTodo] {
        guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) else {
            return []
        }

        var results: [OpenTodo] = []
        for case let file as URL in enumerator {
            guard file.pathExtension.lowercased() == "md" else { continue }
            do {
                let contents = try String(contentsOf: file, encoding: .utf8)
                guard let split = FrontmatterCoder.split(file: contents) else { continue }
                guard let fm = try? YAMLDecoder().decode(EmailNoteFrontmatter.self, from: split.yaml),
                      fm.noteWorthy else { continue }

                let body = String(contents[split.bodyStart...])
                let subject = Self.parseSubject(body: body)

                for (index, todo) in fm.todos.enumerated() where todo.issue == nil {
                    results.append(OpenTodo(
                        id: "\(file.path)#\(index)",
                        file: file,
                        todoIndex: index,
                        from: fm.from,
                        subject: subject,
                        title: todo.title,
                        detail: todo.detail,
                        due: todo.due,
                        priority: todo.priority
                    ))
                }
            } catch {
                Self.log.error("Failed to parse email note at \(file.path, privacy: .public): \(String(describing: error), privacy: .public)")
                continue
            }
        }
        return results
    }

    /// Parses the subject from the first `# <subject>` H1 heading line in
    /// the note body, falling back to "Email" if none is found.
    private static func parseSubject(body: String) -> String {
        for line in body.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("# ") {
                let subject = trimmed.dropFirst(2).trimmingCharacters(in: .whitespaces)
                return subject.isEmpty ? "Email" : subject
            }
        }
        return "Email"
    }
}
