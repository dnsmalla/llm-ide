// mac/Sources/LlmIdeMac/Services/NotesFolder/InboxStore.swift
import Foundation

/// Writes one raw captured item per file into `<root>/YYYY/MM/`. Pairs with
/// `InboxGenerationPipeline`, which scans what this writes. Header-agnostic:
/// any source (email, slack, future connectors) passes its own headers.
///
/// Files written here are never modified, moved, or deleted by the app —
/// they are the permanent raw record. Dedup for generation purposes is by
/// content hash, computed by `InboxGenerationPipeline` from the file bytes.
struct InboxStore {
    let root: URL
    init(root: URL) { self.root = root }

    /// Writes each `Key: Value` header, a blank line, then `body`, to
    /// `root/YYYY/MM/<yyyy-MM-dd-HHmmss>-<slug>.txt`. The pipeline parser
    /// requires a `Date:` header (ISO-8601) to recover the item date.
    @discardableResult
    func write(headers: [String: String], body: String, slug: String) throws -> URL {
        let headerBlock = headers.map { "\($0.key): \($0.value)" }.joined(separator: "\n")
        let contents = "\(headerBlock)\n\n\(body)"
        let date = (headers["Date"].flatMap { AppDateFormatter.parseISO($0) }) ?? Date()
        let folder = monthFolder(for: date)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent(filename(date: date, slug: slug))
        try Data(contents.utf8).write(to: url, options: .atomic)
        return url
    }

    private func monthFolder(for date: Date) -> URL {
        let c = Calendar.current.dateComponents([.year, .month], from: date)
        return root
            .appendingPathComponent(String(format: "%04d", c.year ?? 0), isDirectory: true)
            .appendingPathComponent(String(format: "%02d", c.month ?? 0), isDirectory: true)
    }

    private func filename(date: Date, slug: String) -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd-HHmmss"; f.timeZone = TimeZone(identifier: "UTC")
        return "\(f.string(from: date))-\(slug).txt"
    }

    /// Shared slug helper (callers build the slug for the raw filename).
    static func slugify(_ s: String) -> String {
        let allowed = CharacterSet.alphanumerics
        let cleaned = s.lowercased().unicodeScalars.map { allowed.contains($0) ? Character($0) : "-" }
        let joined = String(cleaned)
        let collapsed = joined.split(separator: "-").joined(separator: "-")
        return String(collapsed.prefix(60)).isEmpty ? "item" : String(collapsed.prefix(60))
    }
}
