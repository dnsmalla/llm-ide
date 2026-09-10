import SwiftUI

/// Menu-bar llm-agent chat — compact Gemini-style surface matching the iPhone
/// companion. Shares the `.quick` `ChatEngine` (and its code-pipeline
/// transport) with `LlmChatSheet` and the phone via `ChatEngineRegistry` —
/// one conversation, not the old `/kb/agent/ask` meeting-agent transcript.
struct MenuBarChatView: View {
    let api: LlmIdeAPIClient

    @EnvironmentObject private var theme: ThemeStore
    @EnvironmentObject private var config: AppConfig
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var projectStore: ProjectStore
    @Environment(\.openWindow) private var openWindow
    // Read-only: whether the server this window would talk to knows the
    // `ask` mode this chat sends. See `QuickChatContext.serverSupportsAsk`.
    @Environment(BackendManager.self) private var backend

    // The SAME engine the LLM Chat sheet and the phone drive: one engine per
    // conversation. Each surface holding its own would mean three engines
    // writing one session file — the concurrent-holders bug that already
    // resurrected deleted chats through persistCurrentChat.
    @State private var engine: ChatEngine
    @State private var viewModel: LlmChatViewModel
    /// Measured bubble heights for THIS surface only (the sheet renders the
    /// same `.quick` engine at another width). See `BubbleHeightCache`.
    @State private var bubbleHeights = BubbleHeightCache()
    @State private var draft: String = ""
    @State private var confirmingClear = false
    @State private var clearingHistory = false
    @State private var popoverWindow: NSWindow?
    @StateObject private var completion = CompletionController()
    @State private var pendingSkillIds: [String] = []
    @State private var pendingDirectives: [String] = []
    /// Why the last send was refused (server too old, unreachable, or the
    /// shared engine already busy). Cleared when the next send starts.
    @State private var sendRefusal: String?
    /// The draft as `refuse()` restored it. `.onChange(of: draft)` clears the
    /// notice only when the draft differs from this — the restore itself is a
    /// draft change, and clearing on it wiped the message in the same update
    /// that set it, so the two refusals only the composer can show (busy, and
    /// "server didn't answer") were never readable.
    @State private var refusalDraft: String = ""
    @FocusState private var inputFocused: Bool

    @State private var voiceService = VoiceInputService()
    @State private var voiceState = ChatVoiceState()

    private static let greetingBlue = Color(red: 0.26, green: 0.52, blue: 0.96)
    private static let suggestionPrompts = [
        "Discuss a topic with me",
        "What can you do?",
        "Help me make a decision",
    ]

    init(api: LlmIdeAPIClient) {
        self.api = api
        // Resolved from the registry rather than constructed here — see the
        // `engine` property's doc comment. `ChatTransportFactory` (inside the
        // registry) picks the real code-pipeline transport; this view no
        // longer builds a meeting-agent transport at all.
        let engine = ChatEngineRegistry.shared.engine(for: .quick, api: api)
        _engine = State(initialValue: engine)
        _viewModel = State(initialValue: LlmChatViewModel(engine: engine))
    }

    private var combinedError: String? {
        engine.error ?? viewModel.lastError
    }

