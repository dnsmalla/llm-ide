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
    /// When set, this file is attached automatically the first time the panel appears.
    var initialURL: URL? = nil
    /// Hide "Add from Library" from the input bar (use when file is auto-attached).
    var showFileAttachButtons: Bool = true
    /// Show Cursor-style agent + model picker row in the input bar.
    var showModelPicker: Bool = false

    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @EnvironmentObject var projectStore: ProjectStore
    @Environment(LibraryItemStore.self) private var library

    @AppStorage("MEETNOTES_CURRENT_CHAT_SESSION_ID") private var currentSessionIDString: String = ""

    @State var attachments: [LlmIdeAPIClient.CodeAttachment] = []
    /// Files modified during this session (for File → PR automation)
    @State var modifiedFiles: Set<String> = []
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
    @State var selectedSkills: [InvokedSkill] = []
    /// Per-request project-memory overhead from the last turn, surfaced on the
    /// 🧠 button so the always-on memory block's token cost is visible.
    @State private var lastMemoryTokens: Int?
    @State private var lastMemoryHasChat = false
    @State private var showLibraryPicker = false
    @State var history: [LlmIdeAPIClient.CodeAssistTurn] = []
    @State private var sessions: [ChatSession] = []
    @State private var showingSessionPicker: Bool = false
    @State private var draft: String = ""
    /// Shell / Claude-Code-style prompt history: submitted prompts (oldest →
    /// newest). Up-arrow walks back through them, Down walks forward, Down past
    /// the newest restores the in-progress draft. `historyIndex == nil` means
    /// we're editing the live draft, not browsing.
    @State private var sentPrompts: [String] = []
    @State private var historyIndex: Int? = nil
    @State private var draftStash: String = ""
    @State var busy: Bool = false
    /// Live agent status streamed from /code-assist (SSE): "Searching the web…",
    /// "Writing the answer…", etc. Shown in place of a static "Thinking…" so a
    /// 60–90s agent turn doesn't look hung. Reset at the start/end of each turn.
    @State private var statusText: String = ""
    /// Handle to the in-flight user turn, so Stop can cancel it.
    @State private var runTask: Task<Void, Never>?
    /// Messages the user submitted while a turn was running, in FIFO order; they
    /// auto-send one per turn as the current run finishes (or is stopped).
    /// FIFO of messages queued while a turn runs. Identifiable so a cancel
    /// button removes the RIGHT entry even after the queue shifts (drain pops
    /// the head between render and tap) — index-keyed rows deleted the wrong one.
    private struct QueuedMessage: Identifiable { let id = UUID(); let text: String; let skillIds: [String] }
    @State private var queued: [QueuedMessage] = []
    @State private var error: String?
    /// Measured render height per assistant turn, keyed by turn id, so each
    /// markdown web-view bubble can be sized to its content in the scroll list.
    @State private var bubbleHeights: [UUID: CGFloat] = [:]
    @State private var prefLanguage: String = "en"
    @State private var didAttachInitial = false
    /// Path of the file auto-attached from the tree selection (`initialURL`),
    /// so a later selection can swap just that one without nuking files the
    /// user attached manually.
    @State private var autoAttachedPath: String?
    /// Transient notice shown when a picked/selected file can't be attached
    /// (e.g. an image or binary). Prevents the silent drop on the Visual page.
    @State var attachNotice: String?
    @State private var selectedModel: String = ""
    /// Live provider models, keyed by provider id ("openai"/"google"/...).
    /// Populated from the provider's models endpoint; falls back to the
    /// built-in AICliTool.models list when empty (no key / fetch failed).
    @State private var liveModels: [String: [AIModel]] = [:]
    /// User-added model ids, keyed by provider id, JSON in AppStorage. Lets
    /// the user run a model the built-in/live lists don't include (e.g. a
    /// brand-new release) — it's sent as-is and routed by id prefix.
    @AppStorage("MEETNOTES_CUSTOM_MODELS") private var customModelsRaw = "{}"
    @State private var showAddModel = false
    @State private var newModelId = ""
    @State var pendingTool: PendingTool?
    /// Snapshot of recent issues for the active project, refreshed on
    /// panel mount and every ~60s. Bundled into agentContext so the
    /// agent recognises references like "fix the colourful icons issue".
    @State var recentIssues: [AgentContext.RecentIssue] = []
    @State var showingIssueSheet: Bool = false
    @State var showingCommentSheet: Bool = false
    @State var showingGetIssueSheet: Bool = false
    @State var showingUpdateIssueSheet: Bool = false
    @State var showingListIssuesSheet: Bool = false
    @State var showingCreateBranchSheet: Bool = false
    // PR creation disabled - requires additional backend support
    @State var showingCreatePRSheet: Bool = false
    @State var showingReviewCodeSheet: Bool = false
    @State var showingUpdateFileSheet: Bool = false
    @State var showingGitOpSheet: Bool = false
    /// Git ops auto-run (no confirm card) so far within the current user turn —
    /// counting BOTH the primary turn and follow-ups, so "commit and push" can
    /// complete hands-free in Auto mode. Bounded by maxAutoGitOpsPerTurn so a
    /// looping agent can't fire endless write ops. Reset at each user turn start.
    @State var autoGitOpsThisTurn = 0
    static let maxAutoGitOpsPerTurn = 10
    /// Assistant turns the user has explicitly expanded. Combined with the
    /// "latest is always open" rule (see isAssistantExpanded), this collapses
    /// older replies to a lightweight text preview so a long chat stays short.
    @State private var expandedTurns: Set<UUID> = []
    @State var reportingFault: FaultReportContext?
    /// How file-edit tool calls are accepted. Persisted across launches.
    /// `.review` (default) shows the confirmation card + popup; `.auto`
    /// applies `update-file` edits immediately (to attached files only —
    /// the GitLab actions always confirm regardless).
    @AppStorage("codeAssist.editMode") private var editModeRaw = EditAcceptanceMode.review.rawValue
    var editMode: EditAcceptanceMode { EditAcceptanceMode(rawValue: editModeRaw) ?? .review }
    @StateObject private var session = CodeAssistantSession()
    /// Cursor-style "/" (command/skill) + "@" (file) autocomplete for the input.
    @StateObject private var completion = CompletionController()
    /// Web search enhancement: history and caching
    @StateObject private var webSearch = WebSearchService()
    /// Project-memory viewer sheet (what the assistant auto-learned).
    @State private var showProjectMemory = false
    /// Captured at the moment the banner appears so Save uses the
    /// prompt+answer that triggered the threshold, not whatever the
    /// user types next.
    @State private var nudgePrompt: String?
    @State private var savingQA = false
    @State private var qaSaveError: String?
    @State private var agentSessionId: String = UUID().uuidString
    @State private var agentIsAutonomous: Bool = false
    @State private var agentStopRequested: Bool = false
    @State private var agentPendingTasks: [AgentTask] = []

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
    @State private var panelWidth: CGFloat = 320
    private var isCompact: Bool { panelWidth < 240 }
    private var isVeryCompact: Bool { panelWidth < 180 }

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
            .sheet(isPresented: $showProjectMemory) {
                showProjectMemorySheet
            }
            .task { await refreshRecentIssuesLoop() }
            .task { await loadModels(for: AICliTool(rawValue: config.activeCLI) ?? .claudeCode) }
            .onAppear { handleOnAppear() }
            .onChange(of: history) { oldValue, newValue in
                handleHistoryChange(oldValue: oldValue, newValue: newValue)
            }
            .onChange(of: config.activeCLI) { _, _ in
                selectedModel = config.defaultModelId
            }
            .onChange(of: activeRepoKey) { _, _ in
                handleActiveRepoChange()
            }
            .onChange(of: initialURL) { _, newURL in
                handleInitialURLChange(newURL)
            }
            .sheet(isPresented: $showingIssueSheet) {
                showingIssueSheetContent
            }
            .sheet(isPresented: $showingReviewCodeSheet, onDismiss: {
                if pendingTool?.triggerReviewCodeArgs != nil { pendingTool = nil }
            }) {
                showingReviewCodeSheetContent
            }
            .sheet(isPresented: $showingUpdateFileSheet, onDismiss: {
                if pendingTool?.updateFileArgs != nil { pendingTool = nil }
            }) {
                showingUpdateFileSheetContent
            }
            .sheet(isPresented: $showingCommentSheet) {
                showingCommentSheetContent
            }
            .sheet(isPresented: $showingGetIssueSheet) {
                showingGetIssueSheetContent
            }
            .sheet(isPresented: $showingUpdateIssueSheet) {
                showingUpdateIssueSheetContent
            }
            .sheet(isPresented: $showingListIssuesSheet) {
                showingListIssuesSheetContent
            }
            .sheet(isPresented: $showingCreateBranchSheet) {
                showingCreateBranchSheetContent
            }
            .sheet(isPresented: $showingCreatePRSheet) {
                showingCreatePRSheetContent
            }
            .sheet(item: $reportingFault) { ctx in
                reportingFaultSheetContent(ctx)
            }
            .sheet(isPresented: $showLibraryPicker) {
                showLibraryPickerContent
            }
            .sheet(isPresented: $showingGitOpSheet, onDismiss: {
                if pendingTool?.gitOpArgs != nil { pendingTool = nil }
            }) {
                showingGitOpSheetContent
            }
    }

    // MARK: - Body Components

    private var baseContent: some View {
        VStack(spacing: 0) {
            header
            Divider().background(theme.current.border)
            chatScroll
            Divider().background(theme.current.border)
            if !selectedSkills.isEmpty { skillBar }
            if !attachments.isEmpty { attachmentBar }
            if let attachNotice { attachNoticeBar(attachNotice) }
            if let prompt = nudgePrompt, activeRepoRoot != nil {
                nudgeBanner(prompt: prompt)
            }
            inputBar
        }
    }

    // MARK: - Event Handlers

    private func handleOnAppear() {
        if selectedModel.isEmpty {
            selectedModel = config.defaultModelId.isEmpty
                ? AICliTool.claudeCode.defaultModelId
                : config.defaultModelId
        }
        let migrated = ChatSessionStore.migrateLegacy()
        sessions = ChatSessionStore.listSessions()
        if let cur = UUID(uuidString: currentSessionIDString),
           let session = sessions.first(where: { $0.id == cur }) {
            history = session.history
            rebuildSentPrompts(from: session.history)
        } else if let mid = migrated, let session = sessions.first(where: { $0.id == mid }) {
            currentSessionIDString = mid.uuidString
            history = session.history
            rebuildSentPrompts(from: session.history)
        } else {
            let fresh = ChatSession()
            ChatSessionStore.save(fresh)
            currentSessionIDString = fresh.id.uuidString
            sessions = ChatSessionStore.listSessions()
            history = []
            sentPrompts = []; historyIndex = nil; draftStash = ""
        }
        if let url = initialURL, !didAttachInitial {
            didAttachInitial = true
            if addFile(url: url) == .added {
                autoAttachedPath = displayPath(url)
            }
        }
    }

    private func handleHistoryChange(oldValue: [LlmIdeAPIClient.CodeAssistTurn], newValue: [LlmIdeAPIClient.CodeAssistTurn]) {
        persistCurrentSession(history: Array(newValue.suffix(50)))
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

    private func handleActiveRepoChange() {
        session.reset()
        nudgePrompt = nil
        qaSaveError = nil
        autoAttachedPath = nil
        attachNotice = nil
    }

    private func handleInitialURLChange(_ newURL: URL?) {
        if let prev = autoAttachedPath {
            attachments.removeAll { $0.path == prev }
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

    // MARK: - Sheet Content Views

    private var showProjectMemorySheet: some View {
        ProjectMemoryView(api: api, repos: activeMemoryRepos, workspaceRoot: activeMemoryWorkspaceRoot)
            .environmentObject(theme)
    }

    private var showingIssueSheetContent: some View {
        Group {
            if let pt = pendingTool,
               let args = pt.createIssueArgs,
               let target = resolveIssueTarget() {
                CreateIssueSheet(
                    initialArgs: args,
                    projectName: target.label,
                    projectURL: target.projectURL,
                    provider: target.kind == .gitlab ? "GitLab" : "GitHub",
                    isAllowed: config.isAllowed(.createIssue, provider: target.kind),
                    onConfirm: { editedArgs in
                        await confirmCreateIssue(editedArgs, target: target)
                    }
                )
            } else {
                VStack(spacing: 12) {
                    Text("No issue tracker available.")
                        .font(.system(size: 13))
                    Text("Add or activate a project in Settings → GitLab or GitHub.")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                    Button("Close") { showingIssueSheet = false }
                }
                .padding(20)
            }
        }
    }

    private var showingReviewCodeSheetContent: some View {
        Group {
            if let pt = pendingTool,
               let args = pt.triggerReviewCodeArgs {
                TriggerReviewCodeSheet(
                    plan: args.plan,
                    iid: args.iid,
                    issueTitle: recentIssues.first(where: { $0.iid == args.iid })?.title,
                    api: api
                )
                .environmentObject(config)
            } else {
                VStack(spacing: 12) {
                    Text("Review Code action unavailable.")
                        .font(.system(size: 13))
                    Button("Close") { showingReviewCodeSheet = false }
                }
                .padding(20)
            }
        }
    }

    private var showingUpdateFileSheetContent: some View {
        Group {
            if let pt = pendingTool,
               let args = pt.updateFileArgs,
               let match = matchingAttachment(for: args.path) {
                UpdateFileSheet(
                    initialArgs: args,
                    originalContent: match.content,
                    displayPath: match.path,
                    onConfirm: { editedContent in
                        await confirmUpdateFile(args, finalContent: editedContent)
                    }
                )
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    Text("File update unavailable")
                        .font(.headline)
                    Text("The agent proposed a path that doesn't match any attached file.")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                    if let pt = pendingTool, let args = pt.updateFileArgs {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Agent's path").font(.caption).foregroundStyle(.secondary)
                            Text(args.path)
                                .font(.system(size: 11, design: .monospaced))
                                .textSelection(.enabled)
                                .padding(6)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Color.secondary.opacity(0.1))
                                .clipShape(RoundedRectangle(cornerRadius: 4))
                        }
                        if !attachments.isEmpty {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Attached files (\(attachments.count))").font(.caption).foregroundStyle(.secondary)
                                ForEach(attachments) { att in
                                    Text(att.path)
                                        .font(.system(size: 11, design: .monospaced))
                                        .textSelection(.enabled)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }
                            .padding(6)
                            .background(Color.secondary.opacity(0.1))
                            .clipShape(RoundedRectangle(cornerRadius: 4))
                        }
                    }
                    HStack {
                        Spacer()
                        Button("Close") { showingUpdateFileSheet = false }
                            .keyboardShortcut(.cancelAction)
                    }
                }
                .padding(20)
                .frame(minWidth: 460)
            }
        }
    }

    private var showingCommentSheetContent: some View {
        Group {
            if let pt = pendingTool,
               let args = pt.commentIssueArgs,
               let target = resolveIssueTarget() {
                CommentIssueSheet(
                    initialArgs: args,
                    projectName: target.label,
                    projectURL: target.projectURL,
                    provider: target.kind == .gitlab ? "GitLab" : "GitHub",
                    issueTitle: recentIssues.first(where: { $0.iid == args.iid })?.title,
                    isAllowed: config.isAllowed(.commentIssue, provider: target.kind),
                    onConfirm: { editedArgs in
                        await confirmCommentIssue(editedArgs, target: target)
                    }
                )
            } else {
                VStack(spacing: 12) {
                    Text("No issue tracker available.")
                        .font(.system(size: 13))
                    Text("Add or activate a project in Settings → GitLab or GitHub.")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                    Button("Close") { showingCommentSheet = false }
                }
                .padding(20)
            }
        }
    }

    private var showingGetIssueSheetContent: some View {
        Group {
            if let pt = pendingTool, let args = pt.getIssueArgs, let target = resolveIssueTarget() {
                GetIssueSheet(
                    iid: args.iid,
                    projectId: target.projectId,
                    providerKind: target.kind,
                    onConfirm: {
                        showingGetIssueSheet = false
                        pendingTool = nil
                    }
                )
            } else {
                VStack(spacing: 12) {
                    Text("No issue tracker available.")
                        .font(.system(size: 13))
                    Button("Close") { showingGetIssueSheet = false }
                }
                .padding(20)
            }
        }
    }

    private var showingUpdateIssueSheetContent: some View {
        Group {
            if let pt = pendingTool, let args = pt.updateIssueArgs, let target = resolveIssueTarget() {
                UpdateIssueSheet(
                    initialArgs: UpdateIssueSheet.Args(
                        iid: args.iid,
                        title: args.title,
                        body: args.description,
                        state: args.state,
                        labels: args.labels
                    ),
                    issueTitle: recentIssues.first(where: { $0.iid == args.iid })?.title,
                    projectId: target.projectId,
                    providerKind: target.kind,
                    isAllowed: config.isAllowed(.editIssue, provider: target.kind),
                    onConfirm: { editedArgs in
                        await confirmUpdateIssue(editedArgs, target: target)
                    }
                )
            } else {
                VStack(spacing: 12) {
                    Text("No issue tracker available.")
                        .font(.system(size: 13))
                    Button("Close") { showingUpdateIssueSheet = false }
                }
                .padding(20)
            }
        }
    }

    private var showingListIssuesSheetContent: some View {
        Group {
            if let pt = pendingTool, let args = pt.listIssuesArgs, let target = resolveIssueTarget() {
                ListIssuesSheet(
                    initialArgs: ListIssuesSheetArgs(
                        search: args.search,
                        state: args.state,
                        label: args.label
                    ),
                    projectId: target.projectId,
                    providerKind: target.kind,
                    onConfirm: {
                        showingListIssuesSheet = false
                        pendingTool = nil
                    }
                )
            } else {
                VStack(spacing: 12) {
                    Text("No issue tracker available.")
                        .font(.system(size: 13))
                    Button("Close") { showingListIssuesSheet = false }
                }
                .padding(20)
            }
        }
    }

    @State var branchSheetContext: AgentContext?

    private var showingCreateBranchSheetContent: some View {
        Group {
            if let pt = pendingTool, let args = pt.createBranchArgs {
                BranchCreationSheet(
                    initialArgs: BranchCreationSheet.CreateBranchArgs(
                        branch: args.branch,
                        startPoint: args.startPoint
                    ),
                    currentBranch: branchSheetContext?.currentBranch,
                    onConfirm: { editedArgs in
                        await confirmBranchCreation(editedArgs)
                    }
                )
            } else {
                VStack(spacing: 12) {
                    Text("Branch creation unavailable.")
                        .font(.system(size: 13))
                    Button("Close") { showingCreateBranchSheet = false }
                }
                .padding(20)
            }
        }
    }

    private func reportingFaultSheetContent(_ ctx: FaultReportContext) -> some View {
        Group {
            if let repoRoot = activeRepoRoot {
                let target = resolveIssueTarget()
                ReportFaultSheet(
                    prompt: ctx.prompt,
                    response: ctx.response,
                    repoRoot: repoRoot,
                    agent: config.activeCLI,
                    onSubmitted: { _ in reportingFault = nil },
                    onDismiss: { reportingFault = nil },
                    onFileIssue: target.map { tgt in
                        { fault in try await fileFaultAsIssue(fault, target: tgt) }
                    },
                    fileIssueTargetLabel: target?.label ?? ""
                )
                .environmentObject(theme)
                .environmentObject(config)
            } else {
                EmptyView()
            }
        }
    }

    private var showLibraryPickerContent: some View {
        LibraryPicker(
            allowed: [.code, .notes, .data],
            mode: .multi,
            title: "Add from Library"
        ) { items in
            attachNotice = nil
            var rejected: [String] = []
            for item in items where addFile(url: item.url) == .notText {
                rejected.append(item.name)
            }
            if !rejected.isEmpty {
                attachNotice = rejected.count == 1
                    ? "File: " + rejected[0] + " - can not be attached"
                    : "\(rejected.count) files couldn't be attached — images and binary files aren't supported in chat yet."
            }
        }
    }

    private var showingGitOpSheetContent: some View {
        Group {
            if let pt = pendingTool, let g = pt.gitOpArgs {
                GitOpSheet(
                    args: g,
                    onConfirm: {
                        showingGitOpSheet = false
                        Task { await runGitOpFlow(g) }
                    },
                    onCancel: {
                        showingGitOpSheet = false
                        pendingTool = nil
                    }
                )
                .environmentObject(theme)
            } else {
                VStack(spacing: 12) {
                    Text("Git operation unavailable.")
                        .font(.system(size: 13))
                    Button("Close") { showingGitOpSheet = false }
                }
                .padding(20)
                .environmentObject(theme)
            }
        }
    }


    // MARK: - Fault → Issue routing

    /// Resolves the currently-active issue tracker target — used by the
    /// "Also file as issue" toggle in ReportFaultSheet. Precedence matches
    /// `config.activeRepoLocalURL`: GitLab project first, then GitHub.
    /// Returns nil when nothing is configured or the active project is
    /// missing the bits we need (token, resolved ID).
    func resolveIssueTarget() -> IssueTarget? {
        if !config.gitLabToken.isEmpty,
           let p = config.gitLabSavedProjects.first(where: { $0.isActive }),
           let id = p.resolvedId
        {
            let display = !p.displayName.isEmpty ? p.displayName
                : (URL(string: p.url)?.lastPathComponent ?? "project")
            return .init(kind: .gitlab, projectId: String(id), label: "\(display) (GitLab)", projectURL: p.url)
        }
        if !config.gitHubToken.isEmpty,
           let r = config.gitHubSavedRepos.first(where: { $0.isActive }),
           let (owner, name) = GitHubClient.ownerAndName(from: r.url)
        {
            let pid = "\(owner)/\(name)"
            return .init(kind: .github, projectId: pid, label: "\(pid) (GitHub)", projectURL: r.url)
        }
        return nil
    }

    /// Build a RepoIssuePayload from the local FaultReport and POST it via
    /// the matching RepoBackend. Returns the new issue's web URL on
    /// success.
    func fileFaultAsIssue(_ fault: FaultReport, target: IssueTarget) async throws -> URL? {
        let title = fault.notes
            .split(whereSeparator: { $0.isNewline })
            .first.map(String.init)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            ?? "Fault report"
        let body = """
        **Severity:** \(fault.severity.displayName)
        **Agent:** \(fault.agent)
        **App version:** \(fault.appVersion)
        \(fault.gitHead.map { "**Git HEAD:** `\($0)`" } ?? "")

        ### Notes
        \(fault.notes)

        ### Prompt
        ```
        \(fault.prompt.prefix(4000))
        ```

        ### Response
        \(fault.response.prefix(8000))
        """
        // "bug" stays as the conventional issue-tracker label so existing
        // tracker filters/automation keep matching.
        let labels = fault.tags + ["bug", "meet-notes"]
        let payload = RepoIssuePayload(
            title: String(title.prefix(140)),
            body: body,
            labels: labels
        )
        let client: RepoBackend = (target.kind == .gitlab)
            ? RepoBackendFactory.guarded(GitLabClient(config: config), config: config) as RepoBackend
            : RepoBackendFactory.guarded(GitHubClient(config: config), config: config) as RepoBackend
        let issue = try await client.createIssue(projectId: target.projectId, payload: payload)
        return URL(string: issue.webUrl)
    }

    /// Target descriptor returned by `resolveIssueTarget`.
    internal struct IssueTarget {
        let kind: RepoBackendKind
        let projectId: String
        let label: String
        let projectURL: String
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 10) {
            if !isVeryCompact {
                SectionLabel(isCompact ? "AI" : "Code Assistant", size: 12, tracking: 0.8)
                    .lineLimit(1)
            }
            // Session counter only when we have horizontal room to spare.
            if !isCompact, !history.isEmpty || !attachments.isEmpty {
                Text("·")
                    .foregroundStyle(theme.current.textMuted.opacity(0.5))
                Text("\(history.count) turn\(history.count == 1 ? "" : "s")  \(attachments.count) file\(attachments.count == 1 ? "" : "s")")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(theme.current.textMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            sessionDropdownButton
        }
        .padding(.horizontal, isVeryCompact ? 6 : Spacing.md)
        .padding(.vertical, 8)
    }

    /// Cursor-style chat-list dropdown: shows the current session's
    /// title and opens a popover with recent sessions + "New chat".
    private var sessionDropdownButton: some View {
        Button {
            // Refresh the list every time the popover opens so the
            // ordering reflects the latest `lastUsedAt`.
            sessions = ChatSessionStore.listSessions()
            showingSessionPicker.toggle()
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "bubble.left.and.bubble.right")
                    .font(.system(size: 10, weight: .medium))
                if !isVeryCompact {
                    Text(currentSessionTitle)
                        .font(.system(size: 11))
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .medium))
            }
            .padding(.horizontal, isVeryCompact ? 4 : 8)
            .padding(.vertical, 4)
            .foregroundStyle(theme.current.textMuted)
            .frame(maxWidth: isCompact ? 90 : 220, alignment: .trailing)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Switch chat session")
        .accessibilityLabel("Switch chat session")
        .popover(isPresented: $showingSessionPicker, arrowEdge: .top) {
            sessionPickerPopover
        }
    }

    private var currentSessionTitle: String {
        guard let cur = UUID(uuidString: currentSessionIDString),
              let s = sessions.first(where: { $0.id == cur }) else {
            return "New chat"
        }
        return s.title.isEmpty ? "New chat" : s.title
    }

    private var sessionPickerPopover: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                showingSessionPicker = false
                createNewSession()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "plus")
                        .font(.system(size: 11, weight: .medium))
                    Text("New chat")
                        .font(.system(size: 12, weight: .medium))
                    Spacer()
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(theme.current.text)

            Divider()

            if sessions.isEmpty {
                Text("No saved chats yet.")
                    .font(.system(size: 11))
                    .foregroundStyle(theme.current.textMuted)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(sessions.prefix(20))) { session in
                            SessionRow(
                                session: session,
                                isActive: session.id.uuidString == currentSessionIDString,
                                onSelect: {
                                    showingSessionPicker = false
                                    switchSession(to: session.id)
                                },
                                onDelete: {
                                    deleteSession(session.id)
                                }
                            )
                            .environmentObject(theme)
                        }
                    }
                }
                .frame(maxHeight: 320)
            }
        }
        .frame(width: 320)
    }

    // MARK: - Chat scroll

    @ViewBuilder
    private var chatScroll: some View {
        if history.isEmpty && !showModelPicker {
            emptyState
        } else if history.isEmpty {
            // Clean empty state when model picker is shown — no hero, just space
            Color.clear
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: Spacing.md) {
                        ForEach(history) { turn in
                            turnView(turn)
                                .id(turn.id)
                            if let pt = pendingTool,
                               turn.id == history.last?.id,
                               turn.role == .assistant {
                                PendingActionCard(pendingTool: pt) {
                                    switch pt.name {
                                    case "create-gitlab-issue", "create-issue":
                                        showingIssueSheet = true
                                    case "comment-gitlab-issue", "comment-issue":
                                        showingCommentSheet = true
                                    case "get-issue":
                                        showingGetIssueSheet = true
                                    case "update-issue":
                                        showingUpdateIssueSheet = true
                                    case "list-issues":
                                        showingListIssuesSheet = true
                                    case "create-branch":
                                        showingCreateBranchSheet = true
                                        Task { branchSheetContext = await buildAgentContext() }
                                    case "create-gitlab-mr", "create-pr":
                                        showingCreatePRSheet = true
                                    case "trigger-review-code":
                                        showingReviewCodeSheet = true
                                    case "update-file":
                                        showingUpdateFileSheet = true
                                    case "git-op":
                                        if let g = pt.gitOpArgs, g.op.tier == .read {
                                            Task { await runGitOpFlow(g) }
                                        } else {
                                            showingGitOpSheet = true
                                        }
                                    case "bash":
                                        Task { await runBashCommand(pt.bashArgs) }
                                    default:
                                        break
                                    }
                                }
                                .padding(.top, 4)
                            }
                        }
                        if busy {
                            HStack(spacing: 6) {
                                ProgressView().controlSize(.small)
                                Text(statusText.isEmpty ? "Thinking…" : statusText)
                                    .font(Typography.caption)
                                    .foregroundStyle(theme.current.textMuted)
                            }
                            .padding(.top, 4)
                            .id("typing-indicator")
                        }
                        if let err = error {
                            errorBubble(err)
                        }
                    }
                    .padding(Spacing.md)
                }
                .onChange(of: history.count) { _, _ in
                    if let last = history.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
                }
                .onChange(of: busy) { _, b in
                    if b { withAnimation { proxy.scrollTo("typing-indicator", anchor: .bottom) } }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Chat transcript")
        }
    }

    /// Refined empty state.  Subtle, centered, no oversized hero cards —
    /// the input toolbar at the bottom already exposes "Add from Library"
    /// as the primary action, so we don't duplicate it here.
    private var emptyState: some View {
        VStack(spacing: 0) {
            Spacer()
            VStack(alignment: .center, spacing: 14) {
                Image(systemName: "command")
                    .font(.system(size: 20, weight: .light))
                    .foregroundStyle(theme.current.textMuted)
                    .frame(width: 40, height: 40)
                    .background(theme.current.surface)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8)
                                .strokeBorder(theme.current.border, lineWidth: 1))

                VStack(spacing: 4) {
                    Text("Code Assistant")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(theme.current.text)
                    Text("Attach context with the buttons below, then describe what you want.")
                        .font(.system(size: 12))
                        .foregroundStyle(theme.current.textMuted)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 480)
                }

                // Quiet suggestion chips — small, single row, secondary.
                HStack(spacing: 6) {
                    ForEach(["Review for bugs",
                             "Refactor for readability",
                             "Add unit tests",
                             "Explain this code"], id: \.self) { sug in
                        Button(sug) { draft = sug }
                            .buttonStyle(.borderless)
                            .controlSize(.small)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 4)
                            .background(theme.current.surface)
                            .overlay(RoundedRectangle(cornerRadius: 12)
                                        .strokeBorder(theme.current.border.opacity(0.6),
                                                      lineWidth: 1))
                            .clipShape(Capsule())
                            .foregroundStyle(theme.current.textMuted)
                            .font(.system(size: 11))
                    }
                }
                .padding(.top, 4)
            }
            .padding(.horizontal, Spacing.lg)
            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// The most recent assistant turn — always rendered expanded.
    private var lastAssistantTurnId: UUID? {
        history.last(where: { $0.role == .assistant })?.id
    }

    /// An assistant turn renders in full iff it's the latest one or the user
    /// expanded it; otherwise it collapses to a preview.
    private func isAssistantExpanded(_ turn: LlmIdeAPIClient.CodeAssistTurn) -> Bool {
        turn.id == lastAssistantTurnId || expandedTurns.contains(turn.id)
    }

    /// A short plain-text preview of a markdown reply for the collapsed state —
    /// strips common markdown so the bubble reads cleanly without a web view.
    private func markdownPreview(_ content: String) -> String {
        var s = content
        // [text](url) -> text
        s = s.replacingOccurrences(of: "\\[([^\\]]+)\\]\\([^\\)]*\\)", with: "$1", options: .regularExpression)
        // strip structural markdown chars (leave inline hyphens intact)
        s = s.replacingOccurrences(of: "[`#*_>~]", with: "", options: .regularExpression)
        s = s.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return s.count > 160 ? String(s.prefix(160)) + "…" : s
    }

    @ViewBuilder
    private func turnView(_ turn: LlmIdeAPIClient.CodeAssistTurn) -> some View {
        let isUser = turn.role == .user
        HStack(alignment: .top, spacing: Spacing.sm) {
            if isUser { Spacer(minLength: 40) }
            VStack(alignment: isUser ? .trailing : .leading, spacing: 4) {
                Text(isUser ? "You" : "Claude")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                if isUser {
                    // User input is plain text — render verbatim (no markdown).
                    Text(turn.content)
                        .font(.system(size: 12))
                        .foregroundStyle(theme.current.text)
                        .textSelection(.enabled)
                        .frame(maxWidth: 720, alignment: .trailing)
                        .padding(10)
                        .background(theme.current.accent.opacity(0.14))
                        .cornerRadius(8)
                        .fixedSize(horizontal: false, vertical: true)
                } else if isAssistantExpanded(turn) {
                    // Expanded assistant reply — full markdown render (web view).
                    VStack(alignment: .leading, spacing: 4) {
                        SelfSizingMarkdownView(
                            markdown: turn.content,
                            isDark: theme.current.isDark
                        ) { h in
                            if bubbleHeights[turn.id] != h { bubbleHeights[turn.id] = h }
                        }
                        .frame(maxWidth: 720, alignment: .leading)
                        .frame(height: max(bubbleHeights[turn.id] ?? 24, 24))
                        // Older expanded replies can be collapsed again; the
                        // latest stays open and shows no collapse control.
                        if turn.id != lastAssistantTurnId {
                            Button { expandedTurns.remove(turn.id) } label: {
                                Label("Collapse", systemImage: "chevron.up")
                                    .font(Typography.caption)
                                    .foregroundStyle(theme.current.textMuted)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .frame(maxWidth: 720, alignment: .leading)
                    .padding(10)
                    .background(theme.current.surface)
                    .cornerRadius(8)
                } else {
                    // Collapsed older reply — lightweight text preview, NO web
                    // view (keeps a long chat short and avoids one WKWebView per
                    // old reply). Tap to expand into the full render.
                    Button {
                        expandedTurns.insert(turn.id)
                    } label: {
                        HStack(alignment: .top, spacing: 6) {
                            Text(markdownPreview(turn.content))
                                .font(.system(size: 12))
                                .foregroundStyle(theme.current.textMuted)
                                .lineLimit(2)
                                .multilineTextAlignment(.leading)
                            Spacer(minLength: 4)
                            Image(systemName: "chevron.down")
                                .font(.caption2)
                                .foregroundStyle(theme.current.textMuted)
                        }
                        .frame(maxWidth: 720, alignment: .leading)
                        .padding(10)
                        .background(theme.current.surface)
                        .cornerRadius(8)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("Show full reply")
                }
                if !isUser, activeRepoRoot != nil {
                    Button {
                        reportingFault = FaultReportContext(
                            prompt: prevUserPrompt(before: turn) ?? "",
                            response: turn.content
                        )
                    } label: {
                        Label("Report this", systemImage: "ant")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                    }
                    .buttonStyle(.plain)
                    .help("Save this answer as a fault report")
                }
            }
            if !isUser { Spacer(minLength: 40) }
        }
    }

    /// Walk backwards from `turn`'s position in `history` and return the
    /// most recent user message. Falls back to nil when the assistant
    /// answered without a preceding user turn (rare; agent self-prompts).
    private func prevUserPrompt(before turn: LlmIdeAPIClient.CodeAssistTurn) -> String? {
        guard let idx = history.firstIndex(where: { $0.id == turn.id }) else { return nil }
        for i in stride(from: idx - 1, through: 0, by: -1) {
            if history[i].role == .user { return history[i].content }
        }
        return nil
    }

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
    private var activeRepoKey: String {
        if let p = config.gitLabSavedProjects.first(where: { $0.isActive }) { return "gl:\(p.id)" }
        if let r = config.gitHubSavedRepos.first(where: { $0.isActive }) { return "gh:\(r.id)" }
        return "none"
    }

    /// Candidate repo paths ("~/…") for the project-memory viewer. The server
    /// resolves the first allow-listed one (the agent's actual write target),
    /// so we hand it the full indexedRepos list rather than guessing first.
    internal var activeMemoryRepos: [String] {
        let codeItems = library.items(for: .code)
        let grouped = Dictionary(grouping: codeItems.filter { $0.folderOrigin != nil },
                                 by: { $0.folderOrigin! })
        return grouped.keys.sorted().compactMap { folder in
            let items = grouped[folder] ?? []
            let ancestor = commonAncestor(items.map { $0.path })
            return ancestor.isEmpty ? nil : homeRelativePath(ancestor)
        }
    }

    /// The open Explorer folder ("~/…") for the project-memory viewer, so memory
    /// resolves to the open project even when it isn't a formally-indexed repo.
    internal var activeMemoryWorkspaceRoot: String? {
        WorkspaceRoot.resolve(config: config, projectStore: projectStore)
            .map { homeRelativePath($0.path) }
    }

    // MARK: - Autocomplete actions

    /// ↑ moves the autocomplete selection when the menu is open, otherwise walks
    /// prompt history (the original behaviour).
    private func arrowUpAction() -> Bool {
        if completion.isOpen { completion.moveUp(); return true }
        return historyUp() == .handled
    }
    private func arrowDownAction() -> Bool {
        if completion.isOpen { completion.moveDown(); return true }
        return historyDown() == .handled
    }

    /// Apply the highlighted completion: rewrite the draft for a command/skill,
    /// or attach the chosen file and strip its "@token" from the draft.
    private func acceptCompletion() {
        guard let accept = completion.acceptSelected(currentDraft: draft) else {
            completion.close(); return
        }
        switch accept {
        case .replaceDraft(let s):
            draft = s
        case .attachFile(let url, let newDraft):
            switch addFile(url: url) {
            case .added, .duplicate: break
            case .notText:   attachNotice = "That file isn't text — not attached."
            case .unreadable: attachNotice = "Couldn't read that file."
            }
            draft = newDraft
        case .useSkill(let id, let name, let newDraft):
            // Library skill → chip carrying the id sent via the skill channel.
            addInvokedSkill(.init(id: id, name: name, action: .library(id)))
            draft = newDraft
        case .useDirective(let id, let name, let directive, let newDraft):
            // In-built skill/subagent → chip carrying the directive text that's
            // prepended to the message on send (composer stays clean).
            addInvokedSkill(.init(id: id, name: name, action: .directive(directive)))
            draft = newDraft
        }
        completion.close()
    }

    /// Append an invoked-skill chip, deduped by id.
    private func addInvokedSkill(_ skill: InvokedSkill) {
        if !selectedSkills.contains(where: { $0.id == skill.id }) {
            selectedSkills.append(skill)
        }
    }

    @ViewBuilder
    private func nudgeBanner(prompt: String) -> some View {
        let t = theme.current
        let count = session.count(for: session.hashForPrompt(prompt))
        HStack(spacing: Spacing.sm) {
            Image(systemName: "sparkles")
                .foregroundStyle(t.accent2)
            Text("You've asked this \(count) times — save the answer to memory?")
                .font(Typography.caption).foregroundStyle(t.text)
                .lineLimit(2).truncationMode(.tail)
            Spacer(minLength: 8)
            if let err = qaSaveError {
                Text(err).font(Typography.caption).foregroundStyle(t.danger)
                    .lineLimit(1).truncationMode(.tail)
            }
            Button(savingQA ? "Saving…" : "Save") {
                Task { await saveLatestAnswer(forPrompt: prompt) }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(savingQA)
            Button("Dismiss") {
                session.dismiss(hash: session.hashForPrompt(prompt))
                nudgePrompt = nil
                qaSaveError = nil
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(savingQA)
        }
        .padding(.horizontal, Spacing.md).padding(.vertical, 6)
        .background(t.accent2.opacity(0.08))
        .overlay(Rectangle().frame(height: 1).foregroundStyle(t.border), alignment: .top)
        .overlay(Rectangle().frame(height: 1).foregroundStyle(t.border), alignment: .bottom)
    }

    /// Find the most recent assistant turn that followed `prompt` and
    /// write it as a QAEntry. Falls back to the last assistant turn
    /// in history when no exact prompt match is found.
    private func saveLatestAnswer(forPrompt prompt: String) async {
        guard let repoRoot = activeRepoRoot else {
            qaSaveError = "No active repo."
            return
        }
        savingQA = true
        qaSaveError = nil
        defer { savingQA = false }
        let answer = mostRecentAnswer(forPrompt: prompt) ?? ""
        guard !answer.isEmpty else {
            qaSaveError = "No agent answer found yet."
            return
        }
        let entry = QAEntry(
            question: prompt,
            answer: answer,
            savedAt: Date(),
            askCount: session.count(for: session.hashForPrompt(prompt)),
            agent: config.activeCLI
        )
        let store = config.memoryStore
        do {
            _ = try store.writeQA(at: repoRoot, entry)
            session.dismiss(hash: session.hashForPrompt(prompt))
            nudgePrompt = nil
        } catch {
            qaSaveError = "Couldn't save: \(error.localizedDescription)"
        }
    }

    /// Walk the history in reverse, find the most recent assistant
    /// turn that follows a user turn whose content matches `prompt`.
    /// Falls back to the latest assistant turn if no exact match.
    private func mostRecentAnswer(forPrompt prompt: String) -> String? {
        for i in stride(from: history.count - 1, through: 0, by: -1) {
            let t = history[i]
            if t.role == .assistant {
                if i > 0 && history[i - 1].role == .user && history[i - 1].content == prompt {
                    return t.content
                }
            }
        }
        return history.last(where: { $0.role == .assistant })?.content
    }

    private func errorBubble(_ msg: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(theme.current.danger)
            Text(msg)
                .font(Typography.caption)
                .foregroundStyle(theme.current.danger)
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
            Button {
                error = nil
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(theme.current.textMuted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss error")
            .help("Dismiss error")
        }
        .padding(10)
        .background(theme.current.danger.opacity(0.1))
        .cornerRadius(6)
    }

    // MARK: - Attachment bar

    /// Dismissible inline notice for files that couldn't be attached.
    private func attachNoticeBar(_ message: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "info.circle")
                .font(.system(size: 11))
                .foregroundStyle(theme.current.textMuted)
            Text(message)
                .font(.system(size: 11))
                .foregroundStyle(theme.current.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button {
                attachNotice = nil
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(theme.current.textMuted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
        }
        .padding(.horizontal, Spacing.md)
        .padding(.vertical, 6)
        .background(theme.current.surface.opacity(0.6))
    }

    private var attachmentBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(attachments) { a in
                    AttachmentChip(path: a.path, charCount: a.content.count, isBinary: a.content.hasPrefix("[binary:")) {
                        attachments.removeAll { $0.path == a.path }
                    }
                }
            }
            .padding(.horizontal, Spacing.md)
            .padding(.vertical, 6)
        }
        .background(theme.current.surface.opacity(0.6))
    }

    /// Chips for library skills the user invoked — distinct from attachments so
    /// it's clear these are followed, not edited. Each is individually removable.
    private var skillBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(selectedSkills) { s in
                    HStack(spacing: 4) {
                        Image(systemName: s.iconName)
                            .font(.system(size: 10))
                        Text(s.name)
                            .font(.system(size: 11, weight: .medium))
                            .lineLimit(1)
                        Button {
                            selectedSkills.removeAll { $0.id == s.id }
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 11))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Remove \(s.name) skill")
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .foregroundStyle(theme.current.accent)
                    .background(theme.current.accent.opacity(0.12))
                    .clipShape(Capsule())
                }
            }
            .padding(.horizontal, Spacing.md)
            .padding(.vertical, 6)
        }
        .background(theme.current.surface.opacity(0.6))
    }

    // MARK: - Input bar

    private var inputBar: some View {
        VStack(spacing: 0) {
            // Messages queued while a turn is running — they auto-send in order,
            // one per turn. Each is individually removable.
            if !queued.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(queued.enumerated()), id: \.element.id) { index, q in
                        HStack(spacing: 6) {
                            Image(systemName: "clock")
                                .font(.system(size: 10))
                                .foregroundStyle(theme.current.textMuted)
                            Text("Queued #\(index + 1): \(q.text)")
                                .font(.system(size: 11))
                                .foregroundStyle(theme.current.textMuted)
                                .lineLimit(1)
                                .truncationMode(.tail)
                            Spacer()
                            Button {
                                // Remove by stable id, not index — the queue may
                                // have shifted (FIFO drain) since this row rendered.
                                queued.removeAll { $0.id == q.id }
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: 11))
                                    .foregroundStyle(theme.current.textMuted)
                            }
                            .buttonStyle(.plain)
                            .help("Cancel this queued message")
                            .accessibilityLabel("Cancel queued message \(index + 1)")
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 5)
                    }
                }
                .background(theme.current.surface)
                Divider().background(theme.current.border)
            }
            // Agent task progress list — shown when the agent has pending tasks
            if !agentPendingTasks.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(agentPendingTasks) { task in
                        HStack(spacing: 6) {
                            Image(systemName: agentTaskIcon(task.status))
                                .foregroundColor(agentTaskColor(task.status))
                                .font(.caption)
                            Text(task.title)
                                .font(.caption)
                                .foregroundColor(.secondary)
                                .lineLimit(1)
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 4)
            }
            // Autocomplete dropdown — sits directly above the editor (Cursor-style).
            // Kept ALWAYS in the tree and toggled via height/opacity — do NOT
            // wrap in `if completion.isOpen`. Inserting/removing this sibling
            // adjacent to the editor rebuilds the editor subtree and drops the
            // NSTextView's first responder, which silently kills ↑ history
            // recall after the menu has been used once (same fragility the
            // placeholder below documents).
            CompletionMenu(controller: completion, onAccept: { acceptCompletion() })
                .environmentObject(theme)
                .padding(.horizontal, 8)
                .padding(.top, 4)
                .frame(height: completion.isOpen ? nil : 0)
                .opacity(completion.isOpen ? 1 : 0)
                .allowsHitTesting(completion.isOpen)
                .clipped()
            // Text area
            ZStack(alignment: .topLeading) {
                // Keep the placeholder ALWAYS in the tree and toggle its
                // opacity — do NOT wrap it in `if draft.isEmpty`. Inserting/
                // removing this sibling on the first recall (empty → text)
                // rebuilds the editor subtree, and the NSTextView loses first
                // responder, so the second ↑ never reaches keyDown — which is
                // why recall got stuck after a single prompt.
                Text(isCompact ? "Ask Claude…" : "Ask Claude about the attached code…")
                    .font(.system(size: 12))
                    .foregroundStyle(theme.current.textMuted.opacity(0.6))
                    .padding(.horizontal, 12)
                    .padding(.top, 10)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .allowsHitTesting(false)
                    .opacity(draft.isEmpty ? 1 : 0)
                // Recall previous prompts with ↑ / ↓ (like a shell / Claude
                // Code). Backed by NSTextView so the arrows are reliably
                // intercepted: SwiftUI's TextEditor swallows them for caret
                // movement once the field has text, which capped recall at a
                // single prompt. historyUp/historyDown still own the gating —
                // they only hijack the arrows when the field is empty or we're
                // already browsing; otherwise the caret moves normally.
                HistoryTextEditor(
                    text: $draft,
                    font: .systemFont(ofSize: 12),
                    textColor: NSColor(theme.current.text),
                    onArrowUp: { arrowUpAction() },
                    onArrowDown: { arrowDownAction() },
                    onReturn: { if completion.isOpen { acceptCompletion(); return true }; return false },
                    onTab: { if completion.isOpen { acceptCompletion(); return true }; return false },
                    onEscape: { if completion.isOpen { completion.close(); return true }; return false }
                )
                .frame(height: composerHeight)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
            }
            .background(theme.current.body)

            Divider().background(theme.current.border)

            // Bottom toolbar — picks between a single-row layout and a
            // two-row stacked layout depending on available width.
            // ViewThatFits measures the wide layout's ideal width
            // against the parent's offered width; if it doesn't fit,
            // it falls back to the stacked one.
            ViewThatFits(in: .horizontal) {
                toolbarSingleRow
                toolbarStacked
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(theme.current.surface)
        }
        .overlay(RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(theme.current.border, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .padding(.horizontal, Spacing.md)
        .padding(.vertical, 10)
    }

    // MARK: - Toolbar layouts (used by ViewThatFits)

    /// Wide layout — all chips, hint, and send button on one row.
    private var toolbarSingleRow: some View {
        HStack(spacing: 6) {
            if showFileAttachButtons {
                contextButton(icon: "plus", label: "Add from Library", action: { showLibraryPicker = true })
                if !attachments.isEmpty {
                    Text("\(attachments.count) file\(attachments.count == 1 ? "" : "s") · \(formatBytes(totalAttachmentChars))")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(theme.current.textMuted)
                        .lineLimit(1)
                        .padding(.leading, 4)
                }
            }
            if showModelPicker { modelPickerChips }
            editModeChip
            memoryButton
            Spacer()
            keyHint
            sendButton
        }
    }

    /// Narrow layout — chips wrap to a top row; the keyboard hint
    /// and send button keep their own bottom row right-aligned.
    private var toolbarStacked: some View {
        VStack(alignment: .leading, spacing: 6) {
            if showFileAttachButtons || showModelPicker {
                HStack(spacing: 6) {
                    if showFileAttachButtons {
                        contextButton(icon: "plus", label: "Add from Library", action: { showLibraryPicker = true })
                    }
                    if showModelPicker { modelPickerChips }
                    editModeChip
                    memoryButton
                    Spacer(minLength: 0)
                }
                if showFileAttachButtons && !attachments.isEmpty {
                    Text("\(attachments.count) file\(attachments.count == 1 ? "" : "s") · \(formatBytes(totalAttachmentChars))")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(theme.current.textMuted)
                        .lineLimit(1)
                }
            }
            HStack(spacing: 6) {
                Spacer(minLength: 0)
                keyHint
                sendButton
            }
        }
    }

    /// Opens the project-memory viewer (auto-captured facts about this repo).
    /// Shows the last turn's memory token cost so the always-on memory block's
    /// overhead is visible — 0 means no project memory was injected.
    private var memoryButton: some View {
        Button { showProjectMemory = true } label: {
            HStack(spacing: 3) {
                Image(systemName: "brain").font(.system(size: 11))
                if let t = lastMemoryTokens {
                    Text(t > 0 ? "~\(formatTokens(t))" : "0")
                        .font(.system(size: 9, weight: .medium, design: .rounded))
                }
            }
            .frame(height: 22)
            .padding(.horizontal, lastMemoryTokens == nil ? 0 : 3)
        }
        .buttonStyle(.plain)
        .foregroundStyle(theme.current.textMuted)
        .help(memoryButtonHelp)
        .accessibilityLabel("Project memory")
    }

    private var memoryButtonHelp: String {
        guard let t = lastMemoryTokens else {
            return "Project memory — what the assistant has learned about this repo"
        }
        if t == 0 {
            return "Project memory — no memory injected last turn (0 tokens). None generated for this project yet."
        }
        let chat = lastMemoryHasChat ? " (incl. chat-captured facts)" : " (graph-derived only)"
        return "Project memory — added ~\(t) tokens to the last request\(chat). Click to view/prune."
    }

    /// "1.2k" / "850" style compact token count.
    private func formatTokens(_ t: Int) -> String {
        t >= 1000 ? String(format: "%.1fk", Double(t) / 1000.0) : "\(t)"
    }

    private var keyHint: some View {
        Text("⌘↵")
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(theme.current.textMuted.opacity(0.6))
            .fixedSize()
    }

    private var sendButton: some View {
        HStack(spacing: 6) {
            // While a turn is running, offer a Stop control that cancels it.
            if busy {
                Button { stop() } label: {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 11, weight: .semibold))
                        .frame(width: 24, height: 24)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .keyboardShortcut(.cancelAction)   // Esc
                .help("Stop the running response (Esc)")
                .accessibilityLabel("Stop")
            }
            if agentIsAutonomous && !busy {
                Button(action: {
                    agentStopRequested = true
                    agentIsAutonomous = false
                }) {
                    Label("Stop", systemImage: "stop.circle.fill")
                        .foregroundColor(.red)
                }
                .buttonStyle(.borderless)
                .help("Stop autonomous agent")
            }
            // ⌘↵ submits the draft: sends now when idle, queues when a turn is
            // already running (auto-sends as the next turn).
            Button {
                submit()
            } label: {
                Image(systemName: busy ? "arrow.up.to.line" : "arrow.up")
                    .font(.system(size: 12, weight: .semibold))
                    .frame(width: 24, height: 24)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .keyboardShortcut(.return, modifiers: .command)
            .help(busy ? "Queue this message — sends when the current response finishes (⌘↵)" : "Send (⌘↵)")
            .accessibilityLabel(busy ? "Queue message" : "Send message")
        }
    }

    /// CLI-branded agent chip + model picker.
    /// Both chips are `.fixedSize()` so their text never squeezes —
    /// without this, a narrow parent container collapses the chip
    /// down past 1-character width and SwiftUI renders the label
    /// vertically (one glyph per line).  The chips truncate via
    /// `.lineLimit(1)` as a belt-and-braces guard.
    private var modelPickerChips: some View {
        let cli = AICliTool(rawValue: config.activeCLI) ?? .claudeCode
        return HStack(spacing: 6) {
            // Provider chip — a menu to switch among the direct-API providers
            // (Claude / OpenAI / Gemini). Switching resets the model to that
            // provider's default. A provider without a configured key surfaces
            // a clear "add a key in Settings" error on send.
            Menu {
                ForEach(AICliTool.selectable) { tool in
                    Button { switchProvider(tool) } label: {
                        Label(tool.displayName, systemImage: tool.icon)
                    }
                }
            } label: {
                Chip(
                    icon: cli.icon,
                    label: isCompact ? "" : cli.displayName,
                    trailing: "chevron.down",
                    compact: isCompact
                )
            }
            .menuStyle(.borderlessButton)
            .help("Switch model provider")
            .fixedSize()

            // Model picker. Truncate label aggressively when compact so
            // the chip stays one capsule wide instead of wrapping.
            Menu {
                ForEach(modelsFor(cli)) { model in
                    Button(model.displayName) { selectedModel = model.id }
                }
                Divider()
                Button("Add model…") { newModelId = ""; showAddModel = true }
            } label: {
                Chip(
                    icon: nil,
                    label: isCompact ? shortModelLabel(for: cli) : currentModelDisplayName(for: cli),
                    trailing: "chevron.down",
                    compact: isCompact
                )
            }
            .menuStyle(.borderlessButton)
            .help(currentModelDisplayName(for: cli))
            .fixedSize()
        }
        .alert("Add a model", isPresented: $showAddModel) {
            TextField("model id, e.g. gpt-5 / claude-opus-4-9 / gemini-2.5-pro", text: $newModelId)
            Button("Add") {
                let id = newModelId.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !id.isEmpty else { return }
                let active = AICliTool(rawValue: config.activeCLI) ?? .claudeCode
                addCustomModel(id, provider: active.provider)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Adds a model id under the current provider. It's sent to the backend as-is and routed by id prefix — handy for a release not yet in the list.")
        }
    }

    /// Edit-acceptance mode selector (Review / Auto). Same capsule style as
    /// the model picker; collapses to icon-only when the panel is compact.
    private var editModeChip: some View {
        Menu {
            ForEach(EditAcceptanceMode.allCases) { mode in
                Button { editModeRaw = mode.rawValue } label: {
                    Label(mode.label, systemImage: mode.icon)
                }
            }
        } label: {
            Chip(
                icon: editMode.icon,
                label: isCompact ? "" : editMode.label,
                trailing: "chevron.down",
                compact: isCompact
            )
        }
        .menuStyle(.borderlessButton)
        .help(editMode.help)
        .fixedSize()
    }

    /// Aggressive truncation for the model label in compact panels —
    /// "Sonnet 4.6" → "S4.6", "Opus 4.7" → "O4.7". Keeps the chip on
    /// a single short capsule instead of clipping mid-glyph.
    private func shortModelLabel(for cli: AICliTool) -> String {
        let full = currentModelDisplayName(for: cli)
        // Match a leading word + trailing number/version (e.g. "Sonnet 4.6").
        let parts = full.split(separator: " ")
        if parts.count >= 2, let first = parts.first?.first {
            return "\(first)\(parts.dropFirst().joined())"
        }
        return String(full.prefix(6))
    }

    private func currentModelDisplayName(for cli: AICliTool) -> String {
        let models = modelsFor(cli)
        return models.first(where: { $0.id == selectedModel })?.displayName
            ?? models.first?.displayName
            ?? selectedModel
    }

    /// Models to offer for a provider: the live list when we've fetched one,
    /// otherwise the built-in static list (keeps the picker populated when no
    /// key is set or the fetch failed), plus any user-added custom ids.
    private func modelsFor(_ cli: AICliTool) -> [AIModel] {
        let base = (liveModels[cli.provider]?.isEmpty == false) ? liveModels[cli.provider]! : cli.models
        let baseIds = Set(base.map(\.id))
        let custom = customModels(for: cli.provider)
            .filter { !baseIds.contains($0) }
            .map { AIModel(id: $0, displayName: $0) }
        return base + custom
    }

    /// User-added model ids for a provider (decoded from AppStorage JSON).
    private func customModels(for provider: String) -> [String] {
        let dict = (try? JSONDecoder().decode([String: [String]].self,
                                              from: Data(customModelsRaw.utf8))) ?? [:]
        return dict[provider] ?? []
    }

    /// Append a custom model id for a provider and select it.
    private func addCustomModel(_ id: String, provider: String) {
        var dict = (try? JSONDecoder().decode([String: [String]].self,
                                              from: Data(customModelsRaw.utf8))) ?? [:]
        var list = dict[provider] ?? []
        if !list.contains(id) { list.append(id) }
        dict[provider] = list
        if let data = try? JSONEncoder().encode(dict), let s = String(data: data, encoding: .utf8) {
            customModelsRaw = s
        }
        selectedModel = id
    }

    /// Fetch the provider's live chat models (best-effort; silent on failure).
    private func loadModels(for cli: AICliTool) async {
        guard let ids = try? await api.listProviderModels(cli.provider), !ids.isEmpty else { return }
        liveModels[cli.provider] = ids.map { AIModel(id: $0, displayName: $0) }
    }

    /// Switch the active model provider (Claude / OpenAI / Gemini) and reset
    /// the selected model to that provider's default. The model id flows to
    /// the backend, which routes it to the right provider API.
    private func switchProvider(_ tool: AICliTool) {
        config.activeCLI = tool.rawValue
        config.defaultModelId = tool.defaultModelId
        selectedModel = tool.defaultModelId
        Task { await loadModels(for: tool) }
    }

    /// Single source of truth for composer text-area height.  Caps
    /// the editor so it never pushes everything else off-screen.
    /// Grows linearly with line count up to a hard ceiling.
    private var composerHeight: CGFloat {
        let lineCount = max(1, draft.components(separatedBy: "\n").count)
        let approx = CGFloat(lineCount) * 16 + 12
        return min(max(approx, 40), 120)
    }

    /// Compact text-button for the composer footer.  Borderless,
    /// hover-only highlight — quieter than the previous pill style so
    /// the composer feels like one cohesive element instead of a row
    /// of competing controls.
    @ViewBuilder
    private func contextButton(icon: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.system(size: 10, weight: .medium))
                // These are the lowest-priority controls, so drop them to
                // icon-only as soon as the panel isn't comfortably wide —
                // keeping room for the model picker rather than clipping it.
                // `lineLimit(1)` + `fixedSize` are essential: without them a
                // narrow row squeezes the label to 1-character width and
                // SwiftUI renders it vertically (one glyph per line).
                if panelWidth >= 320 {
                    Text(label)
                        .font(.system(size: 11))
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .foregroundStyle(theme.current.textMuted)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            // Hover highlight handled via the .background modifier
            // applied to the wrapping Button via a state trick — keep
            // it simple: no-op, the .help below is enough feedback.
            _ = hovering
        }
        .help(label)
    }

    private func formatBytes(_ chars: Int) -> String {
        if chars < 1024 { return "\(chars) B" }
        if chars < 1024 * 1024 {
            let kb = Double(chars) / 1024.0
            return String(format: "%.1f KB", kb)
        }
        let mb = Double(chars) / (1024.0 * 1024.0)
        return String(format: "%.2f MB", mb)
    }

    private var totalAttachmentChars: Int {
        attachments.reduce(0) { $0 + $1.content.count }
    }

    enum AttachOutcome { case added, duplicate, notText, unreadable }

    // MARK: - Agent context

    /// Pure derivation: maps an active project (if any) to an
    /// AgentContext.Project. Extracted as a static fn so unit tests can
    /// exercise the conversion without instantiating a SwiftUI view.
    static func deriveActiveProject(from active: ProjectStore.ActiveProject?) -> AgentContext.Project? {
        guard let active, let linked = active.bundle.settings.linkedRepo else { return nil }
        return AgentContext.Project(
            name: active.bundle.displayName,
            url: linked.url,
            defaultBranch: linked.defaultBranch,
            provider: linked.kind == .gitlab ? "GitLab" : "GitHub")
    }

    /// Fallback active-project derivation for users who configured a repo via
    /// Settings → GitLab / GitHub (which populates `config.gitLabSavedProjects`
    /// / `config.gitHubSavedRepos`) but whose open workspace bundle has no
    /// `linkedRepo`. Without this, the agent's System context reports
    /// "(none configured)" and the create-issue skill refuses — even though
    /// `resolveIssueTarget()` could file the issue. Mirrors that resolver's
    /// precedence (GitLab first, then GitHub) so the agent's view of the
    /// active project matches where issues actually get filed.
    static func deriveActiveProject(fromConfig config: AppConfig) -> AgentContext.Project? {
        if !config.gitLabToken.isEmpty,
           let p = config.gitLabSavedProjects.first(where: { $0.isActive }) {
            let name = !p.displayName.isEmpty ? p.displayName
                : (URL(string: p.url)?.lastPathComponent ?? "project")
            return AgentContext.Project(name: name, url: p.url,
                                        defaultBranch: p.defaultBranch, provider: "GitLab")
        }
        if !config.gitHubToken.isEmpty,
           let r = config.gitHubSavedRepos.first(where: { $0.isActive }) {
            let name = !r.displayName.isEmpty ? r.displayName
                : (URL(string: r.url)?.lastPathComponent ?? "repository")
            return AgentContext.Project(name: name, url: r.url,
                                        defaultBranch: r.defaultBranch, provider: "GitHub")
        }
        return nil
    }

    /// Builds the per-request snapshot of "what the agent should know":
    /// the active GitLab project and the user's indexed code repos.
    /// Recomputed every send so Settings changes are picked up live.
    private func buildAgentContext() async -> AgentContext {
        // New: derive from the active workspace's linkedRepo. Falls
        // through to nil when no project is open (Welcome screen path)
        // or when the active project has no linked repo set. Existing
        // AgentContext.Project shape is preserved so the server-side
        // render-active-project skill renders identically.
        // Prefer the open workspace's linkedRepo; fall back to the active
        // Settings → GitLab/GitHub connection so a project configured only
        // there is still visible to the agent (otherwise it reports
        // "(none configured)" and the create-issue skill refuses to act).
        let activeProject = Self.deriveActiveProject(from: projectStore.activeProject)
            ?? Self.deriveActiveProject(fromConfig: config)
        let codeItems = library.items(for: .code)
        let grouped = Dictionary(grouping: codeItems.filter { $0.folderOrigin != nil },
                                 by: { $0.folderOrigin! })
        let indexedRepos: [AgentContext.IndexedRepo] = grouped.keys.sorted().map { folder in
            let items = grouped[folder] ?? []
            let ancestor = commonAncestor(items.map { $0.path })
            return .init(name: folder, path: ancestor.isEmpty ? nil : homeRelativePath(ancestor))
        }
        // NOTE: `recentIssues` is still populated by the issue-polling
        // flow that reads `config.gitLabSavedProjects.first(where: { $0.isActive })`
        // (see refreshRecentIssuesOnce and call sites around lines 197/306/
        // 358/720/1214). If the legacy GitLab "active" project diverges from
        // `projectStore.activeProject.linkedRepo`, the agent sees a mismatched
        // (activeProject, recentIssues) pair. Acceptable for Phase 1 because
        // most users will run the migrator and end up consistent; rewiring
        // the polling sites is tracked as a Phase 2 follow-up.
        // The folder open in the Explorer — the server scopes its read-only
        // file tools (list-files / read-file) to this root + the indexed repos,
        // so "find the README and review it" can resolve a real file.
        let workspaceRoot = WorkspaceRoot.resolve(config: config, projectStore: projectStore)
            .map { homeRelativePath($0.path) }

        // Git context: populate currentBranch and gitStatus so the agent
        // can answer repo-state questions without a git-op tool call.
        // Resolved from the active repo URL; nil when not in a git repo.
        var gitBranch: String?
        var gitStatus: AgentContext.GitStatus?
        if let repoURL = config.activeRepoLocalURL, WorkspaceRoot.isGitRepo(repoURL) {
            let repoManager = RepoManager()
            // Get current branch
            if let branch = try? await repoManager.runGit(["rev-parse", "--abbrev-ref", "HEAD"], at: repoURL) {
                gitBranch = branch.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            // Get status counts (porcelain v1: XY filename)
            if let status = try? await repoManager.runGit(["status", "--porcelain=v1"], at: repoURL) {
                let lines = status.split(separator: "\n")
                let staged = lines.filter { $0.prefix(1) != " " && $0.prefix(1) != "?" }.count
                let unstaged = lines.filter { $0.count >= 2 && $0.dropFirst().prefix(1) != " " }.count
                // Get ahead/behind from branch tracking
                var ahead = 0, behind = 0, hasUpstream = false
                if let branch = gitBranch,
                   let tracking = try? await repoManager.runGit(["rev-parse", "--abbrev-ref", "\(branch)@{upstream}"], at: repoURL),
                   !tracking.contains("no upstream") {
                    hasUpstream = true
                    let counts = try? await repoManager.runGit(["rev-list", "--left-right", "--count", "\(branch)...@{u}"], at: repoURL)
                    if let counts = counts {
                        let parts = counts.split(separator: "\t").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                        if parts.count == 2 {
                            ahead = Int(parts[0]) ?? 0
                            behind = Int(parts[1]) ?? 0
                        }
                    }
                }
                gitStatus = AgentContext.GitStatus(
                    staged: staged,
                    unstaged: unstaged,
                    ahead: ahead,
                    behind: behind,
                    hasUpstream: hasUpstream
                )
            }
        }

        return AgentContext(
            activeProject: activeProject,
            indexedRepos: indexedRepos,
            recentIssues: recentIssues.isEmpty ? nil : recentIssues,
            workspaceRoot: workspaceRoot,
            sessionId: agentSessionId,
            currentBranch: gitBranch,
            gitStatus: gitStatus
        )
    }

    /// Polls GitLab for the active project's recent issues and updates
    /// `recentIssues`. Runs once on panel mount and every 60 s while
    /// alive. Silently no-ops when no project is configured or the
    /// project ID hasn't been resolved yet.
    private func refreshRecentIssuesLoop() async {
        while !Task.isCancelled {
            await refreshRecentIssuesOnce()
            // 60 s between polls — issues don't change fast enough to
            // justify hammering the GitLab API.
            try? await Task.sleep(nanoseconds: 60 * 1_000_000_000)
        }
    }

    func refreshRecentIssuesOnce() async {
        // Determine the active project and its provider
        guard let activeProject = Self.deriveActiveProject(from: projectStore.activeProject)
            ?? Self.deriveActiveProject(fromConfig: config),
              let provider = activeProject.provider else {
            recentIssues = []
            return
        }

        // Create the appropriate RepoBackend based on provider
        let backend: RepoBackend
        let projectId: String

        if provider == "GitLab" {
            guard let project = config.gitLabSavedProjects.first(where: { $0.isActive }),
                  let pid = project.resolvedId else {
                recentIssues = []
                return
            }
            backend = RepoBackendFactory.guarded(GitLabClient(config: config), config: config)
            projectId = String(pid)
        } else if provider == "GitHub" {
            guard let repo = config.gitHubSavedRepos.first(where: { $0.isActive }),
                  let (owner, name) = GitHubClient.ownerAndName(from: repo.url) else {
                recentIssues = []
                return
            }
            backend = RepoBackendFactory.guarded(GitHubClient(config: config), config: config)
            projectId = "\(owner)/\(name)"
        } else {
            recentIssues = []
            return
        }

        do {
            // Open issues only: that's what the user actively references.
            // Closed issues clutter the prompt without much upside.
            let filter = RepoIssueFilter(state: .opened, search: "", labelName: "")
            let issues = try await backend.listIssues(projectId: projectId, filter: filter, page: 1)

            // Cap at 15 so the prompt context doesn't blow up; pick the
            // most recently updated. Sort by updatedAt (descending).
            let capped = Array(
                issues
                    .sorted { $0.updatedAt > $1.updatedAt }
                    .prefix(15)
            )

            recentIssues = capped.map { issue in
                let desc = issue.body ?? ""
                let snippet = desc.isEmpty ? nil : String(desc.prefix(160))
                return AgentContext.RecentIssue(
                    iid: issue.number,  // Use `number` (GitLab iid, GitHub number)
                    title: issue.title,
                    state: issue.state,   // "opened" / "closed"
                    labels: issue.labels,
                    snippet: snippet,
                    updatedAt: issue.updatedAt
                )
            }
        } catch {
            // Don't surface — agent just sees an empty list this turn.
            recentIssues = []
        }
    }

    private func commonAncestor(_ paths: [String]) -> String {
        guard !paths.isEmpty else { return "" }
        let split = paths.map { $0.components(separatedBy: "/") }
        let shortest = split.min(by: { $0.count < $1.count }) ?? []
        var result: [String] = []
        for i in 0..<shortest.count {
            let c = shortest[i]
            if split.allSatisfy({ $0.indices.contains(i) && $0[i] == c }) { result.append(c) }
            else { break }
        }
        return result.joined(separator: "/")
    }

    private func homeRelativePath(_ p: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        if p.hasPrefix(home) { return "~" + p.dropFirst(home.count) }
        return p
    }

    // MARK: - Send

    @MainActor
    /// ⌘↵ / Send button. Sends the draft now when idle; appends it to the queue
    /// when a turn is already running (queued messages auto-send in FIFO order,
    /// one per turn).
    private func submit() {
        let msg = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !msg.isEmpty else { return }
        draft = ""
        // Record the PLAIN text for ↑ recall (not the skill-decorated message).
        if sentPrompts.last != msg {
            sentPrompts.append(msg)
            if sentPrompts.count > 100 { sentPrompts.removeFirst(sentPrompts.count - 100) }
        }
        historyIndex = nil
        draftStash = ""
        // Consume the invoked-skill chips one-shot for THIS message: in-built
        // directives are prepended to the text; library ids ride alongside it
        // (sent via the skill channel). Cleared so a skill applies to exactly the
        // message it was invoked for, not silently to every later turn.
        let directives = selectedSkills.compactMap { s -> String? in
            if case .directive(let d) = s.action { return d } else { return nil }
        }
        let skillIds = selectedSkills.compactMap { s -> String? in
            if case .library(let id) = s.action { return id } else { return nil }
        }
        selectedSkills = []
        let outgoing = directives.isEmpty ? msg : directives.joined(separator: "\n") + "\n\n" + msg
        if busy {
            queued.append(.init(text: outgoing, skillIds: skillIds))
        } else {
            startTurn(outgoing, skillIds: skillIds)
        }
    }

    /// ↑ in the composer: walk back through previously-sent prompts. Returns
    /// `.ignored` (so the cursor moves normally) unless the field is empty or
    /// we're already browsing history.
    /// Seed ↑/↓ recall from a loaded/switched session's turns. Without this,
    /// `sentPrompts` only tracks prompts submitted in the CURRENT app run, so
    /// after a relaunch or session switch the chat shows prior turns but ↑
    /// recalls nothing. Synthetic turns (tool acks like "(applied update…)",
    /// "(continue)") are skipped so they don't pollute recall.
    private func rebuildSentPrompts(from turns: [LlmIdeAPIClient.CodeAssistTurn]) {
        var prompts: [String] = []
        for t in turns where t.role == .user {
            let c = t.content.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !c.isEmpty, !c.hasPrefix("(") else { continue }
            if prompts.last != c { prompts.append(c) }
        }
        if prompts.count > 100 { prompts.removeFirst(prompts.count - 100) }
        sentPrompts = prompts
        historyIndex = nil
        draftStash = ""
    }

    private func historyUp() -> KeyPress.Result {
        guard !sentPrompts.isEmpty, draft.isEmpty || historyIndex != nil else { return .ignored }
        if let i = historyIndex {
            guard i > 0 else { return .handled }   // already at the oldest
            historyIndex = i - 1
        } else {
            draftStash = draft                     // stash the live draft
            historyIndex = sentPrompts.count - 1
        }
        draft = sentPrompts[historyIndex!]
        return .handled
    }

    /// ↓ in the composer: walk forward; past the newest, restore the draft.
    private func historyDown() -> KeyPress.Result {
        guard let i = historyIndex else { return .ignored }
        if i < sentPrompts.count - 1 {
            historyIndex = i + 1
            draft = sentPrompts[historyIndex!]
        } else {
            historyIndex = nil
            draft = draftStash
        }
        return .handled
    }

    /// Launch a turn as an unstructured Task whose handle Stop can cancel.
    private func startTurn(_ message: String, skillIds: [String] = []) {
        runTask = Task { await runTurn(message, skillIds: skillIds) }
    }

    /// Cancel the in-flight turn. URLSession.data(for:) throws on cancellation,
    /// so the network request is actually aborted; runTurn treats that as a
    /// clean stop (no error bubble) and then drains any queued message.
    private func stop() {
        runTask?.cancel()
    }

    /// Run one user turn end-to-end. On completion it drains `queued` (if any)
    /// as a FRESH task — an unstructured `Task {}` does NOT inherit the current
    /// task's cancellation, so a stopped turn still lets the queued message run.
    private func runTurn(_ message: String, skillIds: [String] = []) async {
        _ = session.record(prompt: message)
        if session.shouldNudge(for: message) {
            nudgePrompt = message
        }
        // Append the user turn FIRST so the message appears immediately
        // even if the network call is slow.
        history.append(.init(role: .user, content: message))
        busy = true
        statusText = ""
        error = nil
        // Clear any stale pending-tool card from a prior turn the user ignored —
        // otherwise it stays interactive against the old args while a new turn runs.
        pendingTool = nil
        // Fresh budget of auto-run git ops for this user turn (commit→push→… ).
        autoGitOpsThisTurn = 0
        do {
            // Send the most recent ~8 turns as history — server caps too
            // but we'd rather not push a huge payload over the wire.
            let recent = history.count > 8 ? Array(history.suffix(8)) : history
            // Stream so the user sees live progress ("Searching the web…",
            // "Writing the answer…") instead of a frozen spinner for the
            // 60–90s an agent turn can take. Falls back to buffered on a
            // stream failure (see codeAssistRoundTrip).
            let resp = try await codeAssistRoundTrip(
                message: message,
                history: Array(recent.dropLast()),  // exclude the just-pushed user turn — server appends it
                attachments: attachments,
                skills: skillIds,
            )
            // If Stop fired during the await, don't append the (now-unwanted) reply.
            try Task.checkCancellation()
            history.append(.init(role: .assistant, content: resp.reply))
            self.pendingTool = resp.pendingTool
            // Update task list display
            if let newTasks = resp.tasks {
                agentPendingTasks = newTasks
            }
            // Auto-continue if the agent has pending work and the user hasn't stopped
            if resp.continueNeeded == true && !agentStopRequested {
                agentIsAutonomous = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                    guard !self.agentStopRequested else {
                        self.agentIsAutonomous = false
                        return
                    }
                    self.startTurn("Continue working on your pending tasks.")
                }
            } else {
                agentIsAutonomous = false
                agentStopRequested = false
            }
            if let u = resp.usage {
                lastMemoryTokens = u.memoryApproxTokens
                lastMemoryHasChat = u.memoryHasChatMemory ?? false
            }
            // Fast path: in Auto mode, apply a proposed file edit immediately
            // instead of surfacing the card + popup. Scoped to `update-file`
            // (confirmUpdateFile enforces the attached-files-only guard, and
            // leaves the card up if the file isn't attached); GitLab actions
            // keep their confirmation. Only the primary turn auto-applies —
            // the follow-up turn falls back to the card, so an agent that
            // keeps proposing edits can't loop.
            if editMode == .auto, let pt = resp.pendingTool, let args = pt.updateFileArgs {
                // Data-loss guard: if the server CUT this file to fit the prompt,
                // the agent only saw its head — auto-overwriting with the "full"
                // rewrite would silently drop the tail. Fall back to the manual
                // confirmation card (its diff makes the loss visible) instead of
                // applying. matchingAttachment uses the same exact-path rule
                // confirmUpdateFile enforces in auto mode.
                let truncated = Set(resp.usage?.truncatedPaths ?? [])
                if let match = matchingAttachment(for: args.path, allowBasenameFallback: false),
                   truncated.contains(match.path) {
                    let basename = (match.path as NSString).lastPathComponent
                    self.error = "“\(basename)” was too large to send in full, so auto-edit is disabled for it — review the proposed change before applying."
                    // Leave resp.pendingTool in place (set above) so the card shows.
                } else {
                    _ = await confirmUpdateFile(args, finalContent: args.content)
                }
            }
            // Auto-run the proposed git op when allowed (see shouldAutoRunGitOp);
            // otherwise it stays as a pending card for the user to confirm.
            if let pt = resp.pendingTool, let g = pt.gitOpArgs, shouldAutoRunGitOp(g) {
                autoGitOpsThisTurn += 1
                await runGitOpFlow(g)
            }
        } catch is CancellationError {
            // Stopped by the user — leave the user turn, no error bubble.
        } catch let urlError as URLError where urlError.code == .cancelled {
            // Stopped: Task cancellation surfaced as a cancelled URLSession request.
        } catch {
            self.error = error.localizedDescription
        }
        // Drain the next queued message (FIFO) as a fresh, un-cancelled turn.
        if !queued.isEmpty {
            let next = queued.removeFirst()
            startTurn(next.text, skillIds: next.skillIds)
        } else {
            busy = false
            runTask = nil
        }
    }

    /// Creates the issue via the resolved backend (GitLab or GitHub) with
    /// the user's edited args. On success, appends a synthetic user turn so
    /// the agent can acknowledge in the next round, and re-POSTs /code-assist.
    @MainActor
    func confirmCreateIssue(_ args: CreateIssueSheet.Args,
                                    target: IssueTarget) async -> CreateIssueSheet.ConfirmResult {
        let client: RepoBackend = target.kind == .gitlab
            ? RepoBackendFactory.guarded(GitLabClient(config: config), config: config)
            : RepoBackendFactory.guarded(GitHubClient(config: config), config: config)
        do {
            let payload = RepoIssuePayload(
                title: args.title,
                body: args.description.isEmpty ? nil : args.description,
                labels: args.labels.isEmpty ? nil : args.labels
            )
            let issue = try await client.createIssue(projectId: target.projectId, payload: payload)
            // Clear the pending tool so the card disappears.
            self.pendingTool = nil
            // Synthetic acknowledgement turn — agent sees the result in history.
            // RepoIssue.webUrl is backend-correct for both providers.
            history.append(.init(
                role: .user,
                content: "(executed create-issue → #\(issue.number) \(issue.webUrl))"
            ))
            // Re-invoke the agent so it can acknowledge in natural language.
            await sendFollowup()
            return .success(issue.number)
        } catch {
            return .failure(error.localizedDescription)
        }
    }

    /// Resolve an agent-supplied path to one of the chat's attachments.
    /// The agent emits absolute paths but the chip stores ~/-prefixed
    /// display paths, so we normalise both sides before comparing.
    /// Returns nil if no match — the caller refuses to write in that
    /// case (defence in depth against the agent emitting a path the
    /// user never attached).
    func matchingAttachment(for proposedPath: String,
                                    allowBasenameFallback: Bool = true)
        -> LlmIdeAPIClient.CodeAttachment?
    {
        let canonProposed = PathUtils.canonicalise(proposedPath)
        let canonBasename = (canonProposed as NSString).lastPathComponent
        // 1. Exact canonicalised match (handles ~, file://, symlinks, ./).
        if let exact = attachments.first(where: {
            PathUtils.canonicalise($0.path) == canonProposed
        }) {
            return exact
        }
        // 2. Basename match as a fallback when the agent emitted a
        //    different parent path (e.g. it guessed /Users/.../README.md
        //    while the user attached ~/Developer/.../README.md). The
        //    agent is supposed to use the exact attachment path, but
        //    LLMs slip — better to update the obviously-intended file
        //    than refuse on a parent-dir difference.
        //    DISABLED in auto-edit mode (allowBasenameFallback=false): with no
        //    confirmation sheet, a poisoned/hallucinated path that merely
        //    shares a basename with an attachment would silently overwrite that
        //    file. Auto mode requires an exact path the agent explicitly chose.
        if allowBasenameFallback && !canonBasename.isEmpty {
            let matches = attachments.filter {
                ($0.path as NSString).lastPathComponent == canonBasename
            }
            // Only fall back when there's exactly one candidate — if
            // multiple attachments share the basename, the agent's
            // ambiguous path means we can't pick safely.
            if matches.count == 1 { return matches.first }
        }
        return nil
    }

    // Path canonicalisation lives in `Utilities/PathUtils.swift` so the
    // attachment match here uses the same rules as every other tilde-
    // expansion / symlink-resolution site in the app.

    /// Writes the user-approved content to disk, then refreshes the
    /// in-memory attachment so subsequent chat turns see the new file.
    /// Append a synthetic ack turn and re-invoke the agent so it can
    /// acknowledge in natural language (matches createIssue flow).
    @MainActor
    func confirmUpdateFile(_ args: PendingTool.UpdateFileArgs,
                                   finalContent: String)
        async -> UpdateFileSheet.ConfirmResult
    {
        // In auto-edit mode the write happens with no confirmation sheet, so
        // require an EXACT attached-path match — don't let the lenient basename
        // fallback silently redirect a write onto a different attached file.
        guard let match = matchingAttachment(for: args.path,
                                             allowBasenameFallback: editMode != .auto) else {
            return .failure(editMode == .auto
                ? "Auto-edit can only write a file whose exact path is attached — refusing to write '\(args.path)'."
                : "That file isn't attached to this chat — refusing to write.")
        }
        // Write to the authoritative attached path, not the LLM-emitted path.
        // A basename-fallback match can make args.path diverge from match.path,
        // which would overwrite the wrong file.
        let absolute = PathUtils.canonicalise(match.path)
        let url = URL(fileURLWithPath: absolute)
        do {
            try finalContent.write(to: url, atomically: true, encoding: .utf8)
            // Track this file for File → PR automation
            modifiedFiles.insert(match.path)
        } catch {
            return .failure("Couldn't write \(absolute): \(error.localizedDescription)")
        }
        // Deselect the file now that the update is applied. The user attached it
        // to edit it — that's done — and leaving the (now-written) chip in place
        // just re-sends the whole file on every later turn. Remove only THIS
        // file's chip (other attachments stay), and clear the auto-attach
        // bookkeeping if it was the auto-attached file. `match` is a value copy,
        // so the line-delta math below still sees the pre-write content.
        attachments.removeAll { $0.path == match.path }
        if autoAttachedPath == match.path { autoAttachedPath = nil }
        self.pendingTool = nil

        // Synthetic acknowledgement turn so the agent can react.
        let basename = (absolute as NSString).lastPathComponent
        let oldLineCount = match.content.components(separatedBy: "\n").count
        let newLineCount = finalContent.components(separatedBy: "\n").count
        let delta = newLineCount - oldLineCount
        let deltaStr = delta == 0
            ? "no net line change"
            : (delta > 0 ? "+\(delta) lines" : "\(delta) lines")
        history.append(.init(
            role: .user,
            content: "(applied update to \(basename): \(deltaStr))"
        ))
        // In auto-edit mode confirmUpdateFile is called from inside runTurn,
        // which has already set busy = true. sendFollowup() guards on !busy
        // and would silently skip. Clear busy here so the follow-up fires;
        // runTurn sets busy = false at its tail afterwards (a benign no-op,
        // unless a queued message is waiting — which it then drains). In
        // manual mode the sheet calls us directly with busy already false,
        // so this is also safe.
        busy = false
        await sendFollowup()
        return .success
    }

    /// Posts a comment on the given issue via the resolved backend (GitLab or
    /// One code-assist round-trip that streams live status, with a safety net:
    /// if the SSE transport fails for any reason other than a user cancellation,
    /// fall back to the buffered endpoint once. So a streaming/parse bug can
    /// never break the feature — the worst case is losing the live status line.
    private func codeAssistRoundTrip(
        message: String,
        history: [LlmIdeAPIClient.CodeAssistTurn],
        attachments: [LlmIdeAPIClient.CodeAttachment],
        skills: [String] = [],
    ) async throws -> LlmIdeAPIClient.CodeAssistResponse {
        let provider = (AICliTool(rawValue: config.activeCLI) ?? .claudeCode).provider
        let model = selectedModel.isEmpty ? nil : selectedModel
        let ctx = await buildAgentContext()
        do {
            return try await api.codeAssistStream(
                message: message, language: prefLanguage, model: model, provider: provider,
                history: history, attachments: attachments, skills: skills, agentContext: ctx,
                onProgress: { statusText = $0 })
        } catch let e as APIError {
            // APIError == a server/stream/format failure (cancellations surface
            // as CancellationError / URLError.cancelled, which propagate). Retry
            // once on the buffered path so streaming issues degrade gracefully.
            if case .http = e {
                return try await api.codeAssist(
                    message: message, language: prefLanguage, model: model, provider: provider,
                    history: history, attachments: attachments, skills: skills, agentContext: ctx)
            }
            throw e
        }
    }

    func sendFollowup() async {
        // Don't fire a second round-trip if one is already in flight.
        // Without this guard, rapid confirms or a manual ⌘↵ during
        // model streaming would stack overlapping /code-assist requests.
        guard !busy else { return }
        busy = true
        statusText = ""
        defer { busy = false }
        do {
            let recent = history.count > 8 ? Array(history.suffix(8)) : history
            // The synthetic "(executed create-gitlab-issue …)" turn we
            // pushed before this call IS the signal the agent needs to
            // see. Keep it in `history`; pass "(continue)" as the user
            // message purely to pass the server's empty-message guard.
            let resp = try await codeAssistRoundTrip(
                message: "(continue)",
                history: recent,
                attachments: [],
            )
            history.append(.init(role: .assistant, content: resp.reply))
            self.pendingTool = resp.pendingTool
        } catch {
            self.error = error.localizedDescription
        }
        // Chain the NEXT git op hands-free when allowed — this is what lets
        // "commit and push" finish without a card: commit auto-runs on the
        // primary turn, the agent then proposes push on this follow-up, and we
        // auto-run it too. runGitOpFlow resets `busy = false` itself before its
        // own sendFollowup, so the re-entry isn't blocked by the `guard !busy`
        // even though our `busy` is still true here. The recursion (and so any
        // looping agent) is bounded by autoGitOpsThisTurn.
        if let g = pendingTool?.gitOpArgs, shouldAutoRunGitOp(g) {
            autoGitOpsThisTurn += 1
            await runGitOpFlow(g)
        }
    }

    // MARK: - Session management

    /// Persist `history` into the active session's JSON file, deriving
    /// a title from the first user turn if it's still "New chat".
    private func persistCurrentSession(history: [LlmIdeAPIClient.CodeAssistTurn]) {
        guard let cur = UUID(uuidString: currentSessionIDString) else { return }
        var session = ChatSessionStore.load(id: cur)
            ?? ChatSession(id: cur, history: history)
        session.history = history
        if session.title == "New chat" || session.title.isEmpty {
            if let firstUser = history.first(where: { $0.role == .user }) {
                let raw = firstUser.content
                    .replacingOccurrences(of: "\n", with: " ")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if !raw.isEmpty {
                    session.title = String(raw.prefix(40))
                }
            }
        }
        ChatSessionStore.save(session)
        sessions = ChatSessionStore.listSessions()
    }

    /// Spawn a new empty session, persist it, switch to it, and clear
    /// in-memory composer state. Per-project `recentIssues` stays.
    /// Cancel any in-flight turn and clear per-conversation transient state.
    /// Called when the active session changes so a running turn can't land its
    /// reply in — or leave `busy` stuck locking — the new session, and so
    /// queued messages / expanded-turn ids don't bleed across sessions.
    private func resetActiveTurnState() {
        runTask?.cancel()
        runTask = nil
        busy = false
        queued.removeAll()
        expandedTurns.removeAll()
    }

    private func createNewSession() {
        // Flush the outgoing session synchronously first. The
        // .onChange(of: history) persist is deferred to the next view update,
        // so without this an explicit save the last reply can be lost when we
        // immediately repoint currentSessionIDString / clear history below.
        persistCurrentSession(history: Array(history.suffix(50)))
        resetActiveTurnState()
        let fresh = ChatSession()
        ChatSessionStore.save(fresh)
        currentSessionIDString = fresh.id.uuidString
        sessions = ChatSessionStore.listSessions()
        history = []
        sentPrompts = []; historyIndex = nil; draftStash = ""
        draft = ""
        attachments.removeAll()
        selectedSkills.removeAll()
        autoAttachedPath = nil
        attachNotice = nil
        pendingTool = nil
        error = nil
        agentSessionId = UUID().uuidString
        agentPendingTasks = []
        agentIsAutonomous = false
        agentStopRequested = false
    }

    private func switchSession(to id: UUID) {
        guard id.uuidString != currentSessionIDString else { return }
        guard let session = ChatSessionStore.load(id: id) else { return }
        // Flush the OUTGOING session (current id + current history, incl. its
        // last reply) before repointing — the .onChange persist is deferred,
        // so relying on it alone can drop the final reply on a same-runloop
        // navigation away.
        persistCurrentSession(history: Array(history.suffix(50)))
        resetActiveTurnState()
        currentSessionIDString = id.uuidString
        history = session.history
        rebuildSentPrompts(from: session.history)
        draft = ""
        attachments.removeAll()
        selectedSkills.removeAll()
        autoAttachedPath = nil
        attachNotice = nil
        pendingTool = nil
        error = nil
        // Bump lastUsedAt so this session moves to the top of the list.
        ChatSessionStore.save(session)
        sessions = ChatSessionStore.listSessions()
    }

    private func deleteSession(_ id: UUID) {
        // If we're deleting the ACTIVE session, cancel any in-flight turn first
        // (mirrors switch/create). Otherwise the running turn would append its
        // reply onto the next session's history and leave `busy` stuck.
        if id.uuidString == currentSessionIDString { resetActiveTurnState() }
        ChatSessionStore.delete(id: id)
        sessions = ChatSessionStore.listSessions()
        if id.uuidString == currentSessionIDString {
            // Deleted the active session — fall back to most recent, or
            // mint a fresh one.
            if let next = sessions.first {
                currentSessionIDString = next.id.uuidString
                history = next.history
                rebuildSentPrompts(from: next.history)
            } else {
                createNewSession()
            }
        }
    }

    private func loadLanguage() async {
        do {
            let p = try await api.getUserPrefs()
            prefLanguage = p.language ?? "en"
        } catch {
            prefLanguage = "en"
        }
    }
    private func agentTaskIcon(_ status: String) -> String {
        switch status {
        case "completed": return "checkmark.circle.fill"
        case "in_progress": return "arrow.trianglehead.clockwise"
        case "skipped": return "minus.circle"
        default: return "circle"
        }
    }

    private func agentTaskColor(_ status: String) -> Color {
        switch status {
        case "completed": return .green
        case "in_progress": return .blue
        case "skipped": return .secondary
        default: return .secondary
        }
    }

}

