import Foundation

/// Reads the Refactoring loop's `REFACTOR.md` batch sections, which the planner
/// writes and the apply stage updates in place. Pure: no I/O, no runner state.
///
/// Batch grammar (the planner's):
/// ```
/// ### R<n> <title>  (status: todo|done|skipped[, free text])
/// - Files: `a`, `b`
/// - Symbols: …
/// - Tests: present | missing `…`
/// - Intent: …
/// - Risk: …
/// - Expect: <counter> <before> → <after>
/// ```
public enum RefactorPlanDiff {
    /// One batch the plan names, as the runner needs it.
    struct Applied: Equatable {
        var id: String
        /// The status token after `status:` (`todo`, `done`, `skipped`, …).
        var status: String
        /// The counter named by the batch's `Expect:` line, if it has one.
        var expect: String?
        /// Every backtick-quoted path on the batch's `Files:` line.
        var files: [String]
    }

    private struct Section {
        var id: String
        var status: String
        var lines: [String]
    }

    private static let headerPattern = #"^### (R\d+)\b.*\(status:\s*([A-Za-z]+)[^)]*\)"#
    private static let replyPattern = #"(?m)^Applied:\s*(R\d+)\b"#

    /// The first batch still `todo`, in document order.
    static func firstTodo(in text: String) -> Applied? {
        sections(in: text).first { $0.status == "todo" }.map(applied(from:))
    }

    /// The batch whose status changed from `todo` between the two texts, in the
    /// order it appears in `after`. Nil when no batch changed.
    static func appliedBatch(before: String, after: String) -> Applied? {
        let prior = Dictionary(sections(in: before).map { ($0.id, $0.status) },
                               uniquingKeysWith: { first, _ in first })
        return sections(in: after).first { section in
            prior[section.id] == "todo" && section.status != "todo"
        }.map(applied(from:))
    }

    /// The batch id a repair/apply reply declares with an `Applied: R<n>` line.
    static func appliedReplyBatchId(_ reply: String) -> String? {
        firstGroups(replyPattern, in: reply)?.first
    }

    /// The batch with `id`, as the plan currently states it.
    static func batch(id: String, in text: String) -> Applied? {
        sections(in: text).first { $0.id == id }.map(applied(from:))
    }

    /// The batch's section, verbatim (header through its last line, no trailing blank lines).
    public static func section(of id: String, in text: String) -> String? {
        sections(in: text).first { $0.id == id }.map { $0.lines.joined(separator: "\n") }
    }

    /// Marks batch `id` `blocked` after a rollback (spec §3.5): rewrites its
    /// header to `(status: blocked)` and inserts (or replaces) a
    /// `- Blocked: <reason>` line directly under it — the planner rule reads
    /// this to never retry a blocked batch as-is. Every other section, and the
    /// text around the batch, is byte-identical. `id` not found → `plan` unchanged.
    public static func markingBlocked(_ plan: String, id: String, reason: String) -> String {
        let lines = plan.components(separatedBy: "\n")
        var out: [String] = []
        var index = 0
        var found = false
        while index < lines.count {
            let line = lines[index]
            if line.hasPrefix("### "), let groups = firstGroups(headerPattern, in: line),
               groups.count == 2, groups[0] == id {
                found = true
                out.append(blockedHeader(line))
                index += 1
                // An existing `- Blocked:` line directly under the header is replaced,
                // not duplicated, so marking an already-blocked batch again stays idempotent.
                if index < lines.count,
                   lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("- Blocked:") {
                    index += 1
                }
                out.append("- Blocked: \(reason)")
                continue
            }
            out.append(line)
            index += 1
        }
        return found ? out.joined(separator: "\n") : plan
    }

