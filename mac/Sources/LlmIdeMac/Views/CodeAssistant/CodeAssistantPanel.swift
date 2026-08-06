import SwiftUI
import AppKit

/// Claude-Code-style chat panel embedded inside ReviewView.  The user
/// can attach files from the Library, then ask the LLM to review, refactor,
/// explain, or generate code.  Each round-trip POSTs to /code-assist
/// with the message + attachments + the last few turns of history.
///
/// Everything is in-memory.  Nothing is written to disk on the server
/// side — the assistant is purely advisory.  When the user wants the
/// model to actually CHANGE files, they take its suggestion to the
/// Plan tab's Generate Code flow (which is review-gated).

/// How the agent's file-edit tool calls are accepted in the chat panel.
enum EditAcceptanceMode: String, CaseIterable, Identifiable {
    /// Show the confirmation card + `UpdateFileSheet` for every edit.
    case review
    /// Apply `update-file` edits immediately (to already-attached files,
    /// enforced by `confirmUpdateFile`); GitLab actions still always confirm.
    case auto

    var id: String { rawValue }
    var label: String { self == .auto ? "Auto" : "Review" }
    var icon: String { self == .auto ? "bolt.fill" : "checklist" }
    var help: String {
        self == .auto
            ? "Auto-apply file edits (attached files only) — no popup"
            : "Review each file edit in a confirmation popup"
    }
}

struct CodeAssistantPanel: View {
    let api: LlmIdeAPIClient
    /// Which section this chat belongs to. Chats are UUID files under
    /// `sessions/<uuid>.json` tagged with this scope; `ChatSessionStore`
    /// lists/filters by it and a per-scope pointer in UserDefaults tracks
    /// the current session. Required: each embedding site passes its own.
    let scope: ChatScope
    /// When set, this file is attached automatically the first time the panel appears.
    var initialURL: URL? = nil
    /// Hide "Add from Library" from the input bar (use when file is auto-attached).
    var showFileAttachButtons: Bool = true
    /// Show Cursor-style agent + model picker row in the input bar.
    var showModelPicker: Bool = false

    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @EnvironmentObject var projectStore: ProjectStore
    @Environment(LibraryItemStore.self) var library

