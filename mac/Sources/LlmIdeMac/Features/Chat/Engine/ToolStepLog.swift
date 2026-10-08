import Foundation

/// Applies one tool progress tick to a turn's step list. Lifted out of
/// `ChatEngine.recordProgress` so the engine keeps one line and the rules
/// keep one place; the decisions themselves are the public, lab-asserted
/// `ToolStepMergePolicy` functions.
enum ToolStepLog {
    static func apply(_ progress: LlmIdeAPIClient.AgentProgress,
                      to steps: inout [ChatMessage.ToolStep],
                      now: Date = Date()) {
        let finishes = progress.resultText != nil || progress.isError != nil

        // v2 with ids: the tick belongs to exactly one call, wherever it sits.
        if let i = ToolStepMergePolicy.index(forToolUseId: progress.toolUseId, in: steps.map(\.toolUseId)) {
            steps[i] = steps[i].updated(
                label: progress.label,
                args: progress.args,
                resultText: progress.resultText,
                isError: progress.isError,
                endedAt: finishes ? now : nil
            )
            return
        }

        // Three-way, because v2 reports one tool call more than once. The old
        // label-only dedupe worked solely because both ticks used to produce
        // the same label; once the result started naming the file they
        // diverged and every call recorded two rows. See `ToolStepMergePolicy`.
        let last = steps.last
        switch ToolStepMergePolicy.decideWithIds(
            lastTool: last?.tool,
            lastLabel: last?.label,
            lastHasResult: last?.resultText != nil,
            lastToolUseId: last?.toolUseId,
            incomingTool: progress.tool,
            incomingLabel: progress.label,
            incomingHasResult: progress.resultText != nil,
            incomingToolUseId: progress.toolUseId
        ) {
        case .ignore:
            return
        case .completeLast:
            // Same call finishing (a server that sent no id on its start):
            // keep identity and start time, take the richer label.
            steps[steps.count - 1] = steps[steps.count - 1].updated(
                label: progress.label,
                args: progress.args,
                resultText: progress.resultText,
                isError: progress.isError,
                toolUseId: progress.toolUseId,
                endedAt: finishes ? now : nil
            )
        case .append:
            if let previous = steps.last,
               ToolStepMergePolicy.closesPrevious(previousToolUseId: previous.toolUseId,
                                                  previousEnded: previous.endedAt != nil,
                                                  incomingToolUseId: progress.toolUseId) {
                steps[steps.count - 1] = previous.updated(endedAt: now)
            }
            steps.append(.init(
                label: progress.label,
                tool: progress.tool,
                at: now,
                args: progress.args ?? legacySubagentArgs(progress.subagent),
                resultText: progress.resultText,
                isError: progress.isError,
                toolUseId: progress.toolUseId,
                endedAt: finishes ? now : nil
            ))
        }
    }

    /// Marks every still-open legacy step finished — the turn completing is
    /// the only end event legacy sends for its last tool. v2 steps (with an id)
    /// are left alone: theirs is the result, and one without it did not finish.
    static func closeOpenSteps(_ steps: inout [ChatMessage.ToolStep], now: Date = Date()) {
        for i in steps.indices where steps[i].toolUseId == nil && steps[i].endedAt == nil {
            steps[i] = steps[i].updated(endedAt: now)
        }
    }

    /// The legacy wire names an `ask-subagent` call's subagent in its own
    /// `subagent` field (API v71+), not in arguments. Stored as `{"name": …}`
    /// args so `SubagentActivity` reads both engines the same way.
    static func legacySubagentArgs(_ subagent: String?) -> String? {
        guard let subagent, !subagent.isEmpty,
              let data = try? JSONSerialization.data(withJSONObject: ["name": subagent]) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
