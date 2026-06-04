import Foundation

/// File-based meeting store.  One .md file per meeting.  Lifecycle:
///   createPartial → appendCaption* → finalize (rename) → writeSummary
final class MeetingFileStore {
    let root: URL
    private static let slugAllowed = CharacterSet.alphanumerics
        .union(.whitespaces)
        .union(CharacterSet(charactersIn: "-"))

    init(root: URL) {
        self.root = root
    }

    final class Handle {
        let id: String
        let url: URL
        let fileHandle: FileHandle
        var frontmatter: MeetingFrontmatter

        // Spec §6.3 step 2: buffer caption writes in a 1-second flush
        // window.  Writes still hit the file immediately; the timer
        // bounds the cost of fsync (and the cloud-sync churn that
        // follows) to once per second instead of once per caption.
        private let flushInterval: TimeInterval = 1.0
        private var lastSyncedAt: Date = .distantPast
        /// Tracks whether `close()` has run, so a deinit-time close
        /// (called when ARC drops the last reference, e.g. when an
        /// outer finalize() throws before its explicit close fires)
        /// is a no-op rather than a double-close on Foundation's
        /// non-idempotent FileHandle.close().
        private var isClosed = false

        init(id: String, url: URL, fileHandle: FileHandle, frontmatter: MeetingFrontmatter) {
            self.id = id; self.url = url; self.fileHandle = fileHandle; self.frontmatter = frontmatter
        }
        deinit {
            // Last-line-of-defense FD reclamation. If the explicit
            // close() never ran (an earlier throw in finalize, an
            // uncaught error in the recovery path), ARC drops us and
            // we close on the way out. Safe because isClosed gates it.
            if !isClosed { try? fileHandle.close() }
        }
        func appendCaption(timestamp: Date, speaker: String, text: String) throws {
            let line = "[\(AppDateFormatter.hourMinuteSecond(timestamp))] **\(speaker)**: \(text)\n"
            try fileHandle.write(contentsOf: Data(line.utf8))
            let now = Date()
            if now.timeIntervalSince(lastSyncedAt) >= flushInterval {
                try? fileHandle.synchronize()
                lastSyncedAt = now
            }
        }
        func flush() throws {
            try fileHandle.synchronize()
            lastSyncedAt = Date()
        }
        func close() throws {
            // Idempotent — second call after the FD is gone would
            // throw EBADF on Foundation. Skip if we've already closed.
            if isClosed { return }
            isClosed = true
            try fileHandle.close()
        }
    }

    func createPartial(id: String, startedAt: Date,
                       platform: String, language: String) throws -> Handle {
        let folder = monthFolder(for: startedAt)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent(partialFilename(startedAt: startedAt, slug: "untitled"))

        let fm = MeetingFrontmatter(
            id: id, title: "", startedAt: startedAt,
            platform: platform, language: language)
        let yaml = try FrontmatterCoder.encode(fm)
        let body = "---\n\(yaml)---\n\n## Transcript\n\n"
        try utf8Data(body).write(to: url, options: .atomic)

        let handle = try FileHandle(forWritingTo: url)
        try handle.seekToEnd()
        return Handle(id: id, url: url, fileHandle: handle, frontmatter: fm)
    }