    /// Skills/subagents the user invoked from the "/" menu, shown as removable
    /// chips so the composer stays clean. Two flavours, consumed one-shot on the
    /// next send:
    ///   - `.library(id)`   — central-repo skill the agent can't run; the id is
    ///     sent and the server injects its SKILL.md as instructions to follow.
    ///   - `.directive(text)` — in-built skill/subagent the agent runs by name;
    ///     the text ("Use the X skill:") is prepended to the outgoing message.
    struct InvokedSkill: Identifiable, Equatable {
        let id: String
        let name: String
        enum Action: Equatable { case library(String); case directive(String) }
        let action: Action
        var iconName: String { if case .library = action { return "books.vertical" } else { return "sparkles" } }
    }
    /// Attachments/modified-files/invoked-skills — see
    /// CodeAssistantAttachmentState's doc comment.
    @State var attachmentState = CodeAssistantAttachmentState()
    @State var history: [LlmIdeAPIClient.CodeAssistTurn] = []
    @State var draft: String = ""
    /// Shell / Claude-Code-style prompt history: submitted prompts (oldest →
    /// newest). Up-arrow walks back through them, Down walks forward, Down past
    /// the newest restores the in-progress draft. `historyIndex == nil` means
    /// we're editing the live draft, not browsing.
    @State var sentPrompts: [String] = []
    @State var historyIndex: Int? = nil
    @State var draftStash: String = ""
    /// Recent chats for this scope, newest `lastUsedAt` first — backs the
    /// session-picker popover.
    @State var sessions: [ChatSession] = []
    @State var showingSessionPicker = false
    /// UUID string of the chat currently loaded into `history`. Mirrored to
    /// UserDefaults under `chat.current.<scope>` so it survives relaunch.
    @State var currentSessionIDString: String = ""
    @State var busy: Bool = false
    /// Live agent status streamed from /code-assist (SSE): "Searching the web…",
    /// "Writing the answer…", etc. Shown in place of a static "Thinking…" so a
    /// 60–90s agent turn doesn't look hung. Reset at the start/end of each turn.
    @State var statusText: String = ""
    /// Handle to the in-flight user turn, so Stop can cancel it.
    @State var runTask: Task<Void, Never>?
    /// Messages the user submitted while a turn was running, in FIFO order; they
    /// auto-send one per turn as the current run finishes (or is stopped).
    /// FIFO of messages queued while a turn runs. Identifiable so a cancel
    /// button removes the RIGHT entry even after the queue shifts (drain pops
    /// the head between render and tap) — index-keyed rows deleted the wrong one.
    struct QueuedMessage: Identifiable { let id = UUID(); let text: String; let skillIds: [String] }
    @State var queued: [QueuedMessage] = []
    @State var error: String?
    /// Measured render height per assistant turn, keyed by turn id, so each
    /// markdown web-view bubble can be sized to its content in the scroll list.
    @State var bubbleHeights: [UUID: CGFloat] = [:]
    @State var prefLanguage: String = "en"
    @State var didAttachInitial = false
    /// Path of the file auto-attached from the tree selection (`initialURL`),
    /// so a later selection can swap just that one without nuking files the
    /// user attached manually.
    @State var autoAttachedPath: String?
    /// Transient notice shown when a picked/selected file can't be attached
    /// (e.g. an image or binary). Prevents the silent drop on the Visual page.
    @State var attachNotice: String?
    /// Model/provider selection — see CodeAssistantModelState's doc comment.
    @State var modelState = CodeAssistantModelState()
    /// User-added model ids, keyed by provider id, JSON in AppStorage. Lets
    /// the user run a model the built-in/live lists don't include (e.g. a
    /// brand-new release) — it's sent as-is and routed by id prefix.
    @AppStorage("MEETNOTES_CUSTOM_MODELS") var customModelsRaw = "{}"
    /// Agent-turn / issue-context / Q&A-nudge metadata — see
    /// CodeAssistantAgentState's doc comment.
    @State var agent = CodeAssistantAgentState()
    /// Sheet/popover presentation flags — see CodeAssistantSheetState's
    /// doc comment for why these are grouped apart from the fragile
    /// composer/session/streaming state.
    @State var sheets = CodeAssistantSheetState()
    /// Git ops auto-run (no confirm card) so far within the current user turn —
    /// counting BOTH the primary turn and follow-ups, so "commit and push" can
    /// complete hands-free in Auto mode. Bounded by maxAutoGitOpsPerTurn so a
    /// looping agent can't fire endless write ops. Reset at each user turn start.
    @State var autoGitOpsThisTurn = 0
    static let maxAutoGitOpsPerTurn = 10
    /// Assistant turns the user has explicitly expanded. Combined with the
    /// "latest is always open" rule (see isAssistantExpanded), this collapses
    /// older replies to a lightweight text preview so a long chat stays short.
    @State var expandedTurns: Set<UUID> = []
    /// The assistant turn currently receiving live text — real token
    /// streaming from the server's SSE `chunk` events, mutated in place via
    /// CodeAssistantPanel+Session's beginStreamingTurn/appendStreamedChunk/
    /// finishStreamingTurn. nil once nothing is streaming.
    @State var revealingTurnID: UUID?
    @State var revealedCount: Int = 0
    /// Filter text for the session-picker popover. Reset whenever the
    /// popover closes so it never opens pre-filtered from a prior search.
    @State var sessionSearchQuery: String = ""
    /// How file-edit tool calls are accepted. Persisted across launches.
    /// `.review` (default) shows the confirmation card + popup; `.auto`
    /// applies `update-file` edits immediately (to attached files only —
    /// the GitLab actions always confirm regardless).
    @AppStorage("codeAssist.editMode") var editModeRaw = EditAcceptanceMode.review.rawValue
    var editMode: EditAcceptanceMode { EditAcceptanceMode(rawValue: editModeRaw) ?? .review }
    @StateObject var session = CodeAssistantSession()
    /// Cursor-style "/" (command/skill) + "@" (file) autocomplete for the input.
    @StateObject var completion = CompletionController()
    /// Voice input service — SFSpeechRecognizer + mic tap for freeform dictation
    @State var voiceService = VoiceInputService()
    /// Voice UI state — recording, interim text, errors
    @State var voiceState = ChatVoiceState()
    /// Bumped every time the active chat session changes (create/switch/
    /// delete-fallback). Captured by the auto-continue `asyncAfter` closure
    /// before its delay; if the epoch has moved on by the time it fires, the
    /// closure no-ops instead of starting a turn against a different chat's
    /// history. `agentStopRequested` alone isn't enough here because it's a
    /// single shared flag, not scoped to the session that scheduled the
    /// closure.
    @State var sessionEpoch: UInt = 0
    /// While `true`, `handleHistoryChange` persists but skips the VoiceOver
    /// announcement. Set around bulk history loads (switch/delete-fallback/
    /// on-appear) so restoring an old chat doesn't read its last message
    /// aloud as if the assistant had just replied.
    @State var suppressHistoryAnnounce = false

