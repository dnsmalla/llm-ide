import SwiftUI

/// What the finish card may CLAIM, decided from evidence. Kept out of the
/// View so `chat-contract-lab` can assert it (this toolchain has no XCTest).
///
/// The tracker reaches `.finished` when the turn ends with nothing pending
/// — which is also what happens when the agent does one step, asks "ready
/// for step 2?" and stops. The card used to render that as "All 7 steps
/// completed": a claim it had no evidence for, over a reply that said the
/// opposite. Evidence is the task list (`task-create`/`task-update`); with
/// none, the honest statement is that the TURN finished and progress was
/// not tracked, and the reader should trust the agent's own summary.
public enum PlanExecutionSummaryPolicy {
    public struct Summary: Equatable {
        public let title: String
        public let body: String
    }

    public static func summary(planTitle: String, total: Int, completed: Int,
                               hasTaskState: Bool, failed: Bool) -> Summary {
        if failed {
            return Summary(title: "Plan execution stopped",
                           body: "\(completed)/\(total) steps completed before a failure.")
        }
        guard hasTaskState else {
            return Summary(
                title: "Execution turn finished",
                body: "The agent did not report step-by-step progress, so the \(total) steps of "
                    + "\"\(planTitle)\" could not be tracked. Read its summary above — if it stopped "
                    + "early, reply to continue.")
        }
        if completed >= total {
            return Summary(title: "Execution finished",
                           body: "All \(total) steps completed for \"\(planTitle)\".")
        }
        return Summary(
            title: "Execution turn finished",
            body: "\(completed) of \(total) steps completed for \"\(planTitle)\". The agent stopped "
                + "with work remaining — reply to continue.")
    }
}

/// Plan execution UX: total step count, one current step at a time, then a
/// Review/Push finish card. Replaces the full task checklist during runs
/// started from PlanSavedCard.
///
/// The finish card's three actions are ordered by the workflow they belong
/// to: **Review** runs the code-review skill over the diff this execution
/// produced, **Push** merges the branch into the default branch and pushes
/// it, **Dismiss** drops the card. Push is disabled until a review has run —
/// merging to main is the one op allowed to reach `origin/<default>`, and
/// doing it on an unreviewed agent-written change is exactly the mistake this
/// card exists to prevent.
struct PlanExecutionCard: View {
    let tracker: CodeAssistantAgentState.PlanExecutionTracker
    let liveTasks: [AgentTask]
    /// The engine's live status line ("Running xcodebuild…"), shown under the
    /// current step while the turn is working. The step title says WHICH step
    /// the agent is on; this says what it is doing inside it — without it a
    /// step that takes four minutes of tool calls looks identical to a stuck
    /// one. Nil when the turn is idle (between auto-continue hops).
    let statusLine: String?
    let onReview: () -> Void
    /// Merge this branch into the default branch and push. Destructive tier —
    /// the confirmation dialog below is what `RepoManager.runGitOp`'s
    /// `merge_to_main` contract requires of its caller.
    let onPush: () -> Void
    let onDismiss: () -> Void

    @EnvironmentObject var theme: ThemeStore
    /// Expands the review findings under the verdict strip.
    @State private var reviewExpanded = false
    @State private var confirmingPush = false

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

    private var fraction: Double {
        total > 0 ? Double(completed) / Double(total) : 0
    }

