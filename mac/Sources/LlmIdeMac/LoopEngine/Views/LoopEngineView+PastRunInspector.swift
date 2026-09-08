// Past-run detail inspector (log pane, panel 3). Click a row under PAST RUNS
// to read the durable journal record — outcome, config snapshot, per-stage
// attempts, failure output, and files changed. Live log returns via Back.

import SwiftUI

extension LoopEngineView {

    @ViewBuilder
    func pastRunInspector(_ record: LoopRunRecord) -> some View {
        let t = theme.current
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.md) {
                pastRunSummaryHeader(record)
                pastRunBudgets(record)
                pastRunIterations(record)
                pastRunChangedFiles(record)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Spacing.md)
            .padding(.vertical, Spacing.sm)
        }
        .background(t.surface)
    }

    @ViewBuilder
    private func pastRunSummaryHeader(_ record: LoopRunRecord) -> some View {
        let t = theme.current
        let ok = record.statusCode == "success"
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Circle()
                    .fill(ok ? t.success : t.danger)
                    .frame(width: 6, height: 6)
                Text(record.statusSummary)
                    .font(Typography.bodyStrong)
                    .foregroundStyle(t.text)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text("\(LoopEngineView.runStamp(record.startedAt)) · \(record.trigger.rawValue) · \(record.iterationsUsed) iter · \(Int(record.durationSeconds))s")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(t.textMuted)
            if let name = record.loopName, !name.isEmpty {
                Text(name)
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
            }
            Text(record.gitRoot)
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(t.textMuted)
                .lineLimit(2)
                .truncationMode(.middle)
        }
    }

    @ViewBuilder
    private func pastRunBudgets(_ record: LoopRunRecord) -> some View {
        let t = theme.current
        let cfg = record.config
        let wall = cfg.wallClockBudgetSeconds.map { "\(Int($0 / 60)) min" } ?? "no limit"
        Text("Budgets: \(cfg.maxIterations) iter · stop after \(cfg.consecutiveFailureStop) non-improving · \(wall) · \(cfg.maxRepairsPerStage) repairs/stage · protected: \(cfg.protectedPathPolicy.rawValue)")
            .font(.system(size: 9, design: .monospaced))
            .foregroundStyle(t.textMuted)
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private func pastRunIterations(_ record: LoopRunRecord) -> some View {
        let t = theme.current
        if record.iterations.isEmpty {
            Text("No stages executed.")
                .font(Typography.caption)
                .foregroundStyle(t.textMuted)
        } else {
            ForEach(record.iterations, id: \.index) { iteration in
                VStack(alignment: .leading, spacing: 4) {
                    Text("Iteration \(iteration.index)")
                        .font(Typography.caption.weight(.semibold))
                        .foregroundStyle(t.textMuted)
                    ForEach(Array(iteration.attempts.enumerated()), id: \.offset) { _, attempt in
                        pastRunAttemptRow(attempt)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func pastRunAttemptRow(_ attempt: LoopStageAttempt) -> some View {
        let t = theme.current
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(attempt.passed ? "✓" : "✗")
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .foregroundStyle(attempt.passed ? t.success : t.danger)
                Text(attempt.stageName)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(t.text)
                if let score = attempt.score {
                    Text("\(score) failing")
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundStyle(t.textMuted)
                }
                Text(String(format: "%.1fs", attempt.durationSeconds))
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(t.textMuted)
                if attempt.repairAttempted {
                    // Repair index + wall clock: the only per-repair cost
                    // signal obtainable here (the code-assist response
                    // carries no token or price data at all), and the one
                    // that answers "where did this run's time go" — a
                    // stage's own `durationSeconds` excludes its repair.
                    Text(repairLabel(attempt))
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundStyle(t.accent4)
                }
                Spacer(minLength: 0)
            }
            if !attempt.changedPaths.isEmpty {
                Text(attempt.changedPaths.joined(separator: ", "))
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(t.textMuted)
                    .lineLimit(2)
            }
            if !attempt.passed, !attempt.outputTail.isEmpty {
                Text(attempt.outputTail)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(t.danger.opacity(0.9))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 14)
            }
        }
        .padding(.vertical, 2)
    }

    /// The run's changed paths, now reviewable and committable rather than a
    /// bare list (see `LoopRunChangesReview` for why the diff is read live).
    /// Falls back to the plain list when no git working tree is resolvable —
    /// the paths are still the useful part of the record.
    @ViewBuilder
    private func pastRunChangedFiles(_ record: LoopRunRecord) -> some View {
        let t = theme.current
        let paths = Array(Set(record.iterations.flatMap { $0.attempts.flatMap(\.changedPaths) })).sorted()
        if !paths.isEmpty {
            if let gitRoot = activeGitRootURL {
                LoopRunChangesReview(
                    gitRoot: gitRoot,
                    paths: paths,
                    ranInDifferentCheckout: Self.ranElsewhere(record, gitRoot: gitRoot),
                    defaultMessage: Self.commitMessage(for: record, fileCount: paths.count))
                    // Per-record identity: without it, selecting a different
                    // past run reuses this instance — same `gitRoot`, so its
                    // `.task` never re-fires — and the review keeps the
                    // previous run's loaded diffs, commit note, and (worse)
                    // its stale git status, which makes every path read
                    // "no longer modified".
                    .id(record.id)
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Files changed")
                        .font(Typography.caption.weight(.semibold))
                        .foregroundStyle(t.textMuted)
                    ForEach(paths, id: \.self) { path in
                        Text(path)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(t.text)
                    }
                }
            }
        }
    }

    /// "repair 2 · 41s · clean" — index and duration are omitted when the
    /// record predates those fields, so an older journal entry still reads
    /// correctly instead of showing "repair 0 · 0s".
    private func repairLabel(_ attempt: LoopStageAttempt) -> String {
        var parts = ["repair"]
        if let index = attempt.repairAttemptIndex { parts[0] = "repair \(index)" }
        if let seconds = attempt.repairDurationSeconds {
            parts.append("\(Int(seconds))s")
        }
        parts.append(attempt.scopeVerdict.rawValue)
        return parts.joined(separator: " · ")
    }

    /// Whether the run worked against a checkout other than the one open now.
    ///
    /// Symlinks are resolved on both sides because the two paths come from
    /// different resolvers — a run records `runGitRoot.path` while this view
    /// holds `WorkspaceRoot`'s pick — and `/tmp` vs `/private/tmp` alone
    /// would otherwise label a perfectly reviewable run as "elsewhere".
    static func ranElsewhere(_ record: LoopRunRecord, gitRoot: URL) -> Bool {
        let recorded = URL(fileURLWithPath: record.gitRoot).resolvingSymlinksInPath().path
        return recorded != gitRoot.resolvingSymlinksInPath().path
    }

    /// Seed commit message naming the loop that produced the changes — the
    /// point being that a commit from here is attributable to a Loop run
    /// rather than appearing as an anonymous edit.
    ///
    /// "changed", not "repaired": a generate/skill stage records
    /// `changedPaths` without ever attempting a repair, so those paths reach
    /// this message having been written rather than fixed. The type stays
    /// `chore` for the same reason — the seed cannot know whether the run
    /// produced a fix, docs, or a refactor, and the user edits it anyway.
    static func commitMessage(for record: LoopRunRecord, fileCount: Int) -> String {
        let loop = (record.loopName?.isEmpty == false) ? record.loopName! : "Loop"
        return "chore(loop): \(loop) changed \(fileCount) file(s)"
    }
}
