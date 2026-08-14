import Foundation

/// Writes a human-readable summary of a finished run into the Library.
///
/// The journal (`LoopRunJournal`) is machine-shaped: one JSON file per run, meant
/// for tooling and audits. This is the other half — a markdown note under
/// `llm-doc/loop/<yyyy>/<MM>/`, indexed by `NoteService` like every other
/// generated note, so a loop run becomes something a person can read, search, and
/// link to alongside meeting and email notes rather than a file they have to know
/// to go looking for.
///
/// **Fail-open, exactly like the journal.** Writing a note is an observation of
/// the work, never a gate on it; a failure is reported as a string for the caller
/// to log and ignore.
protocol LoopRunSummaryWriting: AnyObject {
    /// Writes the summary for `record` beneath `root`.
    func write(_ record: LoopRunRecord, root: URL) async -> LoopSummaryNoteResult
}

/// Outcome of a summary-note write. A dedicated type rather than
/// `Result<String, String>`, since the failure here is a diagnostic string to
/// show the user, not a thrown `Error` — the same reason `RepairScopeGuard` has
/// its own `Probe`.
enum LoopSummaryNoteResult: Equatable {
    /// Repo-relative path of the written note.
    case written(path: String)
    case failed(reason: String)
}

/// Production writer, going through the same `NoteService` the Source Connectors
/// use so the note lands in the Library index rather than as a loose file.
final class NoteLoopRunSummaryWriter: LoopRunSummaryWriting {
    /// `llm-doc/loop/` — a note type of its own, so loop output is filterable and
    /// never mixed in with meeting or email notes.
    static let noteType = NoteType("loop")

    private static let filenameFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd-HHmmss"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    func write(_ record: LoopRunRecord, root: URL) async -> LoopSummaryNoteResult {
        let service = NoteService(repoRoot: root)
        let title = "Loop run — \(record.statusSummary)"
        let filename = "loop-\(Self.filenameFormatter.string(from: record.startedAt)).md"
        let markdown = Self.render(record, title: title)

        let metadata = NoteMetadata(
            id: "", type: Self.noteType, source: "loop-engineering", title: title,
            date: AppDateFormatter.isoString(record.startedAt), path: "", rawFile: nil,
            // The journal record is this note's machine-readable counterpart; the
            // run id doubles as the dedup key so a re-write cannot fan out.
            sourceHash: record.id,
            generatedAt: AppDateFormatter.isoString(record.endedAt),
            // Tagged by outcome so the Library can filter "show me the blocked
            // runs" without opening any of them.
            tags: [record.statusCode, record.trigger.rawValue],
            participants: nil, fileSize: 0)

        do {
            let saved = try await service.saveNote(
                type: Self.noteType, filename: filename,
                content: Data(markdown.utf8), metadata: metadata)
            return .written(path: saved.path)
        } catch {
            return .failed(reason: error.localizedDescription)
        }
    }

    /// The note body. Static + pure so its shape is unit-testable without a disk.
    static func render(_ record: LoopRunRecord, title: String) -> String {
        var md = """
        ---
        source: loop-engineering
        noteType: \(noteType.rawValue)
        noteWorthy: true
        date: \(AppDateFormatter.isoString(record.startedAt))
        status: \(record.statusCode)
        trigger: \(record.trigger.rawValue)
        runId: \(record.id)
        ---

        # \(title)

        **Outcome:** \(record.statusSummary)
        **Trigger:** \(record.trigger.rawValue)
        **Repo:** `\(record.gitRoot)`
        **Duration:** \(Int(record.durationSeconds))s over \(record.iterationsUsed) iteration(s)

        ## Pipeline

        """

        for stage in record.config.stages {
            let role = stage.kind == .skill ? "generate" : "verify"
            let severity = stage.severity == .advisory ? ", advisory" : ""
            // `enabled == false` is the only skip marker; nil (pre-field
            // records) means the stage ran normally. Without this, a disabled
            // stage reads as "ran and was fine" — it appears in the pipeline
            // but has no row in the iterations table below.
            let skipped = stage.enabled == false ? ", disabled — skipped" : ""
            let detail = stage.command ?? stage.skillId ?? "fault sweep"
            md += "- **\(stage.name)** (\(role)\(severity)\(skipped)) — `\(detail)`\n"
        }

        md += """

        Budgets: \(record.config.maxIterations) iterations · \
        stop after \(record.config.consecutiveFailureStop) non-improving · \
        \(record.config.wallClockBudgetSeconds.map { "\(Int($0 / 60)) min" } ?? "no time limit") · \
        \(record.config.maxRepairsPerStage) repairs/stage · \
        protected paths: \(record.config.protectedPathPolicy.rawValue)

        ## Iterations

        """

        if record.iterations.isEmpty {
            md += "_The run ended before any stage executed._\n"
        }
        for iteration in record.iterations {
            md += "\n### Iteration \(iteration.index)\n\n"
            md += "| Stage | Result | Failing | Took | Repair |\n|---|---|---|---|---|\n"
            for attempt in iteration.attempts {
                let result = attempt.passed ? "pass" : "FAIL\(attempt.exitCode.map { " (exit \($0))" } ?? "")"
                let score = attempt.score.map(String.init) ?? "—"
                let repair = attempt.repairAttempted
                    ? "yes · \(attempt.scopeVerdict.rawValue)"
                    : "—"
                md += "| \(attempt.stageName) | \(result) | \(score) | \(String(format: "%.1f", attempt.durationSeconds))s | \(repair) |\n"
            }
        }

        // Only the paths the guard could attribute to an agent edit — the answer
        // to "what did this run actually change", which is the first thing anyone
        // reading a loop summary wants to know.
        let changed = record.iterations
            .flatMap { $0.attempts }
            .flatMap { $0.changedPaths }
        if !changed.isEmpty {
            md += "\n## Files changed\n\n"
            for path in Array(Set(changed)).sorted() {
                md += "- `\(path)`\n"
            }
        }

        let violations = record.iterations
            .flatMap { $0.attempts }
            .filter { $0.scopeVerdict == .violated || $0.scopeVerdict == .violatedReverted }
        if !violations.isEmpty {
            md += "\n## Protected-path violations\n\n"
            for attempt in violations {
                md += "- **\(attempt.stageName)** — \(attempt.scopeVerdict.rawValue)\n"
            }
            md += "\nA stage that turned green only after one of these edits is reported blocked, not fixed.\n"
        }

        md += "\n## Journal\n\n`system/loop-runs/` · run id `\(record.id)`\n"
        return md
    }
}