    /// Puts batch `id` back to `todo` after a rollback whose cause was not the
    /// batch (`RefactorBatchRollback.planOutcome`): rewrites its header to
    /// `(status: todo)` — undoing the apply stage's `done` — and drops a
    /// `- Blocked:` line directly under it, so the next run retries the batch
    /// as written. Every other line is byte-identical. `id` not found → `plan`
    /// unchanged.
    public static func markingTodo(_ plan: String, id: String) -> String {
        let lines = plan.components(separatedBy: "\n")
        var out: [String] = []
        var index = 0
        var found = false
        while index < lines.count {
            let line = lines[index]
            if line.hasPrefix("### "), let groups = firstGroups(headerPattern, in: line),
               groups.count == 2, groups[0] == id {
                found = true
                out.append(header(line, status: "todo"))
                index += 1
                if index < lines.count,
                   lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("- Blocked:") {
                    index += 1
                }
                continue
            }
            out.append(line)
            index += 1
        }
        return found ? out.joined(separator: "\n") : plan
    }

    /// Replaces the `(status: …)` parenthetical on a header line with
    /// `(status: blocked)`, dropping any free text the old status carried
    /// (e.g. `, reason: …`) — `blocked` always states its own reason on the
    /// line below, via `- Blocked:`.
    private static func blockedHeader(_ line: String) -> String {
        header(line, status: "blocked")
    }

    private static func header(_ line: String, status: String) -> String {
        guard let range = line.range(of: #"\(status:\s*[A-Za-z]+[^)]*\)"#, options: .regularExpression)
        else { return line }
        return line.replacingCharacters(in: range, with: "(status: \(status))")
    }

    // MARK: - Parsing

    private static func sections(in text: String) -> [Section] {
        var out: [Section] = []
        var current: Section?
        for line in text.components(separatedBy: "\n") {
            if line.hasPrefix("### ") {
                if let done = current { out.append(finish(done)) }
                current = nil
                if let groups = firstGroups(headerPattern, in: line), groups.count == 2 {
                    current = Section(id: groups[0], status: groups[1], lines: [line])
                }
            } else if line.hasPrefix("## ") {
                if let done = current { out.append(finish(done)) }
                current = nil
            } else if current != nil {
                current?.lines.append(line)
            }
        }
        if let done = current { out.append(finish(done)) }
        return out
    }

    private static func finish(_ section: Section) -> Section {
        var copy = section
        while let last = copy.lines.last, last.trimmingCharacters(in: .whitespaces).isEmpty {
            copy.lines.removeLast()
        }
        return copy
    }

    private static func applied(from section: Section) -> Applied {
        let expectLine = field("Expect", in: section.lines)
        let expect = expectLine?.split(whereSeparator: \.isWhitespace).first
            .map { String($0).trimmingCharacters(in: CharacterSet(charactersIn: "`")) }
        let files = field("Files", in: section.lines).map { line in
            allGroups(#"`([^`]+)`"#, in: line).map(\.first).compactMap { $0 }
        } ?? []
        // `Expect: none` promises no counter to fall: nothing to verify, not a counter named "none".
        let counter = expect.flatMap { $0.isEmpty || $0.lowercased() == "none" ? nil : $0 }
        return Applied(id: section.id, status: section.status, expect: counter, files: files)
    }

    /// The value after `- <name>:` on the first matching bullet line.
    private static func field(_ name: String, in lines: [String]) -> String? {
        let prefix = "- \(name):"
        guard let line = lines.first(where: { $0.trimmingCharacters(in: .whitespaces).hasPrefix(prefix) }) else {
            return nil
        }
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return String(trimmed.dropFirst(prefix.count)).trimmingCharacters(in: .whitespaces)
    }

    private static func firstGroups(_ pattern: String, in text: String) -> [String]? {
        allGroups(pattern, in: text).first
    }

    /// Capture groups of every match, one array per match.
    private static func allGroups(_ pattern: String, in text: String) -> [[String]] {
        guard let rx = try? NSRegularExpression(pattern: pattern) else { return [] }
        let ns = text as NSString
        return rx.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { match in
            (1..<match.numberOfRanges).compactMap { i -> String? in
                let r = match.range(at: i)
                return r.location == NSNotFound ? nil : ns.substring(with: r)
            }
        }
    }
}