    /// Whether the server has told us anything about task state yet. Before
    /// the first `tasks_progress` event the bar is honestly at zero of a
    /// known total — but on a server too old to send them it would STAY
    /// there for the whole run, so the card says "starting…" rather than
    /// showing a step counter it cannot advance.
    private var hasTaskState: Bool { !tasks.isEmpty }

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
            HStack(spacing: 6) {
                Text(hasTaskState ? "Step \(max(currentIndex, 1)) of \(total)" : "Starting…")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(theme.current.textMuted)
                if hasTaskState {
                    Text("·")
                        .font(.system(size: 11))
                        .foregroundStyle(theme.current.textMuted)
                    Text("\(completed) done · \(Int((fraction * 100).rounded()))%")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(theme.current.textMuted)
                }
                Spacer(minLength: 0)
            }
            if let title = currentTitle {
                HStack(alignment: .top, spacing: 8) {
                    ProgressView()
                        .controlSize(.small)
                        .frame(width: 14, height: 14)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(theme.current.text)
                            .fixedSize(horizontal: false, vertical: true)
                        if let statusLine, !statusLine.isEmpty {
                            Text(statusLine)
                                .font(.system(size: 11))
                                .foregroundStyle(theme.current.textMuted)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
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
        let summary = PlanExecutionSummaryPolicy.summary(
            planTitle: tracker.planTitle, total: total, completed: completed,
            hasTaskState: hasTaskState, failed: failed)
        // Green only for a claim backed by evidence: every tracked step done.
        let verified = !failed && hasTaskState && completed >= total
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: failed ? "exclamationmark.triangle.fill"
                      : (verified ? "checkmark.circle.fill" : "flag.checkered"))
                    .foregroundStyle(failed ? theme.current.danger
                                     : (verified ? theme.current.success : theme.current.textMuted))
                Text(summary.title)
                    .font(.system(size: 13, weight: .semibold))
            }
            Text(summary.body)
                .font(.system(size: 12))
                .foregroundStyle(theme.current.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            if !failed {
                if tracker.reviewPhase == .done { reviewVerdictStrip }
                reviewActions
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

    /// What the review concluded, with its findings one click away. Shown
    /// only once a review has actually finished — before that the card makes
    /// no claim about the change at all.
    @ViewBuilder
    private var reviewVerdictStrip: some View {
        let verdict = tracker.reviewVerdict ?? .unclear
        let display = PlanReviewPolicy.display(for: verdict)
        let (icon, tint): (String, Color) = switch verdict {
        case .pass: ("checkmark.seal.fill", theme.current.success)
        case .changesRequested: ("exclamationmark.triangle.fill", theme.current.warning)
        case .unclear: ("questionmark.circle.fill", theme.current.textMuted)
        }
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 11))
                    .foregroundStyle(tint)
                VStack(alignment: .leading, spacing: 2) {
                    Text(display.title)
                        .font(.system(size: 12, weight: .semibold))
                    Text(display.detail)
                        .font(.system(size: 11))
                        .foregroundStyle(theme.current.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            if !tracker.reviewSummary.isEmpty {
                Button {
                    withAnimation(.easeOut(duration: 0.15)) { reviewExpanded.toggle() }
                } label: {
                    Label(reviewExpanded ? "Hide findings" : "Show findings",
                          systemImage: reviewExpanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 11))
                }
                .buttonStyle(.plain)
                .foregroundStyle(theme.current.accent)
                if reviewExpanded {
                    // Plain text, not a markdown web view: this sits inside
                    // the transcript's own lazy stack, and the review reply
                    // is already rendered in full as its own chat turn just
                    // above — this is the copy you read without scrolling.
                    ScrollView {
                        Text(tracker.reviewSummary)
                            .font(.system(size: 11))
                            .foregroundStyle(theme.current.text)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 260)
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.opacity(0.08))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(tint.opacity(0.3), lineWidth: 1))
        .cornerRadius(8)
    }

    private var isReviewing: Bool { tracker.reviewPhase == .running }

    /// Review / Push / Dismiss.
    private var reviewActions: some View {
        HStack(spacing: 8) {
            // Prominent until a review has run (it is the step the card is
            // asking for), then demoted so Push is the obvious next action.
            if tracker.hasReviewed {
                Button(action: onReview) { reviewButtonLabel }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(isReviewing)
                    .help("Run the code-review skill over the changes this execution made")
            } else {
                Button(action: onReview) { reviewButtonLabel }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(isReviewing)
                    .help("Run the code-review skill over the changes this execution made")
            }

            Button { confirmingPush = true } label: {
                Label("Push", systemImage: "arrow.up.circle")
                    .font(.system(size: 12, weight: .medium))
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(!PlanReviewPolicy.allowsPush(reviewed: tracker.hasReviewed) || isReviewing)
            .help(tracker.hasReviewed
                  ? "Commit anything outstanding, merge this branch into the default branch, and push"
                  : "Run the review first — Push merges straight into the default branch")

            Spacer(minLength: 0)
            Button("Dismiss", action: onDismiss)
                .buttonStyle(.plain)
                .font(.system(size: 11))
                .foregroundStyle(theme.current.textMuted)
        }
        .confirmationDialog("Merge into the default branch and push?",
                            isPresented: $confirmingPush, titleVisibility: .visible) {
            Button("Merge & Push", role: .destructive, action: onPush)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(pushConfirmationMessage)
        }
    }

    @ViewBuilder
    private var reviewButtonLabel: some View {
        if isReviewing {
            HStack(spacing: 5) {
                ProgressView().controlSize(.small)
                Text("Reviewing…").font(.system(size: 12))
            }
        } else {
            Label(tracker.hasReviewed ? "Review again" : "Review", systemImage: "checkmark.seal")
                .font(.system(size: 12))
        }
    }

    /// Says what Push is about to do, and warns when the review did not come
    /// back clean — the point at which overriding it becomes a decision.
    private var pushConfirmationMessage: String {
        let base = "Any uncommitted changes are committed, this branch is merged into the "
            + "default branch (fast-forward only), and that branch is pushed to origin."
        guard PlanReviewPolicy.warnsBeforePush(tracker.reviewVerdict) else { return base }
        return "The review did not come back clean. " + base
    }
}
