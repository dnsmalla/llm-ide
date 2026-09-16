import SwiftUI

/// Status-bar chip for the shared LLM Chat surface (Mac sheet + menu-bar
/// popover + iPhone `llmide_chat`). Replaces the old meeting-agent badge — no
/// dispatch/stop/run controls here; tap opens the chat sheet, which runs the
/// shared `.quick` `ChatEngine` on the code pipeline in read-only `ask` mode,
/// not the retired `/kb/agent/ask` transcript.
struct LlmChatStatusBadge: View {
    @EnvironmentObject var theme: ThemeStore

    var body: some View {
        Button {
            NotificationCenter.default.post(name: .openLlmChatSheet, object: nil)
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "bubble.left.and.text.bubble.right")
                    .font(.system(size: 10))
                Text("llm-chat")
                    .font(.system(size: 11, weight: .medium))
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(theme.current.surface.opacity(0.6))
            .cornerRadius(4)
        }
        .buttonStyle(.plain)
        .help("LLM Chat — shared with iPhone (⌘⇧L)")
    }
}
