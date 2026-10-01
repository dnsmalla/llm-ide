import SwiftUI
import SharedProtocol

/// A tool/edit permission prompt from a running turn: exactly what would change (the file and the
/// before/after text, the file being written, or the command), then Deny / Allow once. There is no
/// "always allow" here — that persists a rule and stays a Mac decision.
struct ToolApprovalCard: View {
    let request: ToolApprovalRequest
    /// False while the link to the Mac is down: a tap would carry a request id the Mac no longer knows.
    var enabled: Bool = true
    let onAnswer: (Bool) -> Void

    /// A change cut for the phone can't be reviewed here, so it can't be allowed here (the Mac refuses
    /// too). Denying is always possible.
    private var canAllow: Bool { enabled && !request.truncated }

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
                .disabled(!enabled)
                Button { onAnswer(true) } label: {
                    Text("Allow once").font(.callout.weight(.semibold)).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(!canAllow)
            }
            .controlSize(.large)
            if request.truncated {
                Text("Too long to review on the phone — deny, or approve it on the Mac.")
                    .font(DesignSystem.Typography.captionFont).foregroundColor(DesignSystem.Colors.textTertiary)
            } else if !enabled {
                Text("Reconnecting… answer when the Mac is back.")
                    .font(DesignSystem.Typography.captionFont).foregroundColor(DesignSystem.Colors.textTertiary)
            }
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
