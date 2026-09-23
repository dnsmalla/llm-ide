import Foundation

/// Tracks one saved-plan execute run in the chat UI. The engine drives the
/// state machine through the four methods below so it never needs to know
/// the transition rules itself — see `ChatEngine.finishStreamingTurn`,
/// `applyLiveTasks`, and `updatePlanExecution`.
public struct PlanExecutionTracker: Equatable {
    public enum Phase: String, Equatable {
        case running
        case finished
        case failed
    }

    public var planTitle: String
    public var steps: [String]
    public var planCardMessageId: UUID
    public var phase: Phase = .running
    /// Snapshot kept when execution ends (live `agentPendingTasks` clears on the next turn).
    public var lastTasks: [AgentTask] = []

    /// Where the post-execution code review has got to. Separate from
    /// `phase` on purpose: the review is a turn that runs AFTER the
    /// execution tracker has already settled, and `apply(tasks:continueNeeded:pendingToolParked:)`
    /// only touches a `.running` tracker — so the finish card stays up,
    /// unchanged, while its own review streams underneath it.
    public enum ReviewPhase: String, Equatable {
        case none
        case running
        case done
    }

    public var reviewPhase: ReviewPhase = .none
    /// The review reply, kept so the verdict strip can show the findings
    /// without hunting the transcript for the message again.
    public var reviewSummary: String = ""
    /// Parsed from `reviewSummary` by `PlanReviewPolicy.verdict(from:)`.
    public var reviewVerdict: PlanReviewVerdict?
    /// The branch the review was taken against ("main"), for wording.
    public var reviewBaseBranch: String?

    /// What a Push would commit, resolved when the button is tapped and
    /// shown in the confirmation. Push commits the WHOLE working tree
    /// (`SourceControlService.commit` runs `git add -A` when nothing is
    /// staged) and the status it reads includes untracked files — so
    /// anything sitting in the repo that the plan never touched goes
    /// along, under the plan's name, into the default branch, to origin.
    /// "Any uncommitted changes are committed" was true and still did not
    /// tell anyone that. Naming the files is what makes it a decision.
    public var pendingCommitFiles: [String] = []

    /// Push is offered once a review has RUN — see
    /// `PlanReviewPolicy.allowsPush(reviewed:)`.
    public var hasReviewed: Bool { reviewPhase == .done }

    public var totalSteps: Int { max(steps.count, lastTasks.count) }

    public init(planTitle: String, steps: [String], planCardMessageId: UUID) {
        self.planTitle = planTitle
        self.steps = steps
        self.planCardMessageId = planCardMessageId
    }

    /// A turn ended without the chain continuing (Stop, error, auto-continue
    /// ceiling). Returns true when this settled a running tracker.
    ///
    /// `.failed` is the honest phase: its card reads "Plan execution
    /// stopped" and carries the Dismiss a `.running` card doesn't have.
    public mutating func settleInterrupted() -> Bool {
        guard phase == .running else { return false }
        phase = .failed
        return true
    }

    /// Live task list mid-turn; only a running tracker records it.
    ///
    /// Display only: it moves the task list and the plan-execute progress
    /// bar WHILE the turn runs — a plan-execute turn can work its way
    /// through dozens of steps before it ends, and until this arrived the
    /// card reported "Step 1 of 30" for all of them.
    ///
    /// Deliberately separate from `apply(tasks:continueNeeded:pendingToolParked:)`:
    /// that method owns the tracker's phase transitions, and every one of
    /// them is wrong mid-turn. `.finished` would fire the moment the last
    /// task flips to completed, replacing the still-running card with a
    /// Review/Commit card; `.failed` would do the same on a task the agent
    /// marked failed and then recovered from. The turn's own end is the
    /// only honest place to settle the phase.
    public mutating func noteLiveTasks(_ tasks: [AgentTask]) {
        guard phase == .running, !tasks.isEmpty else { return }
        lastTasks = tasks
    }

    /// Terminal task list for a turn. Returns true when the run is genuinely
    /// over and the mode picker may be released.
    public mutating func apply(tasks: [AgentTask], continueNeeded: Bool?, pendingToolParked: Bool) -> Bool {
        guard phase == .running else { return false }
        if !tasks.isEmpty { lastTasks = tasks }
        if tasks.contains(where: { $0.status == .failed }) {
            phase = .failed
        } else if !tasks.contains(where: { $0.status == .pending || $0.status == .inProgress }),
                  continueNeeded != true,
                  // A plan executed via direct tool calls (bash/file edits)
                  // without ever touching the session task-list leaves
                  // `tasks` empty for the whole run — an empty list must be
                  // able to finish here too, or the tracker never leaves
                  // `.running` and the card spins forever under the turn's
                  // own already-delivered final answer. But an empty list
                  // carries no evidence of its own, so it settles the
                  // tracker only when the turn itself ended the chain:
                  // `continueNeeded` came back an explicit false (an
                  // external turn's hard-coded nil means "don't chain", not
                  // "the chain ended") and no proposal is parked waiting
                  // for an answer (a legacy update-file/bash card mid-plan
                  // also arrives with an empty list).
                  !tasks.isEmpty || (continueNeeded == false && !pendingToolParked) {
            phase = .finished
        }
        // Release only when the run is genuinely OVER — never while the chain
        // is about to send "Continue working…" (see ChatEngine.finishStreamingTurn).
        // A task the agent marked `.failed` settles the tracker even
        // mid-run, and when `continueNeeded` is true the engine is about to
        // send "Continue working on your pending tasks." — handing the
        // picker back now would send that continuation as `auto`, to be
        // re-classified, possibly into a tool-restricted mode that cannot
        // finish the edits it is in the middle of.
        return phase != .running && continueNeeded != true
    }

    /// A review turn ended without landing. Returns true when it was running.
    ///
    /// Same reasoning as `settleInterrupted()`: a stopped or failed review
    /// would otherwise leave the finish card spinning "Reviewing…" forever,
    /// with Push locked behind it.
    public mutating func releaseInterruptedReview() -> Bool {
        guard reviewPhase == .running else { return false }
        reviewPhase = .none
        return true
    }
}

extension ChatEngine {
    /// The action a saved-plan card should show as in progress, derived from
    /// live state instead of the tap persisted on the message.
    ///
    /// Persisted, the lock outlived everything that could end it: a run that
    /// failed or was dismissed, an app restart (no live run at all), or an
    /// "Edit in chat" the user never followed with a message all left the
    /// card on "Executing plan…" / "Editing in chat…" with no buttons, so
    /// the plan could never be run again. Execute now reads as in progress
    /// only while THIS card's run is queued or running; Edit never locks.
    func livePlanCardAction(for cardId: UUID,
                            persisted: ChatMessage.PlanCardAction?) -> ChatMessage.PlanCardAction? {
        guard persisted == .execute else { return nil }
        if let run = agent.planExecution, run.planCardMessageId == cardId, run.phase == .running {
            return .execute
        }
        if queued.contains(where: { $0.planTracker?.planCardMessageId == cardId }) { return .execute }
        return nil
    }
}