    /// Recovery entry point.  Opens the .partial.md at `url`, reads its
    /// frontmatter, and finalizes it as if it were the orchestrator's
    /// in-memory handle.  Used by the launch-time recovery prompt for
    /// orphaned partial files left behind by a crashed run.
    @discardableResult
    func finalize(partialAt url: URL, title: String, endedAt: Date,
                  participants: [String]) throws -> URL {
        let contents = try String(contentsOf: url, encoding: .utf8)
        guard let split = FrontmatterCoder.split(file: contents) else {
            throw NSError(domain: "MeetingFileStore", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "Missing frontmatter"])
        }
        let fm = try FrontmatterCoder.decode(split.yaml)
        let fh = try FileHandle(forWritingTo: url)
        // If seekToEnd throws, we have an open FD nobody owns — close
        // it here. Past Handle construction the FD is owned by the
        // Handle (its deinit covers any subsequent throw).
        do {
            try fh.seekToEnd()
        } catch {
            try? fh.close()
            throw error
        }
        let handle = Handle(id: fm.id, url: url, fileHandle: fh, frontmatter: fm)
        return try finalize(handle: handle, title: title,
                            endedAt: endedAt, participants: participants)
    }

    @discardableResult
    func finalize(handle: Handle, title: String, endedAt: Date,
                  participants: [String]) throws -> URL {
        try handle.flush()
        try handle.close()

        var fm = handle.frontmatter
        fm.title = title
        fm.endedAt = endedAt
        fm.durationSeconds = Int(endedAt.timeIntervalSince(fm.startedAt))
        fm.participants = participants

        let contents = try String(contentsOf: handle.url, encoding: .utf8)
        let rewritten = try replaceFrontmatter(in: contents, with: fm)

        let finalURL = handle.url.deletingLastPathComponent()
            .appendingPathComponent(finalFilename(startedAt: fm.startedAt,
                                                  title: title, id: fm.id))
        try utf8Data(rewritten).write(to: handle.url, options: .atomic)
        _ = try FileManager.default.replaceItemAt(finalURL, withItemAt: handle.url)
        return finalURL
    }

    /// Insert (or replace) the summary section above the Transcript
    /// heading.  Idempotent — calling twice does not duplicate
    /// content; the prior summary block (everything from the start of
    /// the body up to `## Transcript`) is replaced wholesale.
    func writeSummary(into url: URL, summary: MeetingSummary) throws {
        let contents = try String(contentsOf: url, encoding: .utf8)
        guard let split = FrontmatterCoder.split(file: contents) else {
            throw NSError(domain: "MeetingFileStore", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "Missing frontmatter"])
        }
        var fm = try FrontmatterCoder.decode(split.yaml)
        fm.gist = summary.gist
        fm.tldr = summary.tldr
        fm.summaryGeneratedAt = summary.generatedAt
        fm.summaryModel = summary.model

        let body = String(contents[split.bodyStart...])
        let summarySection = renderSummarySection(summary)
        let newBody: String
        if let transcriptRange = body.range(of: "## Transcript") {
            // Drop everything between frontmatter and ## Transcript —
            // that's the previous summary section, if any.
            newBody = summarySection + String(body[transcriptRange.lowerBound...])
        } else {
            newBody = summarySection
        }
        let newYaml = try FrontmatterCoder.encode(fm)
        let final = "---\n\(newYaml)---\n\(newBody)"
        try utf8Data(final).write(to: url, options: .atomic)
    }

    // MARK: helpers

    private func monthFolder(for date: Date) -> URL {
        let cal = Calendar(identifier: .iso8601)
        let comps = cal.dateComponents([.year, .month], from: date)
        return root
            .appendingPathComponent(String(format: "%04d", comps.year ?? 0), isDirectory: true)
            .appendingPathComponent(String(format: "%02d", comps.month ?? 0), isDirectory: true)
    }

    private func partialFilename(startedAt: Date, slug: String) -> String {
        return "\(AppDateFormatter.dateHourMinuteLocal(startedAt))-\(slug).partial.md"
    }

    private func finalFilename(startedAt: Date, title: String, id: String) -> String {
        let slug = slugify(title.isEmpty ? "untitled" : title)
        // Append the first 8 chars of the session id to prevent collisions
        // when two meetings on the same day share the same title.
        // e.g. 2026-05-28-standup-m1a2b3c4.md
        let idSuffix = String(id.prefix(8))
        return "\(AppDateFormatter.dateOnlyLocal(startedAt))-\(slug)-\(idSuffix).md"
    }

    private func slugify(_ s: String) -> String {
        let lowered = s.lowercased()
        let cleaned = lowered.unicodeScalars.filter { MeetingFileStore.slugAllowed.contains($0) }
        let joined = String(String.UnicodeScalarView(cleaned))
            .replacingOccurrences(of: " ", with: "-")
        return joined.isEmpty ? "untitled" : String(joined.prefix(60))
    }

    private func replaceFrontmatter(in contents: String,
                                    with fm: MeetingFrontmatter) throws -> String {
        let yaml = try FrontmatterCoder.encode(fm)
        guard let split = FrontmatterCoder.split(file: contents) else {
            // No existing frontmatter — prepend one and keep the body
            // intact.  This shouldn't happen in practice (createPartial
            // always writes one) but is a safe fallback.
            return "---\n\(yaml)---\n\n\(contents)"
        }
        return "---\n\(yaml)---\n\(contents[split.bodyStart...])"
    }

    private func renderSummarySection(_ s: MeetingSummary) -> String {
        var out = "\n\(s.full)\n"
        if !s.actions.isEmpty {
            out += "\n## Actions\n"
            for a in s.actions {
                let owner = a.owner.map { "**\($0)** — " } ?? ""
                let due = a.due.map { " (due \($0))" } ?? ""
                out += "- [ ] \(owner)\(a.text)\(due)\n"
            }
        }
        if !s.decisions.isEmpty {
            out += "\n## Decisions\n"
            for d in s.decisions { out += "- \(d.text)\n" }
        }
        if !s.blockers.isEmpty {
            out += "\n## Blockers\n"
            for b in s.blockers { out += "- \(b.text)\n" }
        }
        out += "\n"
        return out
    }

    private func utf8Data(_ string: String) throws -> Data {
        guard let data = string.data(using: .utf8) else {
            throw CocoaError(.fileWriteUnknown)
        }
        return data
    }
}
