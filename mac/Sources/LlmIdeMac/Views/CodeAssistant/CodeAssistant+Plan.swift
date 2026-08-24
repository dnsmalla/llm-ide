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
    func executeSavedPlan(_ payload: ChatMessage.ToolResultPayload) {
        // A parked legacy proposal (update-file/bash card) is a write the
        // agent is waiting on — firing a new turn now would abandon it
        // unanswered. (A parked v2 approval keeps `busy` true, so that case
        // lands on the enqueue branch below instead.)
        guard engine.agent.pendingTool == nil else {
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
        if engine.busy {
            engine.enqueue(outgoing, skillIds: skillIds)
        } else {
            engine.startTurn(outgoing, skillIds: skillIds)
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
        parts.append(
            "First, call task-create once per step below (exact titles). "
            + "Then mark step 1 in_progress and implement it. "
            + "Use Edit/Write for code changes, Bash for builds/tests, "
            + "and ask-subagent when a step matches an enabled plugin subagent."
        )
        parts.append("Steps:")
        for (index, step) in steps.enumerated() {
            parts.append("\(index + 1). \(step)")
        }
        parts.append("Track progress with task-update after each step. Report what you completed.")
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
        // Already saved — read the LIVE message, not the captured copy, and
        // refuse a repeat write.
        guard planSavedFlag(for: message.id) != true else { return }
        // Flag OPTIMISTICALLY, before the await: the write can be slow, and
        // a double-click landing in that window would otherwise save twice
        // and append two identical PlanSavedCards. Reverted on failure so
        // the button comes back for a retry.
        setPlanSavedFlag(true, for: message.id)
        let args = PendingTool.SavePlanArgs(
            title: Self.planTitle(from: message.content),
            content: message.content)
        switch await confirmSavePlan(args, finalContent: message.content, followUp: .none) {
        case .success:
            break // the optimistic flag stands — the affordance is retired
        case .failure(let failure):
            setPlanSavedFlag(nil, for: message.id)
            engine.error = failure
        }
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
