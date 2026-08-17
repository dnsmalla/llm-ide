import Foundation

/// The chat's save-plan flow — the one write action the plan-like modes
/// (Plan, Assist Plan) get. Unlike
/// `update-file`/`bash`, this is never gated behind a confirmation sheet or
/// the auto-edit toggle: it can only ever write its own fixed-location plan
/// file under `llm-doc/plans/`, never an arbitrary one, so it always saves
/// automatically the moment it's proposed (see `ChatAutoChainPolicy`).
extension CodeAssistantPanel {

    /// Resolve a `save-plan` proposal against the open project.
    func resolvePlan(_ args: PendingTool.SavePlanArgs) -> Result<ProposedPlan, ProposedPlanError> {
        ProposedPlanResolver.resolve(args: args, projectRoot: activeRepoRoot)
    }

    /// Save the currently pending plan, with no user interaction. Called from
    /// `autoChainPendingAction` for every arriving `save-plan` pendingTool,
    /// and defensively from the chat card's tap handler in case a race ever
    /// left one on screen.
    ///
    /// Unlike `confirmUpdateFile`'s failure path (which leaves the sheet up
    /// to show the error), there is no UI here to leave up — a failure
    /// (no open project, empty content) is reported as an error banner AND
    /// acknowledged to the agent, so the loop isn't left holding an
    /// unanswered write.
    @MainActor
    func autoSavePendingPlan() async {
        guard let args = engine.agent.pendingTool?.savePlanArgs else { return }
        switch await confirmSavePlan(args, finalContent: args.content) {
        case .success:
            break // confirmSavePlan already cleared pendingTool and acknowledged.
        case .failure(let message):
            engine.error = message
            engine.agent.pendingTool = nil
            let payload = ChatMessage.ToolResultPayload(
                kind: .skip, summary: "(couldn't save the plan: \(message))",
                exitCode: nil, command: nil, output: nil, url: nil, isFailure: true)
            await engine.acknowledge(payload, followUp: .forceUnblock)
        }
    }
}
