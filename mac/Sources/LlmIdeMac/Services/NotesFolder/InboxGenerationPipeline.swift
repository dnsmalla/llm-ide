// mac/Sources/LlmIdeMac/Services/NotesFolder/InboxGenerationPipeline.swift
import Foundation
import CryptoKit

/// One parsed raw item recovered from an `InboxStore` file, plus the raw
/// file's SHA-256 content hash — the dedup key `InboxGenerationPipeline`
/// checks against notes already generated.
struct RawInboxItem {
    let url: URL
    let from: String
    let subject: String
    let date: Date
    let body: String
    let hash: String
}

/// Generic "scan a raw-capture folder, skip what's already been turned into
/// a note, generate the rest" loop. Pairs with `InboxStore`: `InboxStore`
/// writes the raw files, this scans them. Dedup is by content hash, not by
/// message id or DB state — a file counts as done once the caller-supplied
/// `knownHashes` set (typically read from existing notes' frontmatter)
/// contains its hash. Source-agnostic and dependency-free (no networking,
/// no `SourceContext`) so it's reusable by any source with this shape.
enum InboxGenerationPipeline {
    /// Recursively finds every `.txt` file under `inboxRoot`, skips any
    /// whose content hash is in `knownHashes`, and calls `generate` for the
    /// rest. A `generate` throw is recorded in `failures` and does not stop
    /// the remaining items — matches `SlackSource.ingest`'s per-item
    /// failure isolation. Returns the count of items `generate` completed
    /// without throwing, plus any failure messages (`"<filename>: <error>"`).
    static func run(
        inboxRoot: URL,
        knownHashes: Set<String>,
        generate: (RawInboxItem) async throws -> Void
    ) async -> (processed: Int, failures: [String]) {
        guard let enumerator = FileManager.default.enumerator(at: inboxRoot, includingPropertiesForKeys: nil) else {
            return (0, [])
        }
        var processed = 0
        var failures: [String] = []
        for case let file as URL in enumerator {
            guard file.pathExtension.lowercased() == "txt" else { continue }
            guard let data = try? Data(contentsOf: file) else { continue }
            let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            if knownHashes.contains(hash) { continue }
            guard let item = parse(file: file, data: data, hash: hash) else { continue }
            do {
                try await generate(item)
                processed += 1
            } catch {
                failures.append("\(file.lastPathComponent): \(error.localizedDescription)")
            }
        }
        return (processed, failures)
    }

    /// Parses the `From:`/`Subject:`/`Date:` header block written by
    /// `InboxStore.write`. Returns nil (silently skips the file) if the
    /// headers, the blank-line separator, or the date can't be parsed.
    private static func parse(file: URL, data: Data, hash: String) -> RawInboxItem? {
        guard let text = String(data: data, encoding: .utf8) else { return nil }
        guard let sep = text.range(of: "\n\n") else { return nil }
        let header = String(text[text.startIndex..<sep.lowerBound])
        let body = String(text[sep.upperBound...])

        var from = "", subject = "", dateStr = ""
        for line in header.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("From: ") { from = String(line.dropFirst("From: ".count)) }
            else if line.hasPrefix("Subject: ") { subject = String(line.dropFirst("Subject: ".count)) }
            else if line.hasPrefix("Date: ") { dateStr = String(line.dropFirst("Date: ".count)) }
        }
        guard let date = AppDateFormatter.parseISO(dateStr) else { return nil }
        return RawInboxItem(url: file, from: from, subject: subject, date: date, body: body, hash: hash)
    }
}