// MARK: - Issue Sheets

/// Sheet for reading full issue details
struct GetIssueSheet: View {
    let iid: Int
    let projectId: String
    let providerKind: RepoBackendKind
    let onConfirm: () -> Void

    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject var theme: ThemeStore
    @State private var isLoading = false
    @State private var issue: RepoIssue?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            if isLoading {
                ProgressView("Loading issue...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let issue = issue {
                VStack(alignment: .leading, spacing: 16) {
                    Text("#\(issue.number): \(issue.title)")
                        .font(.system(size: 16, weight: .semibold))

                    HStack(spacing: 8) {
                        Text(issue.state.capitalized)
                            .font(.system(size: 11, weight: .medium))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(stateColor(for: issue.state))
                            .foregroundStyle(.white)
                            .clipShape(Capsule())
                        if !issue.labels.isEmpty {
                            ForEach(issue.labels.prefix(3), id: \.self) { label in
                                Text(label)
                                    .font(.system(size: 10, weight: .medium))
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(Capsule().fill(Color.secondary.opacity(0.15)))
                            }
                        }
                    }

                    if let body = issue.body, !body.isEmpty {
                        Divider()
                        Text(body)
                            .font(.system(size: 13))
                            .foregroundStyle(.secondary)
                    }

                    Divider()
                    VStack(alignment: .leading, spacing: 6) {
                        if !issue.webUrl.isEmpty {
                            HStack(spacing: 6) {
                                Image(systemName: "link")
                                    .font(.system(size: 11))
                                    .foregroundStyle(.secondary)
                                Text(issue.webUrl)
                                    .font(.system(size: 11))
                                    .foregroundStyle(.blue)
                            }
                        }
                        HStack(spacing: 6) {
                            Image(systemName: "clock")
                                .font(.system(size: 11))
                                .foregroundStyle(.secondary)
                            Text(formatDate(issue.updatedAt))
                                .font(.system(size: 11))
                                .foregroundStyle(.secondary)
                        }
                        if issue.commentCount > 0 {
                            HStack(spacing: 6) {
                                Image(systemName: "bubble.left")
                                    .font(.system(size: 11))
                                    .foregroundStyle(.secondary)
                                Text("\(issue.commentCount) comment\(issue.commentCount == 1 ? "" : "s")")
                                    .font(.system(size: 11))
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }

                    Spacer()
                    Button("Done") {
                        dismiss()
                        onConfirm()
                    }
                    .buttonStyle(.borderedProminent)
                    .frame(maxWidth: .infinity)
                }
                .padding(20)
            } else if let error = error {
                VStack(spacing: 12) {
                    Text("Failed to load issue")
                        .font(.system(size: 14, weight: .semibold))
                    Text(error)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                    Button("Close") {
                        dismiss()
                        onConfirm()
                    }
                    .buttonStyle(.bordered)
                }
                .padding(20)
            }
        }
        .frame(width: 500, height: 400)
        .task {
            await loadIssue()
        }
    }

    private func loadIssue() async {
        isLoading = true
        defer { isLoading = false }

        let client: RepoBackend = providerKind == .gitlab
            ? RepoBackendFactory.guarded(GitLabClient(config: AppConfig.shared), config: AppConfig.shared)
            : RepoBackendFactory.guarded(GitHubClient(config: AppConfig.shared), config: AppConfig.shared)

        do {
            let filter = RepoIssueFilter(state: .all, search: "", labelName: "")
            let issues = try await client.listIssues(projectId: projectId, filter: filter, page: 1)
            if let found = issues.first(where: { $0.number == iid }) {
                issue = found
            } else {
                error = "Issue #\(iid) not found"
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func stateColor(for state: String) -> Color {
        switch state.lowercased() {
        case "opened": return .green
        case "closed": return .red
        default: return .secondary
        }
    }

    private func formatDate(_ date: String) -> String {
        let formatter = ISO8601DateFormatter()
        guard let d = formatter.date(from: date) else { return date }
        let relative = RelativeDateTimeFormatter()
        return relative.localizedString(for: d, relativeTo: Date())
    }
}

/// Sheet for updating an issue
struct UpdateIssueSheet: View {
    struct Args {
        var iid: Int
        var title: String?
        var body: String?
        var state: String?
        var labels: [String]?
    }

    enum ConfirmResult {
        case success(Int)
        case failure(String)
    }

    let initialArgs: Args
    let issueTitle: String?
    let projectId: String
    let providerKind: RepoBackendKind
    let isAllowed: Bool
    let onConfirm: (Args) async -> ConfirmResult

    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject var theme: ThemeStore
    @State private var title: String
    @State private var bodyText: String
    @State private var selectedState: String
    @State private var labelsText: String
    @State private var isRunning = false
    @State private var errorMessage: String?

    init(initialArgs: Args, issueTitle: String?, projectId: String, providerKind: RepoBackendKind, isAllowed: Bool, onConfirm: @escaping (Args) async -> ConfirmResult) {
        self.initialArgs = initialArgs
        self.issueTitle = issueTitle
        self.projectId = projectId
        self.providerKind = providerKind
        self.isAllowed = isAllowed
        self.onConfirm = onConfirm
        self._title = State(initialValue: initialArgs.title ?? "")
        self._bodyText = State(initialValue: initialArgs.body ?? "")
        self._selectedState = State(initialValue: initialArgs.state ?? "opened")
        self._labelsText = State(initialValue: (initialArgs.labels ?? []).joined(separator: ", "))
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Title")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                    TextField("Issue title", text: $title)
                        .textFieldStyle(.roundedBorder)
                        .disabled(!isAllowed || isRunning)
                }

                VStack(alignment: .leading, spacing: 4) {
                    Text("State")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                    Picker("State", selection: $selectedState) {
                        Text("Opened").tag("opened")
                        Text("Closed").tag("closed")
                    }
                    .pickerStyle(.segmented)
                    .disabled(!isAllowed || isRunning)
                }

                VStack(alignment: .leading, spacing: 4) {
                    Text("Labels")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                    TextField("bug, enhancement, priority (comma-separated)", text: $labelsText)
                        .textFieldStyle(.roundedBorder)
                        .disabled(!isAllowed || isRunning)
                }

                VStack(alignment: .leading, spacing: 4) {
                    Text("Description")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                    TextEditor(text: $bodyText)
                        .font(.system(size: 13))
                        .frame(height: 120)
                        .background(Color.secondary.opacity(0.05))
                        .cornerRadius(6)
                        .disabled(!isAllowed || isRunning)
                }

                if let error = errorMessage {
                    Text(error)
                        .font(.system(size: 11))
                        .foregroundStyle(.red)
                }

                Spacer()
                HStack(spacing: 12) {
                    Button("Cancel") { dismiss() }
                        .buttonStyle(.bordered)
                        .disabled(isRunning)

                    Button("Update Issue") { Task { await submit() } }
                        .buttonStyle(.borderedProminent)
                        .disabled(!isAllowed || isRunning || title.isEmpty)

                    if isRunning { ProgressView().scaleEffect(0.8) }
                }
            }
            .padding(20)
            .navigationTitle("Update Issue #\(initialArgs.iid)")
        }
        .frame(width: 500, height: 500)
    }

    private func submit() async {
        isRunning = true
        defer { isRunning = false }
        errorMessage = nil

        let labels = labelsText.isEmpty ? [] : labelsText.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }

        let args = Args(
            iid: initialArgs.iid,
            title: title.isEmpty ? nil : title,
            body: bodyText.isEmpty ? nil : bodyText,
            state: selectedState,
            labels: labels.isEmpty ? nil : labels
        )

        let result = await onConfirm(args)
        switch result {
        case .success: dismiss()
        case .failure(let message): errorMessage = message
        }
    }
}

