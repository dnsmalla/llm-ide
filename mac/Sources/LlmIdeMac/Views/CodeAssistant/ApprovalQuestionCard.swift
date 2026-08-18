import SwiftUI

/// Interactive card for a parked `AskUserQuestion` (the v2 engine blocking on
/// `canUseTool`). Rendered by `ChatMessageList` under the last assistant
/// message while `engine.pendingApproval` is set — the Mac panel owns the
/// shared engine, so the card shows for Mac-driven AND phone-driven turns
/// (the phone additionally gets the "⏸ Question pending on Mac…" note in the
/// turn's tool steps; it cannot render this card itself).
///
/// Styling follows `PendingActionCard`: 10pt padding, rounded 8pt box on a
/// subtle fill with a tinted border, 12/13pt type. Selection is local
/// `@State`; the card is keyed by `requestId` at the placement site so a
/// SECOND approval mints fresh selection state instead of inheriting the
/// previous question's.
struct ApprovalQuestionCard: View {
    let state: AgentV2ApprovalState
    /// Posts the user's answers — wired to `ChatEngine.submitApproval(answers:)`.
    let onSubmit: ([String: String]) async -> Void
    /// Drops the card without answering — `ChatEngine.dismissApproval()`.
    let onDismiss: () -> Void

    /// Selected option labels per question INDEX (labels may repeat across
    /// questions, so they can't key the dictionary). Single-select questions
    /// hold exactly one label; multi-select holds a toggleable set.
    @State private var selection: [Int: Set<String>] = [:]

    /// Every question answered (≥1 option each) and not already accepted by
    /// the server. `AskUserQuestion` semantics need an answer per question —
    /// with the usual one-question approval this is simply "something is
    /// selected".
    private var canSubmit: Bool {
        !state.submitted
            && !state.approval.questions.isEmpty
            && state.approval.questions.indices.allSatisfy { !(selection[$0]?.isEmpty ?? true) }
    }

    /// Why Submit is greyed out, shown next to the buttons.
    private var submitHint: String? {
        if state.submitted { return "Answered" }
        if state.approval.questions.indices.contains(where: { (selection[$0]?.isEmpty ?? true) }) {
            return state.approval.questions.count > 1 ? "Answer each question" : "Select an option"
        }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            ForEach(Array(state.approval.questions.enumerated()), id: \.offset) { index, question in
                questionBlock(index, question)
            }
            if let error = state.lastError {
                errorHint(error)
            }
            actionRow
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.08)))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.accentColor.opacity(0.4), lineWidth: 1))
    }

    // MARK: - Sections

    /// Small-caps header row. With exactly one question the question's own
    /// header (≤12 chars per the spec's card rules) titles the card;
    /// otherwise a generic label — per-question headers still render in
    /// their blocks below.
    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "questionmark.bubble.fill")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.accentColor)
            Text(headerText.uppercased())
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
        }
    }

    private var headerText: String {
        if state.approval.questions.count == 1,
           let header = state.approval.questions[0].header, !header.isEmpty {
            return header
        }
        return state.approval.questions.count > 1 ? "Questions" : "Question"
    }

    private func questionBlock(_ index: Int, _ question: AgentV2ApprovalQuestion) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            // Multi-question cards restate each question's own small-caps
            // header above its text (the card title only carries the first).
            if state.approval.questions.count > 1,
               let header = question.header, !header.isEmpty {
                Text(header.uppercased())
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.tertiary)
            }
            Text(question.question)
                .font(.system(size: 13, weight: .semibold))
                .fixedSize(horizontal: false, vertical: true)
            ForEach(question.options, id: \.label) { option in
                optionRow(option, question: question, index: index)
            }
        }
    }

    private func optionRow(
        _ option: AgentV2ApprovalOption,
        question: AgentV2ApprovalQuestion,
        index: Int
    ) -> some View {
        let isSelected = selection[index]?.contains(option.label) ?? false
        return Button {
            toggle(option.label, question: question, index: index)
        } label: {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: iconName(isSelected: isSelected, multi: question.multiSelect))
                    .font(.system(size: 12))
                    .foregroundStyle(isSelected ? Color.accentColor : Color.secondary)
                    .frame(width: 14, alignment: .center)
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label)
                        .font(.system(size: 12, weight: isSelected ? .semibold : .regular))
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let description = option.description, !description.isEmpty {
                        Text(description)
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(isSelected ? Color.accentColor.opacity(0.12) : Color.secondary.opacity(0.05))
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(option.label)\(isSelected ? ", selected" : "")")
    }

    private func iconName(isSelected: Bool, multi: Bool) -> String {
        switch (isSelected, multi) {
        case (true, true): return "checkmark.square.fill"
        case (false, true): return "square"
        case (true, false): return "largecircle.fill.circle"
        case (false, false): return "circle"
        }
    }

    /// Single-select replaces the choice (a second tap on the chosen option
    /// keeps it — there is no "none of the above" state to return to);
    /// multi-select toggles membership.
    private func toggle(_ label: String, question: AgentV2ApprovalQuestion, index: Int) {
        if question.multiSelect {
            var labels = selection[index] ?? []
            if labels.contains(label) { labels.remove(label) } else { labels.insert(label) }
            selection[index] = labels
        } else {
            selection[index] = [label]
        }
    }

    private func errorHint(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 11))
                .foregroundStyle(Color.orange)
            // The failure KEPT the card so the answers are still selected and
            // Submit is a retry — say so, or a transient 503 reads as dead.
            Text("\(message) Your selection is kept — submit again to retry.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var actionRow: some View {
        HStack(spacing: 8) {
            Button(state.submitted ? "Submitted" : "Submit") {
                Task { await onSubmit(Self.answers(selection: selection,
                                                   questions: state.approval.questions)) }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(!canSubmit)
            // Deliberately NO .keyboardShortcut(.defaultAction): this card
            // sits above a focused composer, and Return must send a message,
            // not answer the question. (Same call as PendingActionCard.)
            Button("Dismiss", action: onDismiss)
                .controlSize(.small)
            if let hint = submitHint {
                Text(hint)
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
            }
            Spacer(minLength: 0)
        }
    }

    // MARK: - Answer mapping

    /// Selection → the decision POST's `answers` dictionary. Keyed by the
    /// question TEXT and comma-joined for multi-select — the contract the
    /// server passes through verbatim to the SDK's `updatedInput.answers`
    /// (engine.mjs: "multi-select arrives comma-joined from the client";
    /// the live round-trip smoke answers `{ [q.question]: chosen }`).
    /// Labels are sorted before joining so the wire value is deterministic
    /// regardless of tap order. Unanswered questions are omitted — the card
    /// disables Submit while any exist, so this is belt-and-braces.
    static func answers(
        selection: [Int: Set<String>],
        questions: [AgentV2ApprovalQuestion]
    ) -> [String: String] {
        var answers: [String: String] = [:]
        for (index, question) in questions.enumerated() {
            guard let labels = selection[index], !labels.isEmpty else { continue }
            answers[question.question] = labels.sorted().joined(separator: ",")
        }
        return answers
    }
}
