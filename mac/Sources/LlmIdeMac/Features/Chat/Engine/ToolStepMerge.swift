import Foundation

/// What `ChatEngine.recordProgress` should do with an incoming tool progress
/// event, given the step already at the end of the turn's list.
public enum ToolStepMerge: Equatable {
    /// A back-to-back repeat of the same action — the legacy loop re-emits on
    /// every iteration, and that is noise, not a second step.
    case ignore
    /// A new tool step.
    case append
    /// The RESULT for the call whose start is already the last step: fill that
    /// step in rather than adding a second row for the same call.
    case completeLast
}

/// The merge decision, as a pure function so `chat-contract-lab` can assert it.
///
/// This exists because widening the v2 progress event broke a silent
/// assumption. `recordProgress` used to dedupe on LABEL alone, which worked
/// only because `tool_use_start` and `tool_result` produced the *identical*
/// label ("Reading"). Once `tool_result` started carrying the salient argument
/// the labels diverged ("Reading" then "Reading Foo.swift"), the dedupe stopped
/// firing, and every v2 tool call recorded — and persisted — TWO rows.
///
/// The legacy engine is unaffected by construction: it never sets a result on a
/// progress event, so `incomingHasResult` is always false for it and only the
/// original label-dedupe branch can fire.
public enum ToolStepMergePolicy {
    public static func decide(
        lastTool: String?,
        lastLabel: String?,
        lastHasResult: Bool,
        incomingTool: String?,
        incomingLabel: String,
        incomingHasResult: Bool
    ) -> ToolStepMerge {
        guard let lastLabel else { return .append }

        // The result arriving for the still-open step of the same tool.
        if incomingHasResult, !lastHasResult, lastTool == incomingTool {
            return .completeLast
        }
        if lastLabel == incomingLabel { return .ignore }
        return .append
    }
}

extension ToolStepMergePolicy {
    /// `decide`, for a tick that may carry a tool-use id and matched no step
    /// by it. An id means a distinct call: never label-deduped (two concurrent
    /// Reads both open as "Reading"), and never completing a step that has its
    /// own, different id. The one merge left is a result for a last step
    /// opened WITHOUT an id — a server predating ids on `tool_use_start`.
    public static func decideWithIds(
        lastTool: String?,
        lastLabel: String?,
        lastHasResult: Bool,
        lastToolUseId: String?,
        incomingTool: String?,
        incomingLabel: String,
        incomingHasResult: Bool,
        incomingToolUseId: String?
    ) -> ToolStepMerge {
        guard let incomingToolUseId, !incomingToolUseId.isEmpty else {
            return decide(lastTool: lastTool, lastLabel: lastLabel, lastHasResult: lastHasResult,
                          incomingTool: incomingTool, incomingLabel: incomingLabel,
                          incomingHasResult: incomingHasResult)
        }
        if lastLabel != nil, lastToolUseId == nil, incomingHasResult, !lastHasResult, lastTool == incomingTool {
            return .completeLast
        }
        return .append
    }

    /// v2: the step a tick carrying `toolUseId` updates — the LAST step with
    /// that id. Nil when the tick has no id (legacy) or no step carries it yet
    /// (a server predating ids on `tool_use_start`); the caller then falls
    /// back to `decide`, whose `.completeLast` assumes the last step is the one
    /// finishing — wrong with concurrent calls, which is why ids win.
    public static func index(forToolUseId toolUseId: String?, in stepIds: [String?]) -> Int? {
        guard let toolUseId, !toolUseId.isEmpty else { return nil }
        return stepIds.lastIndex(where: { $0 == toolUseId })
    }

    /// Legacy: whether appending a new step marks the previous one finished.
    /// The legacy loop runs one tool at a time and sends no end event, so the
    /// next step starting IS the previous one ending. Never for a v2 step
    /// (it has an id and gets a real result), nor one already ended.
    public static func closesPrevious(previousToolUseId: String?, previousEnded: Bool,
                                      incomingToolUseId: String?) -> Bool {
        previousToolUseId == nil && incomingToolUseId == nil && !previousEnded
    }
}
