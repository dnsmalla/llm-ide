import SwiftUI

/// Menu-bar llm-agent chat — compact Gemini-style surface matching the iPhone
/// companion. Uses the same `/kb/agent/ask` transcript as `LlmChatSheet`.
struct MenuBarChatView: View {
    let api: LlmIdeAPIClient

    @EnvironmentObject private var theme: ThemeStore
    @EnvironmentObject private var config: AppConfig
    @EnvironmentObject private var session: SessionStore
    @Environment(\.openWindow) private var openWindow

    @State private var engine: ChatEngine
    @State private var viewModel: LlmChatViewModel
    @State private var draft: String = ""
    @State private var confirmingClear = false
    @State private var clearingHistory = false
    @State private var historyRefreshTask: Task<Void, Never>?
    @State private var popoverWindow: NSWindow?
    @State private var selectedModelId: String? = nil
    @StateObject private var completion = CompletionController()
    @State private var pendingSkillIds: [String] = []
    @State private var pendingDirectives: [String] = []
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
        let engine = ChatEngine(scope: .explorer, transport: AgentAskTransport(api: api))
        _engine = State(initialValue: engine)
        _viewModel = State(initialValue: LlmChatViewModel(engine: engine, historyAPI: api))
    }

    private var combinedError: String? {
        engine.error ?? viewModel.lastError
    }

    var body: some View {
        VStack(spacing: 0) {
            headerBar
            Divider().opacity(0.5)
            contentArea
            composerSection
        }
        .frame(width: 380, height: 520)
        .background(Color(nsColor: .windowBackgroundColor))
        .background(MenuBarChatWindowAccessor(window: $popoverWindow))
        .onExitCommand { closePopover() }
        .onAppear {
            wireEngine()
            wireVoiceService()
            completion.configure(api: api, repoRoot: nil)
            inputFocused = true
            Task {
                await viewModel.loadHistory()
                await completion.loadMetaIfNeeded()
            }
            startHistoryRefresh()
        }
        .onDisappear {
            historyRefreshTask?.cancel()
            historyRefreshTask = nil
            if voiceState.isRecording {
                voiceState.setRecording(false)
                voiceService.cancel()
            }
        }
        .onChange(of: selectedModelId) { _, _ in wireEngine() }
        .onChange(of: draft) { _, newValue in
            completion.update(draft: newValue)
        }
        .onChange(of: engine.messages) { oldValue, newValue in
            viewModel.notifyIfTurnFinished(oldValue: oldValue, newValue: newValue)
            if let recovered = viewModel.recoverableDraftAfterFailure(oldValue: oldValue, newValue: newValue) {
                draft = recovered
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .llmChatTranscriptChanged)) { _ in
            Task { await viewModel.loadHistory() }
        }
        .alert("Clear the conversation?", isPresented: $confirmingClear) {
            Button("Clear", role: .destructive) {
                Task { await performClearHistory() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes the shared transcript from the server. iPhone and Mac will both start fresh.")
        }
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
                
                Text(displayedContent(for: msg))
                    .font(.subheadline)
                    .foregroundStyle(theme.current.text)
                    .textSelection(.enabled)
                    .multilineTextAlignment(isUser ? .trailing : .leading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(
                        isUser
                            ? Self.greetingBlue.opacity(0.12)
                            : Color(nsColor: .controlBackgroundColor)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                
                if !isUser, msg.status == .stopped {
                    Text("Stopped")
                        .font(.caption2)
                        .foregroundStyle(theme.current.textMuted)
                }
            }
            .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
        }
    }

    private func displayedContent(for msg: ChatMessage) -> String {
        guard msg.id == engine.revealingTurnID else { return msg.content }
        return String(msg.content.prefix(engine.revealedCount))
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
            Button("Auto") { selectedModelId = nil }
            Divider()
            ForEach(modelsForPicker(), id: \.id) { model in
                Button(model.displayName) { selectedModelId = model.id }
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
        if let id = selectedModelId ?? (config.defaultModelId.isEmpty ? nil : config.defaultModelId),
           let model = modelsForPicker().first(where: { $0.id == id }) {
            return model.displayName
        }
        return "Auto"
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

    private func startHistoryRefresh() {
        historyRefreshTask?.cancel()
        historyRefreshTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                guard !clearingHistory else { continue }
                await viewModel.loadHistory()
            }
        }
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
        await viewModel.clearHistory()
        startHistoryRefresh()
    }

    private func wireEngine() {
        engine.resolveTransportInput = { message, history, attachments, skills in
            let tool = AICliTool(rawValue: config.activeCLI) ?? .claudeCode
            let model = selectedModelId ?? (config.defaultModelId.isEmpty ? nil : config.defaultModelId)
            return ChatTransportInput(
                message: message,
                history: history,
                attachments: attachments,
                skills: skills,
                agentContext: nil,
                language: config.preferredLanguage.isEmpty ? nil : config.preferredLanguage,
                model: model,
                provider: ChatTransportInput.makeProvider(selectedProvider: tool.rawValue),
                mode: nil
            )
        }
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
        if !pendingDirectives.isEmpty {
            text = pendingDirectives.joined(separator: "\n") + "\n\n" + text
            pendingDirectives = []
        }
        let skills = pendingSkillIds
        pendingSkillIds = []
        viewModel.send(text, skillIds: skills)
    }

    private func openMainWindow(section: ShellState.Section) {
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
