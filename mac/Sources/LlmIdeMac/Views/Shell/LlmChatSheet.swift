import SwiftUI

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
    /// Older assistant replies the user tapped to expand. Ids are stable
    /// across polls (derived from the row's `seq`, see
    /// `LlmChatViewModel.chatMessage(from:)`), so an expansion survives a
    /// history refresh instead of snapping shut under the user.
    @State private var manuallyExpanded: Set<UUID> = []
    @FocusState private var inputFocused: Bool

    /// Hand-written rather than memberwise: `viewModel` and `engine` must
    /// share the SAME `ChatEngine` instance (the view renders `engine`
    /// directly; the view model drives its turn lifecycle and its
    /// server-history polling), and `@State`'s initial value needs `api` to
    /// build it — `api` isn't in scope for a property initializer.
    ///
    /// WARNING: `scope: .explorer` is a borrowed label, not a real scope for
    /// this chat — this engine never persists a `ChatSession` file (its
    /// transcript is server-side, via `AgentAskTransport`/`loadHistory`), so
    /// nothing here actually reads/writes anything keyed by `.explorer`
    /// today. That's true only as long as no one calls this engine's
    /// session-file methods (`persistCurrentChat`, `handleOnAppearSessions`,
    /// `switchSession`, …) — which `LlmChatSheet`/`LlmChatViewModel`
    /// deliberately never do. A future task wiring persistence onto this
    /// sheet (Tasks 13/14) must NOT reuse `.explorer` for that — add a
    /// dedicated `ChatScope` case instead, or it will silently collide with
    /// the real Explorer panel's saved chats.
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
            // Backing-off fallback poll, shared with MenuBarChatView — see
            // `LlmChatViewModel.PollBackoff` for why a 2s heartbeat was never
            // what kept this transcript in sync.
            viewModel.resetPollBackoff()
            historyRefreshTask = Task { await viewModel.runHistoryPolling() }
        }
        .onDisappear {
            historyRefreshTask?.cancel()
            historyRefreshTask = nil
        }
        .onChange(of: engine.messages) { oldValue, newValue in
            viewModel.notifyIfTurnFinished(oldValue: oldValue, newValue: newValue)
            // A connectivity/server failure (never a user-initiated stop —
            // that's `.stopped`, not `.failed`) leaves the user's prompt
            // sent-and-gone with no retry affordance yet (Task 16 owns
            // that); restoring it into the composer at least means the
            // words aren't lost. `draft = text` unconditionally, matching
            // the original sheet's synchronous `catch { draft = text }` —
            // this can overwrite something the user started typing during
            // the failed round trip, same as the original did.
            if let recovered = viewModel.recoverableDraftAfterFailure(oldValue: oldValue, newValue: newValue) {
                draft = recovered
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .llmChatTranscriptChanged)) { _ in
            // Something changed: refresh now AND pull the backoff back to the
            // floor, so the loop doesn't sit out the rest of a long window
            // while a conversation is active.
            viewModel.resetPollBackoff()
            Task { await viewModel.loadHistory() }
        }
        .confirmationDialog(
            "Clear the conversation?",
            isPresented: $confirmingClear,
            titleVisibility: .visible
        ) {
            Button("Clear", role: .destructive) {
                // Drop remembered expansions with the transcript they belong
                // to: message ids are derived from the row's `seq`, so a
                // stale id could otherwise match a future message and open a
                // reply the user never expanded.
                manuallyExpanded.removeAll()
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
                    // Computed once per render rather than per row: the
                    // expansion cutoff needs the position of each assistant
                    // message among the assistant messages, and deriving that
                    // inside `bubble(for:)` would make the list O(n²).
                    let expanded = expandedAssistantIDs
                    ForEach(engine.messages) { msg in
                        bubble(for: msg, isExpanded: expanded.contains(msg.id))
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

    /// How many of the most recent assistant replies render as full markdown.
    ///
    /// Each expanded reply is a `WKWebView` loading its own document, and this
    /// sheet has no collapse of its own — so a 50-row transcript stood up ~25
    /// of them, every one re-parsing the inlined highlighter, purely to show
    /// answers the user had already read. Recent replies are what people
    /// actually look at; older ones collapse to a preview and expand on tap,
    /// the same affordance the Code Assistant transcript has always had.
    private static let expandedAssistantLimit = 4

    /// Ids of the assistant messages that render as full markdown: the last
    /// `expandedAssistantLimit`, plus anything the user expanded by hand.
    private var expandedAssistantIDs: Set<UUID> {
        var ids = manuallyExpanded
        let assistantIDs = engine.messages.filter { $0.role == .assistant }.map(\.id)
        ids.formUnion(assistantIDs.suffix(Self.expandedAssistantLimit))
        return ids
    }

    @ViewBuilder
    private func bubble(for msg: ChatMessage, isExpanded: Bool) -> some View {
        // The streaming placeholder starts life with empty content (this
        // transport never streams chunks into it — it's filled in one shot
        // when the reply lands) — an empty bubble with a name label and
        // nothing else would flash on screen for no reason. The "Thinking…"
        // row below the list already covers this turn's in-progress state.
        if msg.status == .streaming && msg.content.isEmpty {
            EmptyView()
        } else {
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
                    } else if isExpanded {
                        AssistantBubbleContent(markdown: msg.content, isDark: theme.current.isDark)
                    } else {
                        collapsedAssistantContent(msg)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(10)
            .background(msg.role == .user ? Color.accentColor.opacity(0.08) : theme.current.accent.opacity(0.08))
            .cornerRadius(8)
        }
    }

    /// An older reply, as a tappable plain-text preview — no web view until
    /// the user asks for one.
    private func collapsedAssistantContent(_ msg: ChatMessage) -> some View {
        Button {
            manuallyExpanded.insert(msg.id)
        } label: {
            HStack(alignment: .top, spacing: 6) {
                Text(MarkdownRenderer.plainTextPreview(msg.content))
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                Image(systemName: "chevron.down")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Show full reply")
        .accessibilityLabel("Show full reply")
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
    ///
    /// WARNING: unlike `/code-assist`, `/kb/agent/ask` has no server-side
    /// cancel — see `LlmChatViewModel.stop()`'s doc comment. The bubble
    /// really does show `.stopped` immediately, it just isn't guaranteed to
    /// stay that way once the next history poll fetches what the server
    /// finished anyway.
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
