import Foundation

/// The classic engine's `ask-user` question card (see `AskUserQuestionCard`).
///
/// The turn that asked has already ended with the question as its
/// `pendingTool`, so the answer travels like any other client-side tool
/// result: a tool-result message the model reads as the call's outcome. The
/// summary line is both what the chat shows ("You chose …") and what the
/// server sees (`legacyContent()` sends the summary), so it names the
/// question as well as the choice — the model may have asked several things
/// over the conversation.
extension CodeAssistantPanel {
    /// Record the user's choice and let the agent continue with it — the same
    /// `.forceUnblock` round a confirmed edit or command gets, because the
    /// agent asked in order to carry on.
    @MainActor
    func answerPendingQuestion(_ answers: [String: String]) async {
        guard let args = engine.agent.pendingTool?.askUserArgs else { return }
        let chosen = Self.chosenAnswer(answers, for: args)
        guard !chosen.isEmpty else { return }
        engine.agent.pendingTool = nil
        let payload = ChatMessage.ToolResultPayload(
            kind: .other,
            summary: "(the user chose \(chosen) for: \(args.question))",
            exitCode: nil, command: nil, output: nil, url: nil, isFailure: false)
        await engine.acknowledge(payload, followUp: .forceUnblock)
    }

    /// The user closed the card without choosing. No follow-up round: they
    /// will say what they want in the composer, and a "(continue)" now would
    /// only have the agent guess — or ask the same question again.
    @MainActor
    func dismissPendingQuestion() async {
        guard let args = engine.agent.pendingTool?.askUserArgs else {
            engine.agent.pendingTool = nil
            return
        }
        engine.agent.pendingTool = nil
        let payload = ChatMessage.ToolResultPayload(
            kind: .skip,
            summary: "(the user dismissed the question without choosing: \(args.question))",
            exitCode: nil, command: nil, output: nil, url: nil, isFailure: false)
        await engine.acknowledge(payload, followUp: .none)
    }

    /// The chosen label(s) as one quoted, human-readable phrase. The card
    /// keys answers by question text and comma-joins a multi-select; a label
    /// can itself contain a comma, so multi-select labels are recovered by
    /// matching the offered options rather than by splitting.
    nonisolated static func chosenAnswer(_ answers: [String: String],
                                         for args: PendingTool.AskUserArgs) -> String {
        guard let raw = answers[args.question] ?? answers.values.first, !raw.isEmpty else { return "" }
        guard args.multiSelect == true else { return "\"\(raw)\"" }
        let picked = args.options.filter { option in
            raw == option || raw.hasPrefix(option + ",") || raw.hasSuffix("," + option)
                || raw.contains("," + option + ",")
        }
        let labels = picked.isEmpty ? [raw] : picked
        return labels.map { "\"\($0)\"" }.joined(separator: " and ")
    }
}
