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
