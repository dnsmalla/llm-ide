import SwiftUI
import os.log

/// Global LLM Chat sheet — same `/kb/agent/ask` transcript the iPhone uses via
/// `llmide_chat`. History is server-persisted so Mac and iPhone stay in sync.
///
/// As of Task 11, this runs on the same `ChatEngine` the Code Assistant panel
/// uses — via `AgentAskTransport`, a `ChatTransport` over `/kb/agent/ask`
/// instead of `/code-assist` — rather than its own hand-rolled
/// send/transcript state. `send`/`stop`/`loadHistory`/`clearHistory` live on
/// `LlmChatViewModel` so they're unit-testable without a SwiftUI host.
struct LlmChatSheet: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var theme: ThemeStore
    @Environment(\.dismiss) private var dismiss

    @State private var engine: ChatEngine
    @State private var viewModel: LlmChatViewModel
    @State private var draft: String = ""
    @State private var confirmingClear = false
    @State private var historyRefreshTask: Task<Void, Never>?
    @FocusState private var inputFocused: Bool
    private let log = Logger(subsystem: "com.llmide.macapp", category: "LlmChatSheet")

    /// Hand-written rather than memberwise: `viewModel` and `engine` must
    /// share the SAME `ChatEngine` instance (the view renders `engine`
    /// directly; the view model drives its turn lifecycle and its
    /// server-history polling), and `@State`'s initial value needs `api` to
    /// build it — `api` isn't in scope for a property initializer.
    init(api: LlmIdeAPIClient) {
        self.api = api
        let engine = ChatEngine(scope: .explorer, transport: AgentAskTransport(api: api))
        _engine = State(initialValue: engine)
        _viewModel = State(initialValue: LlmChatViewModel(engine: engine, historyAPI: api))
    }

    private var combinedError: String? {
        engine.error ?? viewModel.lastError
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            transcriptView
            Divider()
            inputRow
        }
        .frame(minWidth: 520, idealWidth: 580, minHeight: 480, idealHeight: 560)
        .onAppear {
            inputFocused = true
            Task { await viewModel.loadHistory() }
            historyRefreshTask = Task {
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    await viewModel.loadHistory()
                }
            }
        }
        .onDisappear {
            historyRefreshTask?.cancel()
            historyRefreshTask = nil
        }
        .onChange(of: engine.messages) { oldValue, newValue in
            viewModel.notifyIfTurnFinished(oldValue: oldValue, newValue: newValue)
        }
        .onReceive(NotificationCenter.default.publisher(for: .llmChatTranscriptChanged)) { _ in
            Task { await viewModel.loadHistory() }
        }
        .confirmationDialog(
            "Clear the conversation?",
            isPresented: $confirmingClear,
            titleVisibility: .visible
        ) {
            Button("Clear", role: .destructive) {
                Task { await viewModel.clearHistory() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes the shared LLM Chat transcript from the server. iPhone and Mac will both start fresh.")
        }
    }

    private var header: some View {
        HStack {
            Image(systemName: "bubble.left.and.text.bubble.right")
                .foregroundStyle(theme.current.accent)
            Text("llm-chat")
                .font(.headline)
            if viewModel.loadingHistory {
                ProgressView().controlSize(.small)
            }
            Spacer()
            Text("Synced with iPhone")
                .font(.caption)
                .foregroundStyle(.secondary)
            Button {
                confirmingClear = true
            } label: {
                Label("Clear", systemImage: "trash")
            }
            .disabled(engine.messages.isEmpty)
            Button("Close") { dismiss() }
                .keyboardShortcut(.cancelAction)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private var transcriptView: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if engine.messages.isEmpty {
                        emptyState
                    }
                    ForEach(engine.messages) { msg in
                        bubble(for: msg)
                            .id(msg.id)
                    }
                    if engine.busy {
                        HStack(spacing: 6) {
                            ProgressView().controlSize(.small)
                            Text(engine.statusText.isEmpty ? "Thinking…" : engine.statusText)
                                .font(.callout)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.leading, 10)
                    }
                    if let err = combinedError {
                        Text(err)
                            .font(.callout)
                            .foregroundStyle(theme.current.danger)
                            .padding(.horizontal, 10)
                    }
                }
                .padding(14)
            }
            .onChange(of: engine.messages.count) { _, _ in
                if let last = engine.messages.last {
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Ask LLM-IDE anything. Messages here are shared with the iPhone Chat tab.")
                .font(.callout)
                .foregroundStyle(.secondary)
            Text("Examples:")
                .font(.caption.bold())
                .foregroundStyle(.secondary)
                .padding(.top, 6)
            Group {
                examplePrompt("Summarize my last meeting notes.")
                examplePrompt("What should I follow up on this week?")
                examplePrompt("Explain the active project's architecture.")
            }
        }
    }

    private func examplePrompt(_ text: String) -> some View {
        Button {
            draft = text
            inputFocused = true
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "arrow.right.circle")
                    .foregroundStyle(.secondary)
                Text(text)
                    .font(.callout)
                    .foregroundStyle(theme.current.text)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Spacer()
            }
            .padding(.vertical, 4)
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func bubble(for msg: ChatMessage) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: msg.role == .user ? "person.fill" : "bubble.left.fill")
                .foregroundStyle(msg.role == .user ? Color.accentColor : theme.current.accent)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(msg.role == .user ? "You" : "LLM-IDE")
                    .font(.caption.bold())
                    .foregroundStyle(.secondary)
                if msg.role == .user {
                    // User input is plain text — rendered verbatim, no markdown.
                    Text(msg.content)
                        .font(.body)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    AssistantBubbleContent(markdown: msg.content, isDark: theme.current.isDark)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(msg.role == .user ? Color.accentColor.opacity(0.08) : theme.current.accent.opacity(0.08))
        .cornerRadius(8)
    }

    private var inputRow: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message llm-chat…", text: $draft, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...4)
                .focused($inputFocused)
                .onSubmit { sendDraft() }
            sendButton
        }
        .padding(14)
    }

    /// While a turn is running this becomes a Stop control — matching the
    /// Code Assistant composer's `sendButton` (`ChatComposer.swift`), just
    /// without that view's queueing/autonomous-agent affordances, which
    /// don't apply to this sheet's single-shot `/kb/agent/ask` turns.
    private var sendButton: some View {
        Button {
            if engine.busy {
                viewModel.stop()
            } else {
                sendDraft()
            }
        } label: {
            if engine.busy {
                Image(systemName: "stop.fill")
                    .font(.system(size: 14, weight: .semibold))
            } else {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.title2)
            }
        }
        .buttonStyle(.plain)
        .disabled(!engine.busy && draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        .keyboardShortcut(.return, modifiers: .command)
        .help(engine.busy ? "Stop the running response" : "Send (⌘↩)")
        .accessibilityLabel(engine.busy ? "Stop" : "Send message")
    }

    // MARK: - Actions

    /// Submit the draft as a new turn. No-ops while a turn is already
    /// running (matching the original `guard !sending`) or when the draft is
    /// blank — this sheet doesn't queue a second message like the Code
    /// Assistant composer does.
    private func sendDraft() {
        guard !engine.busy else { return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        viewModel.send(text)
    }
}

/// Assistant bubble's markdown render, isolated into its own view so its
/// measured content height is local `@State` — per bubble instance, NOT
/// cached into a shared dictionary keyed by message id (that's
/// `ChatEngine.bubbleHeights`, the main panel's Task 15 concern; this sheet
/// scrolls its `ScrollView` natively and has no need for it).
private struct AssistantBubbleContent: View {
    let markdown: String
    let isDark: Bool
    @State private var height: CGFloat = 24

    var body: some View {
        SelfSizingMarkdownView(markdown: markdown, isDark: isDark) { h in
            if height != h { height = h }
        }
        .frame(maxWidth: 640, alignment: .leading)
        .frame(height: max(height, 24))
    }
}
