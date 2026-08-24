import Foundation
import os.log
import Yams

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

struct EmailNoteStore {
    let root: URL
    private let log = Logger(subsystem: "com.llmide.macapp", category: "EmailNoteStore")

    init(root: URL) { self.root = root }

    func scanOpenTodos() -> [OpenTodo] {
        guard FileManager.default.fileExists(atPath: root.path) else { return [] }
        var open: [OpenTodo] = []
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(at: root, includingPropertiesForKeys: nil) else { return [] }
        for case let url as URL in enumerator {
            guard url.pathExtension.lowercased() == "md" else { continue }
            do {
                let contents = try String(contentsOf: url, encoding: .utf8)
                guard let split = FrontmatterCoder.split(file: contents) else { continue }
                let decoder = YAMLDecoder()
                guard let note = try? decoder.decode(EmailNoteFrontmatter.self, from: split.yaml),
                      note.noteWorthy else { continue }
                let subject = parseSubject(from: contents, bodyStart: split.bodyStart)
                for (index, todo) in note.todos.enumerated() where todo.issue == nil {
                    open.append(OpenTodo(
                        id: "\(url.path)#\(index)",
                        file: url,
                        todoIndex: index,
                        from: note.from,
                        subject: subject,
                        title: todo.title,
                        detail: todo.detail,
                        due: todo.due,
                        priority: todo.priority
                    ))
                }
            } catch {
                log.debug("Skipping unparseable email note \(url.path, privacy: .public): \(error.localizedDescription, privacy: .public)")
            }
        }
        return open.sorted { $0.subject.localizedCaseInsensitiveCompare($1.subject) == .orderedAscending }
    }

    func markTodoCreated(file: URL, todoIndex: Int, issueURL: String) throws {
        var contents = try String(contentsOf: file, encoding: .utf8)
        guard let split = FrontmatterCoder.split(file: contents) else {
            throw EmailNoteStoreError.missingFrontmatter
        }
        var note = try YAMLDecoder().decode(EmailNoteFrontmatter.self, from: split.yaml)
        guard note.todos.indices.contains(todoIndex) else {
            throw EmailNoteStoreError.todoIndexOutOfRange
        }
        note.todos[todoIndex].issue = issueURL
        let encoder = YAMLEncoder()
        encoder.options.sortKeys = false
        let yaml = try encoder.encode(note)
        let body = String(contents[split.bodyStart...])
        contents = "---\n\(yaml.trimmingCharacters(in: .newlines))\n---\n\(body)"
        contents = flipBodyCheckbox(in: contents, title: note.todos[todoIndex].title, issueURL: issueURL)
        try contents.write(to: file, atomically: true, encoding: .utf8)
    }

    private func parseSubject(from contents: String, bodyStart: String.Index) -> String {
        let body = String(contents[bodyStart...])
        for line in body.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("# ") {
                let subject = trimmed.dropFirst(2).trimmingCharacters(in: .whitespaces)
                return subject.isEmpty ? "Email" : subject
            }
        }
        return "Email"
    }

    private func flipBodyCheckbox(in contents: String, title: String, issueURL: String) -> String {
        var lines = contents.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let prefix = "- [ ] \(title)"
        for i in lines.indices where lines[i].hasPrefix(prefix) {
            // The writer emits "- [ ] <title>[ — due …] (<priority>)", so after
            // the title comes end-of-line or a space. Without this boundary
            // check, title "Fix bug" would match — and REWRITE — the line for
            // "Fix bugs in parser", mangling a different todo's body text.
            let next = lines[i].dropFirst(prefix.count).first
            guard next == nil || next == " " else { continue }
            lines[i] = "- [x] \(title) — \(issueURL)"
            return lines.joined(separator: "\n")
        }
        return contents
    }
}

enum EmailNoteStoreError: LocalizedError {
    case missingFrontmatter
    case todoIndexOutOfRange

    var errorDescription: String? {
        switch self {
        case .missingFrontmatter: return "Email note is missing YAML frontmatter."
        case .todoIndexOutOfRange: return "To-do index is out of range."
        }
    }
}