/// Arguments for listing issues
struct ListIssuesSheetArgs {
    var search: String?
    var state: String?
    var label: String?
}

/// Sheet for listing/searching issues
struct ListIssuesSheet: View {
    let initialArgs: ListIssuesSheetArgs
    let projectId: String
    let providerKind: RepoBackendKind
    let onConfirm: () -> Void

    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject var theme: ThemeStore
    @State private var searchQuery = ""
    @State private var stateFilter: String?
    @State private var labelFilter = ""
    @State private var issues: [RepoIssue] = []
    @State private var isLoading = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                VStack(spacing: 12) {
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 13))
                            .foregroundStyle(.secondary)
                        TextField("Search issues", text: $searchQuery)
                            .textFieldStyle(.plain)
                            .onChange(of: searchQuery) { _, _ in Task { await loadIssues() } }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color.secondary.opacity(0.05))
                    .cornerRadius(8)

                    Picker("State", selection: Binding(
                        get: { stateFilter ?? "" },
                        set: { stateFilter = $0.isEmpty ? nil : $0 }
                    )) {
                        Text("All States").tag("")
                        Text("Opened").tag("opened")
                        Text("Closed").tag("closed")
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: stateFilter) { _, _ in Task { await loadIssues() } }

                    HStack(spacing: 8) {
                        Image(systemName: "tag")
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                        TextField("Filter by label", text: $labelFilter)
                            .textFieldStyle(.plain)
                            .onChange(of: labelFilter) { _, _ in Task { await loadIssues() } }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color.secondary.opacity(0.05))
                    .cornerRadius(8)
                }
                .padding(16)

                Divider()
                if isLoading {
                    ProgressView("Searching issues...")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let error = error {
                    VStack(spacing: 12) {
                        Text("Search failed")
                            .font(.system(size: 14, weight: .semibold))
                        Text(error)
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                        Button("Retry") { Task { await loadIssues() } }
                            .buttonStyle(.bordered)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if issues.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "tray")
                            .font(.system(size: 40))
                            .foregroundStyle(.secondary)
                        Text("No issues found")
                            .font(.system(size: 14))
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(issues) { issue in
                                IssueRow(issue: issue)
                                    .onTapGesture {
                                        let pasteboard = NSPasteboard.general
                                        pasteboard.clearContents()
                                        pasteboard.setString("#\(issue.number)", forType: .string)
                                    }
                            }
                        }
                    }
                }

                Divider()
                Button("Close") {
                    dismiss()
                    onConfirm()
                }
                .buttonStyle(.bordered)
                .padding(16)
            }
            .navigationTitle("Issues")
        }
        .frame(width: 600, height: 500)
        .task {
            searchQuery = initialArgs.search ?? ""
            stateFilter = initialArgs.state
            labelFilter = initialArgs.label ?? ""
            await loadIssues()
        }
    }

    private func loadIssues() async {
        isLoading = true
        defer { isLoading = false }

        let client: RepoBackend = providerKind == .gitlab
            ? RepoBackendFactory.guarded(GitLabClient(config: AppConfig.shared), config: AppConfig.shared)
            : RepoBackendFactory.guarded(GitHubClient(config: AppConfig.shared), config: AppConfig.shared)

        do {
            let filter = RepoIssueFilter(
                state: stateFilter == nil ? .all : (stateFilter == "opened" ? .opened : .closed),
                search: searchQuery,
                labelName: labelFilter.isEmpty ? "" : labelFilter
            )
            self.issues = try await client.listIssues(projectId: projectId, filter: filter, page: 1)
            self.error = nil
        } catch {
            self.error = error.localizedDescription
            self.issues = []
        }
    }

    struct IssueRow: View {
        let issue: RepoIssue

        var body: some View {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .top) {
                    Text("#\(issue.number)")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.blue)

                    Text(issue.title)
                        .font(.system(size: 13, weight: .medium))
                        .lineLimit(2)

                    Spacer()
                    Text(issue.state.capitalized)
                        .font(.system(size: 10, weight: .medium))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(stateColor(for: issue.state))
                        .foregroundStyle(.white)
                        .clipShape(Capsule())
                }

                HStack(spacing: 12) {
                    if !issue.labels.isEmpty {
                        Text(issue.labels.prefix(3).joined(separator: ", "))
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }

                    Spacer()
                    Text(formatDate(issue.updatedAt))
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)

                    if issue.commentCount > 0 {
                        HStack(spacing: 2) {
                            Image(systemName: "bubble.left")
                                .font(.system(size: 9))
                            Text("\(issue.commentCount)")
                                .font(.system(size: 10))
                        }
                        .foregroundStyle(.secondary)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(Color.secondary.opacity(0.03))
        }

        private func stateColor(for state: String) -> Color {
            switch state.lowercased() {
            case "opened": return .green
            case "closed": return .red
            default: return .secondary
            }
        }

        private func formatDate(_ date: String) -> String {
            let formatter = ISO8601DateFormatter()
            guard let d = formatter.date(from: date) else { return date }
            let relative = RelativeDateTimeFormatter()
            return relative.localizedString(for: d, relativeTo: Date())
        }
    }


}
