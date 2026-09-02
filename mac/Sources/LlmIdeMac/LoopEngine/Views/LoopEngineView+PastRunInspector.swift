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
            Text("\(AppDateFormatter.hourMinuteSecond(record.startedAt)) · \(record.trigger.rawValue) · \(record.iterationsUsed) iter · \(Int(record.durationSeconds))s")
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
                    Text("repair · \(attempt.scopeVerdict.rawValue)")
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

    @ViewBuilder
    private func pastRunChangedFiles(_ record: LoopRunRecord) -> some View {
        let t = theme.current
        let paths = Array(Set(record.iterations.flatMap { $0.attempts.flatMap(\.changedPaths) })).sorted()
        if !paths.isEmpty {
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
