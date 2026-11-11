import SwiftUI
import SharedProtocol

/// Execute chat: sends execute turns to the desktop, which does the work in the project and streams the result.
/// It is its own chat on the desktop (`surface: "execute"`), separate from the Ask tab's, with its own
/// New chat and Clear controls.
struct ExplorerChatView: View {
    @EnvironmentObject var connection: ConnectionService
    @EnvironmentObject var store: ExecuteChatStore
    @EnvironmentObject var projects: ProjectsStore
    @State private var text = ""
    @State private var showClearConfirm = false

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: DesignSystem.Spacing.sm) {
                    if store.llmIdeMessages.isEmpty {
                        EmptyChatState(icon: "hammer", title: "Run a code change",
                                       subtitle: "Describe it; the desktop edits the project and reports back.")
                    }
                    ForEach(store.llmIdeMessages) { message in
                        bubble(message)
                    }
                    approvalCard
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(DesignSystem.Spacing.md)
            }
            .onChange(of: store.llmIdeMessages.last?.text) { _ in
                withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
            }
        }
    }

    private func bubble(_ message: ChatMessage) -> some View {
        let streaming = store.isStreaming && message.id == store.llmIdeMessages.last?.id
        return ChatBubble(message: message, isStreaming: streaming).id(message.id)
    }

    @ViewBuilder
    private var approvalCard: some View {
        if let request = store.pendingApproval {
            ApprovalQuestionCard(request: request) { selection in store.submitApproval(selection: selection) }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            if connection.connectionStatus != .connected {
                StatusBanner(.connection(isConnecting: connection.connectionStatus == .connecting))
            }
            if let err = connection.errorMessage {
                StatusBanner(.error(message: err) { connection.errorMessage = nil })
            }
            transcript
            if let tool = store.pendingToolApproval {
                ToolApprovalCard(request: tool, enabled: connection.connectionStatus == .connected) { store.submitToolApproval(allow: $0) }
                    .padding(.horizontal, DesignSystem.Spacing.md)
            }
            HStack(spacing: DesignSystem.Spacing.sm) {
                TextField("Describe the code change…", text: $text, axis: .vertical)
                    .lineLimit(1...6)
                    .textFieldStyle(.roundedBorder)
                Button {
                    let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !prompt.isEmpty else { return }
                    text = ""
                    Task { _ = await store.sendLlmideChat(prompt, mode: "execute") }
                } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.title2)
                }
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.isStreaming || connection.connectionStatus != .connected)
                .accessibilityLabel("Run on desktop")
            }
            .padding(DesignSystem.Spacing.md)
        }
        .navigationTitle("Execute")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button { store.newChat() } label: { Label("New chat", systemImage: "square.and.pencil") }
                        .disabled(store.isStreaming || !connection.supports(HostApiCommand.chatNew.capability))
                    Button(role: .destructive) { showClearConfirm = true } label: { Label("Delete this chat", systemImage: "trash") }
                        .disabled(store.llmIdeMessages.isEmpty || !connection.supports(HostApiCommand.chatHistoryClear.capability))
                } label: { Image(systemName: "ellipsis.circle") }
                .accessibilityLabel("Execute chat options")
            }
            if store.isStreaming {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(role: .destructive) { store.cancelStreaming() } label: { Image(systemName: "stop.fill") }
                        .accessibilityLabel("Stop the run")
                }
            }
        }
        .confirmationDialog("Delete this Execute chat?", isPresented: $showClearConfirm, titleVisibility: .visible) {
            Button("Delete on this iPhone and the desktop", role: .destructive) { store.clearLlmIdeChat() }
            Button("Cancel", role: .cancel) {}
        } message: { Text("The Ask chat is not affected. This can't be undone.") }
        .onAppear { store.loadSharedHistory() }
        .onChange(of: connection.connectionStatus) { status in if status == .connected { store.loadSharedHistory() } }
        .onChange(of: projects.state.selectedId) { _ in store.loadSharedHistory() }
        .background(DesignSystem.Colors.background.ignoresSafeArea())
    }
}
