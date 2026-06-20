// User-reported fault feedback. Persisted as a markdown file with YAML
// frontmatter under <repo>/.understand-anything/memory/faults/<slug>.md.
//
// Format chosen to be:
//   • Human-readable (open in any text editor).
//   • Agent-readable via the Understand-Anything skill (which already
//     understands the memory/ dir convention).
//   • Diff-friendly (single status field updates touch one line).
//
// The notes body sits after the closing `---` so the user can edit it
// freely without breaking the frontmatter.

import Foundation
import Yams

enum FaultSeverity: String, Codable, CaseIterable, Identifiable {
    case info
    case minor
    case major
    var id: String { rawValue }
    var displayName: String {
        switch self {
        case .info:  return "Info"
        case .minor: return "Minor"
        case .major: return "Major"
        }
    }
}

enum FaultStatus: String, Codable, CaseIterable, Identifiable {
    case open
    case acknowledged
    case fixed
    case wontFix = "wont_fix"
    var id: String { rawValue }
    var displayName: String {
        switch self {
        case .open:         return "Open"
        case .acknowledged: return "Acknowledged"
        case .fixed:        return "Fixed"
        case .wontFix:      return "Won't fix"
        }
    }
}


struct FaultReport: Equatable {
    enum VerifyKind: String, Codable, CaseIterable, Identifiable {
        case command
        var id: String { rawValue }
    }

    var prompt: String
    var response: String
    var notes: String
    var severity: FaultSeverity
    var reportedAt: Date
    /// Short git SHA at time of report. Optional — git may not be
    /// available or the repo path may not be a working tree.
    var gitHead: String?
    var appVersion: String
    /// `AICliTool.rawValue` of the agent that produced the response.
    var agent: String
    var status: FaultStatus
    var tags: [String]
    /// Agent-authored shell command, runnable from the repo root, that
    /// FAILS (non-zero exit) when this fault is present and PASSES when
    /// it is fixed. nil on legacy faults and faults with no runnable
    /// check — those fall back to answer comparison.
    var verify: String? = nil
    /// Kind of `verify`. `.command` is the only kind today; reserved so
    /// the schema can grow without a migration. nil ⇔ `verify` is nil.
    var verifyKind: VerifyKind? = nil

    enum DecodeError: Error, Equatable {
        case missingFrontmatter
        case invalidYAML(String)
    }

    // MARK: - File name

    /// `<ISO8601Z-with-dashes>-<slug>.md` so directory listings sort
    /// chronologically and the slug is human-readable.
    func suggestedFileName() -> String {
        let ts = Self.fsTimestampFormatter.string(from: reportedAt)
        return "\(ts)-\(Self.slugify(prompt)).md"
    }

    static func slugify(_ s: String) -> String {
        let lower = s.lowercased()
        let mapped = lower.map { ch -> Character in
            if ch.isLetter || ch.isNumber { return ch }
            return "-"
        }
        // Collapse runs of dashes, trim leading/trailing.
        var collapsed = ""
        var prevDash = false
        for ch in mapped {
            if ch == "-" {
                if !prevDash { collapsed.append(ch) }
                prevDash = true
            } else {
                collapsed.append(ch)
                prevDash = false
            }
        }
        let trimmed = collapsed.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        // Cap at 60 chars so file names stay readable.
        return String(trimmed.prefix(60))
    }

    // MARK: - Markdown round-trip

    func toMarkdown() throws -> String {
        // Build a dictionary literal so Yams emits a deterministic
        // top-level field order. Using YAML block style with quoted
        // strings for prompt/response so multi-line content round-trips
        // without surprises.
        var fm: [String: Any] = [
            "prompt": prompt,
            "response": response,
            "severity": severity.rawValue,
            "reported_at": Self.isoFormatter.string(from: reportedAt),
            "app_version": appVersion,
            "agent": agent,
            "status": status.rawValue,
            "tags": tags
        ]
        if let gitHead { fm["git_head"] = gitHead }
        if let verify { fm["verify"] = verify }
        if let verifyKind { fm["verify_kind"] = verifyKind.rawValue }
        let yaml = try Yams.dump(object: fm)
        return "---\n\(yaml)---\n\(notes)"
    }

    static func fromMarkdown(_ source: String) throws -> FaultReport {
        guard source.hasPrefix("---\n") else {
            throw DecodeError.missingFrontmatter
        }
        let afterOpen = source.index(source.startIndex, offsetBy: 4)
        guard let endRange = source.range(of: "\n---\n", range: afterOpen..<source.endIndex)
        else { throw DecodeError.missingFrontmatter }
        let yamlBlock = String(source[afterOpen..<endRange.lowerBound])
        let notes = String(source[endRange.upperBound...])
        let any: Any
        do { any = try Yams.load(yaml: yamlBlock) ?? [:] }
        catch { throw DecodeError.invalidYAML(error.localizedDescription) }
        guard let dict = any as? [String: Any] else {
            throw DecodeError.invalidYAML("frontmatter is not a mapping")
        }
        guard let prompt = dict["prompt"] as? String,
              let response = dict["response"] as? String,
              let severityRaw = dict["severity"] as? String,
              let severity = FaultSeverity(rawValue: severityRaw),
              let reportedAt = Self.coerceDate(dict["reported_at"]),
              let appVersion = dict["app_version"] as? String,
              let agent = dict["agent"] as? String
        else { throw DecodeError.invalidYAML("missing required field") }
        let statusRaw = (dict["status"] as? String) ?? FaultStatus.open.rawValue
        let status = FaultStatus(rawValue: statusRaw) ?? .open
        let gitHead = dict["git_head"] as? String
        let tags = (dict["tags"] as? [String]) ?? []
        let verify = dict["verify"] as? String
        let verifyKind = (dict["verify_kind"] as? String).flatMap(VerifyKind.init(rawValue:))
        return FaultReport(
            prompt: prompt, response: response, notes: notes,
            severity: severity, reportedAt: reportedAt, gitHead: gitHead,
            appVersion: appVersion, agent: agent, status: status, tags: tags,
            verify: verify, verifyKind: verifyKind
        )
    }

    /// Read existing markdown, rewrite only the status field, return the
    /// new source. Keeps the notes body byte-identical so user edits
    /// outside the frontmatter aren't disturbed.
    static func rewritingStatus(in source: String, to newStatus: FaultStatus) throws -> String {
        let fault = try fromMarkdown(source)
        var copy = fault
        copy.status = newStatus
        return try copy.toMarkdown()
    }

    // MARK: - Date helpers

    /// Thin alias for `Date.iso8601Formatter` kept under the old
    /// name so QAEntry / MemoryNotesWriter callsites don't churn.
    /// Single underlying instance — see `Date+ISO.swift`.
    static var isoFormatter: ISO8601DateFormatter { Date.iso8601Formatter }

    /// Filesystem-safe ISO timestamp (colons are illegal on some FS).
    /// Shared with `QAEntry` so all memory-dir files sort
    /// chronologically with identical timestamp prefixes.
    static let fsTimestampFormatter: DateFormatter = {
        let f = DateFormatter()
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd'T'HH-mm-ss'Z'"
        return f
    }()

    private static func parseDate(_ s: String) -> Date? {
        isoFormatter.date(from: s)
    }

    /// Yams may decode an unquoted ISO timestamp as `Date` directly, or
    /// as `String` when quoted. Accept either shape.
    private static func coerceDate(_ raw: Any?) -> Date? {
        if let d = raw as? Date { return d }
        if let s = raw as? String { return parseDate(s) }
        return nil
    }
}