    /// Context passed to ReportFaultSheet — captured at the moment the
    /// user clicks "Report this" so the sheet sees the prompt + answer
    /// that were on screen, not a later edit.
    struct FaultReportContext: Identifiable {
        let id = UUID()
        let prompt: String
        let response: String
    }

    /// Live-tracked rendered width of the panel. Drives the compact-mode
    /// switch so controls collapse gracefully when the user drags the
    /// divider in.
    @State var panelWidth: CGFloat = 320
    var isCompact: Bool { panelWidth < 240 }
    var isVeryCompact: Bool { panelWidth < 180 }

    var body: some View {
        baseContent
            .frame(minWidth: 120)
            .background(
                GeometryReader { geo in
                    Color.clear
                        .onAppear { panelWidth = geo.size.width }
                        .onChange(of: geo.size.width) { _, w in panelWidth = w }
                }
            )
            .background(theme.current.body)
            .task { await loadLanguage() }
            .task(id: activeRepoKey) {
                completion.configure(api: api, repoRoot: activeRepoRoot)
                await completion.loadMetaIfNeeded()
            }
            .onChange(of: draft) { _, newValue in
                if historyIndex == nil {
                    completion.update(draft: newValue)
                } else {
                    completion.close()
                }
            }
            .sheet(isPresented: $sheets.showProjectMemory) {
                showProjectMemorySheet
            }
            .task { await refreshRecentIssuesLoop() }
            .task { await loadModels(for: AICliTool(rawValue: config.activeCLI) ?? .claudeCode) }
            .onAppear { handleOnAppear() }
            .onChange(of: history) { oldValue, newValue in
                handleHistoryChange(oldValue: oldValue, newValue: newValue)
            }
            .onReceive(NotificationCenter.default.publisher(for: .explorerChatTranscriptChanged)) { note in
                // An iPhone explore_chat persisted a turn to this session —
                // reload so the Mac panel shows it (and so the panel's own
                // persistCurrentChat can't clobber it with a stale in-memory
                // copy). The explorer-panel twin of LlmChatSheet's
                // .llmChatTranscriptChanged handling.
                guard let sid = note.object as? String, sid == currentSessionIDString,
                      let uid = UUID(uuidString: sid),
                      let session = ChatSessionStore.load(id: uid),
                      session.scope == scope else { return }
                history = session.history
                rebuildSentPrompts(from: session.history)
            }
            .onChange(of: config.activeCLI) { _, _ in
                modelState.selectedModel = config.defaultModelId
            }
            .onChange(of: activeRepoKey) { _, _ in
                handleActiveRepoChange()
            }
            .onChange(of: initialURL) { _, newURL in
                handleInitialURLChange(newURL)
            }
            .sheet(isPresented: $sheets.showingIssueSheet) {
                showingIssueSheetContent
            }
            .sheet(isPresented: $sheets.showingReviewCodeSheet, onDismiss: {
                if agent.pendingTool?.triggerReviewCodeArgs != nil { agent.pendingTool = nil }
            }) {
                showingReviewCodeSheetContent
            }
            .sheet(isPresented: $sheets.showingUpdateFileSheet, onDismiss: {
                if agent.pendingTool?.updateFileArgs != nil { agent.pendingTool = nil }
            }) {
                showingUpdateFileSheetContent
            }
            .sheet(isPresented: $sheets.showingCommentSheet) {
                showingCommentSheetContent
            }
            .sheet(isPresented: $sheets.showingGetIssueSheet) {
                showingGetIssueSheetContent
            }
            .sheet(isPresented: $sheets.showingUpdateIssueSheet) {
                showingUpdateIssueSheetContent
            }
            .sheet(isPresented: $sheets.showingListIssuesSheet) {
                showingListIssuesSheetContent
            }
            .sheet(isPresented: $sheets.showingCreateBranchSheet) {
                showingCreateBranchSheetContent
            }
            .sheet(isPresented: $sheets.showingCreatePRSheet) {
                showingCreatePRSheetContent
            }
            .sheet(item: $sheets.reportingFault) { ctx in
                reportingFaultSheetContent(ctx)
            }
            .sheet(isPresented: $sheets.showLibraryPicker) {
                showLibraryPickerContent
            }
            .sheet(isPresented: $sheets.showingGitOpSheet, onDismiss: {
                if agent.pendingTool?.gitOpArgs != nil { agent.pendingTool = nil }
            }) {
                showingGitOpSheetContent
            }
    }

