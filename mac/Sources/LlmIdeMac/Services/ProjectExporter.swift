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
        /// True when the plans side-export failed (meetings were still written;
        /// the failure is already logged). Surfaced so the UI can say so
        /// instead of silently reporting "0 plan(s)".
        let plansWriteFailed: Bool
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
        client: LlmIdeAPIClient,
        plansFolder: URL
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
        let meetingsRoot = ProjectLayout(root: folderURL).sourceDir
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

        // ── Plans → global plans folder ──────────────────────────────────────
        // Plans belong to the project in the backend DB, but they are exported
        // to the user's global Plans folder (one subfolder per project) so all
        // plan output lives in one browsable place. A failure here must NOT fail
        // the meeting export — the data is safe in the backend SQLite DB.
        var plansWritten = 0
        var plansWriteFailed = false
        do {
            plansWritten = try writePlans(bundle.plans, project: project, to: plansFolder)
        } catch {
            log.error("plans export failed (meetings already written): \(error.localizedDescription, privacy: .public)")
            plansWritten = 0
            plansWriteFailed = true
        }

        // ── README badge ──────────────────────────────────────────────────────
        updateReadme(
            at: folderURL.appendingPathComponent("README.md"),
            meetings: bundle.meetings.count)

        // ── system/sync.json — written LAST ────────────────────────────────
        // Its presence on disk signals that the entire export above completed
        // successfully.  A reader that sees no sync.json should treat the
        // folder as a partial / in-progress export.
        let layout = ProjectLayout(root: folderURL)
        try fm.createDirectory(at: layout.systemDir, withIntermediateDirectories: true)
        try JSONSerialization
            .data(withJSONObject: [
                "exportedAt":        nowISO(),
                "meetingsExported":  bundle.meetings.count,
                "plansExported":     plansWritten,
                "backendExportedAt": bundle.exportedAt,
            ] as [String: Any], options: .prettyPrinted)
            .write(to: layout.syncJSON, options: .atomic)

        let ms = Int(Date().timeIntervalSince(t0) * 1000)
        log.info("export done: \(bundle.meetings.count) meetings, \(plansWritten) plans in \(ms)ms")

        return ExportResult(
            meetingsWritten: bundle.meetings.count,
            plansWritten:    plansWritten,
            plansWriteFailed: plansWriteFailed,
            exportedAt:      Date(),
            durationMs:      ms
        )
    }

    // MARK: - Plans

    /// Fetch the project's plans from the backend and write each one as
    /// Markdown into the global plans folder. Drives the manual
    /// "Save Plans to Folder…" command. Returns the number of plans written.
    ///
    /// Deliberate trade-off: this fetches the FULL export bundle (all meetings
    /// + transcripts), not just plans — `GET /kb/plans` has no project filter,
    /// so a plans-only fetch needs a server-side change. The backend is
    /// localhost and this is an occasional manual command; if it ever feels
    /// slow on meeting-heavy projects, add a `projectId` filter to
    /// `/kb/plans` and switch this to it.
    @discardableResult
    func exportPlans(project: Project,
                     client: LlmIdeAPIClient,
                     to plansFolder: URL) async throws -> Int {
        let bundle = try await client.exportProject(projectId: project.id)
        return try writePlans(bundle.plans, project: project, to: plansFolder)
    }

    /// Write each plan in `plans` as a Markdown file under
    /// `<plansFolder>/<projectSlug>/`. Filenames are deterministic
    /// (`YYYY-MM-DD-<title-slug>-<id8>.md`) so re-exporting overwrites in place
    /// rather than producing duplicates. Returns the number of files written.
    /// Empty input is a no-op (creates no project subfolder).
    func writePlans(_ plans: [ProjectExportBundle.Plan],
                    project: Project,
                    to plansFolder: URL) throws -> Int {
        guard !plans.isEmpty else { return 0 }
        let fm = FileManager.default
        let projectDir = plansFolder
            .appendingPathComponent(projectSlug(for: project), isDirectory: true)
        try fm.createDirectory(at: projectDir, withIntermediateDirectories: true)

        var written = 0
        for plan in plans {
            let prefix   = datePrefix(from: plan.createdAt)
            let slug     = slugify(plan.title, id: plan.id)
            let filename = "\(prefix)-\(slug).md"
            let fileURL  = projectDir.appendingPathComponent(filename)

            // Plan titles are user-editable (inline rename via /kb/plan/save),
            // so the title-derived slug changes. Identity is anchored by the
            // id8 filename suffix: before writing, remove any superseded file
            // carrying the same plan id so a rename replaces instead of
            // duplicating. (The no-deletion rule covers *user* files; this
            // only removes the exporter's own out-of-date output.)
            let idSuffix = "-\(plan.id.suffix(8)).md"
            if let names = try? fm.contentsOfDirectory(atPath: projectDir.path) {
                for name in names where name.hasSuffix(idSuffix) && name != filename {
                    try? fm.removeItem(at: projectDir.appendingPathComponent(name))
                }
            }

            try plansMarkdown(plan: plan, projectId: project.id)
                .write(to: fileURL, atomically: true, encoding: .utf8)
            written += 1
        }
        return written
    }

    /// Stable per-project subfolder name. Uses the same Unicode-aware slugify
    /// as meetings (lowercased title + last-8 of the id) so two projects that
    /// share a display name never collide and re-export lands in the same dir.
    private func projectSlug(for project: Project) -> String {
        slugify(project.displayName, id: project.id)
    }

    /// Render a plan (and its tasks) as a self-contained Markdown document.
    func plansMarkdown(plan: ProjectExportBundle.Plan, projectId: String) -> String {
        var lines: [String] = []
        lines.append("---")
        lines.append("id: \(yamlScalar(plan.id))")
        lines.append("projectId: \(yamlScalar(projectId))")
        lines.append("title: \(yamlScalar(plan.title))")
        lines.append("language: \(yamlScalar(plan.language))")
        if let m = plan.meetingId { lines.append("meetingId: \(yamlScalar(m))") }
        if let c = plan.createdAt  { lines.append("createdAt: \(yamlScalar(c))") }
        if let u = plan.updatedAt  { lines.append("updatedAt: \(yamlScalar(u))") }
        lines.append("exportedAt: \(yamlScalar(nowISO()))")
        lines.append("---")
        lines.append("")
        lines.append("# \(escapeMd(plan.title))")
        lines.append("")
        lines.append("**Goal**")
        lines.append("")
        lines.append(plan.goal)
        lines.append("")

        let tasks = plan.tasks.sorted { $0.position < $1.position }
        if tasks.isEmpty {
            lines.append("_No tasks._")
        } else {
            lines.append("## Tasks")
            lines.append("")
            for t in tasks {
                lines.append(taskLine(t))
            }
        }
        return lines.joined(separator: "\n") + "\n"
    }

    /// One task as a GitHub-style checklist item with indented metadata.
    private func taskLine(_ t: ProjectExportBundle.Task) -> String {
        let box: String
        switch t.status {
        case "done":      box = "- [x]"
        case "cancelled": box = "- [-]"
        default:          box = "- [ ]"
        }

        var line = "\(box) \(escapeMd(t.title))"
        switch t.status {
        case "blocked":     line += " ⚠️"
        case "in_progress": line += " 🔄"
        default: break
        }

        var detail: [String] = ["Status: \(t.status)"]
        if let m = t.milestone   { detail.append("Milestone: \(escapeMd(m))") }
        if let owner = t.owner   { detail.append("Owner: \(escapeMd(owner))") }
        if let due = t.due       { detail.append("Due: \(escapeMd(due))") }
        if let days = t.estimateDays { detail.append("Estimate: \(days)d") }
        if !t.dependsOn.isEmpty  { detail.append("Depends on: \(t.dependsOn.joined(separator: ", "))") }
        if let risk = t.risk {
            var r = "Risk: \(escapeMd(risk))"
            if let reason = t.riskReason, !reason.isEmpty { r += " — \(escapeMd(reason))" }
            detail.append(r)
        }
        if let desc = t.description, !desc.isEmpty { detail.append(escapeMd(desc)) }

        for d in detail { line += "\n  - \(d)" }
        return line
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

    // MARK: - README badge

    private func updateReadme(at url: URL, meetings: Int) {
        guard let content = try? String(contentsOf: url, encoding: .utf8) else { return }
        let badge = "**Last exported:** \(nowISO()) — \(meetings) meeting(s)"

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
