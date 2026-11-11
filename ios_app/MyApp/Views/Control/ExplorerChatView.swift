import SwiftUI

/// Explorer Chat: sends an execute turn to the desktop, which does the work in the project and streams the result.
/// The transcript is the desktop's phone chat, shared with the Chat tab until the core gains separate sessions.
struct ExplorerChatView: View {
    @EnvironmentObject var connection: ConnectionService
    @EnvironmentObject var llmIdeStore: LlmIdeChatStore
    @EnvironmentObject var projects: ProjectsStore
    @State private var text = ""

    var body: some View {
        VStack(spacing: 0) {
            if connection.connectionStatus != .connected {
                StatusBanner(.connection(isConnecting: connection.connectionStatus == .connecting))
            }
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: DesignSystem.Spacing.sm) {
                        ForEach(Array(llmIdeStore.llmIdeMessages.enumerated()), id: \.offset) { _, message in
                            ChatBubble(message: message)
                        }
                        if llmIdeStore.isStreaming { ProgressView().padding() }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(DesignSystem.Spacing.md)
                }
                .onChange(of: llmIdeStore.llmIdeMessages.count) { _ in
                    withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
                }
            }
            if llmIdeStore.pendingApproval != nil {
                Text("The desktop is waiting for an approval. Open Chat to answer it.")
                    .font(DesignSystem.Typography.captionFont)
                    .foregroundColor(DesignSystem.Colors.textSecondary)
                    .padding(DesignSystem.Spacing.sm)
            }
            HStack(spacing: DesignSystem.Spacing.sm) {
                TextField("Ask the desktop to change code…", text: $text, axis: .vertical)
                    .lineLimit(1...6)
                    .textFieldStyle(.roundedBorder)
                Button {
                    let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !prompt.isEmpty else { return }
                    text = ""
                    Task { _ = await llmIdeStore.sendLlmideChat(prompt, mode: "execute") }
                } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.title2)
                }
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || llmIdeStore.isStreaming || connection.connectionStatus != .connected)
                .accessibilityLabel("Run on desktop")
            }
            .padding(DesignSystem.Spacing.md)
        }
        .navigationTitle("Explorer")
        .background(DesignSystem.Colors.background.ignoresSafeArea())
    }
}
