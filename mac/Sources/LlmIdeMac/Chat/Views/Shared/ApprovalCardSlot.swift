import SwiftUI

/// The parked-approval card, in the one place all three chat surfaces render it.
///
/// The panel transcript, the menu bar and the quick-chat sheet each carried a
/// byte-for-byte copy of this `kind` dispatch; two of them even carried a
/// comment pointing at the third ("See `ChatMessageList`'s identical block").
/// Adding a third approval shape meant editing three files, so this is now one.
///
/// What did NOT move here, deliberately: **when** to show the card. The panel
/// renders inside a per-turn `ForEach` and must pick the last assistant turn;
/// the other two render once, outside any loop. That gate is a property of the
/// call site, not of the card, so each caller keeps its own `if let`.
///
/// `kind` is compared as a raw string because that is what the wire carries —
/// see `AgentV2Event`. "ToolApproval" is either engine's gated tool (run-bash,
/// Edit/Write/Bash); anything else today is "AskUserQuestion".
struct ApprovalCardSlot: View {
    let state: AgentV2ApprovalState
    /// `ChatEngine.submitToolDecision(action:)` — "deny" | "allow" | "always-allow".
    let onToolDecision: (_ action: String) async -> Void
    /// `ChatEngine.submitApproval(answers:)`.
    let onSubmitAnswers: (_ answers: [String: String]) async -> Void
    /// `ChatEngine.dismissApproval()`.
    let onDismiss: () -> Void

    /// Per-surface spacing. The panel and menu bar inset the top; the sheet
    /// insets the sides. Defaults to the panel's, the copy the other two cited.
    var insets = EdgeInsets(top: 4, leading: 0, bottom: 0, trailing: 0)
    /// The panel animates the card in; the other two do not.
    var transition: AnyTransition = .identity

    var body: some View {
        Group {
            if state.approval.kind == "ToolApproval" {
                ToolApprovalCard(state: state, onDecide: onToolDecision)
            } else {
                ApprovalQuestionCard(
                    state: state,
                    onSubmit: onSubmitAnswers,
                    onDismiss: onDismiss
                )
            }
        }
        // Keyed by requestId: a second approval must not inherit the previous
        // card's @State (for the question card, its selection).
        .id(state.approval.requestId)
        .padding(insets)
        .transition(transition)
    }
}
