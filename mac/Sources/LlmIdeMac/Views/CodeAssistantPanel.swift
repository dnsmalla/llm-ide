import SwiftUI
import AppKit

/// Claude-Code-style chat panel embedded inside ReviewView.  The user
/// can attach files (NSOpenPanel) or whole folders (recursive walk
/// with an extension allow-list), then ask the LLM to review, refactor,
/// explain, or generate code.  Each round-trip POSTs to /code-assist
/// with the message + attachments + the last few turns of history.
///
/// Everything is in-memory.  Nothing is written to disk on the server
/// side — the assistant is purely advisory.  When the user wants the
/// model to actually CHANGE files, they take its suggestion to the
/// Plan tab's Generate Code flow (which is review-gated).
struct CodeAssistantPanel: View {
    let api: LlmIdeAPIClient
    /// When set, this file is attached automatically the first time the panel appears.
    var initialURL: URL? = nil
    /// Hide "+ Add files" / "+ Add folder" from the input bar (use when file is auto-attached).
    var showFileAttachButtons: Bool = true
    /// Show Cursor-style agent + model picker row in the input bar.
    var showModelPicker: Bool = false

    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @EnvironmentObject var projectStore: ProjectStore
    @Environment(LibraryItemStore.self) private var library

    @AppStorage("MEETNOTES_CURRENT_CHAT_SESSION_ID") private var currentSessionIDString: String = ""

    @State private var attachments: [LlmIdeAPIClient.CodeAttachment] = []
    @State private var history: [LlmIdeAPIClient.CodeAssistTurn] = []
    @State private var sessions: [ChatSession] = []
    @State private var showingSessionPicker: Bool = false
    @State private var draft: String = ""
    @State private var busy: Bool = false
    @State private var error: String?
    @State private var prefLanguage: String = "en"
    @State private var didAttachInitial = false
    /// Path of the file auto-attached from the tree selection (`initialURL`),
    /// so a later selection can swap just that one without nuking files the
    /// user attached manually.
    @State private var autoAttachedPath: String?
    /// Transient notice shown when a picked/selected file can't be attached
    /// (e.g. an image or binary). Prevents the silent drop on the Visual page.
    @State private var attachNotice: String?
    @State private var selectedModel: String = ""
    @State private var pendingTool: PendingTool?
    /// Snapshot of recent issues for the active project, refreshed on
    /// panel mount and every ~60s. Bundled into agentContext so the
    /// agent recognises references like "fix the colourful icons issue".
    @State private var recentIssues: [AgentContext.RecentIssue] = []
    @State private var showingIssueSheet: Bool = false
    @State private var showingCommentSheet: Bool = false
    @State private var showingReviewCodeSheet: Bool = false
    @State private var showingUpdateFileSheet: Bool = false
    @State private var reportingFault: FaultReportContext?
    @StateObject private var session = CodeAssistantSession()
    /// Captured at the moment the banner appears so Save uses the
    /// prompt+answer that triggered the threshold, not whatever the
    /// user types next.
    @State private var nudgePrompt: String?
    @State private var savingQA = false
    @State private var qaSaveError: String?

    /// Context passed to ReportFaultSheet — captured at the moment the
    /// user clicks "Report this" so the sheet sees the prompt + answer
    /// that were on screen, not a later edit.
    struct FaultReportContext: Identifiable {
        let id = UUID()
        let prompt: String
        let response: String
    }

    /// Extensions we'll walk into when the user picks a folder.  Keeps
    /// us out of node_modules / images / binaries.  The user can still
    /// pick individual files of any type — this is just the recursive
    /// folder filter.
    private static let walkableExtensions: Set<String> = [
        "ts", "tsx", "js", "jsx", "mjs", "cjs",
        "py", "rb", "go", "rs", "java", "kt", "swift",
        "c", "cc", "cpp", "h", "hpp", "m", "mm",
        "md", "mdx", "txt", "rst",
        "json", "yml", "yaml", "toml", "ini", "cfg",
        "sql", "sh", "bash", "html", "css", "scss",
        "vue", "svelte",
    ]
    private static let skipDirs: Set<String> = IgnoreList.directories

