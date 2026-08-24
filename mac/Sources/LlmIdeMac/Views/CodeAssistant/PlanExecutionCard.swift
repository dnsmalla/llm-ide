import SwiftUI

/// Plan execution UX: total step count, one current step at a time, then a
/// Review/Commit finish card. Replaces the full task checklist during runs
/// started from PlanSavedCard.
struct PlanExecutionCard: View {
    let tracker: CodeAssistantAgentState.PlanExecutionTracker
    let liveTasks: [AgentTask]
    let onReview: () -> Void
    let onCommit: () -> Void
    let onDismiss: () -> Void

    @EnvironmentObject var theme: ThemeStore

    private var tasks: [AgentTask] {
        liveTasks.isEmpty ? tracker.lastTasks : liveTasks
    }

    private var total: Int {
        max(tracker.totalSteps, tasks.count, 1)
    }

    private var completed: Int {
        tasks.filter { $0.status == .completed || $0.status == .skipped }.count
    }

    private var currentTitle: String? {
        if let active = tasks.first(where: { $0.status == .inProgress }) {
            return active.title
        }
        if let next = tasks.first(where: { $0.status == .pending }) {
            return next.title
        }
        if completed < tracker.steps.count {
            return tracker.steps[completed]
        }
        return tracker.steps.last
    }

    private var currentIndex: Int {
        min(completed + (tasks.contains(where: { $0.status == .inProgress }) ? 1 : 0), total)
    }

    var body: some View {
        switch tracker.phase {
        case .running:
            runningCard
        case .finished:
            completeCard(failed: false)
        case .failed:
            completeCard(failed: true)
        }
    }

    private var runningCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "list.bullet.clipboard")
                    .font(.system(size: 11))
                    .foregroundStyle(theme.current.accent)
                Text(tracker.planTitle)
                    .font(.system(size: 12, weight: .semibold))
                    .lineLimit(1)
                Spacer(minLength: 0)
                Text("\(total) steps")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(theme.current.textMuted)
            }
            ProgressView(value: Double(completed), total: Double(total))
                .tint(theme.current.accent)
            Text("Step \(max(currentIndex, 1)) of \(total)")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(theme.current.textMuted)
            if let title = currentTitle {
                HStack(alignment: .top, spacing: 8) {
                    ProgressView()
                        .controlSize(.small)
                        .frame(width: 14, height: 14)
                    Text(title)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(theme.current.text)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(12)
        .background(theme.current.surface)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(theme.current.border, lineWidth: 1))
        .cornerRadius(8)
        .frame(maxWidth: 720, alignment: .leading)
    }

    private func completeCard(failed: Bool) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: failed ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                    .foregroundStyle(failed ? theme.current.danger : theme.current.success)
                Text(failed ? "Plan execution stopped" : "Execution finished")
                    .font(.system(size: 13, weight: .semibold))
            }
            Text(failed
                 ? "\(completed)/\(total) steps completed before a failure."
                 : "All \(total) steps completed for \"\(tracker.planTitle)\".")
                .font(.system(size: 12))
                .foregroundStyle(theme.current.textMuted)
            if !failed {
                HStack(spacing: 8) {
                    Button(action: onReview) {
                        Label("Review changes", systemImage: "arrow.triangle.branch")
                            .font(.system(size: 12))
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    Button(action: onCommit) {
                        Label("Commit", systemImage: "checkmark.circle")
                            .font(.system(size: 12, weight: .medium))
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    Spacer(minLength: 0)
                    Button("Dismiss", action: onDismiss)
                        .buttonStyle(.plain)
                        .font(.system(size: 11))
                        .foregroundStyle(theme.current.textMuted)
                }
            } else {
                Button("Dismiss", action: onDismiss)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
        }
        .padding(12)
        .background(theme.current.surface2)
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(theme.current.border, lineWidth: 1))
        .cornerRadius(10)
        .frame(maxWidth: 720, alignment: .leading)
    }
}
