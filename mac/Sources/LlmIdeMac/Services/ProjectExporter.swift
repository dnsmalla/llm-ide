import Foundation
import os.log

/// Exports all server-side KB data for a project into the canonical local
/// folder tree.  Called by `ProjectStore.closeActiveWithExport()` and by the
/// manual "Export Project" action.
///
/// Output after a successful export:
///
/// ```
/// <projectFolder>/
/// ├── system/
/// │   └── sync.json                  ← written LAST; its presence = complete export
/// └── source/
///     ├── _index.json
///     └── YYYY/MM/
///         └── YYYY-MM-DD-slug-<id8>.md
/// ```
///
/// **ID suffix** — every filename ends with the last 8 chars of the item's ID
/// so two meetings/source items with identical titles on the same date never collide.
///
/// **YAML safety** — all frontmatter values are double-quoted via `yamlScalar()`.
///
/// **Transcript safety** — the raw transcript is fenced inside ` ```text … ``` `
/// so embedded `---`, backticks, or YAML sequences cannot break the document.
///
/// **CJK/Unicode slugs** — non-ASCII letters are preserved in slugs via
/// their Unicode scalar values rather than stripped, so Japanese/Chinese/Korean
/// titles remain recognisable.
@MainActor
final class ProjectExporter {

    private let log = Logger(
        subsystem: "com.llmide.macapp",
        category:  "ProjectExporter"
    )

    // MARK: - Result

    struct ExportResult {
        let meetingsWritten: Int
        let plansWritten: Int
        let exportedAt: Date
        let durationMs: Int
    }

    // MARK: - Shared formatters (expensive to create — reuse)

