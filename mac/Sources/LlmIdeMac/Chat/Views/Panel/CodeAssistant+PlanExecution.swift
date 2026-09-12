import SwiftUI

extension CodeAssistantPanel {

    /// `planContent` is the SAME resolved body the execute prompt was built
    /// from (`planContentForExecute`), not `payload.planContent` — re-deriving
    /// it here would let the tracker's step list disagree with the step list
    /// the agent was actually told to execute whenever the card carries no
    /// plan text and the body came off the attached file.
    @MainActor
    func beginPlanExecution(messageId: UUID, payload: ChatMessage.ToolResultPayload, planContent content: String) {
        let steps = Self.parsePlanSteps(from: content)
        let title = payload.planTitle ?? Self.planTitle(from: content)
        engine.agent.planExecution = CodeAssistantAgentState.PlanExecutionTracker(
            planTitle: title,
            steps: steps,
            planCardMessageId: messageId
        )
    }

    @MainActor
    func dismissPlanExecution() {
        engine.agent.planExecution = nil
        // The run is over, however it ended — hand the picker back so the
        // next message is classified on its own merits instead of staying an
        // Execute turn forever. See `releaseStickyMode`.
        releaseStickyMode(from: [.execute, .plan, .assistPlan])
    }

    @MainActor
    func reviewPlanExecutionChanges() {
        NotificationCenter.default.post(
            name: .openSection,
            object: ShellState.Section.sourceControl.rawValue
        )
    }

    @MainActor
    func commitPlanExecutionChanges() async {
        guard let root = config.activeRepoLocalURL, WorkspaceRoot.isGitRepo(root) else {
            engine.error = "Open a git repository to commit plan changes."
            return
        }
        let title = engine.agent.planExecution?.planTitle ?? "Plan execution"
        let message = "feat: \(title)"
        let svc = SourceControlService()
        svc.config = config
        await svc.refresh(root: root)
        // A clean tree is a state, not a failure. It is also the COMMON case
        // after an execution: the agent has Bash and usually commits its own
        // work — sometimes on another branch, which is worth saying, because
        // "nothing to commit" over a reply that names a commit hash reads as
        // "nothing happened". Reported as a notice, and the card is done.
        if svc.state.files.isEmpty {
            let branch = svc.state.branch.map { " on \($0)" } ?? ""
            attachNotice = "Nothing to commit — the working tree\(branch) is clean. If the agent "
                + "committed its own work, it is already in git (see Source Control); it may "
                + "have committed on a different branch."
            dismissPlanExecution()
            return
        }
        // Committing is the end of the run too; `dismissPlanExecution` below
        // releases the mode on the success path.
        guard await svc.commit(root: root, message: message) else {
            engine.error = svc.state.opError ?? svc.state.error ?? "Commit failed."
            return
        }
        dismissPlanExecution()
    }
}
