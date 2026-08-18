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
    /// The PlanSavedCard's "Execute plan" action: switch the mode picker to
    /// Execute and attach the saved plan file, but do NOT auto-send — the
    /// user reviews and fires the message themselves (their explicit choice
    /// over auto-execution).
    @MainActor
    func executeSavedPlan(_ payload: ChatMessage.ToolResultPayload) {
        modelState.selectedMode = .execute
        guard let path = payload.url else { return }
        switch addFile(url: URL(fileURLWithPath: path)) {
        case .added, .duplicate:
            break
        case .notText, .unreadable:
            // The file can be gone by the time a card from a reloaded session
            // is tapped (moved, deleted, project relocated). The payload still
            // carries the full plan text, so attach that instead of silently
            // dropping the user into Execute mode with nothing attached.
            if let content = payload.planContent {
                let label = "plan: \(payload.planTitle ?? "saved plan")"
                if !attachmentState.attachments.contains(where: { $0.path == label }) {
                    attachmentState.attachments.append(
                        LlmIdeAPIClient.CodeAttachment(path: label, content: content))
                }
                attachNotice = "The saved plan file couldn't be read — attached the plan text from this card instead."
            } else {
                attachNotice = "Couldn't read the saved plan file — attach it manually or re-save the plan."
            }
        }
    }

    /// The PlanSavedCard's "Edit in chat" action: keep the collaborative flow
    /// in a plan-like mode (a revision saved with the same title on the same
    /// day overwrites the file in place — see ProposedPlanResolver) and seed
    /// the composer so the next keystroke is already a revision instruction.
    /// The seed names the card's own plan: a transcript can hold several plan
    /// cards, and a bare "Revise the plan:" would read as the latest one.
    @MainActor
    func editSavedPlanInChat(_ payload: ChatMessage.ToolResultPayload) {
        if modelState.selectedMode != .plan && modelState.selectedMode != .assistPlan {
            modelState.selectedMode = .plan
        }
        if draft.isEmpty {
            draft = payload.planTitle.map { "Revise the plan \"\($0)\": " } ?? "Revise the plan: "
        }
    }

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

    /// The v2 counterpart to `autoSavePendingPlan`: the "Save Plan" action
    /// on a plan-like v2 RESULT message. On the v2 engine no `save-plan`
    /// pendingTool ever arrives — the plan IS the reply — so the message's
    /// own text is the plan content, a title is derived from its first
    /// heading line, and the SAME resolver→write→PlanSavedCard path runs.
    /// No follow-up turn is fired afterwards: the v2 engine's history lives
    /// server-side and never sees the local ack, so a "(continue)" round
    /// trip would only earn a confused reply (the legacy loop's
    /// `.forceUnblock` exists for an agent that is actively waiting on the
    /// ack, which v2's isn't).
    @MainActor
    func savePlanFromMessage(_ message: ChatMessage) async {
        guard engine.agent.pendingTool == nil else { return }
        let args = PendingTool.SavePlanArgs(
            title: Self.planTitle(from: message.content),
            content: message.content)
        switch await confirmSavePlan(args, finalContent: message.content, followUp: .none) {
        case .success:
            break
        case .failure(let failure):
            engine.error = failure
        }
    }

    /// Best-effort plan title from a plan-like reply: the first non-empty
    /// line, leading markdown heading marks stripped, capped to the 60-char
    /// slug budget `FilesystemSlug` applies. An empty result is fine — the
    /// resolver's slugify falls back to "untitled-plan".
    static func planTitle(from content: String) -> String {
        let firstLine = content
            .components(separatedBy: .newlines)
            .first { !$0.trimmingCharacters(in: .whitespaces).isEmpty } ?? ""
        let stripped = firstLine.drop(while: { $0 == "#" || $0 == " " })
        return String(stripped).trimmingCharacters(in: .whitespaces).prefix(60).description
    }
}
