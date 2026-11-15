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
            RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusM, style: .continuous)
                // Opaque base first: the tint alone is translucent and would show the shadow through it.
                .fill(DesignSystem.Colors.surface)
                .overlay(RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusM, style: .continuous)
                    .fill(DesignSystem.Colors.primary.opacity(0.08)))
                .overlay(RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusM, style: .continuous)
                    .strokeBorder(DesignSystem.Colors.primary.opacity(0.35), lineWidth: 1)))
        .shadow(color: .black.opacity(DesignSystem.Layout.shadowOpacityRaised),
                radius: DesignSystem.Layout.shadowRadiusRaised, x: 0, y: 6)
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "questionmark.bubble.fill")
                .foregroundColor(DesignSystem.Colors.primary)
            Text(request.questions.count > 1 ? "Questions" : "Question")
                .font(DesignSystem.Typography.footnoteFont.weight(.semibold))
                .foregroundColor(DesignSystem.Colors.textSecondary)
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private func questionBlock(index: Int, question: MobileApprovalQuestion) -> some View {
        VStack(alignment: .leading, spacing: DesignSystem.Spacing.sm) {
            if let header = question.header, !header.isEmpty {
                Text(header.uppercased())
                    .font(.caption2.weight(.semibold))
                    .foregroundColor(DesignSystem.Colors.textTertiary)
            }
            Text(question.question)
                .font(DesignSystem.Typography.calloutFont)
                .foregroundColor(DesignSystem.Colors.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            if question.multiSelect {
                Text("Pick any that apply")
                    .font(.caption2)
                    .foregroundColor(DesignSystem.Colors.textTertiary)
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
                    .foregroundColor(chosen ? DesignSystem.Colors.primary : DesignSystem.Colors.textSecondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label)
                        .font(.callout.weight(chosen ? .semibold : .regular))
                        .multilineTextAlignment(.leading)
                    if let description = option.description, !description.isEmpty {
                        Text(description)
                            .font(DesignSystem.Typography.captionFont)
                            .foregroundColor(DesignSystem.Colors.textSecondary)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(DesignSystem.Spacing.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusS, style: .continuous)
                .fill(chosen ? DesignSystem.Colors.primary.opacity(0.14) : DesignSystem.Colors.surfaceSecondary))
        }
        .buttonStyle(.plain)
        .foregroundColor(DesignSystem.Colors.textPrimary)
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
