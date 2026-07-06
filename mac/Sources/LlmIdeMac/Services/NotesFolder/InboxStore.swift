// mac/Sources/LlmIdeMac/Services/NotesFolder/InboxStore.swift
import Foundation

/// Writes one raw captured item per file into `<root>/YYYY/MM/`. Pairs with
/// `InboxGenerationPipeline`, which scans what this writes. Together they
/// split "capture what arrived" from "generate a note from it" so
/// generation can run independently of however the raw content got here
/// (a live fetch, or a file dropped in by hand) and independently of any
/// fetch-side dedup state (DB, high-water marks, etc).
///
/// Files written here are never modified, moved, or deleted by the app —
/// they are the permanent raw record. Dedup for generation purposes is by
/// content hash, computed by `InboxGenerationPipeline` from the file bytes,
/// not tracked here.
struct InboxStore {
    let root: URL
    init(root: URL) { self.root = root }

    /// Writes `From:`/`Subject:`/`Date:` headers, a blank line, then `body`
    /// to `root/YYYY/MM/<yyyy-MM-dd-HHmmss>-<slug>.txt`. Returns the file URL.
    @discardableResult
    func write(from: String, date: Date, subject: String, body: String) throws -> URL {
        let contents = "From: \(from)\nSubject: \(subject)\nDate: \(AppDateFormatter.isoString(date))\n\n\(body)"
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
        let slug = Self.slugify(subject.isEmpty ? "item" : subject)
        return "\(stamp)-\(slug).txt"
    }

    private static func slugify(_ s: String) -> String {
        let allowed = CharacterSet.alphanumerics
        let cleaned = s.lowercased().unicodeScalars.map { allowed.contains($0) ? Character($0) : "-" }
        let joined = String(cleaned)
        let collapsed = joined.split(separator: "-").joined(separator: "-")
        return String(collapsed.prefix(60)).isEmpty ? "item" : String(collapsed.prefix(60))
    }
}