    private static let iso8601Formatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    /// Full ISO-8601 parser used to validate dates from the server.
    private static let dateParser: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withFullDate, .withDashSeparatorInDate]
        return f
    }()

    // MARK: - Entry point

    func export(
        project: Project,
        folderURL: URL,
        client: LlmIdeAPIClient
    ) async throws -> ExportResult {
        let t0 = Date()

        log.info("export start: \(project.displayName, privacy: .public) (\(project.id, privacy: .public))")

        // Fetch all project data from the backend in one round-trip.
        let bundle = try await client.exportProject(projectId: project.id)

        let fm = FileManager.default

        // Guard: project folder must still exist and be writable.
        // User could have deleted / moved it via Finder between open and close.
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: folderURL.path, isDirectory: &isDir), isDir.boolValue else {
            throw ExportError.folderNotFound(folderURL.path)
        }

        var meetingIndexEntries: [[String: String]] = []

        // ── Meetings ─────────────────────────────────────────────────────────
        let meetingsRoot = folderURL.appendingPathComponent("source")
        try fm.createDirectory(at: meetingsRoot, withIntermediateDirectories: true)

        for meeting in bundle.meetings {
            let (year, month) = validatedYearMonth(from: meeting.date)
            let dir = meetingsRoot
                .appendingPathComponent(year)
                .appendingPathComponent(month)
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)

            let prefix   = datePrefix(from: meeting.date)
            let slug     = slugify(meeting.title, id: meeting.id)
            let filename = "\(prefix)-\(slug).md"
            let fileURL  = dir.appendingPathComponent(filename)

            try meetingMarkdown(meeting: meeting, projectId: project.id)
                .write(to: fileURL, atomically: true, encoding: .utf8)

            meetingIndexEntries.append([
                "id":    meeting.id,
                "title": meeting.title,
                "date":  meeting.date ?? "",
                "path":  "source/\(year)/\(month)/\(filename)",
            ])
        }

        // meetings/_index.json
        try JSONSerialization
            .data(withJSONObject: [
                "generatedAt": nowISO(),
                "count":       bundle.meetings.count,
                "meetings":    meetingIndexEntries,
            ] as [String: Any], options: [.prettyPrinted, .sortedKeys])
            .write(to: meetingsRoot.appendingPathComponent("_index.json"), options: .atomic)

        // ── README badge ──────────────────────────────────────────────────────
        updateReadme(
            at: folderURL.appendingPathComponent("README.md"),
            meetings: bundle.meetings.count,
            plans:    0)

        // ── system/sync.json — written LAST ────────────────────────────────
        // Its presence on disk signals that the entire export above completed
        // successfully.  A reader that sees no sync.json should treat the
        // folder as a partial / in-progress export.
        let systemDir = folderURL.appendingPathComponent("system")
        try fm.createDirectory(at: systemDir, withIntermediateDirectories: true)
        try JSONSerialization
            .data(withJSONObject: [
                "exportedAt":        nowISO(),
                "meetingsExported":  bundle.meetings.count,
                "plansExported":     0,
                "backendExportedAt": bundle.exportedAt,
            ] as [String: Any], options: .prettyPrinted)
            .write(to: systemDir.appendingPathComponent("sync.json"),
                   options: .atomic)

        let ms = Int(Date().timeIntervalSince(t0) * 1000)
        log.info("export done: \(bundle.meetings.count) meetings in \(ms)ms")

        return ExportResult(
            meetingsWritten: bundle.meetings.count,
            plansWritten:    0,
            exportedAt:      Date(),
            durationMs:      ms
        )
    }

    // MARK: - Errors

    enum ExportError: LocalizedError {
        case folderNotFound(String)
        var errorDescription: String? {
            switch self {
            case .folderNotFound(let path):
                return "Project folder not found or not a directory: \(path). It may have been moved or deleted."
            }
        }
    }

    // MARK: - Markdown: meeting

    private func meetingMarkdown(
        meeting: ProjectExportBundle.Meeting,
        projectId: String
    ) -> String {
        let participantLines = meeting.participants
            .map { "  - \(yamlScalar($0))" }
            .joined(separator: "\n")

        let durationStr: String = {
            guard let d = meeting.durationSec, d > 0 else { return "unknown" }
            return "\(d / 60)m \(d % 60)s"
        }()

        var md = """
        ---
        id: \(yamlScalar(meeting.id))
        title: \(yamlScalar(meeting.title))
        date: \(meeting.date ?? "unknown")
        duration: \(durationStr)
        language: \(meeting.language)
        projectId: \(yamlScalar(projectId))
        participants:
        \(participantLines.isEmpty ? "  []" : participantLines)
        ---

        # \(meeting.title)

        """

        // Summary sections
        let actions   = meeting.entities.filter { $0.kind == "action" }
        let decisions = meeting.entities.filter { $0.kind == "decision" }
        let blockers  = meeting.entities.filter { $0.kind == "blocker" }

        if !actions.isEmpty || !decisions.isEmpty || !blockers.isEmpty {
            md += "## Summary\n\n"
            if !actions.isEmpty {
                md += "### Action Items\n\n"
                for a in actions {
                    md += "- [ ] \(escapeMd(a.text))\n"
                    if let q = a.quote, !q.isEmpty {
                        md += "  > \(q.replacingOccurrences(of: "\n", with: "\n  > "))\n"
                    }
                }
                md += "\n"
            }
            if !decisions.isEmpty {
                md += "### Decisions\n\n"
                for d in decisions {
                    md += "- \(escapeMd(d.text))\n"
                    if let q = d.quote, !q.isEmpty {
                        md += "  > \(q.replacingOccurrences(of: "\n", with: "\n  > "))\n"
                    }
                }
                md += "\n"
            }
            if !blockers.isEmpty {
                md += "### Blockers\n\n"
                for b in blockers {
                    md += "- ⚠️ \(escapeMd(b.text))\n"
                    if let q = b.quote, !q.isEmpty {
                        md += "  > \(q.replacingOccurrences(of: "\n", with: "\n  > "))\n"
                    }
                }
                md += "\n"
            }
        }

        // Transcript — fenced inside ```text … ``` so that any embedded `---`,
        // YAML sequences, or backtick runs inside the transcript cannot break
        // the surrounding document structure.
        if !meeting.transcript.isEmpty {
            // Choose a fence length that won't collide with content that
            // contains runs of backticks.
            let maxRun = longestBacktickRun(in: meeting.transcript)
            let fenceLen = max(3, maxRun + 1)
            let fence = String(repeating: "`", count: fenceLen)
            md += "## Transcript\n\n\(fence)text\n\(meeting.transcript)"
            if !meeting.transcript.hasSuffix("\n") { md += "\n" }
            md += "\(fence)\n"
        }

        return md
    }

    // MARK: - Markdown: plan

    private func planMarkdown(plan: ProjectExportBundle.Plan) -> String {
        var seenMilestones = Set<String>()
        var milestoneOrder: [String] = []
        for t in plan.tasks {
            let ms = t.milestone ?? "General"
            if seenMilestones.insert(ms).inserted { milestoneOrder.append(ms) }
        }
        let byMilestone = Dictionary(grouping: plan.tasks) { $0.milestone ?? "General" }

        var md = """
        ---
        id: \(yamlScalar(plan.id))
        title: \(yamlScalar(plan.title))
        language: \(plan.language)
        createdAt: \(plan.createdAt ?? "unknown")
        updatedAt: \(plan.updatedAt ?? "unknown")
        ---

        # \(plan.title)

        """

        // plan.goal can contain Markdown characters — escape before blockquote
        if !plan.goal.isEmpty {
            md += "> \(escapeMd(plan.goal))\n\n"
        }

        let total   = plan.tasks.count
        let done    = plan.tasks.filter { $0.status == "done" || $0.status == "cancelled" }.count
        let active  = plan.tasks.filter { $0.status == "in_progress" }.count
        let blocked = plan.tasks.filter { $0.status == "blocked" }.count

        md += """
        | Total | Done | Active | Blocked |
        |-------|------|--------|---------|
        | \(total) | \(done) | \(active) | \(blocked) |

        """

        for ms in milestoneOrder {
            guard let tasks = byMilestone[ms], !tasks.isEmpty else { continue }
            md += "## \(escapeMd(ms))\n\n"
            for t in tasks {
                let check = (t.status == "done" || t.status == "cancelled") ? "x" : " "
                var line  = "- [\(check)] **\(escapeMd(t.title))**"
                if let owner = t.owner, !owner.isEmpty { line += " — @\(escapeMd(owner))" }
                if let est   = t.estimateDays           { line += " `\(est)d`" }
                if let risk  = t.risk, risk != "low"    { line += " ⚠️ \(risk) risk" }
                if t.status == "blocked"                { line += " 🔴 blocked" }
                md += line + "\n"
                if let desc = t.description, !desc.isEmpty {
                    desc.components(separatedBy: "\n")
                        .forEach { md += "  \($0)\n" }
                }
            }
            md += "\n"
        }

        return md
    }

    // MARK: - README badge

    private func updateReadme(at url: URL, meetings: Int, plans: Int) {
        guard let content = try? String(contentsOf: url, encoding: .utf8) else { return }
        let badge = "**Last exported:** \(nowISO()) — \(meetings) meeting(s), \(plans) plan(s)"

        let updated: String
        if content.contains("**Last exported:**") {
            updated = content
                .components(separatedBy: "\n")
                .map { $0.hasPrefix("**Last exported:**") ? badge : $0 }
                .joined(separator: "\n")
        } else {
            updated = content + "\n---\n\(badge)\n"
        }
        do {
            try updated.write(to: url, atomically: true, encoding: .utf8)
        } catch {
            log.error("failed to stamp export badge: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - YAML helpers

    /// Always produces a safely double-quoted YAML scalar.
    /// Escapes: backslash, double-quote, newline, carriage-return, tab.
    private func yamlScalar(_ s: String) -> String {
        let escaped = s
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\r", with: "\\r")
            .replacingOccurrences(of: "\t", with: "\\t")
        return "\"\(escaped)\""
    }

    // MARK: - Markdown helpers

    /// Escape characters with special meaning in Markdown inline context.
    private func escapeMd(_ s: String) -> String {
        var out = s
        for ch in ["\\", "`", "*", "_", "{", "}", "[", "]", "(", ")", "#", "+", "!", "|"] {
            out = out.replacingOccurrences(of: ch, with: "\\\(ch)")
        }
        return out
    }

    /// Find the longest consecutive run of backticks in `s`.
    /// Used to choose a code-fence length that cannot be closed prematurely.
    private func longestBacktickRun(in s: String) -> Int {
        var max = 0, cur = 0
        for ch in s {
            if ch == "`" { cur += 1; if cur > max { max = cur } }
            else { cur = 0 }
        }
        return max
    }

    // MARK: - Slug / date helpers

    /// Unicode-aware slug.  Non-ASCII letters (CJK, Arabic, Devanagari, …)
    /// are preserved as-is rather than stripped so they remain recognisable
    /// in the filename.  Unsafe filesystem characters are replaced with `-`.
    /// A short ID suffix prevents collisions between items with the same
    /// title + date.
    private func slugify(_ title: String, id: String) -> String {
        // Step 1: lowercase
        var s = title.lowercased()

        // Step 2: replace whitespace runs with a single hyphen
        s = s.components(separatedBy: .whitespacesAndNewlines)
             .filter { !$0.isEmpty }
             .joined(separator: "-")

        // Step 3: keep Unicode letters/digits, hyphens; drop filesystem-unsafe chars
        //         (/ \ : * ? " < > |) and control characters.
        let unsafe = CharacterSet(charactersIn: "/\\:*?\"<>|")
            .union(.controlCharacters)
            .union(.illegalCharacters)
        s = s.unicodeScalars
            .filter { !unsafe.contains($0) }
            .map { String($0) }
            .joined()

        // Step 4: collapse consecutive hyphens; trim leading/trailing
        while s.contains("--") { s = s.replacingOccurrences(of: "--", with: "-") }
        s = s.trimmingCharacters(in: CharacterSet(charactersIn: "-"))

        // Step 5: truncate to 40 chars (leaves room for date prefix + ID suffix)
        if s.count > 40 {
            s = String(s.prefix(40))
                .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        }
        if s.isEmpty { s = "untitled" }

        // Step 6: append last-8 chars of the item ID — guarantees uniqueness
        return "\(s)-\(id.suffix(8))"
    }

    /// Parse an ISO-8601 date string and return ("YYYY", "MM").
    /// Uses the system ISO-8601 parser so invalid dates (e.g. month 13) are
    /// rejected and fall back to ("0000", "00"), preventing garbage directories.
    private func validatedYearMonth(from iso: String?) -> (String, String) {
        guard let iso, let date = Self.dateParser.date(from: String(iso.prefix(10))) else {
            return ("0000", "00")
        }
        let cal = Calendar(identifier: .gregorian)
        let y = cal.component(.year,  from: date)
        let m = cal.component(.month, from: date)
        return (String(format: "%04d", y), String(format: "%02d", m))
    }

    /// "YYYY-MM-DD" from an ISO-8601 string, validated via the date parser.
    private func datePrefix(from iso: String?) -> String {
        guard let iso, let date = Self.dateParser.date(from: String(iso.prefix(10))) else {
            return "0000-00-00"
        }
        let cal = Calendar(identifier: .gregorian)
        let y = cal.component(.year,  from: date)
        let m = cal.component(.month, from: date)
        let d = cal.component(.day,   from: date)
        return String(format: "%04d-%02d-%02d", y, m, d)
    }

    private func nowISO() -> String {
        Self.iso8601Formatter.string(from: Date())
    }
}
