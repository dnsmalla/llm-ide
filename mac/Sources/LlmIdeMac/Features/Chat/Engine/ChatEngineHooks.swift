import Foundation

/// Every panel-wired collaborator `ChatEngine` needs but does not own, as one
/// value. A new plan-side hook is a new field here, not an edit to
/// `ChatEngine.swift` — see that file's `hooks` property and Task 4's brief
/// (`.superpowers/sdd/2026-09-14-chat-feature-isolation/task-4-brief.md`).
///
/// Mutate individual members (`engine.hooks.onX = …`), never assign the
/// whole value — several independent owners (the panel, `MobileControlManager`,
/// `QuickChatContext`, tests) each set different members, and `packHistory` is
/// wired in `ChatEngine.init`, so a whole-struct assignment silently reverts
/// history packing to the bare default.
@MainActor
struct ChatEngineHooks {
    /// Called when a question parks during an EXTERNAL (phone-driven) turn,
    /// with the approval itself — set by whoever is driving that turn so the
    /// question can reach the client that asked for it. Nil for a turn the
    /// Mac drives: the panel renders `pendingApproval` directly.
    var onExternalApproval: ((AgentV2Approval) -> Void)?

    /// message, history, attachments, skills → the wire input. The panel's
    /// implementation fills language/model/provider/mode from its own picker
    /// state (see `ChatTransportInput.makeProvider`). The default is a plain
    /// pass-through so the engine is constructible with a transport alone.
    var resolveTransportInput: (String, [LlmIdeAPIClient.CodeAssistTurn],
                                [LlmIdeAPIClient.CodeAttachment], [String]) async -> ChatTransportInput = {
        message, history, attachments, skills in
        ChatTransportInput(message: message, history: history, attachments: attachments,
                           skills: skills, agentContext: nil, language: nil,
                           model: nil, provider: nil, mode: nil)
    }

    /// Called when a plan run SETTLES — the tracker leaving `.running` for
    /// `.finished` or `.failed`, by any route.
    ///
    /// The picker follows the resolved mode and stays there, and the
    /// lifecycle is what hands it back (`releaseStickyMode`). That release
    /// used to ride on `dismissPlanExecution`, which the finish card's
    /// **Commit** button reached on both of its paths — and "nothing to
    /// commit" was the common one, so an execution normally released the
    /// picker as a side effect of a button people pressed anyway. Commit is
    /// gone (Review / Push / Dismiss replaced it) and Push is gated behind a
    /// review, so Dismiss became the only release — a button that reads as
    /// informational and goes unpressed. The chat then answered every later
    /// message as an Execute turn, including "I want a plan to…".
    ///
    /// The end of the RUN is the honest moment to release, not the dismissal
    /// of the card that reports it: the card's own actions are about git, not
    /// about what the next message should be classified as.
    var onPlanExecutionSettled: () -> Void = {}

    /// Called when a post-execution REVIEW turn ends without landing a
    /// verdict — stopped, cancelled, or failed.
    ///
    /// The normal landing runs from `autoChainPendingAction`, which the
    /// error/stop path never reaches: `runTurn`'s `catch` finalizes the turn
    /// and returns without calling `autoChain`. Everything the panel owns
    /// for a review (the attached diff, the sticky Code Review mode) would
    /// therefore be left behind — a ~130 KB patch re-sent with every later
    /// message, and a picker stuck in a mode the user never chose. The
    /// engine cannot clear either of those itself (both live on the panel),
    /// so it announces the release and the panel does the clearing.
    var onPlanReviewReleased: () -> Void = {}

    /// Called at the very top of every user turn, before any state changes.
    /// Exists so the panel can reset per-turn budgets it still owns (today:
    /// `autoGitOpsThisTurn`, which `autoChainPendingAction` reads and which is
    /// therefore extracted with it, not here).
    var onTurnStart: () -> Void = {}

    /// The prompt the user just sent, for the panel's `CodeAssistantSession`
    /// repeat counter (`session.record(prompt:)`).
    var onRecordPrompt: (String) -> Void = { _ in }

    /// Called with the same prompt right after `onRecordPrompt`. The panel's
    /// wiring applies its own `session.shouldNudge(for:)` test before setting
    /// `agent.nudgePrompt` — the decision stays with the session counter that
    /// owns the threshold, exactly as it did inline.
    var onNudge: (String) -> Void = { _ in }

    /// Attachments to send with a USER turn. `sendFollowup` deliberately sends
    /// none (it re-invokes the agent on the synthetic ack turn already in
    /// history), so this is only consulted by `runTurn` — matching the panel,
    /// where `runTurn` passed `attachmentState.attachments` and `sendFollowup`
    /// passed `[]`.
    var attachmentsForTurn: () -> [LlmIdeAPIClient.CodeAttachment] = { [] }

    /// Packs `messages` for the wire — `[ChatMessage]` in, wire turns out.
    /// Defaults to the engine's own `historyForRequest` (set in `init`, since
    /// a property initializer can't reference `self`) rather than a bare
    /// wire-encoding no-op: code review on Task 12 found that the bare
    /// no-op default was still reachable in production — any engine the
    /// registry hands out whose panel hasn't (yet, or ever, for an
    /// off-screen mobile-bridge engine) called `wireEngine()` fell back to
    /// it, silently dropping the 400k-char total / 24k-per-turn budget for
    /// exactly the phone-driven turns Task 12 added. A caller that
    /// deliberately wants the bare encoder (rather than the budgeted one)
    /// can still reassign this after construction.
    var packHistory: ([ChatMessage]) -> [LlmIdeAPIClient.CodeAssistTurn] = { $0.map { $0.wireTurn() } }

    /// Auto-chain the next pending action (file edit / git op / shell command)
    /// when the budget allows — the panel's `autoChainPendingAction`, which is
    /// extracted later. Both round-trip sites call it so a chained plan keeps
    /// the same truncated-path data-loss guard.
    var autoChain: ((PendingTool?, LlmIdeAPIClient.CodeAssistResponse.Usage?) async -> Void)?

    /// Called with the messages that just replaced `messages` wholesale
    /// (session switch / delete-fallback / on-appear load). The panel wires
    /// this to `rebuildSentPrompts(from:)`, which reseeds the composer's
    /// ↑-recall list — panel-owned composer state until Task 14.
    var onHistoryReplaced: ([ChatMessage]) -> Void = { _ in }

    /// Extra per-conversation reset the panel still owns, called from
    /// `resetActiveTurnState()` in place of the `expandedTurns.removeAll()`
    /// that lived there — `expandedTurns` is view-only expand state, not chat
    /// data, so it stays with the view. No-op until Task 7 wires it.
    var onResetActiveTurnExtra: () -> Void = {}

    /// Extra transient reset the panel still owns, called from
    /// `resetTransientSessionState()`: the composer/attachment state
    /// (`sentPrompts`/`historyIndex`/`draftStash`/`draft`/attachments/
    /// selected skills/auto-attached path/attach notice) that doesn't move
    /// into the engine until Task 14. No-op until Task 7 wires it.
    var onResetTransientStateExtra: () -> Void = {}
}
