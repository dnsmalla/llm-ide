import SwiftUI
import SharedProtocol

/// A tool/edit permission prompt from a running turn: exactly what would change (the file and the
/// before/after text, the file being written, or the command), then Deny / Allow once. There is no
/// "always allow" here — that persists a rule and stays a Mac decision.
struct ToolApprovalCard: View {
    let request: ToolApprovalRequest
    let onAnswer: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: DesignSystem.Spacing.sm) {
            HStack(spacing: 6) {
                Image(systemName: icon).foregroundColor(DesignSystem.Colors.primary)
                Text("Allow \(request.toolName)?")
                    .font(DesignSystem.Typography.headlineFont)
                    .foregroundColor(DesignSystem.Colors.textPrimary)
            }
            // The change itself can be long; it scrolls so the buttons below never leave the screen.
            ScrollView {
                VStack(alignment: .leading, spacing: DesignSystem.Spacing.sm) { details }
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 260)
            HStack(spacing: DesignSystem.Spacing.sm) {
                Button(role: .destructive) { onAnswer(false) } label: {
                    Text("Deny").font(.callout.weight(.semibold)).frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                Button { onAnswer(true) } label: {
                    Text("Allow once").font(.callout.weight(.semibold)).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
            }
            .controlSize(.large)
        }
        .padding(DesignSystem.Spacing.md)
        .background(DesignSystem.Colors.surface, in: RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusM))
        .overlay(RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusM)
            .stroke(DesignSystem.Colors.primary.opacity(0.5), lineWidth: 1))
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var details: some View {
        if let summary = request.summary, !summary.isEmpty {
            Text(summary).font(DesignSystem.Typography.footnoteFont)
                .foregroundColor(DesignSystem.Colors.textSecondary)
        }
        if let path = request.filePath {
            Label(path, systemImage: "doc")
                .font(DesignSystem.Typography.footnoteFont.monospaced())
                .foregroundColor(DesignSystem.Colors.textSecondary)
        }
        if request.overwrites == true {
            Label("This replaces a file that already exists.", systemImage: "exclamationmark.triangle.fill")
                .font(DesignSystem.Typography.footnoteFont).foregroundColor(.orange)
        }
        if request.replaceAll == true {
            Label("Replaces ALL occurrences, not just one.", systemImage: "exclamationmark.triangle.fill")
                .font(DesignSystem.Typography.footnoteFont).foregroundColor(.orange)
        }
        if let old = request.oldString { block(old, tint: DesignSystem.Colors.danger, label: "Remove") }
        if let new = request.newString { block(new, tint: DesignSystem.Colors.success, label: "Add") }
        if let preview = request.contentPreview { block(preview, tint: DesignSystem.Colors.success, label: "New file") }
        if let command = request.command { block(command, tint: DesignSystem.Colors.textSecondary, label: "Command") }
        if request.truncated {
            Label("Long change — only the start is shown here.", systemImage: "scissors")
                .font(DesignSystem.Typography.captionFont).foregroundColor(DesignSystem.Colors.textTertiary)
        }
    }

    private var icon: String {
        switch request.toolName.lowercased() {
        case "bash": return "terminal"
        case "write": return "doc.badge.plus"
        default: return "pencil.and.outline"
        }
    }

    private func block(_ text: String, tint: Color, label: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label.uppercased()).font(DesignSystem.Typography.captionFont.weight(.semibold)).foregroundColor(tint)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text).font(DesignSystem.Typography.codeFont).textSelection(.enabled)
                    .foregroundColor(DesignSystem.Colors.textPrimary)
            }
            .padding(8)
            .background(tint.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
        }
    }
}
