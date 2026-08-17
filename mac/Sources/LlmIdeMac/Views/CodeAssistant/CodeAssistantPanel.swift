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

/// Common shape for the toolbar's chip-style Menu selectors (`ChatComposer.chipMenu`) —
/// `CodeAssistMode` and `EditAcceptanceMode` are its two conformers.
protocol ChipMenuOption: CaseIterable, Identifiable, Hashable {
    var label: String { get }
    var icon: String { get }
    var help: String { get }
}

/// How the agent's file-edit tool calls are accepted in the chat panel.
enum EditAcceptanceMode: String, CaseIterable, Identifiable, ChipMenuOption {
    /// Show the confirmation card + `UpdateFileSheet` for every edit.
    case review
    /// Apply `update-file` edits immediately (to any file `resolveEdit`
    /// accepts — attached, or inside the open project), auto-run write-tier
    /// git ops, and auto-run proposed shell commands (still gated by
    /// `BashService.validateCommand`); GitLab/GitHub actions always confirm.
    case auto

    var id: String { rawValue }
    // "Bypass"/"Manual" rather than "Auto"/"Review" — the adjacent modePicker
    // already has its own unrelated "Auto" task-mode option; a bare "Auto"
    // here reads as the same control (see CodeAssistMode.label comment).
    var label: String { self == .auto ? "Bypass" : "Manual" }
    var icon: String { self == .auto ? "bolt.fill" : "checklist" }
    var help: String {
        self == .auto
            ? "Bypass review — apply file edits (attached files, or anything in the open project) and run proposed shell commands immediately, no popup"
            : "Manual review — Apply / Review diff / Skip each file edit in the chat, and tap to run each proposed command"
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
    /// Chat turn + session lifecycle. Owns `history`, the streaming/queue
    /// state, the saved-session list, and the agent-turn metadata; the panel
    /// keeps only view/composer state and wires the engine's injected
    /// collaborators to it in `wireEngine()`. Constructed in `init` (rather
    /// than assigned on appear) because it needs `api`/`scope`, which are
    /// `let` properties available only there.
    @State var engine: ChatEngine
    /// Attachments/modified-files/invoked-skills — see
    /// CodeAssistantAttachmentState's doc comment.
    @State var attachmentState = CodeAssistantAttachmentState()
    @State var draft: String = ""
    /// Shell / Claude-Code-style prompt history: submitted prompts (oldest →
    /// newest). Up-arrow walks back through them, Down walks forward, Down past
    /// the newest restores the in-progress draft. `historyIndex == nil` means
    /// we're editing the live draft, not browsing.
    @State var sentPrompts: [String] = []
    @State var historyIndex: Int? = nil
    @State var draftStash: String = ""
    @State var showingSessionPicker = false
    // NOTE: the per-turn `ToolStep` struct that used to live here moved to
    // `ChatMessage.ToolStep` in Task 9 — a tool step belongs to the message
    // that produced it, not to the view that draws it, so it is now stored
    // (and reloaded) with the turn instead of held in an in-memory dictionary
    // keyed by turn id.
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
    /// The current `update-file` proposal, resolved against the filesystem.
    /// Cached because resolving reads the target file — see the `onChange` in
    /// `body` that refreshes it, and `pendingUpdateFileDiff` that reads it.
    @State var pendingEditPreview: ProposedEdit?

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

    /// Hand-written rather than memberwise, purely so the engine can be built
    /// from `api`/`scope` — `@State`'s initial value has to be supplied here,
    /// and `api` isn't in scope for a property initializer. The parameter list
    /// and defaults match the memberwise initializer this replaces, so no call
    /// site changes.
    init(api: LlmIdeAPIClient,
         scope: ChatScope,
         initialURL: URL? = nil,
         showFileAttachButtons: Bool = true,
         showModelPicker: Bool = false) {
        self.api = api
        self.scope = scope
        self.initialURL = initialURL
        self.showFileAttachButtons = showFileAttachButtons
        self.showModelPicker = showModelPicker
        _engine = State(initialValue: ChatEngine(scope: scope,
                                                 transport: CodeAssistTransport(api: api)))
    }

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
            // Resolving an edit READS THE TARGET FILE, so it must happen when
            // the proposal arrives — not inside `body`, where a card on screen
            // would mean a synchronous disk read on every re-render (i.e. on
            // every keystroke in the composer below it).
            .onChange(of: engine.agent.pendingTool, initial: true) { _, _ in
                refreshPendingEditPreview()
            }
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
            .onChange(of: engine.messages) { oldValue, newValue in
                engine.announceAndPersist(oldValue: oldValue, newValue: newValue)
            }
            .onReceive(NotificationCenter.default.publisher(for: .explorerChatTranscriptChanged)) { note in
                // An iPhone explore_chat persisted a turn to this session —
                // reload so the Mac panel shows it (and so the panel's own
                // persistCurrentChat can't clobber it with a stale in-memory
                // copy). The explorer-panel twin of LlmChatSheet's
                // .llmChatTranscriptChanged handling. The id match stays here
                // (it reads the notification's payload); the load + scope
                // check are the engine's.
                guard let sid = note.object as? String, sid == engine.currentSessionIDString,
                      let uid = UUID(uuidString: sid) else { return }
                engine.reloadFromDisk(id: uid)
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
                if engine.agent.pendingTool?.triggerReviewCodeArgs != nil { engine.agent.pendingTool = nil }
            }) {
                showingReviewCodeSheetContent
            }
            .sheet(isPresented: $sheets.showingUpdateFileSheet, onDismiss: {
                if engine.agent.pendingTool?.updateFileArgs != nil { engine.agent.pendingTool = nil }
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
                if engine.agent.pendingTool?.gitOpArgs != nil { engine.agent.pendingTool = nil }
            }) {
                showingGitOpSheetContent
            }
    }

    // MARK: - Body Components

    /// Diff stats for the current `update-file` pendingTool — the +/− the user
    /// sees on the card before deciding. Read from the cached resolution rather
    /// than resolving here (see the `onChange` in `body`), and derived from the
    /// SAME `ProposedEdit` the Apply button writes, so the preview can't
    /// describe a different change than the one applied.
    private var pendingUpdateFileDiff: DiffStats? {
        pendingEditPreview?.stats
    }

    var baseContent: some View {
        VStack(spacing: 0) {
            header
            Divider().background(theme.current.border)
            ChatMessageList(
                engine: engine,
                showModelPicker: showModelPicker,
                pendingTool: engine.agent.pendingTool,
                tasks: engine.agent.agentPendingTasks,
                diffPreview: pendingUpdateFileDiff,
                draft: $draft,
                expandedTurns: $expandedTurns,
                activeRepoRoot: activeRepoRoot,
                sheets: sheets,
                loadBranchContext: { await buildAgentContext() },
                onGitOp: { g in await runGitOpFlow(g) },
                onBash: { args in await runBashCommand(args) },
                onApplyEdit: { await applyPendingEdit() },
                onSkipEdit: { await skipPendingEdit() }
            )
            Divider().background(theme.current.border)
            if !attachmentState.selectedSkills.isEmpty { skillBar }
            if !attachmentState.attachments.isEmpty { attachmentBar }
            if let attachNotice { attachNoticeBar(attachNotice) }
            if let prompt = engine.agent.nudgePrompt, activeRepoRoot != nil {
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

    /// Point the engine's injected collaborators at this panel's own state.
    ///
    /// Called from `.onAppear` rather than `init` for two reasons: the
    /// context-building hooks read `@EnvironmentObject`s that aren't available
    /// in `init`, and the closures must capture a view value whose property
    /// wrappers are installed. Re-running it on a later appearance just
    /// reassigns the same closures, so it is idempotent — and it MUST run
    /// before `handleOnAppearSessions()` below, which fires `onHistoryReplaced`
    /// while loading the restored chat.
    func wireEngine() {
        // Not read by the engine itself today (`resolveTransportInput` supplies
        // the context as part of a fully-formed input, exactly as
        // `codeAssistRoundTrip` built `ctx` inline) — wired for completeness.
        engine.buildContext = { await buildAgentContext() }
        engine.sendAnnouncement = { text in
            NSAccessibility.post(
                element: NSApp as Any,
                notification: .announcementRequested,
                userInfo: [
                    .announcement: text,
                    .priority: NSAccessibilityPriorityLevel.high.rawValue,
                ]
            )
        }
        engine.resolveTransportInput = { message, history, attachments, skills in
            ChatTransportInput(
                message: message,
                history: history,
                attachments: attachments,
                skills: skills,
                // Recomputed per turn so Settings/branch changes are picked up
                // live — same as the inline `await buildAgentContext()` the
                // old `codeAssistRoundTrip` did on every call.
                agentContext: await buildAgentContext(),
                language: prefLanguage,
                model: modelState.selectedModel.isEmpty ? nil : modelState.selectedModel,
                provider: ChatTransportInput.makeProvider(
                    selectedProvider: modelState.selectedProvider),
                mode: modelState.selectedMode.rawValue)
        }
        // Fresh budget of auto-run git ops for this user turn (commit→push→…).
        // Panel-owned because `autoChainPendingAction` — which spends it — is.
        engine.onTurnStart = { autoGitOpsThisTurn = 0 }
        engine.onRecordPrompt = { _ = session.record(prompt: $0) }
        engine.onNudge = { prompt in
            if session.shouldNudge(for: prompt) { engine.agent.nudgePrompt = prompt }
        }
        engine.attachmentsForTurn = { attachmentState.attachments }
        engine.packHistory = { engine.historyForRequest($0) }
        engine.autoChain = { pendingTool, usage in
            await autoChainPendingAction(pendingTool, usage: usage)
        }
        engine.onHistoryReplaced = { rebuildSentPrompts(from: $0) }
        engine.onResetActiveTurnExtra = { expandedTurns.removeAll() }
        engine.onResetTransientStateExtra = {
            sentPrompts = []; historyIndex = nil; draftStash = ""
            draft = ""
            attachmentState.attachments.removeAll()
            attachmentState.selectedSkills.removeAll()
            autoAttachedPath = nil
            attachNotice = nil
        }
        engine.forgetSessionMemory = { id in
            _ = try? await api.forgetSessionMemory(sessionId: id)
        }
    }

    func handleOnAppear() {
        wireEngine()
        modelState.customProviders = CustomProvider.loadAll()
        if modelState.selectedModel.isEmpty {
            modelState.selectedModel = config.defaultModelId.isEmpty
                ? AICliTool.claudeCode.defaultModelId
                : config.defaultModelId
        }
        if modelState.selectedProvider.isEmpty {
            modelState.selectedProvider = config.activeCLI.isEmpty ? "anthropic" : config.activeCLI
        }
        engine.handleOnAppearSessions()
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

    func handleActiveRepoChange() {
        session.reset()
        engine.agent.nudgePrompt = nil
        engine.agent.qaSaveError = nil
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
