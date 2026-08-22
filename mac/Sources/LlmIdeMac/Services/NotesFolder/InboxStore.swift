// mac/Sources/LlmIdeMac/Services/NotesFolder/InboxStore.swift
import CryptoKit
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
    /// `root/YYYY/MM/<yyyy-MM-dd-HHmmss>-<slug>.txt` — plus a short
    /// content-hash suffix when that name is already taken by different bytes
    /// (see `nonClobberingURL`). The pipeline parser requires a `Date:` header
    /// (ISO-8601) to recover the item date. Returns the URL actually written.
    @discardableResult
    func write(headers: [String: String], body: String, slug: String) throws -> URL {
        // Sort by key so the serialized bytes — and therefore the SHA-256 content
        // hash `InboxGenerationPipeline` uses for dedup — are byte-stable across
        // process lifetimes (Swift `Dictionary` iteration order is randomized).
        let headerBlock = headers.sorted(by: { $0.key < $1.key })
            .map { "\($0.key): \($0.value)" }
            .joined(separator: "\n")
        let contents = "\(headerBlock)\n\n\(body)"
        let date = (headers["Date"].flatMap { AppDateFormatter.parseISO($0) }) ?? Date()
        let folder = monthFolder(for: date)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let data = Data(contents.utf8)
        let url = nonClobberingURL(in: folder, date: date, slug: slug, data: data)
        try data.write(to: url, options: .atomic)
        return url
    }

    /// Raw files are the permanent record, and `.atomic` *replaces* an existing
    /// file — so a name already taken by different bytes must never be reused.
    /// Callers can and do produce colliding `<timestamp>-<slug>` names (a whole
    /// fetched batch can share one second and one slug), which used to lose
    /// every item but the last while all of them were marked seen.
    ///
    /// Same bytes → same URL, so a re-fetch stays idempotent and the content
    /// hash the generation pipeline dedups on is unchanged. Different bytes →
    /// a deterministic content-derived suffix, so the name is stable across
    /// runs rather than growing a new file each time.
    private func nonClobberingURL(in folder: URL, date: Date, slug: String, data: Data) -> URL {
        let base = filenameStem(date: date, slug: slug)
        let primary = folder.appendingPathComponent("\(base).txt")
        guard let existing = try? Data(contentsOf: primary), existing != data else { return primary }
        let tagged = folder.appendingPathComponent("\(base)-\(Self.contentTag(data)).txt")
        if let other = try? Data(contentsOf: tagged), other != data {
            // A 48-bit SHA-256 prefix collision between two different items in
            // the same second and slug. Take a unique name over a silent loss.
            return folder.appendingPathComponent("\(base)-\(UUID().uuidString.prefix(8).lowercased()).txt")
        }
        return tagged
    }

    private static func contentTag(_ data: Data) -> String {
        String(SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined().prefix(12))
    }

    private func monthFolder(for date: Date) -> URL {
        let c = Calendar.current.dateComponents([.year, .month], from: date)
        return root
            .appendingPathComponent(String(format: "%04d", c.year ?? 0), isDirectory: true)
            .appendingPathComponent(String(format: "%02d", c.month ?? 0), isDirectory: true)
    }

    private func filenameStem(date: Date, slug: String) -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd-HHmmss"; f.timeZone = TimeZone(identifier: "UTC")
        return "\(f.string(from: date))-\(slug)"
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
