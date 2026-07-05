// mac/Sources/LlmIdeMac/Services/NotesFolder/EmailFileStore.swift
import Foundation
import Yams

/// File-based email store. One complete `.md` per email under
/// `root/YYYY/MM/`. Note-worthy emails get a structured to-do note; skipped
/// (automated/bulk) emails get a raw stub. Files are the source of truth.
struct EmailFileStore {
    let root: URL
    init(root: URL) { self.root = root }

    /// Sender-address heuristic: automated senders never need an LLM call.
    static func isBulkSender(_ from: String) -> Bool {
        let lower = from.lowercased()
        return lower.contains("no-reply@") || lower.contains("noreply@") || lower.contains("donotreply@")
    }

    @discardableResult
    func writeNote(from: String, date: Date, subject: String,
                   classification c: LlmIdeAPIClient.EmailClassification,
                   originalBody: String, sourceHash: String) throws -> URL {
        var fm = """
        ---
        source: email
        platform: email
        from: \(yamlScalar(from))
        date: \(AppDateFormatter.isoString(date))
        category: \(c.category)
        noteWorthy: true
        sourceHash: \(yamlScalar(sourceHash))
        todos:

        """
        if c.todos.isEmpty { fm += "  []\n" }
        for t in c.todos {
            fm += "  - title: \(yamlScalar(t.title))\n"
            fm += "    detail: \(yamlScalar(t.detail))\n"
            fm += "    due: \(t.due.map { "\"\($0)\"" } ?? "null")\n"
            fm += "    priority: \(t.priority)\n"
            fm += "    issue: null\n"
        }
        fm += "---\n\n"

        var md = fm
        md += "# \(subject.isEmpty ? "Email" : subject)\n\n"
        md += "**Summary:** \(c.summary)\n\n"
        md += "## To-dos\n\n"
        if c.todos.isEmpty {
            md += "_No action items._\n\n"
        } else {
            for t in c.todos {
                let due = t.due.map { " — due \($0)" } ?? ""
                md += "- [ ] \(t.title)\(due) (\(t.priority))\n"
            }
            md += "\n"
        }
        md += "## Original\n\n\(originalBody)\n"
        return try write(md, date: date, subject: subject)
    }

    @discardableResult
    func writeSkipped(from: String, date: Date, subject: String,
                      category: String, originalBody: String, sourceHash: String) throws -> URL {
        let md = """
        ---
        source: email
        platform: email
        from: \(yamlScalar(from))
        date: \(AppDateFormatter.isoString(date))
        category: \(category)
        noteWorthy: false
        sourceHash: \(yamlScalar(sourceHash))
        skipped: \(category)
        ---

        # \(subject.isEmpty ? "Email" : subject)

        ## Original

        \(originalBody)
        """
        return try write(md, date: date, subject: subject)
    }

    /// Scans `root` for `.md` notes and collects every non-nil `sourceHash`
    /// from their frontmatter. Used by `InboxGenerationPipeline` (via
    /// `EmailSource`) to skip inbox files that already produced a note.
    /// Files that fail to parse are skipped, never thrown — same tolerance
    /// as `EmailNoteStore.scanOpenTodos`.
    func existingSourceHashes() -> Set<String> {
        guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) else {
            return []
        }
        var hashes: Set<String> = []
        for case let file as URL in enumerator {
            guard file.pathExtension.lowercased() == "md" else { continue }
            guard let contents = try? String(contentsOf: file, encoding: .utf8),
                  let split = FrontmatterCoder.split(file: contents),
                  let fm = try? YAMLDecoder().decode(EmailNoteFrontmatter.self, from: split.yaml),
                  let hash = fm.sourceHash else { continue }
            hashes.insert(hash)
        }
        return hashes
    }

    // MARK: - internals
    private func write(_ contents: String, date: Date, subject: String) throws -> URL {
        let folder = monthFolder(for: date)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent(filename(date: date, subject: subject))
        try Data(contents.utf8).write(to: url, options: .atomic)
        return url
    }
    private func monthFolder(for date: Date) -> URL {
        let c = Calendar.current.dateComponents([.year, .month], from: date)
        return root
            .appendingPathComponent(String(format: "%04d", c.year ?? 0), isDirectory: true)
            .appendingPathComponent(String(format: "%02d", c.month ?? 0), isDirectory: true)
    }
    private func filename(date: Date, subject: String) -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd-HHmmss"; f.timeZone = TimeZone(identifier: "UTC")
        let stamp = f.string(from: date)
        let slug = slugify(subject.isEmpty ? "email" : subject)
        return "\(stamp)-\(slug).md"
    }
    private func slugify(_ s: String) -> String {
        let allowed = CharacterSet.alphanumerics
        let cleaned = s.lowercased().unicodeScalars.map { allowed.contains($0) ? Character($0) : "-" }
        let joined = String(cleaned)
        let collapsed = joined.split(separator: "-").joined(separator: "-")
        return String(collapsed.prefix(60)).isEmpty ? "email" : String(collapsed.prefix(60))
    }
    /// Quote a YAML scalar so ':' / '@' / quotes in addresses & titles stay valid.
    private func yamlScalar(_ s: String) -> String {
        "\"" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }
}
