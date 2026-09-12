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
    /// Execute, attach the saved plan, and FIRE the execute turn. It used to
    /// stop at attaching (leaving the send to the user), which read as "the
    /// button does nothing" — clicking Execute IS the explicit go-ahead, so
    /// the turn starts immediately (queued when one is already running, the
    /// same rule the composer applies).
    @MainActor
    func executeSavedPlan(_ payload: ChatMessage.ToolResultPayload, messageId: UUID) {
        markPlanCardAction(.execute, for: messageId)
        // A parked legacy proposal (update-file/bash card) is a write the
        // agent is waiting on — firing a new turn now would abandon it
        // unanswered. (A parked v2 approval keeps `busy` true, so that case
        // lands on the enqueue branch below instead.)
        guard engine.agent.pendingTool == nil else {
            clearPlanCardAction(for: messageId)
            attachNotice = "Resolve the pending action card first, then execute the plan."
            return
        }
        modelState.selectedMode = .execute
        var attached = false
        if let path = payload.url {
            switch addFile(url: URL(fileURLWithPath: path)) {
            case .added, .duplicate:
                attached = true
            case .notText, .unreadable:
                break
            }
        }
        if !attached {
            // The file can be gone by the time a card from a reloaded session
            // is tapped (moved, deleted, project relocated). The payload still
            // carries the full plan text, so attach that instead of silently
            // dropping the user into Execute mode with nothing attached.
            guard Self.executePlanCanFire(attached: false, hasPlanContent: payload.planContent != nil) else {
                clearPlanCardAction(for: messageId)
                attachNotice = "Couldn't read the saved plan file — attach it manually or re-save the plan."
                return
            }
            let content = payload.planContent ?? ""
            let label = "plan: \(payload.planTitle ?? "saved plan")"
            if !attachmentState.attachments.contains(where: { $0.path == label }) {
                attachmentState.attachments.append(
                    LlmIdeAPIClient.CodeAttachment(path: label, content: content))
            }
            attachNotice = "The saved plan file couldn't be read — attached the plan text from this card instead."
        }
        // Consume invoked-skill chips exactly like the composer's submit():
        // directives prepend to the text, library ids ride the skill channel,
        // and the selection clears so a chip applies to exactly one message.
        let directives = attachmentState.selectedSkills.compactMap { s -> String? in
            if case .directive(let d) = s.action { return d } else { return nil }
        }
        let skillIds = attachmentState.selectedSkills.compactMap { s -> String? in
            if case .library(let id) = s.action { return id } else { return nil }
        }
        attachmentState.selectedSkills = []
        let planContent = Self.planContentForExecute(
            payload: payload,
            attachments: attachmentState.attachments)
        let baseMessage = Self.executePlanMessage(forPlanContent: planContent, planTitle: payload.planTitle)
        let outgoing = directives.isEmpty
            ? baseMessage
            : directives.joined(separator: "\n") + "\n\n" + baseMessage
        beginPlanExecution(messageId: messageId, payload: payload, planContent: planContent)
        let stepCount = engine.agent.planExecution?.steps.count ?? 0
        let displayTitle = payload.planTitle ?? Self.planTitle(from: planContent)
        // No count rather than a wrong one: an unparseable plan sent the
        // generic execute message, so there is no step list to promise.
        let stepSuffix = stepCount > 0 ? " (\(stepCount) step\(stepCount == 1 ? "" : "s"))" : ""
        let userMeta = ChatMessage.Metadata(
            planExecuteDisplay: "Execute plan: \(displayTitle)\(stepSuffix)"
        )
        // Snapshot the files as of THIS click, like the composer's submit():
        // a plan enqueued behind a running turn would otherwise read the
        // composer live when it finally drains, by which point a message sent
        // in between has cleared the chips (or staged different ones).
        let attachmentsSnapshot = attachmentState.attachments
        if engine.busy {
            engine.enqueue(outgoing, skillIds: skillIds, userMetadata: userMeta, planExecute: true,
                           attachments: attachmentsSnapshot)
        } else {
            engine.startTurn(outgoing, skillIds: skillIds, userMetadata: userMeta, planExecute: true,
                             attachments: attachmentsSnapshot)
        }
    }

    /// The canned instruction the "Execute plan" action sends. A constant so
    /// tests and the transcript read the same wording.
    static let executePlanMessage =
        "Execute the attached plan step by step, starting from step 1. "
        + "Report progress after each step."

    /// Structured execute instruction: lists parsed steps and tells the agent
    /// to seed `task-create` before working. Falls back to the legacy generic
    /// message when the plan has no parseable steps.
    static func executePlanMessage(forPlanContent content: String, planTitle: String?) -> String {
        let steps = parsePlanSteps(from: content)
        guard !steps.isEmpty else { return executePlanMessage }

        var parts: [String] = [
            "Execute the attached approved plan.",
        ]
        if let planTitle, !planTitle.isEmpty {
            parts.append("Plan title: \"\(planTitle)\".")
        }
        // The HOW — dispatching subagents vs implementing inline, reviewing
        // each task, tracking progress — is no longer spelled out here: the
        // server injects the execution skill (executing-plans or
        // subagent-driven-development, chosen from whether this user has
        // subagents) plus its bindings for a turn sent with `planExecute`.
        // See extension/llm_agent/runtime/plan-pipeline.mjs. This message
        // carries only what the server cannot derive: the parsed step list.
        parts.append("Follow the execution skill in your instructions, starting at step 1.")
        parts.append("Steps:")
        for (index, step) in steps.enumerated() {
            parts.append("\(index + 1). \(step)")
        }
        parts.append("Report what you completed.")
        return parts.joined(separator: "\n")
    }

    /// Best-effort step list from plan markdown, in the order of preference a
    /// reader would use: an explicit steps section if the plan has one, then
    /// its numbered / "Step N" lines, and only bullets when the plan numbers
    /// nothing. Caps at 30 steps to keep the execute prompt bounded.
    ///
    /// The scoping is not cosmetic — the agent is told to `task-create` one
    /// task per line returned here, so a flat scan of the whole document turns
    /// a 3-step plan into a task list that also contains its Context prose,
    /// its "Files to change" paths, every sub-bullet, and its Risks section.
    static func parsePlanSteps(from content: String) -> [String] {
        let scoped = stepsSection(in: content) ?? content
        let numbered = stepLines(in: scoped, patterns: [
            #"^(\d+[.)])\s+(.+)$"#,
            #"^(#{1,4}\s*Step\s*\d*[.:)]?)\s*(.+)$"#,
            #"^(#{1,4}\s*\d+[.:)])\s*(.+)$"#,
        ])
        if !numbered.isEmpty { return numbered }
        return stepLines(in: scoped, patterns: [#"^([-*])\s+(.+)$"#])
    }

    /// Body of the first heading that reads as the plan's step list, up to the
    /// next heading of the same or higher level. `nil` when the plan has no
    /// such section (then the whole document is scanned).
    private static func stepsSection(in content: String) -> String? {
        guard let headingRegex = try? NSRegularExpression(
            pattern: #"^(#{1,6})\s*(?:\d+[.:)]\s*)?(steps?|implementation|implementation plan|tasks?|work items?)\b.*$"#,
            options: [.caseInsensitive]),
              let anyHeading = try? NSRegularExpression(pattern: #"^(#{1,6})\s"#)
        else { return nil }

        let lines = content.components(separatedBy: .newlines)
        var startIndex: Int?
        var level = 0
        for (index, line) in lines.enumerated() {
            let range = NSRange(line.startIndex..<line.endIndex, in: line)
            guard let match = headingRegex.firstMatch(in: line, range: range),
                  let hashes = Range(match.range(at: 1), in: line) else { continue }
            startIndex = index + 1
            level = line[hashes].count
            break
        }
        guard let start = startIndex else { return nil }

        var end = lines.count
        for index in start..<lines.count {
            let line = lines[index]
            let range = NSRange(line.startIndex..<line.endIndex, in: line)
            guard let match = anyHeading.firstMatch(in: line, range: range),
                  let hashes = Range(match.range(at: 1), in: line),
                  line[hashes].count <= level
            else { continue }
            end = index
            break
        }
        let section = lines[start..<end].joined(separator: "\n")
        return section.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : section
    }

    /// Lines matching any of `patterns` at the top nesting level, with the
    /// marker and any `- [ ]` checkbox stripped off the captured title.
    private static func stepLines(in content: String, patterns: [String]) -> [String] {
        let regexes = patterns.compactMap { try? NSRegularExpression(pattern: $0, options: [.caseInsensitive]) }
        var steps: [String] = []
        for line in content.components(separatedBy: .newlines) {
            guard steps.count < 30 else { break }
            // Indented lines are sub-details of the step above, not steps.
            let indent = line.prefix { $0 == " " || $0 == "\t" }.count
            guard indent < 2 else { continue }
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else { continue }
            for regex in regexes {
                let nsRange = NSRange(trimmed.startIndex..<trimmed.endIndex, in: trimmed)
                guard let match = regex.firstMatch(in: trimmed, range: nsRange),
                      match.numberOfRanges > 2,
                      let capture = Range(match.range(at: 2), in: trimmed)
                else { continue }
                let step = stripCheckbox(String(trimmed[capture]))
                guard step.count > 2 else { continue }
                steps.append(step)
                break
            }
        }
        return steps
    }

    /// `[ ] Add tests` → `Add tests`, so a checklist plan doesn't seed task
    /// titles that carry their own markdown checkbox.
    private static func stripCheckbox(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("["), trimmed.count > 3 else { return trimmed }
        let marker = trimmed.prefix(3).lowercased()
        guard marker == "[ ]" || marker == "[x]" || marker == "[-]" else { return trimmed }
        return String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
    }

    /// Plan body for execute-message parsing: card fallback, then attached file.
    static func planContentForExecute(
        payload: ChatMessage.ToolResultPayload,
        attachments: [LlmIdeAPIClient.CodeAttachment]
    ) -> String {
        if let content = payload.planContent, !content.isEmpty { return content }
        if let path = payload.url {
            let match = attachments.first { $0.path == path || $0.path.hasSuffix((path as NSString).lastPathComponent) }
            if let content = match?.content, !content.isEmpty { return content }
        }
        return attachments.first(where: { $0.path.hasSuffix(".md") || $0.path.contains("plan") })?.content ?? ""
    }

    /// Whether the Execute action may fire the turn: the plan file attached,
    /// or the card still carries the plan text as a fallback. Pure, so the
    /// "never send with nothing attached" rule is pinnable in tests.
    static func executePlanCanFire(attached: Bool, hasPlanContent: Bool) -> Bool {
        attached || hasPlanContent
    }

    /// The PlanSavedCard's "Edit in chat" action: keep the collaborative flow
    /// in a plan-like mode (a revision saved with the same title on the same
    /// day overwrites the file in place — see ProposedPlanResolver) and seed
    /// the composer so the next keystroke is already a revision instruction.
    /// The seed names the card's own plan: a transcript can hold several plan
    /// cards, and a bare "Revise the plan:" would read as the latest one.
    @MainActor
    func editSavedPlanInChat(_ payload: ChatMessage.ToolResultPayload, messageId: UUID) {
        markPlanCardAction(.edit, for: messageId)
        if modelState.selectedMode != .plan && modelState.selectedMode != .assistPlan {
            modelState.selectedMode = .plan
        }
        if draft.isEmpty {
            draft = PlanEditPolicy.refineSeed(title: payload.planTitle ?? "")
        }
    }

    /// The "Refine in chat" action on a v2 plan-like RESULT turn — the
    /// pre-save twin of `editSavedPlanInChat`. Nothing is written: the mode
    /// stays plan-like and the composer is seeded, so the next turn produces
    /// a revised plan the user can then save (or edit by hand).
    @MainActor
    func refinePlanInChat(from message: ChatMessage) {
        if modelState.selectedMode != .plan && modelState.selectedMode != .assistPlan {
            modelState.selectedMode = .plan
        }
        if draft.isEmpty {
            draft = PlanEditPolicy.refineSeed(title: Self.planTitle(from: message.content))
        } else {
            // Never overwrite something the user typed. Saying so matters
            // more here than on the saved-plan card: with a draft in the
            // composer the only visible effect is a mode change, which reads
            // as a dead button.
            attachNotice = "Kept what you typed — add your revision instruction to the message and send it."
        }
    }

    /// The "Preview" action on a v2 plan-like RESULT turn: open the reply in
    /// the plan sheet — rendered as a document, with a Markdown toggle so the
    /// user can also fix it BY HAND — before it is written. Nothing is saved
    /// until the sheet's own Save.
    @MainActor
    func beginPlanEdit(from message: ChatMessage) {
        // The same guards the write itself applies, checked up front so the
        // user isn't handed an editor for a plan that can't be saved. Reported
        // rather than silently ignored — the row's Save button reports the
        // same conditions.
        if let refusal = PlanEditPolicy.refusal(
            hasPendingTool: engine.agent.pendingTool != nil,
            alreadySaved: planSavedFlag(for: message.id) == true,
            messageInTranscript: engine.messages.contains(where: { $0.id == message.id }))
        {
            attachNotice = Self.planWriteRefusalMessage(refusal)
            return
        }
        sheets.planEditTarget = PlanEditTarget(
            messageId: message.id,
            title: Self.planTitle(from: message.content),
            content: message.content)
    }

    /// Commit the edit sheet: write the EDITED title/body through the same
    /// resolver→write→PlanSavedCard path the plain Save uses. Only the file
    /// (and the resulting card) carries the edits — the assistant message is
    /// left as the agent wrote it, so the local transcript keeps agreeing
    /// with the v2 engine's server-side history.
    @MainActor
    func savePlanEdits(_ target: PlanEditTarget, title: String, content: String) async -> SavePlanResult {
        switch await writePlan(title: title, content: content, messageId: target.messageId) {
        case .success:
            return .success
        // The sheet reports EVERY refusal inline — unlike the button, a user
        // who just hit Save in a dialog needs to know nothing was written.
        case .refused(let refusal):
            return .failure(Self.planWriteRefusalMessage(refusal))
        case .failure(let message):
            return .failure(message)
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
        switch await writePlan(
            title: Self.planTitle(from: message.content),
            content: message.content,
            messageId: message.id)
        {
        case .success, .refused(.alreadySaved):
            // Already-saved stays SILENT here: the optimistic flag is set
            // before SwiftUI can retire the row, so a double-click lands on
            // this branch routinely — the save it duplicates succeeded, and a
            // red banner for it would be a lie.
            break
        case .refused(let refusal):
            attachNotice = Self.planWriteRefusalMessage(refusal)
        case .failure(let failure):
            engine.error = failure
        }
    }

    /// User-facing wording for a refused plan write. One table so the button,
    /// the Edit sheet and the Edit action can't describe the same refusal
    /// three different ways.
    static func planWriteRefusalMessage(_ refusal: PlanEditPolicy.WriteRefusal) -> String {
        switch refusal {
        case .pendingTool:
            return "Resolve the pending action card first, then save the plan."
        case .alreadySaved:
            return "This plan has already been saved."
        case .messageGone:
            return "This plan's chat message is gone — reopen the plan and save it again."
        }
    }

    /// The one write behind BOTH v2 plan actions (plain Save and the edit
    /// sheet's Save): guard, flag, write, un-flag on failure. Kept in one
    /// place so the edit path can never acquire a different double-save rule
    /// than the plain one.
    @MainActor
    private func writePlan(title: String, content: String, messageId: UUID) async -> PlanWriteOutcome {
        // All three guards read the LIVE transcript, not a captured copy.
        // `messageInTranscript` is not cosmetic: `setPlanSavedFlag` is a
        // no-op for a message that isn't there, so writing anyway would
        // leave the save UNRECORDED and a second one could follow.
        if let refusal = PlanEditPolicy.refusal(
            hasPendingTool: engine.agent.pendingTool != nil,
            alreadySaved: planSavedFlag(for: messageId) == true,
            messageInTranscript: engine.messages.contains(where: { $0.id == messageId }))
        {
            return .refused(refusal)
        }
        // Flag OPTIMISTICALLY, before the await: the write can be slow, and
        // a double-click landing in that window would otherwise save twice
        // and append two identical PlanSavedCards. Reverted on failure so
        // the button comes back for a retry.
        setPlanSavedFlag(true, for: messageId)
        let args = PendingTool.SavePlanArgs(title: title, content: content)
        switch await confirmSavePlan(args, finalContent: content, followUp: .none) {
        case .success:
            return .success
        case .failure(let message):
            setPlanSavedFlag(nil, for: messageId)
            return .failure(message)
        }
    }

    /// `SavePlanResult` plus the refusals that are not failures — a refused
    /// write wrote nothing AND changed nothing, which each caller reports
    /// differently (the button stays quiet on a duplicate click; the sheet
    /// says so inline).
    enum PlanWriteOutcome {
        case success
        case refused(PlanEditPolicy.WriteRefusal)
        case failure(String)
    }

    @MainActor
    private func markPlanCardAction(_ action: ChatMessage.PlanCardAction, for messageId: UUID) {
        guard let idx = engine.messages.firstIndex(where: { $0.id == messageId }) else { return }
        var meta = engine.messages[idx].metadata ?? ChatMessage.Metadata()
        meta.planCardAction = action
        engine.messages[idx].metadata = meta
    }

    /// Re-enable the card when execute could not start (blocked pending tool, unreadable plan).
    @MainActor
    private func clearPlanCardAction(for messageId: UUID) {
        guard let idx = engine.messages.firstIndex(where: { $0.id == messageId }) else { return }
        var meta = engine.messages[idx].metadata ?? ChatMessage.Metadata()
        meta.planCardAction = nil
        engine.messages[idx].metadata = meta
    }

    /// Read/write the per-message planSaved metadata flag in the LIVE
    /// transcript. The saved-plan card is a .toolResult message, so
    /// lastAssistantTurnId doesn't move and this flag is the only thing
    /// that retires the "Save Plan" affordance.
    @MainActor
    private func planSavedFlag(for id: UUID) -> Bool? {
        engine.messages.first(where: { $0.id == id })?.metadata?.planSaved
    }

    @MainActor
    private func setPlanSavedFlag(_ value: Bool?, for id: UUID) {
        guard let idx = engine.messages.firstIndex(where: { $0.id == id }) else { return }
        var meta = engine.messages[idx].metadata ?? ChatMessage.Metadata()
        meta.planSaved = value
        engine.messages[idx].metadata = meta
    }

    /// Best-effort plan title from a plan-like reply: the first Markdown
    /// heading line, leading `#`/space marks stripped, capped to the
    /// 60-char slug budget `FilesystemSlug` applies. Many plan-like replies
    /// open with a sentence of chat preamble ("Here's the plan:") before
    /// their `# Heading` — using the first non-empty line unconditionally
    /// turned that preamble into the saved file's name instead of the
    /// actual title, so a heading line is preferred when the content has
    /// one. Falls back to the first non-empty line when there is no
    /// heading at all. An empty result is fine — the resolver's slugify
    /// falls back to "untitled-plan".
    static func planTitle(from content: String) -> String {
        let lines = content.components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
        let firstLine = lines.first { !$0.isEmpty } ?? ""
        // A title-bearing heading: 1–6 '#'s, a space, then real content
        // (the CommonMark ATX shape). The shape check keeps shebangs
        // ("#!/bin/bash") and marks-only lines ("###") from outranking
        // the first line.
        let headingLine = lines.first { line in
            let hashes = line.prefix(while: { $0 == "#" })
            guard (1...6).contains(hashes.count) else { return false }
            let rest = line.dropFirst(hashes.count)
            return rest.first == " "
                && !rest.trimmingCharacters(in: .whitespaces).isEmpty
        }
        let source = headingLine ?? firstLine
        let stripped = source.drop(while: { $0 == "#" || $0 == " " })
        return String(stripped).trimmingCharacters(in: .whitespaces).prefix(60).description
    }
}
