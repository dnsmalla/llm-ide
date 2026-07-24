import SwiftUI

/// The shared input-bar spine: a multi-line text field + a send button, with a
/// leading slot for surface-specific affordances (the llm-ide surface puts its
/// paperclip menu + mic button there; the explorer surface passes nothing).
///
/// Factored from the duplicated `HStack { TextField; Button(send) }` block in
/// `LlmIdeControlView.inputBar` and `ExplorerChatView.inputBar`. What stays in
/// each caller: the wrapping `VStack { Divider(); … }` and any attachment-chip
/// strip above — those differ enough across surfaces to not be worth forcing
/// through here.
///
/// `canSend` gates both the send button's tint and its enabled state, matching
/// the pre-refactor behavior. The focus binding lets the parent control
/// keyboard focus (e.g. release it when opening the photo picker / mic).
struct ChatInputBar<Leading: View>: View {
    @Binding private var text: String
    private let placeholder: String
    private let canSend: Bool
    private let isFocused: FocusState<Bool>.Binding
    private let onSend: () -> Void
    @ViewBuilder private let leading: () -> Leading

    init(
        text: Binding<String>,
        placeholder: String,
        canSend: Bool,
        isFocused: FocusState<Bool>.Binding,
        onSend: @escaping () -> Void,
        @ViewBuilder leading: @escaping () -> Leading
    ) {
        self._text = text
        self.placeholder = placeholder
        self.canSend = canSend
        self.isFocused = isFocused
        self.onSend = onSend
        self.leading = leading
    }

    /// Convenience init for surfaces with no leading affordances (e.g. explorer).
    init(
        text: Binding<String>,
        placeholder: String,
        canSend: Bool,
        isFocused: FocusState<Bool>.Binding,
        onSend: @escaping () -> Void
    ) where Leading == EmptyView {
        self.init(text: text, placeholder: placeholder, canSend: canSend,
                  isFocused: isFocused, onSend: onSend) { EmptyView() }
    }

    var body: some View {
        HStack(spacing: DesignSystem.Spacing.sm) {
            leading()
            TextField(placeholder, text: $text, axis: .vertical)
                .font(.system(size: DesignSystem.Typography.body))
                .textFieldStyle(.plain)
                .lineLimit(1...4)
                .focused(isFocused)
                .padding(.horizontal, DesignSystem.Spacing.md)
                .padding(.vertical, 10)
                .background(DesignSystem.Colors.surface)
                .overlay(
                    RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusL)
                        .stroke(DesignSystem.Colors.border, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusL))
                .onSubmit(onSend)
            Button(action: onSend) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 30))
                    .foregroundColor(canSend ? DesignSystem.Colors.primary : DesignSystem.Colors.textTertiary)
            }
            .disabled(!canSend)
        }
        .padding(DesignSystem.Spacing.md)
        .background(DesignSystem.Colors.surfaceSecondary)
    }
}