    // MARK: - Body Components

    var baseContent: some View {
        VStack(spacing: 0) {
            header
            Divider().background(theme.current.border)
            ChatMessageList(
                history: history,
                showModelPicker: showModelPicker,
                pendingTool: agent.pendingTool,
                busy: busy,
                statusText: statusText,
                error: $error,
                draft: $draft,
                expandedTurns: $expandedTurns,
                revealingTurnID: $revealingTurnID,
                revealedCount: $revealedCount,
                bubbleHeights: $bubbleHeights,
                activeRepoRoot: activeRepoRoot,
                sheets: sheets,
                loadBranchContext: { await buildAgentContext() },
                onGitOp: { g in await runGitOpFlow(g) },
                onBash: { args in await runBashCommand(args) }
            )
            Divider().background(theme.current.border)
            if !attachmentState.selectedSkills.isEmpty { skillBar }
            if !attachmentState.attachments.isEmpty { attachmentBar }
            if let attachNotice { attachNoticeBar(attachNotice) }
            if let prompt = agent.nudgePrompt, activeRepoRoot != nil {
                nudgeBanner(prompt: prompt)
            }
            // Voice indicators
            if voiceState.error != nil {
                voiceErrorBanner
                    .padding(8)
            }
            if voiceState.isRecording {
                recordingIndicator
                    .padding(8)
            }
            if !voiceState.interimText.isEmpty {
                interimTextDisplay
                    .padding(8)
            }
            inputBar
        }
    }

    // MARK: - Event Handlers

