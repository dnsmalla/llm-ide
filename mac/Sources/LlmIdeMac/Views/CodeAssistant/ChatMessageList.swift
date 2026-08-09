import SwiftUI

/// Chat transcript — scrollable history of turns, the typing indicator, the
/// pending-action confirmation card for the latest assistant turn, and the
/// error bubble. Extracted from `CodeAssistantPanel` as a child view; all
/// mutable state it touches is threaded in via bindings/closures so this
/// stays a pure rendering of `history` + the handful of transient flags
/// that affect it.
struct ChatMessageList: View {
    let history: [LlmIdeAPIClient.CodeAssistTurn]
    let showModelPicker: Bool
    let pendingTool: PendingTool?
    /// Current multi-step task list — `CodeAssistantAgentState.agentPendingTasks`,
    /// rendered as a live checklist above the latest assistant turn.
    let tasks: [AgentTask]
    /// Precomputed diff stats for the current `update-file` pendingTool, if
    /// any — see CodeAssistantPanel.pendingUpdateFileDiff.
    let diffPreview: DiffStats?
    /// See CodeAssistantPanel.turnModes / finishStreamingTurn.
    let turnModes: [UUID: CodeAssistMode]
    let busy: Bool
    let statusText: String
    @Binding var error: String?
    @Binding var draft: String
    @Binding var expandedTurns: Set<UUID>
    /// Live-streaming state — the turn currently receiving chunks, and how
    /// much of its content to show. See CodeAssistantPanel+Session's
    /// beginStreamingTurn/appendStreamedChunk/finishStreamingTurn.
    @Binding var revealingTurnID: UUID?
    @Binding var revealedCount: Int
    @Binding var bubbleHeights: [UUID: CGFloat]
    /// Resolved project root — governs whether "Report this" is shown.
    let activeRepoRoot: URL?

    /// Sheet presentation flags + branch/fault context, shared by reference
    /// with CodeAssistantPanel (an @Observable class, so mutations here are
    /// seen by the parent without a Binding).
    let sheets: CodeAssistantSheetState

    /// Wraps `CodeAssistantPanel.buildAgentContext()` — needed by the
    /// "create-branch" pending action to show the current branch.
    let loadBranchContext: () async -> AgentContext
    /// Wraps `CodeAssistantPanel.runGitOpFlow(_:)`.
    let onGitOp: (GitOpArgs) async -> Void
    /// Wraps `CodeAssistantPanel.runBashCommand(_:)`.
    let onBash: (BashArgs?) async -> Void

    @EnvironmentObject var theme: ThemeStore

    // MARK: - Chat scroll

    @ViewBuilder
    var body: some View {
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
                            if turn.role == .assistant, turn.id == lastAssistantTurnId, !tasks.isEmpty {
                                PlanTimelineCard(tasks: tasks)
                                    .padding(.bottom, 4)
                                    .transition(.opacity)
                            }
                            turnView(turn)
                                .id(turn.id)
                                .transition(.opacity.combined(with: .scale(scale: 0.97, anchor: .bottom)))
                            if let pt = pendingTool,
                               turn.id == history.last?.id,
                               turn.role == .assistant {
                                PendingActionCard(pendingTool: pt, diffPreview: diffPreview) {
                                    switch pt.name {
                                    case "create-gitlab-issue", "create-issue":
                                        sheets.showingIssueSheet = true
                                    case "comment-gitlab-issue", "comment-issue":
                                        sheets.showingCommentSheet = true
                                    case "get-issue":
                                        sheets.showingGetIssueSheet = true
                                    case "update-issue":
                                        sheets.showingUpdateIssueSheet = true
                                    case "list-issues":
                                        sheets.showingListIssuesSheet = true
                                    case "create-branch":
                                        sheets.showingCreateBranchSheet = true
                                        Task { sheets.branchSheetContext = await loadBranchContext() }
                                    case "create-gitlab-mr", "create-pr":
                                        sheets.showingCreatePRSheet = true
                                    case "trigger-review-code":
                                        sheets.showingReviewCodeSheet = true
                                    case "update-file":
                                        sheets.showingUpdateFileSheet = true
                                    case "git-op":
                                        if let g = pt.gitOpArgs, g.op.tier == .read {
                                            Task { await onGitOp(g) }
                                        } else {
                                            sheets.showingGitOpSheet = true
                                        }
                                    case "bash":
                                        Task { await onBash(pt.bashArgs) }
                                    default:
                                        break
                                    }
                                }
                                .padding(.top, 4)
                                .transition(.opacity)
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
                            .transition(.opacity)
                        }
                        if let err = error {
                            errorBubble(err)
                                .transition(.opacity)
                        }
                    }
                    .padding(Spacing.md)
                    .animation(.easeOut(duration: 0.22), value: history.count)
                    .animation(.easeOut(duration: 0.2), value: pendingTool?.name)
                    .animation(.easeOut(duration: 0.18), value: busy)
                    .animation(.easeOut(duration: 0.2), value: error)
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

