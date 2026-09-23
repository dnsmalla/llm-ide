import SwiftUI

/// The classic engine's `ask-user` question, rendered with the SAME card the
/// Agent engine's `AskUserQuestion` gets (`ApprovalQuestionCard`), so a
/// fixed-choice question is one tap on either engine. Before this the classic
/// engine had no question tool and asked in prose ("A, B or C?"), which the
/// user had to answer by retyping an option into the composer.
///
/// Unlike an Agent-engine approval there is no server-side request to answer:
/// the turn already ended with the question as its `pendingTool`, so the
/// state here is local, built once per question, and the answer goes back as
/// an ordinary tool result (`CodeAssistantPanel.answerPendingQuestion`). Key
/// the placement site by the question so a new one gets fresh selection state.
struct AskUserQuestionCard: View {
    let onSubmit: ([String: String]) async -> Void
    let onDismiss: () -> Void

    @State private var state: AgentV2ApprovalState

    init(args: PendingTool.AskUserArgs,
         onSubmit: @escaping ([String: String]) async -> Void,
         onDismiss: @escaping () -> Void) {
        self.onSubmit = onSubmit
        self.onDismiss = onDismiss
        _state = State(initialValue: AgentV2ApprovalState(
            approval: args.approval(requestId: "ask-user-\(UUID().uuidString)")))
    }

    var body: some View {
        ApprovalQuestionCard(
            state: state,
            onSubmit: { answers in
                // The card's own double-submit lock: a second tap while the
                // first is being recorded must not answer twice.
                guard state.beginSubmit() else { return }
                defer { state.endSubmit() }
                await onSubmit(answers)
                state.markSubmitted()
            },
            onDismiss: onDismiss)
    }
}
