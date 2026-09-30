import Foundation

/// What one repair attempt on a stage did and what came of it — the unit of the
/// per-stage attempt ledger. Fed back into the next repair prompt ("these did
/// not work — do something different") and, when a later run meets the SAME
/// failure set, into that run's first repair.
struct LoopLedgerEntry: Codable, Equatable {
    static let maxDiffChars = 4_000
    static let maxReplyChars = 1_000
    static let maxStatChars = 500
    static let maxPathsListed = 20

    /// 1-based repair number for this stage in its run.
    var n: Int
    var changedPaths: [String]
    var diffStat: String
    /// Trimmed `git diff` of `changedPaths` (never a secret or protected path).
    var diff: String
    /// The agent's own account of what it did, trimmed.
    var replySummary: String
    /// Failure-set hash of the failure that prompted this repair.
    var failureSetBefore: String?
    /// Failure-set hash when the stage next ran and still failed; `nil` until
    /// then, or when it passed (`resultingPassed`).
    var resultingFailureSet: String?
    var resultingPassed: Bool?

    init(n: Int, changedPaths: [String], diffStat: String, diff: String, replySummary: String,
         failureSetBefore: String?, resultingFailureSet: String? = nil, resultingPassed: Bool? = nil) {
        self.n = n
        self.changedPaths = changedPaths
        // Redacted here, so nothing that reaches the journal, the event log or a
        // prompt can carry a recognised credential shape.
        self.diffStat = String(SecretRedactor.redact(diffStat).prefix(Self.maxStatChars))
        self.diff = String(SecretRedactor.redact(diff).prefix(Self.maxDiffChars))
        self.replySummary = String(SecretRedactor.redact(replySummary)
            .trimmingCharacters(in: .whitespacesAndNewlines).prefix(Self.maxReplyChars))
        self.failureSetBefore = failureSetBefore
        self.resultingFailureSet = resultingFailureSet
        self.resultingPassed = resultingPassed
    }

    var isSettled: Bool { resultingFailureSet != nil || resultingPassed != nil }
}

enum LoopAttemptLedger {
    /// Attempts quoted in a prompt.
    static let maxEntries = 3
    /// The whole ledger block, headings included.
    static let maxBlockChars = 6_000

    private static let secretDirs: Set<String> = [
        "secrets", ".secrets", "credentials", ".ssh", ".aws", ".gnupg", ".kube"]

    /// True for paths whose contents must never be quoted into a prompt or the
    /// journal: secrets, keys, credentials, and the protected set. Any path
    /// COMPONENT naming a secrets directory counts, not just the file name.
    static func isUnquotable(_ path: String, protectedGlobs: [String]) -> Bool {
        let parts = path.lowercased().split(separator: "/").map(String.init)
        if parts.dropLast().contains(where: { secretDirs.contains($0) }) { return true }
        let name = parts.last ?? ""
        if name == ".env" || name.hasPrefix(".env.") || name == ".envrc" || name.hasSuffix(".pem")
            || name.hasSuffix(".key") || name.hasSuffix(".p12") || name.hasSuffix(".keystore")
            || name.hasSuffix(".tfvars") || name == ".pgpass" || name == "kubeconfig"
            || (name.hasPrefix("service-account") && name.hasSuffix(".json"))
            || name.hasPrefix("id_") || name.contains("credential") || name.contains("secret")
            || name == ".npmrc" || name == ".netrc" { return true }
        return protectedGlobs.contains { GlobMatch.matches(path: path, pattern: $0) }
    }

    /// The prompt block for `entries` (oldest first), or "" when there are none.
    /// Bounded to `budget`: the diffs shrink first, then the oldest attempts
    /// drop — but never the last one, which is cut to fit instead.
    static func block(_ entries: [LoopLedgerEntry], priorRun: Bool = false,
                      budget: Int = maxBlockChars) -> String {
        var kept = Array(entries.suffix(maxEntries))
        guard !kept.isEmpty else { return "" }
        let header = priorRun
            ? "A previous run already tried these fixes for this same failure. Those marked as failed did not "
              + "work. Do something different:"
            : "These earlier attempts in this run did not work, except any marked as fixed-but-returned. "
              + "Do something different:"
        for limit in [LoopLedgerEntry.maxDiffChars, 1_500, 500, 0] {
            while true {
                let text = render(header, kept, diffLimit: limit)
                if text.count <= budget { return text }
                if limit == 0, kept.count > 1 { kept.removeFirst() } else { break }
            }
        }
        return String(render(header, kept, diffLimit: 0).prefix(budget))
    }

    private static func render(_ header: String, _ entries: [LoopLedgerEntry], diffLimit: Int) -> String {
        var lines = ["", header]
        for e in entries {
            lines.append("--- attempt \(e.n) ---")
            lines.append("Files changed: " + pathList(e.changedPaths))
            if e.resultingPassed == true {
                lines.append("Result: the stage passed after it (this attempt fixed it, but the failure returned).")
            } else if let after = e.resultingFailureSet {
                lines.append(after == e.failureSetBefore ? "Result: failed — the same failures remained."
                                                         : "Result: failed — the failure set changed but it still failed.")
            }
            if !e.diffStat.isEmpty { lines.append(SecretRedactor.redact(e.diffStat)) }
            if diffLimit > 0, !e.diff.isEmpty { lines.append(String(SecretRedactor.redact(e.diff).prefix(diffLimit))) }
            if !e.replySummary.isEmpty { lines.append("You said: \(SecretRedactor.redact(e.replySummary))") }
        }
        return lines.joined(separator: "\n") + "\n"
    }

    private static func pathList(_ paths: [String]) -> String {
        guard !paths.isEmpty else { return "none" }
        let shown = paths.prefix(LoopLedgerEntry.maxPathsListed).joined(separator: ", ")
        let more = paths.count - LoopLedgerEntry.maxPathsListed
        return more > 0 ? shown + " +\(more) more" : shown
    }

    /// True when the failure set `current` is back after two repairs that made
    /// DIFFERENT edits: the last two attempts both started from `current` (so
    /// the first one's change did not hold) and their diffs differ. Another
    /// repair would be a third guess at a failure two distinct fixes missed.
    static func returnedAfterDifferentDiffs(_ entries: [LoopLedgerEntry], current: String) -> Bool {
        guard entries.count >= 2 else { return false }
        let a = entries[entries.count - 2], b = entries[entries.count - 1]
        guard a.failureSetBefore == current, b.failureSetBefore == current else { return false }
        func signature(_ e: LoopLedgerEntry) -> String { e.changedPaths.sorted().joined(separator: "\n") + "\u{0}" + e.diff }
        let (sa, sb) = (signature(a), signature(b))
        return sa != sb && (!a.changedPaths.isEmpty || !b.changedPaths.isEmpty)
    }

    /// The entries a prior run's record offers for `stageId` when that run's
    /// last attempt at the stage failed with `failureSet` — the same set this
    /// run just hit. Empty otherwise.
    static func priorRunEntries(in record: LoopRunRecord, stageId: String,
                                failureSet: String) -> [LoopLedgerEntry] {
        let attempts = record.iterations.flatMap(\.attempts).filter { $0.stageId == stageId }
        guard let last = attempts.last, !last.passed, last.outputHash == failureSet else { return [] }
        return Array(attempts.compactMap(\.ledger).filter { $0.failureSetBefore == failureSet }.suffix(maxEntries))
    }
}