    /// Live-tracked rendered width of the panel. Drives the compact-mode
    /// switch so controls collapse gracefully when the user drags the
    /// divider in.
    @State private var panelWidth: CGFloat = 320
    private var isCompact: Bool { panelWidth < 240 }
    private var isVeryCompact: Bool { panelWidth < 180 }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().background(theme.current.border)
            chatScroll
            Divider().background(theme.current.border)
            if !attachments.isEmpty { attachmentBar }
            if let attachNotice { attachNoticeBar(attachNotice) }
            if let prompt = nudgePrompt, activeRepoRoot != nil {
                nudgeBanner(prompt: prompt)
            }
            inputBar
        }
        // Floor of 120pt matches the outer column min in ReviewView.
        // Compact-mode rendering kicks in below 240pt.
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
        .task { await refreshRecentIssuesLoop() }
        .onAppear {
            if selectedModel.isEmpty {
                selectedModel = config.defaultModelId.isEmpty
                    ? AICliTool.claudeCode.defaultModelId
                    : config.defaultModelId
            }
            // Migrate any legacy single-file chat history into a new
            // session. Idempotent — returns nil if the legacy file
            // doesn't exist (the common case after first launch).
            let migrated = ChatSessionStore.migrateLegacy()
            sessions = ChatSessionStore.listSessions()
            // Pick the active session: prefer the persisted id (must
            // still exist), then the just-migrated session, otherwise
            // mint a fresh one.
            if let cur = UUID(uuidString: currentSessionIDString),
               let session = sessions.first(where: { $0.id == cur }) {
                history = session.history
            } else if let mid = migrated, let session = sessions.first(where: { $0.id == mid }) {
                currentSessionIDString = mid.uuidString
                history = session.history
            } else {
                let fresh = ChatSession()
                ChatSessionStore.save(fresh)
                currentSessionIDString = fresh.id.uuidString
                sessions = ChatSessionStore.listSessions()
                history = []
            }
            if let url = initialURL, !didAttachInitial {
                didAttachInitial = true
                if addFile(url: url) == .added {
                    autoAttachedPath = displayPath(url)
                }
            }
        }
        .onChange(of: history) { oldValue, newValue in
            // Persist into the active session's JSON file. Auto-derive
            // the title from the first user turn if it's still the
            // placeholder. Bounded at the last 50 turns.
            persistCurrentSession(history: Array(newValue.suffix(50)))
            // VoiceOver live-region announcement: when a brand-new
            // assistant turn lands (history grew AND the last turn is
            // an assistant reply), post an `.announcementRequested`
            // notification so the user hears the response without
            // navigating. Throttled by count delta — we never fire on
            // intermediate stream chunks because the panel only appends
            // a single assistant turn at completion.
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
        .onChange(of: config.activeCLI) { _, _ in
            selectedModel = config.defaultModelId
        }
        .onChange(of: activeRepoKey) { _, _ in
            session.reset()
            nudgePrompt = nil
            qaSaveError = nil
            autoAttachedPath = nil
            attachNotice = nil
        }
        .onChange(of: initialURL) { _, newURL in
            // When the user selects a different file in the tree, swap ONLY
            // the previously auto-attached file — files the user attached
            // manually are preserved.
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
                // The Visual page selects images, which can't be sent as text.
                // Say so instead of silently ignoring the selection.
                attachNotice = "“\(url.lastPathComponent)” can’t be attached — images and binary files aren’t supported in chat yet."
            case .unreadable:
                attachNotice = "Couldn’t read “\(url.lastPathComponent)”."
            case .duplicate:
                break
            }
        }
        .sheet(isPresented: $showingIssueSheet) {
            if let pt = pendingTool,
               let args = pt.createIssueArgs,
               let proj = config.gitLabSavedProjects.first(where: { $0.isActive }) {
                CreateGitLabIssueSheet(
                    initialArgs: args,
                    projectName: proj.displayName.isEmpty ? "project" : proj.displayName,
                    projectURL: proj.url,
                    onConfirm: { editedArgs in
                        await confirmCreateIssue(editedArgs, project: proj)
                    }
                )
            } else {
                VStack(spacing: 12) {
                    Text("Active GitLab project unavailable.")
                        .font(.system(size: 13))
                    Text("Add or activate a project in Settings → GitLab.")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                    Button("Close") { showingIssueSheet = false }
                }
                .padding(20)
            }
        }
        .sheet(isPresented: $showingReviewCodeSheet, onDismiss: {
            // Clear the chat's pendingTool card once the user has
            // engaged with the Review Code workflow (confirm or cancel).
            // Otherwise the same "→ Review Code for #N" card stays
            // tappable and re-opens the workflow on a stale plan.
            pendingTool = nil
        }) {
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
        .sheet(isPresented: $showingUpdateFileSheet, onDismiss: {
            // Same pattern as Review Code — once the user has engaged
            // with the diff sheet (Apply or Cancel), drop the pending
            // card so it doesn't re-open with stale proposed content.
            pendingTool = nil
        }) {
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
        .sheet(isPresented: $showingCommentSheet) {
            if let pt = pendingTool,
               let args = pt.commentIssueArgs,
               let proj = config.gitLabSavedProjects.first(where: { $0.isActive }) {
                CommentGitLabIssueSheet(
                    initialArgs: args,
                    projectName: proj.displayName.isEmpty ? "project" : proj.displayName,
                    projectURL: proj.url,
                    issueTitle: recentIssues.first(where: { $0.iid == args.iid })?.title,
                    onConfirm: { editedArgs in
                        await confirmCommentIssue(editedArgs, project: proj)
                    }
                )
            } else {
                VStack(spacing: 12) {
                    Text("Active GitLab project unavailable.")
                        .font(.system(size: 13))
                    Text("Add or activate a project in Settings → GitLab.")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                    Button("Close") { showingCommentSheet = false }
                }
                .padding(20)
            }
        }
        .sheet(item: $reportingFault) { ctx in
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
            }
        }
    }

    // MARK: - Fault → Issue routing

    /// Resolves the currently-active issue tracker target — used by the
    /// "Also file as issue" toggle in ReportFaultSheet. Precedence matches
    /// `config.activeRepoLocalURL`: GitLab project first, then GitHub.
    /// Returns nil when nothing is configured or the active project is
    /// missing the bits we need (token, resolved ID).
    private func resolveIssueTarget() -> IssueTarget? {
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
    private func fileFaultAsIssue(_ fault: FaultReport, target: IssueTarget) async throws -> URL? {
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
            ? GitLabClient(config: config)
            : GitHubClient(config: config)
        let issue = try await client.createIssue(projectId: target.projectId, payload: payload)
        return URL(string: issue.webUrl)
    }

    /// Target descriptor returned by `resolveIssueTarget`.
    private struct IssueTarget {
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
                                    case "comment-gitlab-issue":
                                        showingCommentSheet = true
                                    case "trigger-review-code":
                                        showingReviewCodeSheet = true
                                    case "update-file":
                                        showingUpdateFileSheet = true
                                    default:
                                        showingIssueSheet = true
                                    }
                                }
                                .padding(.top, 4)
                            }
                        }
                        if busy {
                            HStack(spacing: 6) {
                                ProgressView().controlSize(.small)
                                Text("Thinking…")
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
    /// the input toolbar at the bottom already exposes "+ Add files" and
    /// "+ Add folder" as primary actions, so we don't duplicate them here.
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

    @ViewBuilder
    private func turnView(_ turn: LlmIdeAPIClient.CodeAssistTurn) -> some View {
        let isUser = turn.role == .user
        HStack(alignment: .top, spacing: Spacing.sm) {
            if isUser { Spacer(minLength: 40) }
            VStack(alignment: isUser ? .trailing : .leading, spacing: 4) {
                Text(isUser ? "You" : "Claude")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                Text(turn.content)
                    .font(.system(size: 12, design: turn.content.contains("```") ? .monospaced : .default))
                    .foregroundStyle(theme.current.text)
                    .textSelection(.enabled)
                    .frame(maxWidth: 720, alignment: isUser ? .trailing : .leading)
                    .padding(10)
                    .background(isUser
                                ? theme.current.accent.opacity(0.14)
                                : theme.current.surface)
                    .cornerRadius(8)
                    .fixedSize(horizontal: false, vertical: true)
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

    /// Active+cloned repo root for fault-report / Q&A writes. The
    /// "Report this" button is hidden when nil. Backed by the shared
    /// `AppConfig.activeRepoLocalURL` so RegressionView sees the
    /// same repo we do.
    private var activeRepoRoot: URL? { config.activeRepoLocalURL }

    /// Single identifier for "which repo is active right now". When
    /// it changes we wipe the session counters so a switch doesn't
    /// carry stale repeats across repos.
    private var activeRepoKey: String {
        if let p = config.gitLabSavedProjects.first(where: { $0.isActive }) { return "gl:\(p.id)" }
        if let r = config.gitHubSavedRepos.first(where: { $0.isActive }) { return "gh:\(r.id)" }
        return "none"
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
                    AttachmentChip(path: a.path, charCount: a.content.count) {
                        attachments.removeAll { $0.path == a.path }
                    }
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
            // Text area
            ZStack(alignment: .topLeading) {
                if draft.isEmpty {
                    Text(isCompact ? "Ask Claude…" : "Ask Claude about the attached code…")
                        .font(.system(size: 12))
                        .foregroundStyle(theme.current.textMuted.opacity(0.6))
                        .padding(.horizontal, 12)
                        .padding(.top, 10)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .allowsHitTesting(false)
                }
                TextEditor(text: $draft)
                    .font(.system(size: 12))
                    .scrollContentBackground(.hidden)
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
                contextButton(icon: "plus",   label: "Add files",  action: pickFiles)
                contextButton(icon: "folder", label: "Add folder", action: pickFolder)
                if !attachments.isEmpty {
                    Text("\(attachments.count) file\(attachments.count == 1 ? "" : "s") · \(formatBytes(totalAttachmentChars))")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(theme.current.textMuted)
                        .lineLimit(1)
                        .padding(.leading, 4)
                }
            }
            if showModelPicker { modelPickerChips }
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
                        contextButton(icon: "plus",   label: "Add files",  action: pickFiles)
                        contextButton(icon: "folder", label: "Add folder", action: pickFolder)
                    }
                    if showModelPicker { modelPickerChips }
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

    private var keyHint: some View {
        Text("⌘↵")
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(theme.current.textMuted.opacity(0.6))
            .fixedSize()
    }

    private var sendButton: some View {
        Button {
            Task { await send() }
        } label: {
            if busy {
                ProgressView().controlSize(.small).frame(width: 24, height: 24)
            } else {
                Image(systemName: "arrow.up")
                    .font(.system(size: 12, weight: .semibold))
                    .frame(width: 24, height: 24)
            }
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.small)
        .disabled(busy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        .keyboardShortcut(.return, modifiers: .command)
        .help("Send (⌘↵)")
        .accessibilityLabel(busy ? "Sending message" : "Send message")
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
            // Active CLI chip — icon-only when very compact, label
            // collapses to an icon button so the row never clips.
            Chip(
                icon: cli.icon,
                label: isCompact ? "" : cli.displayName,
                trailing: "chevron.down",
                compact: isCompact
            )
            .help(cli.displayName)

            // Model picker. Truncate label aggressively when compact so
            // the chip stays one capsule wide instead of wrapping.
            Menu {
                ForEach(cli.models) { model in
                    Button(model.displayName) { selectedModel = model.id }
                }
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
        cli.models.first(where: { $0.id == selectedModel })?.displayName
            ?? cli.models.first?.displayName
            ?? selectedModel
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
                Text(label)
                    .font(.system(size: 11))
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

    // MARK: - File pickers

    private func pickFiles() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = true
        panel.message = "Attach files for Claude to read"
        panel.prompt = "Attach"
        if panel.runModal() == .OK {
            attachNotice = nil
            var rejected: [String] = []
            for url in panel.urls {
                if addFile(url: url) == .notText { rejected.append(url.lastPathComponent) }
            }
            if !rejected.isEmpty {
                attachNotice = rejected.count == 1
                    ? "“\(rejected[0])” can’t be attached — images and binary files aren’t supported in chat yet."
                    : "\(rejected.count) files couldn’t be attached — images and binary files aren’t supported in chat yet."
            }
        }
    }

    private func pickFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.message = "Attach every text file under this folder"
        panel.prompt = "Attach folder"
        if panel.runModal() == .OK, let dir = panel.url {
            walkFolder(dir)
        }
    }

    enum AttachOutcome { case added, duplicate, notText, unreadable }

    /// Attaches a file's text content. Returns why it did or didn't so
    /// single-file callers can surface a notice instead of dropping
    /// silently (the bug behind the "Visual" page ignoring images).
    @discardableResult
    private func addFile(url: URL) -> AttachOutcome {
        let path = displayPath(url)
        // Idempotent — re-adding the same file does nothing.
        if attachments.contains(where: { $0.path == path }) { return .duplicate }
        do {
            let data = try Data(contentsOf: url)
            // Reject obviously-binary files (≥1% NUL bytes in the first 4K).
            let probe = data.prefix(4096)
            let nulCount = probe.reduce(into: 0) { acc, b in if b == 0 { acc += 1 } }
            if nulCount * 100 >= probe.count { return .notText }
            guard let text = String(data: data, encoding: .utf8) else { return .notText }
            attachments.append(.init(path: path, content: text))
            return .added
        } catch {
            return .unreadable
        }
    }

    private func walkFolder(_ root: URL) {
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(at: root,
                                             includingPropertiesForKeys: [.isRegularFileKey, .isDirectoryKey],
                                             options: [.skipsHiddenFiles])
        else { return }
        var added = 0
        let maxFiles = 50           // hard cap so a wrong-folder doesn't blow up the prompt
        while let url = enumerator.nextObject() as? URL {
            if added >= maxFiles { break }
            let name = url.lastPathComponent
            // Skip noisy dirs.
            if Self.skipDirs.contains(name) {
                enumerator.skipDescendants()
                continue
            }
            let ext = url.pathExtension.lowercased()
            guard !ext.isEmpty, Self.walkableExtensions.contains(ext) else { continue }
            let before = attachments.count
            addFile(url: url)
            if attachments.count > before { added += 1 }
        }
    }

    /// Replace the home prefix with `~/` for the chip label / prompt.
    /// Prevents the user's username leaking unnecessarily into LLM
    /// logs upstream.
    private func displayPath(_ url: URL) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let p = url.path
        if p.hasPrefix(home) { return "~" + p.dropFirst(home.count) }
        return p
    }

    // MARK: - Agent context

    /// Pure derivation: maps an active project (if any) to an
    /// AgentContext.Project. Extracted as a static fn so unit tests can
    /// exercise the conversion without instantiating a SwiftUI view.
    static func deriveActiveProject(from active: ProjectStore.ActiveProject?) -> AgentContext.Project? {
        guard let active, let linked = active.bundle.settings.linkedRepo else { return nil }
        return AgentContext.Project(
            name: active.bundle.displayName,
            url: linked.url,
            defaultBranch: linked.defaultBranch)
    }

    /// Builds the per-request snapshot of "what the agent should know":
    /// the active GitLab project and the user's indexed code repos.
    /// Recomputed every send so Settings changes are picked up live.
    private func buildAgentContext() -> AgentContext {
        // New: derive from the active workspace's linkedRepo. Falls
        // through to nil when no project is open (Welcome screen path)
        // or when the active project has no linked repo set. Existing
        // AgentContext.Project shape is preserved so the server-side
        // render-active-project skill renders identically.
        let activeProject = Self.deriveActiveProject(from: projectStore.activeProject)
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
        return AgentContext(
            activeProject: activeProject,
            indexedRepos: indexedRepos,
            recentIssues: recentIssues.isEmpty ? nil : recentIssues
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

    private func refreshRecentIssuesOnce() async {
        guard let project = config.gitLabSavedProjects.first(where: { $0.isActive }),
              let pid = project.resolvedId else {
            recentIssues = []
            return
        }
        let client = GitLabClient()
        do {
            // Open issues only: that's what the user actively references.
            // Closed issues clutter the prompt without much upside.
            let filter = IssueFilter(state: .opened)
            let issues = try await client.listIssues(projectId: pid, filter: filter, page: 1)
            // Cap at 15 so the prompt context doesn't blow up; pick the
            // most recently updated.
            let capped = Array(
                issues
                    .sorted { $0.updatedAt > $1.updatedAt }
                    .prefix(15)
            )
            recentIssues = capped.map { issue in
                let desc = issue.description ?? ""
                let snippet = desc.isEmpty ? nil : String(desc.prefix(160))
                return AgentContext.RecentIssue(
                    iid: issue.iid,
                    title: issue.title,
                    state: issue.state,
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
    private func send() async {
        // Defensive: callers (button, keyboard shortcut) already gate on
        // `busy`, but a programmatic invocation must not stack requests.
        guard !busy else { return }
        let msg = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !msg.isEmpty else { return }
        _ = session.record(prompt: msg)
        if session.shouldNudge(for: msg) {
            nudgePrompt = msg
        }
        // Append the user turn FIRST so the message appears immediately
        // even if the network call is slow.  Clear the draft on success
        // path; if the call errors, we leave history with the user turn
        // showing and surface an error bubble underneath.
        history.append(.init(role: .user, content: msg))
        draft = ""
        busy = true
        error = nil
        defer { busy = false }
        do {
            // Send the most recent ~8 turns as history — server caps too
            // but we'd rather not push a huge payload over the wire.
            let recent = history.count > 8 ? Array(history.suffix(8)) : history
            let agentContext = buildAgentContext()
            let resp = try await api.codeAssist(
                message: msg,
                language: prefLanguage,
                model: selectedModel.isEmpty ? nil : selectedModel,
                history: recent.dropLast(),     // exclude the just-pushed user turn — server appends it
                attachments: attachments,
                agentContext: agentContext,
            )
            history.append(.init(role: .assistant, content: resp.reply))
            self.pendingTool = resp.pendingTool
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Calls GitLab directly with the user's edited args. On success,
    /// appends a synthetic user turn so the agent can acknowledge in
    /// the next round, and re-POSTs /code-assist with "(continue)".
    @MainActor
    private func confirmCreateIssue(_ args: CreateGitLabIssueSheet.Args,
                                    project: SavedGitLabProject) async -> CreateGitLabIssueSheet.ConfirmResult {
        guard let pid = project.resolvedId else {
            return .failure("Project ID not resolved — re-resolve it in Settings → GitLab.")
        }
        let client = GitLabClient()
        do {
            let payload = GitLabIssuePayload(
                title: args.title,
                description: args.description.isEmpty ? nil : args.description,
                labels: args.labels.isEmpty ? nil : args.labels.joined(separator: ","),
                milestoneId: nil,
                assigneeIds: nil
            )
            let issue = try await client.createIssue(projectId: pid, payload: payload)
            // Clear the pending tool so the card disappears.
            self.pendingTool = nil
            // Synthetic acknowledgement turn — agent sees the result in history.
            let issueURL = project.url.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                + "/-/issues/\(issue.iid)"
            history.append(.init(
                role: .user,
                content: "(executed create-gitlab-issue → #\(issue.iid) \(issueURL))"
            ))
            // Re-invoke the agent so it can acknowledge in natural language.
            await sendFollowup()
            return .success(issue.iid)
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
    private func matchingAttachment(for proposedPath: String)
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
        if !canonBasename.isEmpty {
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
    private func confirmUpdateFile(_ args: PendingTool.UpdateFileArgs,
                                   finalContent: String)
        async -> UpdateFileSheet.ConfirmResult
    {
        guard let match = matchingAttachment(for: args.path) else {
            return .failure("That file isn't attached to this chat — refusing to write.")
        }
        let absolute = PathUtils.canonicalise(args.path)
        let url = URL(fileURLWithPath: absolute)
        do {
            try finalContent.write(to: url, atomically: true, encoding: .utf8)
        } catch {
            return .failure("Couldn't write \(absolute): \(error.localizedDescription)")
        }
        // Refresh the in-memory attachment so the next turn's prompt
        // contains the new content. We keep the original chip path
        // verbatim so the user's display stays stable.
        if let idx = attachments.firstIndex(where: { $0.path == match.path }) {
            attachments[idx] = .init(path: match.path, content: finalContent)
        }
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
        await sendFollowup()
        return .success
    }

    /// Calls GitLab directly to post a comment on the given issue.
    /// Mirrors `confirmCreateIssue`: pushes a synthetic ack turn so the
    /// agent can acknowledge in the next round.
    @MainActor
    private func confirmCommentIssue(_ args: CommentGitLabIssueSheet.Args,
                                     project: SavedGitLabProject) async -> CommentGitLabIssueSheet.ConfirmResult {
        guard let pid = project.resolvedId else {
            return .failure("Project ID not resolved — re-resolve it in Settings → GitLab.")
        }
        let client = GitLabClient()
        do {
            let note = try await client.createNote(projectId: pid, iid: args.iid, body: args.body)
            self.pendingTool = nil
            let issueURL = project.url.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                + "/-/issues/\(args.iid)"
            history.append(.init(
                role: .user,
                content: "(executed comment-gitlab-issue → note on #\(args.iid) \(issueURL))"
            ))
            await sendFollowup()
            return .success(note.id)
        } catch {
            return .failure(error.localizedDescription)
        }
    }

    private func sendFollowup() async {
        // Don't fire a second round-trip if one is already in flight.
        // Without this guard, rapid confirms or a manual ⌘↵ during
        // model streaming would stack overlapping /code-assist requests.
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let agentContext = buildAgentContext()
            let recent = history.count > 8 ? Array(history.suffix(8)) : history
            // The synthetic "(executed create-gitlab-issue …)" turn we
            // pushed before this call IS the signal the agent needs to
            // see. Keep it in `history`; pass "(continue)" as the user
            // message purely to pass the server's empty-message guard.
            let resp = try await api.codeAssist(
                message: "(continue)",
                language: prefLanguage,
                model: selectedModel.isEmpty ? nil : selectedModel,
                history: recent,
                attachments: [],
                agentContext: agentContext
            )
            history.append(.init(role: .assistant, content: resp.reply))
            self.pendingTool = resp.pendingTool
        } catch {
            self.error = error.localizedDescription
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
    private func createNewSession() {
        let fresh = ChatSession()
        ChatSessionStore.save(fresh)
        currentSessionIDString = fresh.id.uuidString
        sessions = ChatSessionStore.listSessions()
        history = []
        draft = ""
        attachments.removeAll()
        autoAttachedPath = nil
        attachNotice = nil
        pendingTool = nil
        error = nil
    }

    private func switchSession(to id: UUID) {
        guard id.uuidString != currentSessionIDString else { return }
        guard let session = ChatSessionStore.load(id: id) else { return }
        currentSessionIDString = id.uuidString
        history = session.history
        draft = ""
        attachments.removeAll()
        autoAttachedPath = nil
        attachNotice = nil
        pendingTool = nil
        error = nil
        // Bump lastUsedAt so this session moves to the top of the list.
        ChatSessionStore.save(session)
        sessions = ChatSessionStore.listSessions()
    }

    private func deleteSession(_ id: UUID) {
        ChatSessionStore.delete(id: id)
        sessions = ChatSessionStore.listSessions()
        if id.uuidString == currentSessionIDString {
            // Deleted the active session — fall back to most recent, or
            // mint a fresh one.
            if let next = sessions.first {
                currentSessionIDString = next.id.uuidString
                history = next.history
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
}
