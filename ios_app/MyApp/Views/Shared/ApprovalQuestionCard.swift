import SwiftUI
import SharedProtocol

/// The agent's mid-turn question, answerable by tapping.
///
/// The turn is parked until this is answered, and stage one of a plan is
/// mostly questions — so this is the difference between planning from the
/// phone and waiting to get back to the Mac. Every answer the agent will
/// accept is already on screen as a label: tapping one is the whole
/// interaction, and the composer stays for the case where none of them says
/// what you mean.
struct ApprovalQuestionCard: View {
    let request: ApprovalRequest
    let onSubmit: ([Int: Set<String>]) -> Void

    /// Chosen labels per question index.
    @State private var selection: [Int: Set<String>] = [:]

    /// Every question needs an answer — the server resumes the turn with what
    /// it is given, and a half-answered round just asks again.
    private var canSubmit: Bool {
        request.questions.indices.allSatisfy { !(selection[$0]?.isEmpty ?? true) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: DesignSystem.Spacing.md) {
            header
            ForEach(Array(request.questions.enumerated()), id: \.offset) { index, question in
                questionBlock(index: index, question: question)
            }
            Button(action: submit) {
                Text("Send answer")
                    .font(.callout.weight(.semibold))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(!canSubmit)
        }
        .padding(DesignSystem.Spacing.md)
        .background(
            RoundedRectangle(cornerRadius: 14)
                .fill(Color.accentColor.opacity(0.08))
                .overlay(RoundedRectangle(cornerRadius: 14)
                    .strokeBorder(Color.accentColor.opacity(0.35), lineWidth: 1)))
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "questionmark.bubble.fill")
                .foregroundStyle(Color.accentColor)
            Text(request.questions.count > 1 ? "Questions" : "Question")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private func questionBlock(index: Int, question: MobileApprovalQuestion) -> some View {
        VStack(alignment: .leading, spacing: DesignSystem.Spacing.sm) {
            if let header = question.header, !header.isEmpty {
                Text(header.uppercased())
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            Text(question.question)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            if question.multiSelect {
                Text("Pick any that apply")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            ForEach(question.options, id: \.label) { option in
                optionRow(index: index, question: question, option: option)
            }
        }
    }

    private func optionRow(index: Int, question: MobileApprovalQuestion,
                           option: MobileApprovalOption) -> some View {
        let chosen = selection[index]?.contains(option.label) == true
        return Button {
            toggle(index: index, label: option.label, multiSelect: question.multiSelect)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: chosen
                      ? (question.multiSelect ? "checkmark.square.fill" : "largecircle.fill.circle")
                      : (question.multiSelect ? "square" : "circle"))
                    .foregroundStyle(chosen ? Color.accentColor : .secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label)
                        .font(.callout.weight(chosen ? .semibold : .regular))
                        .multilineTextAlignment(.leading)
                    if let description = option.description, !description.isEmpty {
                        Text(description)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(DesignSystem.Spacing.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10)
                .fill(chosen ? Color.accentColor.opacity(0.14) : Color.secondary.opacity(0.08)))
        }
        .buttonStyle(.plain)
        .foregroundStyle(.primary)
    }

    private func toggle(index: Int, label: String, multiSelect: Bool) {
        var chosen = selection[index] ?? []
        if multiSelect {
            if chosen.contains(label) { chosen.remove(label) } else { chosen.insert(label) }
        } else {
            // Single-select: tapping the chosen one again clears it, so a
            // mis-tap is recoverable without leaving the card.
            chosen = chosen.contains(label) ? [] : [label]
        }
        selection[index] = chosen
    }

    private func submit() {
        guard canSubmit else { return }
        onSubmit(selection)
    }
}