    var body: some View {
        VStack(spacing: 0) {
            headerBar
            Divider().opacity(0.5)
            contentArea
            // The code pipeline cannot run without an active project (the
            // server throws `workspaceRoot is required`), so decline rather
            // than send a request that must fail.
            if QuickChatContext.resolve(config: config, projectStore: projectStore) == nil {
                Text(QuickChatContext.noProjectMessage)
                    .font(.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .padding(14)
            } else if !QuickChatContext.serverSupportsAsk(backend.serverApiVersion) {
                // This surface sends `mode: "ask"` (see `wireEngine()`
                // below); an older server resolves that to `execute`, giving
                // this window full act tools with no approval UI to render
                // them. Hiding the composer is the gate — no path here can
                // reach `sendDraft()` without it.
                Text(QuickChatContext.unsupportedServerMessage(apiVersion: backend.serverApiVersion))
                    .font(.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .padding(14)
                    // Re-probe while this text is showing, so the gate can
                    // OPEN without the user doing anything — the version is
                    // otherwise only recorded inside `BackendManager.start()`,
                    // which never runs for a logged-in user with autostart
                    // off (`node server.mjs` in a terminal). Cancelled with
                    // the view.
                    .task { await QuickChatContext.pollServerVersionWhileUnsupported(backend: backend) }
            } else {
                composerSection
            }
        }
        .frame(width: 380, height: 520)
        .background(Color(nsColor: .windowBackgroundColor))
        .background(MenuBarChatWindowAccessor(window: $popoverWindow))
        .onExitCommand { closePopover() }
        // Re-probe once per appearance, whichever way the gate currently
        // reads. The closed-state `.task` above only runs while the gate is
        // CLOSED, so without this a gate that is stale-OPEN — the app cached
        // v47, then the user restarted the server from a terminal on an older
        // checkout, which never routes through `BackendManager.start()` —
        // would never be re-checked at all. This bounds that window to one
        // popover session instead of the life of the app process.
        .task { await backend.refreshServerApiVersion() }
        .onAppear {
            // Must land before anything below can trigger the engine's first
            // session load: the engine is registry-cached and shared with the
            // sheet and the phone, so it may already hold a session — from a
            // prior appearance of this popover, from the sheet, or from the
            // phone — possibly for a DIFFERENT project. `attach` owns that
            // three-case decision for all three surfaces (see its doc
            // comment); doing it by hand here is what wrote project B's turns
            // into project A's session file, and what tripped `pointerKey`'s
            // assertion after a project was closed. Without any call at all,
            // `.quick` has no session to persist into and every turn lives in
            // memory only until the popover closes.
            QuickChatContext.attach(engine, config: config, projectStore: projectStore)
            wireEngine()
            wireVoiceService()
            completion.configure(api: api, repoRoot: nil)
            inputFocused = true
            Task {
                await completion.loadMetaIfNeeded()
            }
            // No `viewModel.loadHistory()`/history-poll here anymore, and no
            // transcript-changed notification observer below either (that
            // notification is gone entirely now). Both used
            // to re-fetch `/kb/agent/ask/history` and call
            // `engine.replaceMessages(...)` over whatever `engine.messages`
            // already held — a table the code-pipeline transport never writes
            // to, so every fetch came back stale/empty and erased the just-
            // streamed reply within seconds of it landing. The `.quick` engine
            // is shared and owns its own transcript now; this view just
            // renders `engine.messages` and never overwrites it from a second
            // source.
        }
        .onDisappear {
            if voiceState.isRecording {
                voiceState.setRecording(false)
                voiceService.cancel()
            }
        }
        .onChange(of: draft) { _, newValue in
            // Typing again retires the last refusal — but NOT the restore
            // that accompanied it (see `refusalDraft`).
            if sendRefusal != nil, newValue != refusalDraft { sendRefusal = nil }
        }
        .onChange(of: config.activeCLI) { _, _ in
            // A model id belongs to the provider it was picked under (the picker lives here).
            // `effectiveModelId` keeps a pick when the new provider lists no
            // models at all, so without this a Custom/GLM turn would carry the
            // previous provider's id.
            engine.quickChatModelId = nil
        }
        .onChange(of: projectStore.activeProject) { _, _ in
            // The composer gate above re-evaluates LIVE on `@Published
            // activeProject`, so without this the gate and the engine
            // disagree the moment a project is opened, switched or closed
            // while this popover is on screen: the composer appears (or
            // stays) while the engine is still wired to the previous
            // project — or to none, in which case every turn is silently
            // unpersisted because `persistCurrentChat()` no-ops on an empty
            // session id. Same shared decision as `.onAppear`.
            QuickChatContext.attach(engine, config: config, projectStore: projectStore)
        }
        .onChange(of: draft) { _, newValue in
            completion.update(draft: newValue)
        }
        .onChange(of: engine.messages) { oldValue, newValue in
            // Same call `CodeAssistantPanel` wires for its own scopes
            // (`CodeAssistantPanel.swift:261`) — persists (debounced while a
            // reply is streaming) and fires the VoiceOver announcement for a
            // newly-arrived assistant turn. `.quick` had nothing wiring this
            // at all until now, so a turn was correct in memory but never
            // reached `ChatSessionStore`.
            engine.announceAndPersist(oldValue: oldValue, newValue: newValue)
            // No `viewModel.notifyIfTurnFinished(...)` here anymore (the
            // method itself is gone, along with `LlmChatViewModel`'s whole
            // `/kb/agent/ask/history` polling — see its header comment):
            // this used to post a transcript-changed notification to tell
            // other ask-history listeners the SHARED table changed, which,
            // for a turn run through the code pipeline, it never did. The
            // notification had no observers left and has been removed.
            if let recovered = viewModel.recoverableDraftAfterFailure(oldValue: oldValue, newValue: newValue) {
                draft = recovered
            }
        }
        // The clear confirm is an in-popover overlay, NOT `.alert`: inside a
        // `MenuBarExtra(.window)` panel the system alert PRESENTS but its
        // action closures never run on macOS 26 (verified live: the DELETE
        // never reached the server while the same endpoint cleared fine over
        // curl) — the same AppKit-presentation fragility that already forced
        // `confirmationDialog` off this surface. A plain SwiftUI overlay has
        // no second window to lose the action in.
        .overlay {
            if confirmingClear { clearConfirmOverlay }
        }
    }

    /// In-popover replacement for the clear-confirmation alert.
    private var clearConfirmOverlay: some View {
        ZStack {
            Color.black.opacity(0.25)
                .ignoresSafeArea()
                .onTapGesture { confirmingClear = false }
            VStack(alignment: .leading, spacing: 10) {
                Text("Clear the conversation?")
                    .font(.system(size: 14, weight: .semibold))
                Text("This removes this chat's saved conversation and its memory.")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack {
                    Spacer()
                    Button("Cancel") { confirmingClear = false }
                        .keyboardShortcut(.cancelAction)
                    Button("Clear", role: .destructive) {
                        confirmingClear = false
                        Task { await performClearHistory() }
                    }
                    .keyboardShortcut(.defaultAction)
                }
            }
            .padding(16)
            .frame(width: 300)
            .background(RoundedRectangle(cornerRadius: 12).fill(Color(nsColor: .windowBackgroundColor)))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.primary.opacity(0.12)))
            .shadow(radius: 18)
        }
        .transition(.opacity)
    }

