import SwiftUI

/// Live checklist for the current multi-step task, pinned above the
/// assistant's reply. Purely presentational — `tasks` is whatever the
/// server last sent in `CodeAssistantAgentState.agentPendingTasks`; this
/// view owns no state of its own and makes no decisions about auto-run or
/// failure handling (that lives server-side).
///
/// Supersedes the old inline task list that used to live in
/// `ChatComposer.swift`'s `inputBar` (removed in the same commit as this
/// file) — that version was easy to miss (small caption text, no card
/// styling, no collapse) and duplicated this same data in a second place.
/// Icon/color choices mirror what that old code used, for visual
/// consistency with the rest of the app.
struct PlanTimelineCard: View {
    let tasks: [AgentTask]
    @EnvironmentObject var theme: ThemeStore

    private var isRunning: Bool {
        tasks.contains { $0.status == .pending || $0.status == .inProgress }
    }

    private var doneCount: Int {
        tasks.filter { $0.status == .completed || $0.status == .skipped || $0.status == .failed }.count
    }

    private func icon(for status: AgentTaskStatus) -> String {
        switch status {
        case .completed: return "checkmark.circle.fill"
        case .inProgress: return "arrow.trianglehead.clockwise"
        case .skipped: return "minus.circle"
        case .failed: return "xmark.circle.fill"
        case .pending: return "circle"
        }
    }

    private func color(for status: AgentTaskStatus) -> Color {
        switch status {
        case .completed: return theme.current.success
        case .inProgress: return theme.current.info
        case .skipped: return theme.current.textMuted
        case .failed: return theme.current.danger
        case .pending: return theme.current.textMuted
        }
    }

    var body: some View {
        if isRunning {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(tasks) { task in
                    HStack(spacing: 6) {
                        Image(systemName: icon(for: task.status))
                            .font(.system(size: 11))
                            .foregroundStyle(color(for: task.status))
                        Text(task.title)
                            .font(.system(size: 12))
                            .foregroundStyle(task.status == .pending ? theme.current.textMuted : theme.current.text)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        Spacer(minLength: 0)
                    }
                }
            }
            .padding(10)
            .background(theme.current.surface)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(theme.current.border, lineWidth: 1))
            .cornerRadius(8)
            .frame(maxWidth: 720, alignment: .leading)
        } else {
            HStack(spacing: 6) {
                let failed = tasks.contains { $0.status == .failed }
                Image(systemName: failed ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(failed ? theme.current.danger : theme.current.success)
                Text("\(doneCount)/\(tasks.count) steps complete")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(theme.current.textMuted)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(theme.current.surface2)
            .clipShape(Capsule())
        }
    }
}
