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
        guard await svc.commit(root: root, message: message) else {
            engine.error = svc.state.opError ?? svc.state.error ?? "Commit failed."
            return
        }
        dismissPlanExecution()
    }
}