    // MARK: - Header

    private var headerBar: some View {
        HStack(spacing: 10) {
            Button {
                closePopover()
            } label: {
                Image(systemName: "minus")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(theme.current.textMuted)
            }
            .buttonStyle(.plain)
            .help("Minimize chat")

            Spacer()

            if clearingHistory {
                ProgressView().controlSize(.small)
            }

            Button {
                openMainWindow(section: .explorer)
            } label: {
                Image(systemName: "macwindow")
                    .font(.system(size: 13))
                    .foregroundStyle(theme.current.textMuted)
            }
            .buttonStyle(.plain)
            .help("Open main window")

            userAvatar

            Menu {
                Button("Clear conversation", role: .destructive) {
                    confirmingClear = true
                }
                .disabled(engine.messages.isEmpty || engine.busy || clearingHistory)
                Divider()
                Button("Settings…") {
                    openMainWindow(section: .settings)
                }
                Button("Quit \(L.App.name)") {
                    NSApplication.shared.terminate(nil)
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(theme.current.textMuted)
            }
            .menuStyle(.borderlessButton)
            .frame(width: 20)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private var userAvatar: some View {
        let initial = greetingName.prefix(1).uppercased()
        return Text(initial)
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 26, height: 26)
            .background(Color.orange.gradient)
            .clipShape(Circle())
            .accessibilityLabel("Signed in as \(greetingName)")
    }

    // MARK: - Content

    @ViewBuilder
    private var contentArea: some View {
        if voiceState.isRecording {
            recordingOverlay
        } else if engine.messages.isEmpty {
            welcomeState
        } else {
            transcriptView
        }
    }

    private var recordingOverlay: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "waveform")
                .font(.system(size: 40))
                .symbolEffect(.variableColor.iterative.reversing, options: .speed(1.5))
                .foregroundStyle(Self.greetingBlue)
            
            VStack(spacing: 8) {
                Text("Listening…")
                    .font(.headline)
                    .foregroundStyle(theme.current.text)
                
                if !voiceState.interimText.isEmpty {
                    Text(voiceState.interimText)
                        .font(.body)
                        .italic()
                        .foregroundStyle(theme.current.textMuted)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 40)
                }
            }
            
