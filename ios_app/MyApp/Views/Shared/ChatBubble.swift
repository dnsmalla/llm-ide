import SwiftUI
import UIKit

/// One chat bubble in a transcript. Renders the user/assistant turn, the
/// "Thinking…" placeholder for an in-flight assistant turn, and an optional
/// image thumbnail above the text (used by the llm-ide surface; explorer
/// messages never carry `imageData` so the `if let` is a clean no-op there).
///
/// Factored from `LlmIdeControlView.bubble(_:)` and `ExplorerChatView.bubble(_:)`,
/// which were identical modulo the image branch. Quirks preserved:
/// - User bubble tints with `Colors.primary`; assistant uses `Colors.surface`
///   with a hairline `Colors.border` stroke.
/// - 40pt min-length spacers push each bubble to its side.
/// - `cornerRadiusM` + 10pt vertical / `Spacing.md` horizontal padding.
struct ChatBubble: View {
    let message: ChatMessage

    private var isUser: Bool { message.role == .user }
    private var isThinking: Bool { !isUser && message.text.isEmpty }

    var body: some View {
        HStack {
            if isUser { Spacer(minLength: 40) }
            Group {
                if isThinking {
                    HStack(spacing: 8) {
                        ProgressView().scaleEffect(0.8)
                        Text("Thinking…")
                            .font(.system(size: DesignSystem.Typography.body))
                            .foregroundColor(DesignSystem.Colors.textSecondary)
                    }
                } else {
                    VStack(alignment: isUser ? .trailing : .leading, spacing: 6) {
                        if let data = message.imageData, let ui = UIImage(data: data) {
                            Image(uiImage: ui)
                                .resizable().scaledToFit()
                                .frame(maxWidth: 200, maxHeight: 200)
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                        if !message.text.isEmpty {
                            Text(message.text)
                                .font(.system(size: DesignSystem.Typography.body))
                                .foregroundColor(isUser ? .white : DesignSystem.Colors.textPrimary)
                        }
                    }
                }
            }
            .padding(.horizontal, DesignSystem.Spacing.md)
            .padding(.vertical, 10)
            .background(isUser ? DesignSystem.Colors.primary : DesignSystem.Colors.surface)
            .overlay(
                RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusM)
                    .stroke(isUser ? Color.clear : DesignSystem.Colors.border, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusM))
            if !isUser { Spacer(minLength: 40) }
        }
    }
}