    /// The text to actually render for an assistant turn: truncated to
    /// `revealedCount` while this turn is the one actively streaming (see
    /// CodeAssistantPanel+Session's appendStreamedChunk), full content
    /// otherwise — including once streaming finishes, and always for
    /// history loaded from a saved session (which never sets
    /// `revealingTurnID` in the first place).
    private func displayedContent(for turn: LlmIdeAPIClient.CodeAssistTurn) -> String {
        guard turn.id == revealingTurnID else { return turn.content }
        return String(turn.content.prefix(revealedCount))
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

    /// Tool-call acknowledgments (issue created, file updated, git op
    /// result, bash output, …) are appended as role: .user turns — the
    /// agent needs to see them as real conversation context, and the wire
    /// format the server round-trips only distinguishes user/assistant, so
    /// changing that isn't worth the risk for a display-only concern. Every
    /// one of them already starts with "(" — a convention that predates
    /// this check (see CodeAssistant+Issues/PR/Git/Bash.swift and
    /// CodeAssistantPanel+Session.swift) — so detecting it by content works
    /// correctly whether the turn just arrived live or was reloaded from a
    /// saved session, unlike an id-keyed flag (CodeAssistTurn's decoder
    /// mints a fresh id on every decode, so an id-based tag can't survive
    /// a session switch or relaunch).
    private func isToolNotice(_ turn: LlmIdeAPIClient.CodeAssistTurn) -> Bool {
        turn.role == .user && turn.content.hasPrefix("(")
    }

    private func toolNoticeIcon(_ content: String) -> (name: String, color: Color) {
        if content.contains("failed") || content.contains("skipped") {
            return ("exclamationmark.triangle.fill", theme.current.warning)
        }
        return ("checkmark.circle.fill", theme.current.success)
    }

    @ViewBuilder
    private func toolNoticeView(_ turn: LlmIdeAPIClient.CodeAssistTurn) -> some View {
        let (icon, color) = toolNoticeIcon(turn.content)
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 10))
                .foregroundStyle(color)
            Text(turn.content.split(separator: "\n", maxSplits: 1).first.map(String.init) ?? turn.content)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(theme.current.textMuted)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(theme.current.surface2)
        .clipShape(Capsule())
        .frame(maxWidth: .infinity, alignment: .center)
    }

    @ViewBuilder
    private func turnView(_ turn: LlmIdeAPIClient.CodeAssistTurn) -> some View {
        if isToolNotice(turn) {
            if let bash = BashResultDisplay.parse(turn.content) {
                CommandOutputView(display: bash)
            } else {
                toolNoticeView(turn)
            }
        } else {
            let isUser = turn.role == .user
            HStack(alignment: .top, spacing: Spacing.sm) {
                if isUser { Spacer(minLength: 40) }
                VStack(alignment: isUser ? .trailing : .leading, spacing: 4) {
                    Text(isUser ? "You" : "Claude")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                    if !isUser, let mode = turnModes[turn.id] {
                        ModeBadge(mode: mode)
                    }
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
                                markdown: displayedContent(for: turn),
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
                            sheets.reportingFault = CodeAssistantPanel.FaultReportContext(
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
    }

    /// Walk backwards from `turn`'s position in `history` and return the
    /// most recent user message. Falls back to nil when the assistant
    /// answered without a preceding user turn (rare; agent self-prompts).
    private func prevUserPrompt(before turn: LlmIdeAPIClient.CodeAssistTurn) -> String? {
        guard let idx = history.firstIndex(where: { $0.id == turn.id }) else { return nil }
        for i in stride(from: idx - 1, through: 0, by: -1) {
            let candidate = history[i]
            // Skip tool-notices (role: .user but synthetic, see isToolNotice) —
            // a fault report should quote what the human actually typed, not
            // a "(executed create-issue → ...)" acknowledgment that happened
            // to be the nearest .user-role turn.
            if candidate.role == .user && !isToolNotice(candidate) { return candidate.content }
        }
        return nil
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
}
