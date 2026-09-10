import Foundation

/// The outcome of consulting `ChatAutoChainPolicy.decide` for one of the
/// three independent `PendingTool` shapes (`update-file` / `git-op` /
/// `bash`). At most one decision is produced per branch, since the three
/// `PendingTool` accessors (`updateFileArgs`/`gitOpArgs`/`bashArgs`) are
/// mutually exclusive for a given `pendingTool.kind`.
///
/// `.requireManualReview`'s `reason` is a policy-side placeholder, not the
/// final user-facing string — the executor (`autoChainPendingAction` in
/// `CodeAssistantPanel+Session.swift`) re-derives the exact original
/// message from live state (the matched attachment's basename) when it
/// acts on this decision.
enum ChatAutoChainDecision: Equatable {
    case autoApplyEdit
    case requireManualReview(reason: String?)
    case autoRunGitOp
    case autoRunBash
    case autoSavePlan
    case none
}

/// Pure extraction of the three-branch decision table in
/// `autoChainPendingAction` (`CodeAssistantPanel+Session.swift`). Given the
/// state that function used to read directly off `self`, decide which
/// actions may run unattended this turn — without touching the panel,
/// resolving edits, or executing anything. The caller (the panel) still
/// owns `resolveEdit`/`confirmUpdateFile`/`runGitOpFlow`/`runBashCommand`
/// and the exact user-facing error text.
///
/// `shouldAutoRunGitOp` is injected rather than reimplemented here: the
/// real git-op gate (`CodeAssistant+Git.swift`) already folds in its own
/// copy of the per-turn budget plus `editMode` plus `GitOpTier`, and reads
/// live panel state (`autoGitOpsThisTurn`, `editMode`) to do it. Treating
/// it as an opaque predicate keeps this function pure while still letting
/// tests exercise the tier behavior via a scripted closure.
enum ChatAutoChainPolicy {
    static func decide(
        pendingTool: PendingTool?,
        editMode: EditAcceptanceMode,
        autoOpsUsed: Int,
        maxAutoOpsPerTurn: Int,
        truncatedPaths: Set<String>,
        isWholeFileRewrite: Bool,
        matchPath: String?,
        shouldAutoRunGitOp: (GitOpArgs) -> Bool
    ) -> [ChatAutoChainDecision] {
        var decisions: [ChatAutoChainDecision] = []

        // Branch 1: update-file. Auto mode + budget + a proposed edit is the
        // gate; within it, a whole-file rewrite over a truncated attachment
        // falls back to manual review so the diff makes the data-loss risk
        // visible instead of silently overwriting the file's unseen tail.
        if editMode == .auto, autoOpsUsed < maxAutoOpsPerTurn,
           pendingTool?.updateFileArgs != nil {
            if isWholeFileRewrite, let matchPath, truncatedPaths.contains(matchPath) {
                decisions.append(.requireManualReview(reason: "truncated"))
            } else {
                decisions.append(.autoApplyEdit)
            }
        }

        // Branch 2: git-op. `shouldAutoRunGitOp` already fully encapsulates
        // its own budget + tier + editMode checks (read tier always runs,
        // even outside Auto mode) — do not additionally gate this branch on
        // `editMode`/`autoOpsUsed` here, that would double-apply the budget
        // and would wrongly block read-tier ops in review mode.
        if let gitOpArgs = pendingTool?.gitOpArgs, shouldAutoRunGitOp(gitOpArgs) {
            decisions.append(.autoRunGitOp)
        }

        // Branch 3: bash. Same gate shape as update-file.
        if editMode == .auto, autoOpsUsed < maxAutoOpsPerTurn,
           pendingTool?.bashArgs != nil {
            decisions.append(.autoRunBash)
        }

        // Branch 4: save-plan. Unlike the branches above, this is NOT gated
        // by editMode or the per-turn budget — it can never touch an
        // arbitrary file (fixed destination under llm-doc/plans/, always
        // creates/overwrites only its own plan file), so it always saves
        // automatically the instant it's proposed. See save-plan.md and
        // mode-personas.mjs (PLAN_LIKE_MODES) for why it's the one write
        // tool the plan-like modes (plan, assist_plan) get.
        if pendingTool?.savePlanArgs != nil {
            decisions.append(.autoSavePlan)
        }

        return decisions
    }
}