    func handleOnAppear() {
        modelState.customProviders = CustomProvider.loadAll()
        if modelState.selectedModel.isEmpty {
            modelState.selectedModel = config.defaultModelId.isEmpty
                ? AICliTool.claudeCode.defaultModelId
                : config.defaultModelId
        }
        if modelState.selectedProvider.isEmpty {
            modelState.selectedProvider = config.activeCLI.isEmpty ? "anthropic" : config.activeCLI
        }
        _ = ChatSessionStore.migrateScopeFileIfNeeded(for: scope)
        refreshSessions()
        let pointerKey = "chat.current.\(scope.rawValue)"
        if currentSessionIDString.isEmpty {
            currentSessionIDString = UserDefaults.standard.string(forKey: pointerKey) ?? ""
        }
        suppressHistoryAnnounce = true
        if let cur = UUID(uuidString: currentSessionIDString),
           let session = ChatSessionStore.load(id: cur),
           session.scope == scope {
            history = session.history
            rebuildSentPrompts(from: session.history)
        } else if let newest = sessions.first {
            currentSessionIDString = newest.id.uuidString
            history = newest.history
            rebuildSentPrompts(from: newest.history)
            UserDefaults.standard.set(currentSessionIDString, forKey: pointerKey)
        } else {
            mintFreshSession()
        }
        DispatchQueue.main.async { suppressHistoryAnnounce = false }
        if let url = initialURL, !didAttachInitial {
            didAttachInitial = true
            if addFile(url: url) == .added {
                autoAttachedPath = displayPath(url)
            }
        }

        // Setup voice service callbacks - use task to capture state
        Task { @MainActor in
            // Callbacks will be set when service is ready
            voiceService.onFinalResult = { text in
                if !self.draft.isEmpty && !self.draft.hasSuffix(" ") {
                    self.draft += " "
                }
                self.draft += text
                self.voiceState.reset()
            }
            voiceService.onPartialResult = { text in
                self.voiceState.updateInterimText(text)
            }
            voiceService.onError = { error in
                self.voiceState.setError(error)
            }
        }
    }

    func handleHistoryChange(oldValue: [LlmIdeAPIClient.CodeAssistTurn], newValue: [LlmIdeAPIClient.CodeAssistTurn]) {
        persistCurrentChat(history: Array(newValue.suffix(50)))
        guard !suppressHistoryAnnounce else { return }
        if newValue.count > oldValue.count,
           let last = newValue.last,
           last.role == .assistant {
            let text = String(last.content.prefix(200))
            if !text.isEmpty {
                NSAccessibility.post(
                    element: NSApp as Any,
                    notification: .announcementRequested,
                    userInfo: [
                        .announcement: text,
                        .priority: NSAccessibilityPriorityLevel.high.rawValue,
                    ]
                )
            }
        }
    }

    func handleActiveRepoChange() {
        session.reset()
        agent.nudgePrompt = nil
        agent.qaSaveError = nil
        autoAttachedPath = nil
        attachNotice = nil
    }

    func handleInitialURLChange(_ newURL: URL?) {
        if let prev = autoAttachedPath {
            attachmentState.attachments.removeAll { $0.path == prev }
            autoAttachedPath = nil
        }
        attachNotice = nil
        guard let url = newURL else { return }
        didAttachInitial = true
        switch addFile(url: url) {
        case .added:
            autoAttachedPath = displayPath(url)
        case .notText:
            attachNotice = "\u{201C}\(url.lastPathComponent)\u{201D} can't be attached \u{2014} images and binary files aren't supported in chat yet."
        case .unreadable:
            attachNotice = "Could not read file: " + url.lastPathComponent + "."
        case .duplicate:
            break
        }
    }


    // MARK: - Shared derived state

    /// Project root for fault-report / Q&A writes. The "Report this"
    /// button is hidden when nil. Resolved via WorkspaceRoot (active
    /// project first, cloned repo as fallback) so faults land at
    /// `<root>/system/faults` — the SAME place RegressionView reads
    /// them. Using `config.activeRepoLocalURL` here was a bug: it
    /// points at the clone (`code/<repo>`), so faults written by this
    /// panel landed under `code/<repo>/system/faults` and were
    /// invisible to RegressionView (which reads the project root).
    var activeRepoRoot: URL? {
        WorkspaceRoot.resolve(config: config, projectStore: projectStore)
    }

    /// Single identifier for "which repo is active right now". When
    /// it changes we wipe the session counters so a switch doesn't
    /// carry stale repeats across repos.
    var activeRepoKey: String {
        if let p = config.gitLabSavedProjects.first(where: { $0.isActive }) { return "gl:\(p.id)" }
        if let r = config.gitHubSavedRepos.first(where: { $0.isActive }) { return "gh:\(r.id)" }
        return "none"
    }
}
