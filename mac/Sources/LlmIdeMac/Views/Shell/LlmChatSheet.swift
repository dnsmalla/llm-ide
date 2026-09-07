import SwiftUI

/// Global LLM Chat sheet — the SAME `.quick` `ChatEngine` `MenuBarChatView`
/// and the phone drive, resolved via `ChatEngineRegistry`. One conversation,
/// not a per-surface copy: three engines each owning this scope would be
/// three engines writing a single session file — the concurrent-holders bug
/// that already resurrected deleted chats through `persistCurrentChat`.
///
/// As of Task 6, this runs on the code pipeline in read-only `ask` mode
/// (`wireEngine()`), the same as the menu bar — see `MenuBarChatView.swift`
/// for the worked example this mirrors. `send`/`stop` live on
/// `LlmChatViewModel` so they're unit-testable without a SwiftUI host; the
/// transcript itself is `engine.messages` directly, persisted by
/// `ChatSessionStore` via `engine.announceAndPersist`.
struct LlmChatSheet: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject private var config: AppConfig
    @EnvironmentObject private var projectStore: ProjectStore
    @Environment(\.dismiss) private var dismiss

    // The SAME engine the menu bar and the phone drive — see the type's doc
    // comment above.
    @State private var engine: ChatEngine
    @State private var viewModel: LlmChatViewModel
    @State private var draft: String = ""
    @State private var confirmingClear = false
    @State private var clearingHistory = false
    /// Older assistant replies the user tapped to expand. Ids are stable
    /// (the engine's own message ids, not re-derived per poll now that
    /// there's no poll), so an expansion survives a re-render.
    @State private var manuallyExpanded: Set<UUID> = []
    @FocusState private var inputFocused: Bool

    /// Hand-written rather than memberwise: `viewModel` and `engine` must
    /// share the SAME `ChatEngine` instance (the view renders `engine`
    /// directly; the view model drives its turn lifecycle), and `@State`'s
    /// initial value needs `api` to resolve it from the registry — `api`
    /// isn't in scope for a property initializer.
    init(api: LlmIdeAPIClient) {
        self.api = api
        // Resolved from the registry rather than constructed here (no more
        // `ChatEngine(scope: .explorer, transport: AgentAskTransport(api:))`)
        // — `ChatTransportFactory` (inside the registry) picks the real
        // code-pipeline transport.
        let engine = ChatEngineRegistry.shared.engine(for: .quick, api: api)
        _engine = State(initialValue: engine)
        _viewModel = State(initialValue: LlmChatViewModel(engine: engine))
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
            // The code pipeline cannot run without an active project (the
            // server throws `workspaceRoot is required`), so decline rather
            // than send a request that must fail — same gate as the menu bar.
            if QuickChatContext.resolve(config: config, projectStore: projectStore) == nil {
                Text(QuickChatContext.noProjectMessage)
                    .font(.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .padding(14)
            } else {
                inputRow
            }
        }
        .frame(minWidth: 520, idealWidth: 580, minHeight: 480, idealHeight: 560)
        .onAppear {
            // Must land before anything below can trigger the engine's first
            // session load (`handleOnAppearSessions`/pointer read) — set it
            // late and `.quick` silently falls back to the unsuffixed
            // pointer key, reloading the PREVIOUS project's conversation on
            // a project switch. See `ChatEngine+Session.swift`'s `pointerKey`.
            engine.quickChatProjectId = QuickChatContext.resolve(config: config, projectStore: projectStore)?.projectId
            // Same guard `CodeAssistantPanel.handleOnAppear`/`MenuBarChatView`
            // use: the engine is shared, so it may already have a session
            // loaded from a prior appearance of this sheet, the menu bar, or
            // (once Task 8 lands) the phone. Only run the full resolve-or-mint
            // path when nothing is loaded yet; otherwise just refresh the list.
            // `...IfReady()` (not the raw call) — this sheet's own `.sheet`
            // presentation isn't gated on a project, so first appearance can
            // happen with `quickChatProjectId == nil`; see that method's doc
            // comment for why the raw call would assert/misbehave then.
            if engine.currentSessionIDString.isEmpty {
                engine.handleOnAppearSessionsIfReady()
            } else {
                engine.refreshSessions()
            }
            wireEngine()
            inputFocused = true
        }
        .onChange(of: projectStore.activeProject) { _, _ in
            // The sheet lives in the main window, where switching the active
            // project mid-conversation is plausible (unlike the menu-bar
            // popover). `switchQuickChatProject(to:)` is the engine-owned
            // session-swap sequence for exactly this: it stops the in-flight
            // turn and persists it under the OLD project's session (the same
            // prologue `switchSession`/`createNewSession` use) BEFORE
            // re-pointing at the NEW project and reloading — so a turn in
            // flight against project A can never land its reply into project
            // B's session, and B's freshly-loaded chat never inherits A's
            // transient agent/approval state (see that method's doc comment
            // on `ChatEngine+Session.swift`).
            engine.switchQuickChatProject(
                to: QuickChatContext.resolve(config: config, projectStore: projectStore)?.projectId)
        }
        .onChange(of: engine.messages) { oldValue, newValue in
            // Same call `CodeAssistantPanel`/`MenuBarChatView` wire for their
            // own scopes — persists (debounced while a reply is streaming)
            // and fires the VoiceOver announcement for a newly-arrived
            // assistant turn. Nothing did this for the sheet's engine before
            // Task 6; a turn was correct in memory but never reached
            // `ChatSessionStore`.
            engine.announceAndPersist(oldValue: oldValue, newValue: newValue)
            // A connectivity/server failure (never a user-initiated stop —
            // that's `.stopped`, not `.failed`) leaves the user's prompt
            // sent-and-gone with no retry affordance yet; restoring it into
            // the composer at least means the words aren't lost.
            if let recovered = viewModel.recoverableDraftAfterFailure(oldValue: oldValue, newValue: newValue) {
                draft = recovered
            }
        }
        .confirmationDialog(
            "Clear the conversation?",
            isPresented: $confirmingClear,
            titleVisibility: .visible
        ) {
            Button("Clear", role: .destructive) {
                Task { await performClearHistory() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes this chat's saved conversation and its memory.")
        }
    }

    private var header: some View {
        HStack {
            Image(systemName: "bubble.left.and.text.bubble.right")
                .foregroundStyle(theme.current.accent)
            Text("llm-chat")
                .font(.headline)
            if clearingHistory {
                ProgressView().controlSize(.small)
            }
            Spacer()
            Button {
                confirmingClear = true
            } label: {
                Label("Clear", systemImage: "trash")
            }
            .disabled(engine.messages.isEmpty || engine.busy || clearingHistory)
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
            // No longer "shared with the iPhone Chat tab" — that claim
            // belonged to the old `/kb/agent/ask` transcript. The phone isn't
            // on this `.quick` engine yet (a later task), so don't overclaim.
            Text("Ask LLM-IDE anything about the active project.")
                .font(.callout)
                .foregroundStyle(.secondary)
            Text("Examples:")
                .font(.caption.bold())
                .foregroundStyle(.secondary)
                .padding(.top, 6)
            Group {
                examplePrompt("What does this project do?")
                examplePrompt("What should I work on next?")
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
        // The streaming placeholder starts life with empty content — an
        // empty bubble with a name label and nothing else would flash on
        // screen for no reason before the first chunk lands. The
        // "Thinking…" row below the list already covers this turn's
        // in-progress state.
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
    /// don't apply to this sheet's single-shot turns.
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

    /// Send the project context and the read-only `ask` mode — same shape as
    /// `MenuBarChatView.wireEngine()`. This sheet has no model picker of its
    /// own, so `model` always follows the config default rather than a
    /// per-turn override.
    private func wireEngine() {
        engine.resolveTransportInput = { message, history, attachments, skills in
            let tool = AICliTool(rawValue: config.activeCLI) ?? .claudeCode
            let model = config.defaultModelId.isEmpty ? nil : config.defaultModelId
            return ChatTransportInput(
                message: message,
                history: history,
                attachments: attachments,
                skills: skills,
                // Was nil, which is why this chat could neither read nor write
                // project memory — the whole point of unifying it.
                agentContext: QuickChatContext.resolve(config: config, projectStore: projectStore)?.agentContext,
                language: config.preferredLanguage.isEmpty ? nil : config.preferredLanguage,
                model: model,
                provider: ChatTransportInput.makeProvider(selectedProvider: tool.rawValue),
                // Read-only: this sheet can be dismissed while the menu bar
                // or the phone drives the same engine, so a turn that could
                // park on an approval would hang with nothing able to render
                // the card.
                mode: "ask"
            )
        }
    }

    /// Clear this chat's saved conversation and its session memory. NOT a
    /// blind `engine.replaceMessages([])` and NOT the old `/kb/agent/ask`
    /// table — the engine owns this transcript now, persisted under
    /// `ChatSessionStore`, so clearing goes through its own session lifecycle
    /// (`clearCurrentChat()` → `deleteSession`), which also forgets the
    /// session's server-side memory.
    private func performClearHistory() async {
        guard !clearingHistory else { return }
        clearingHistory = true
        defer { clearingHistory = false }
        // Drop remembered expansions with the transcript they belong to.
        manuallyExpanded.removeAll()
        if engine.busy { viewModel.stop() }
        await engine.clearCurrentChat()
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
