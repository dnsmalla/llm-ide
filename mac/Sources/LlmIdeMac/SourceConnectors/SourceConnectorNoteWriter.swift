import Foundation

/// Writes Source Connector notes via the unified `NoteService` (notes land
/// under `llm-doc/<noteType>/`). Generalizes `EmailNoteWriter`: any
/// connector's note (frontmatter + summary + to-dos) keyed for dedup by
/// `sourceHash`.
struct SourceConnectorNoteWriter {
    let noteService: NoteService
    let noteType: NoteType
    let platform: String

    init(repoRoot: URL, noteType: NoteType, platform: String? = nil) {
        self.noteService = NoteService(repoRoot: repoRoot)
        self.noteType = noteType
        self.platform = platform ?? noteType.rawValue
    }

    @discardableResult
    func writeNote(
        headers: [String: String], title: String, date: Date,
        classification c: SourceConnectorClassification,
        originalBody: String, sourceHash: String, rawFile: String
    ) async throws -> URL {
        let fm = FrontMatter(source: platform, platform: platform, noteType: noteType.rawValue,
                             headers: headers, date: AppDateFormatter.isoString(date),
                             category: c.category, noteWorthy: true, sourceHash: sourceHash,
                             rawFile: rawFile, todos: c.todos)
        var md = fm.rendered()
        md += "# \(title)\n\n**Summary:** \(c.summary)\n\n## To-dos\n\n"
        if c.todos.isEmpty {
            md += "_No action items._\n\n"
        } else {
            for t in c.todos {
                let due = t.due.map { " — due \($0)" } ?? ""
                md += "- [ ] \(t.title)\(due) (\(t.priority))\n"
            }
            md += "\n"
        }
        md += "## Original\n\n\(originalBody)"
        return try await save(filename: filename(date: date, title: title),
                              md: md, date: date, title: title, tags: [c.category],
                              sourceHash: sourceHash, rawFile: rawFile)
    }

    @discardableResult
    func writeSkipped(
        headers: [String: String], title: String, date: Date, category: String,
        originalBody: String, sourceHash: String, rawFile: String
    ) async throws -> URL {
        let fm = FrontMatter(source: platform, platform: platform, noteType: noteType.rawValue,
                             headers: headers, date: AppDateFormatter.isoString(date),
                             category: category, noteWorthy: false, sourceHash: sourceHash,
                             rawFile: rawFile, todos: [])
        let md = fm.rendered() + "# \(title)\n\n## Original\n\n\(originalBody)"
        return try await save(filename: filename(date: date, title: title),
                              md: md, date: date, title: title, tags: [category],
                              sourceHash: sourceHash, rawFile: rawFile)
    }

    func existingSourceHashes() async throws -> Set<String> {
        let notes = try await noteService.queryNotes(NoteFilter(type: noteType))
        return Set(notes.compactMap { $0.sourceHash })
    }

    private func save(filename: String, md: String, date: Date, title: String, tags: [String],
                      sourceHash: String, rawFile: String) async throws -> URL {
        // sourceHash/rawFile are embedded in frontmatter above AND carried on
        // NoteMetadata so queryNotes/existingSourceHashes can dedup.
        let metadata = NoteMetadata(
            id: "", type: noteType, source: platform, title: title,
            date: AppDateFormatter.isoString(date), path: "", rawFile: rawFile,
            sourceHash: sourceHash, generatedAt: AppDateFormatter.isoString(Date()),
            tags: tags, participants: nil, fileSize: 0)
        let saved = try await noteService.saveNote(type: noteType, filename: filename,
                                                   content: Data(md.utf8), metadata: metadata)
        return noteService.notesRoot.appendingPathComponent(saved.path)
    }

    private func filename(date: Date, title: String) -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd-HHmmss"; f.timeZone = TimeZone(identifier: "UTC")
        return "\(f.string(from: date))-\(InboxStore.slugify(title.isEmpty ? platform : title)).md"
    }

    /// Minimal YAML frontmatter renderer (mirrors EmailNoteWriter's shape).
    private struct FrontMatter {
        let source: String; let platform: String; let noteType: String
        let headers: [String: String]; let date: String
        let category: String; let noteWorthy: Bool
        let sourceHash: String; let rawFile: String
        let todos: [SourceConnectorClassification.Todo]
        func rendered() -> String {
            var s = "---\nsource: \(q(source))\nplatform: \(q(platform))\nnoteType: \(q(noteType))\n"
            for (k, v) in headers.sorted(by: { $0.key < $1.key }) { s += "\(k): \(q(v))\n" }
            s += "date: \(date)\ncategory: \(q(category))\nnoteWorthy: \(noteWorthy)\n"
            s += "sourceHash: \(q(sourceHash))\nrawFile: \(q(rawFile))\n"
            if todos.isEmpty { s += "todos: []\n" }
            else {
                s += "todos:\n"
                for t in todos {
                    s += "  - title: \(q(t.title))\n    detail: \(q(t.detail))\n"
                    s += "    due: \(t.due.map { "\"\($0)\"" } ?? "null")\n    priority: \(t.priority)\n"
                }
            }
            return s + "---\n\n"
        }
        private func q(_ x: String) -> String {
            "\"" + x.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
        }
    }
}