            Button {
                toggleVoiceInput()
            } label: {
                Text("Stop")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 24)
                    .padding(.vertical, 10)
                    .background(Self.greetingBlue)
                    .clipShape(Capsule())
            }
            .buttonStyle(.plain)
            
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .transition(.opacity)
    }

    private var welcomeState: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer(minLength: 24)
            VStack(alignment: .leading, spacing: 6) {
                Text("Hello, \(greetingName)")
                    .font(.system(size: 28, weight: .regular))
                    .foregroundStyle(Self.greetingBlue)
                Text("How can I help you today?")
                    .font(.system(size: 28, weight: .regular))
                    .foregroundStyle(theme.current.text)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 20)

            VStack(spacing: 10) {
                ForEach(Self.suggestionPrompts, id: \.self) { prompt in
                    suggestionPill(prompt)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 28)

            if let err = combinedError {
                Text(err)
                    .font(.caption)
                    .foregroundStyle(theme.current.danger)
                    .padding(.horizontal, 20)
                    .padding(.top, 12)
            }
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func statusDot(_ label: String, up: Bool) -> some View {
        HStack(spacing: 4) {
            Circle()
                .fill(up ? Color.green : Color.red)
                .frame(width: 7, height: 7)
            Text(label)
                .font(.caption2.weight(.medium))
                .foregroundStyle(theme.current.textMuted)
        }
    }

    private func voiceErrorBanner(_ error: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 11))
                .foregroundStyle(theme.current.danger)
            Text(error)
                .font(.system(size: 11))
                .foregroundStyle(theme.current.textMuted)
                .lineLimit(1)
            Spacer()
            Button {
                voiceState.error = nil
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(theme.current.textMuted)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(theme.current.danger.opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    private func suggestionPill(_ text: String) -> some View {
        Button {
            draft = text
            inputFocused = true
        } label: {
            Text(text)
                .font(.system(size: 14))
                .foregroundStyle(theme.current.text)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                .background(Color(nsColor: .controlBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
    }

    private var transcriptView: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(engine.messages) { msg in
                        messageRow(msg)
                            .id(msg.id)
                    }
                    if engine.busy {
                        HStack(spacing: 6) {
                            ProgressView().controlSize(.small)
                            Text(engine.statusText.isEmpty ? "Thinking…" : engine.statusText)
                                .font(.caption)
                                .foregroundStyle(theme.current.textMuted)
                        }
                        .id("typing-indicator")
                    }
                    if let err = combinedError {
                        Text(err)
                            .font(.caption)
                            .foregroundStyle(theme.current.danger)
                    }
                    // The `.quick` engine is shared with the LLM Chat sheet and
                    // the phone; neither this view nor the sheet used to read
                    // `pendingApproval` at all, so a parked approval on this
                    // engine was invisible everywhere until the server's
                    // 15-minute expiry. See `ChatMessageList`'s identical block
                    // for why it's keyed by requestId (a second approval must
                    // not inherit the previous card's @State).
                    if let approvalState = engine.pendingApproval {
                        if approvalState.approval.kind == "ToolApproval" {
                            ToolApprovalCard(
                                state: approvalState,
                                onDecide: { action in
                                    await engine.submitToolDecision(action: action)
                                }
                            )
                            .id(approvalState.approval.requestId)
                            .padding(.top, 4)
                        } else {
                            ApprovalQuestionCard(
                                state: approvalState,
                                onSubmit: { answers in
                                    await engine.submitApproval(answers: answers)
                                },
                                onDismiss: { engine.dismissApproval() }
                            )
                            .id(approvalState.approval.requestId)
                            .padding(.top, 4)
                        }
                    }
                }
                .padding(16)
            }
            .onChange(of: engine.messages.count) { _, _ in
                if let last = engine.messages.last {
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
            .onChange(of: engine.revealedCount) { _, _ in
                if let last = engine.messages.last, last.id == engine.revealingTurnID {
                    proxy.scrollTo(last.id, anchor: .bottom)
                }
            }
            .onChange(of: engine.busy) { _, b in
                if b { withAnimation { proxy.scrollTo("typing-indicator", anchor: .bottom) } }
            }
        }
    }

    @ViewBuilder
    private func messageRow(_ msg: ChatMessage) -> some View {
        if msg.status == .streaming && msg.content.isEmpty {
            EmptyView()
        } else {
            let isUser = msg.role == .user
            VStack(alignment: isUser ? .trailing : .leading, spacing: 4) {
                Text(isUser ? "You" : "LLM-IDE")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(theme.current.textMuted)

                if isUser {
                    // User input is plain text — rendered verbatim, no markdown.
                    Text(displayedContent(for: msg))
                        .font(.subheadline)
                        .foregroundStyle(theme.current.text)
                        .textSelection(.enabled)
                        .multilineTextAlignment(.trailing)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(Self.greetingBlue.opacity(0.12))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                } else {
                    SelfSizingMarkdownView(
                        markdown: displayedContent(for: msg),
                        isDark: theme.current.isDark
                    ) { h in
                        bubbleHeights[msg.id] = h
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .frame(height: bubbleHeights.height(for: msg.id, min: 24))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color(nsColor: .controlBackgroundColor))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                }

                if !isUser, msg.status == .stopped {
                    Text("Stopped")
                        .font(.caption2)
                        .foregroundStyle(theme.current.textMuted)
                }
            }
            .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
        }
    }

    /// Always the full content. `revealedCount` is the streamed length, so
    /// the prefix was always the whole string — but `String.prefix` is O(n)
    /// in grapheme clusters and this ran on every render of a growing reply.
    /// The counter still drives the follow-the-stream scroll below.
    private func displayedContent(for msg: ChatMessage) -> String {
        msg.content
    }

    // MARK: - Composer

    private var composerSection: some View {
        VStack(spacing: 0) {
            if let err = voiceState.error {
                voiceErrorBanner(err)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 6)
            }
            if completion.isOpen {
                CompletionMenu(controller: completion, onAccept: acceptCompletion)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 6)
            }
            if let refusal = sendRefusal {
                Text(refusal)
                    .font(.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 6)
            }
            VStack(alignment: .leading, spacing: 10) {
                TextField("Type / to use skills", text: $draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...5)
                    .focused($inputFocused)
                    .onSubmit { sendDraft() }
                HStack(spacing: 8) {
                    Button {
                        inputFocused = true
                        if draft.isEmpty { draft = "/" }
                        else { draft += " /" }
                    } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(theme.current.textMuted)
                            .frame(width: 28, height: 28)
                    }
                    .buttonStyle(.plain)
                    .help("Insert / for skills")

                    Spacer()

                    modelMenu

                    voiceButton
                        .keyboardShortcut("m", modifiers: .command)

                    sendButton
                }
            }
            .padding(14)
            .background(
                RoundedRectangle(cornerRadius: 18)
                    .strokeBorder(theme.current.border.opacity(0.8), lineWidth: 1)
                    .background(RoundedRectangle(cornerRadius: 18).fill(Color(nsColor: .textBackgroundColor)))
            )
            .padding(.horizontal, 14)
            .padding(.bottom, 14)
        }
    }

    private var modelMenu: some View {
        Menu {
            Button("Auto") { engine.quickChatModelId = nil }
            Divider()
            ForEach(modelsForPicker(), id: \.id) { model in
                Button(model.displayName) { engine.quickChatModelId = model.id }
            }
        } label: {
            HStack(spacing: 4) {
                Text(selectedModelLabel)
                    .font(.system(size: 13))
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
            }
            .foregroundStyle(theme.current.textMuted)
        }
        .menuStyle(.borderlessButton)
    }

    private var sendButton: some View {
        Button {
            if engine.busy { viewModel.stop() } else { sendDraft() }
        } label: {
            ZStack {
                RoundedRectangle(cornerRadius: 10)
                    .fill(canSend || engine.busy ? Self.greetingBlue : Color(nsColor: .controlBackgroundColor))
                    .frame(width: 36, height: 36)
                if engine.busy {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(.white)
                } else {
                    Image(systemName: "sparkles")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(canSend ? .white : theme.current.textMuted)
                }
            }
        }
        .buttonStyle(.plain)
        .disabled(!engine.busy && !canSend)
        .help(engine.busy ? "Stop" : "Send")
    }

    private var voiceButton: some View {
        Button {
            toggleVoiceInput()
        } label: {
            ZStack(alignment: .topTrailing) {
                RoundedRectangle(cornerRadius: 10)
                    .fill(voiceState.isRecording ? theme.current.danger : Color(nsColor: .controlBackgroundColor))
                    .frame(width: 36, height: 36)
                
                Image(systemName: voiceState.isRecording ? "waveform" : "mic.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(voiceState.isRecording ? .white : theme.current.textMuted)
                    .symbolEffect(.pulse, options: .speed(1.5), isActive: voiceState.isRecording)
                
                if !voiceState.isRecording {
                    Image(systemName: "sparkles")
                        .font(.system(size: 8))
                        .foregroundStyle(theme.current.accent)
                        .padding(4)
                }
            }
        }
        .buttonStyle(.plain)
        .help(voiceState.isRecording ? "Stop recording" : "Voice input")
    }

    // MARK: - Actions

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var greetingName: String {
        if let name = session.user?.displayName, !name.isEmpty { return name }
        if let email = session.user?.email.split(separator: "@").first {
            return String(email).capitalized
        }
        return "there"
    }

    private var selectedModelLabel: String {
        QuickChatContext.modelLabel(modelId: engine.quickChatModelId,
                                    defaultModelId: config.defaultModelId,
                                    models: modelsForPicker())
    }

    private func modelsForPicker() -> [AIModel] {
        let tool = AICliTool(rawValue: config.activeCLI) ?? .claudeCode
        return tool.models
    }

    private func closePopover() {
        if voiceState.isRecording {
            voiceState.setRecording(false)
            voiceService.cancel()
        }
        MenuBarChatWindow.orderOut(popoverWindow)
    }

    private func performClearHistory() async {
        guard !clearingHistory else { return }
        clearingHistory = true
        defer { clearingHistory = false }
        if voiceState.isRecording {
            voiceState.setRecording(false)
            voiceService.cancel()
        }
        draft = ""
        pendingSkillIds = []
        pendingDirectives = []
        voiceState.reset()
        if engine.busy { viewModel.stop() }
        // NOT `viewModel.clearHistory()` — that clears the unrelated
        // `/kb/agent/ask` table this surface no longer reads or writes, then
        // calls `engine.replaceMessages([])` straight over the shared `.quick`
        // engine's real transcript. The engine owns this transcript now,
        // persisted under `ChatSessionStore`, so clearing goes through its own
        // session lifecycle instead — which also forgets the session's
        // server-side memory (see `ChatEngine.deleteSession`).
        await engine.clearCurrentChat()
    }

    /// Install the shared `.quick` transport closure. Both Mac surfaces call
    /// the SAME installer, so it no longer matters which appeared last — see
    /// `QuickChatContext.installTransport`.
    private func wireEngine() {
        QuickChatContext.installTransport(on: engine, config: config, projectStore: projectStore, api: api)
    }

    private func wireVoiceService() {
        voiceService.onFinalResult = { text in
            if !text.isEmpty {
                draft = text
                sendDraft()
            }
            voiceState.reset()
        }
        voiceService.onPartialResult = { text in
            voiceState.updateInterimText(text)
        }
        voiceService.onError = { error in
            voiceState.setError(error)
        }
    }

    private func toggleVoiceInput() {
        if voiceState.isRecording {
            voiceState.setRecording(false)
            voiceService.stopListening()
            return
        }
        Task { @MainActor in
            let started = await voiceService.startListening()
            if started {
                withAnimation {
                    voiceState.setRecording(true)
                }
            } else if voiceState.error == nil {
                voiceState.setError("Failed to start voice input")
            }
        }
    }

    private func acceptCompletion() {
        guard let accept = completion.acceptSelected(currentDraft: draft) else {
            completion.close()
            return
        }
        switch accept {
        case .replaceDraft(let s):
            draft = s
        case .useSkill(let id, _, let newDraft):
            pendingSkillIds.append(id)
            draft = newDraft
        case .useDirective(_, _, let directive, let newDraft):
            pendingDirectives.append(directive)
            draft = newDraft
        case .navigate(let section, _, let newDraft):
            draft = newDraft
            openMainWindow(section: section)
        case .attachFile:
            completion.close()
        }
        completion.close()
    }

    private func sendDraft() {
        // Cleared FIRST, before the early returns below: a slash command or an
        // empty field still means the user moved on from the refusal.
        sendRefusal = nil
        guard !engine.busy else { return }
        var text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        if ChatSlashCommands.isClearCommand(text) {
            draft = ""
            confirmingClear = true
            return
        }
        if let section = ChatSlashCommands.sectionCommand(text) {
            draft = ""
            openMainWindow(section: section)
            return
        }

        draft = ""
        // Everything the composer is about to hand over, kept as it was
        // BEFORE the directives are folded into the text — a refused send
        // must restore the field and its chips exactly, not a merged blob
        // with the chips gone.
        let restoreDraft = text
        let directives = pendingDirectives
        if !pendingDirectives.isEmpty {
            text = pendingDirectives.joined(separator: "\n") + "\n\n" + text
            pendingDirectives = []
        }
        let skills = pendingSkillIds
        pendingSkillIds = []
        // Re-check the gate from a FRESH probe, not from the value this view
        // rendered with: a server swapped for an older one while the popover
        // stayed open would otherwise receive `ask` and resolve it to
        // `execute`. On refusal the draft goes back in the field and the
        // composer disappears on the next body pass (the gate now reads the
        // probed version), so nothing is silently lost.
        Task { @MainActor in
            let gate = await QuickChatContext.confirmServerSupportsAsk(backend: backend)
            // Restore the composer exactly as it was and SAY why — a refusal
            // that only removes the composer (or, when the server merely
            // didn't answer, changes nothing at all) reads as a dead button.
            @MainActor func refuse(_ message: String?) {
                draft = restoreDraft
                refusalDraft = restoreDraft
                pendingDirectives = directives
                pendingSkillIds = skills
                sendRefusal = message
            }
            guard case .allowed = gate else { return refuse(gate.message) }
            // Re-check AFTER the probe's suspension, immediately before the
            // send: the first guard ran before an await, so a second surface
            // (or the phone) could have taken the engine's single turn slot
            // meanwhile. `startTurn` claims that slot synchronously, so this
            // check and the send below cannot be split.
            guard !engine.busy else {
                return refuse("Another message is still being answered. Send this one again in a moment.")
            }
            viewModel.send(text, skillIds: skills)
        }
    }

    private func openMainWindow(section: ShellState.Section) {
        // Leaving the popover floating over the main window it just opened
        // reads as "the popover won't close" — navigation away IS a dismissal.
        closePopover()
        openWindow(id: "main")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            if section == .settings {
                NotificationCenter.default.post(name: .openSettings, object: nil)
            } else {
                NotificationCenter.default.post(name: .openSection, object: section.rawValue)
            }
            NSApp.activate(ignoringOtherApps: true)
        }
    }
}
