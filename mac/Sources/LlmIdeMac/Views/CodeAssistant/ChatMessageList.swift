import SwiftUI

/// Chat transcript — scrollable history of turns, the typing indicator, the
/// pending-action confirmation card for the latest assistant turn, and the
/// error bubble. Extracted from `CodeAssistantPanel` as a child view: the
/// chat itself arrives as the `ChatEngine` that owns it, and everything the
/// PANEL still owns (draft, expanded turns, sheet flags, the pending-action
/// callbacks) is threaded in via bindings/closures — so this stays a pure
/// rendering of `engine.messages` plus the handful of transient flags that
/// affect it.
///
/// As of Task 9 it renders `[ChatMessage]`, not `[CodeAssistTurn]`: a tool
/// result is `role == .toolResult` with a typed `ToolResultPayload` (no more
/// `content.hasPrefix("(")` sniffing), a stopped reply is `status == .stopped`
/// (no more `"_(stopped)_"` suffix in the text), and tool steps / the reply
/// mode are read off the message instead of out of engine-side dictionaries.
struct ChatMessageList: View {
    /// The chat itself: `messages`, the busy/status line, the live-streaming
    /// cursor (`revealingTurnID`/`revealedCount`), the measured bubble heights
    /// this view writes back, and the error banner it can dismiss. A reference
    /// type (`@Observable`), so reading its properties in `body` tracks them
    /// without any Binding.
    let engine: ChatEngine
    let showModelPicker: Bool
    let pendingTool: PendingTool?
    /// Current multi-step task list — `CodeAssistantAgentState.agentPendingTasks`.
    let tasks: [AgentTask]
    /// Active plan execute session, if any (step-by-step progress + finish card).
    let planExecution: CodeAssistantAgentState.PlanExecutionTracker?
    let onReviewPlanExecution: () -> Void
    let onCommitPlanExecution: () -> Void
    let onDismissPlanExecution: () -> Void
    /// Precomputed diff stats for the current `update-file` pendingTool, if
    /// any — see CodeAssistantPanel.pendingUpdateFileDiff.
    let diffPreview: DiffStats?
    @Binding var draft: String
    @Binding var expandedTurns: Set<UUID>

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
    /// Wraps `CodeAssistantPanel.applyPendingEdit()` — writes the proposed file
    /// edit with no review step (the card's inline Apply).
    let onApplyEdit: () async -> Void
    /// Wraps `CodeAssistantPanel.skipPendingEdit()` — declines it and tells the
    /// agent so, so the loop isn't left holding an unanswered write.
    let onSkipEdit: () async -> Void
    /// Wraps `CodeAssistantPanel.autoSavePendingPlan()` — defensive fallback
    /// only; the normal path already resolves this in `autoChainPendingAction`
    /// before the card can render.
    let onSavePlan: () async -> Void
    /// Wraps `CodeAssistantPanel.savePlanFromMessage(_:)` — the "Save Plan"
    /// action on a v2 plan-like RESULT turn (no pendingTool: on the v2
    /// engine the plan IS the reply, so saving is a client-side action on
    /// that reply rather than a tool proposal the loop confirms).
    let onSavePlanFromMessage: (ChatMessage) -> Void
    /// Wraps `CodeAssistantPanel.executeSavedPlan(_:messageId:)` — the PlanSavedCard's
    /// "Execute plan" action (switch to Execute mode, attach the plan file).
    let onExecutePlan: (UUID, ChatMessage.ToolResultPayload) -> Void
    /// Wraps `CodeAssistantPanel.editSavedPlanInChat(_:messageId:)` — the card's "Edit
    /// in chat" action (stay in a plan-like mode, seed the composer with the
    /// card's own plan title).
    let onEditPlan: (UUID, ChatMessage.ToolResultPayload) -> Void

    @EnvironmentObject var theme: ThemeStore

    // MARK: - Chat scroll

    @ViewBuilder
    var body: some View {
        let history = engine.messages
        if history.isEmpty && !showModelPicker {
            emptyState
        } else if history.isEmpty {
            // Clean empty state when model picker is shown — no hero, just space
            Color.clear
        } else {
            // Computed once per render instead of once per turn — history.last(where:)
            // is an O(n) reverse scan, and turnView/isAssistantExpanded each used to
            // call the equivalent computed property independently, making the whole
            // list render O(n^2) instead of O(n).
            let lastAssistantTurnId = history.last(where: { $0.role == .assistant })?.id
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: Spacing.md) {
                        ForEach(history) { turn in
                            if let pe = planExecution,
                               pe.phase == .running,
                               turn.role == .assistant,
                               turn.id == lastAssistantTurnId {
                                PlanExecutionCard(
                                    tracker: pe,
                                    liveTasks: tasks,
                                    onReview: onReviewPlanExecution,
                                    onCommit: onCommitPlanExecution,
                                    onDismiss: onDismissPlanExecution
                                )
                                .padding(.bottom, 4)
                                .transition(.opacity)
                            } else if turn.role == .assistant,
                                      turn.id == lastAssistantTurnId,
                                      !tasks.isEmpty,
                                      planExecution == nil {
                                PlanTimelineCard(tasks: tasks)
                                    .padding(.bottom, 4)
                                    .transition(.opacity)
                            }
                            if turn.role == .assistant, !turn.toolSteps.isEmpty {
                                toolActivityView(turn.toolSteps)
                            }
                            turnView(turn, lastAssistantTurnId: lastAssistantTurnId)
                                .id(turn.id)
                                .transition(.opacity.combined(with: .scale(scale: 0.97, anchor: .bottom)))
                            if let pt = pendingTool,
                               turn.id == history.last?.id,
                               turn.role == .assistant {
                                PendingActionCard(
                                    pendingTool: pt,
                                    diffPreview: diffPreview,
                                    editActions: pt.kind == .updateFile
                                        ? .init(apply: onApplyEdit,
                                                skip: onSkipEdit,
                                                // No resolvable diff (or a
                                                // no-op one) means there is
                                                // nothing to apply — Review
                                                // still opens and explains why.
                                                canApply: (diffPreview?.added ?? 0) > 0
                                                       || (diffPreview?.removed ?? 0) > 0)
                                        : nil
                                ) {
                                    switch pt.kind {
                                    case .createIssue:
                                        sheets.showingIssueSheet = true
                                    case .commentIssue:
                                        sheets.showingCommentSheet = true
                                    case .getIssue:
                                        sheets.showingGetIssueSheet = true
                                    case .updateIssue:
                                        sheets.showingUpdateIssueSheet = true
                                    case .listIssues:
                                        sheets.showingListIssuesSheet = true
                                    case .createBranch:
                                        sheets.showingCreateBranchSheet = true
                                        Task { sheets.branchSheetContext = await loadBranchContext() }
                                    case .createPR:
                                        sheets.showingCreatePRSheet = true
                                    case .triggerReviewCode:
                                        sheets.showingReviewCodeSheet = true
                                    case .updateFile:
                                        sheets.showingUpdateFileSheet = true
                                    case .gitOp:
                                        if let g = pt.gitOpArgs, g.op.tier == .read {
                                            Task { await onGitOp(g) }
                                        } else {
                                            sheets.showingGitOpSheet = true
                                        }
                                    case .bash:
                                        Task { await onBash(pt.bashArgs) }
                                    case .savePlan:
                                        Task { await onSavePlan() }
                                    case nil:
                                        break
                                    }
                                }
                                .padding(.top, 4)
                                .transition(.opacity)
                            }
                            // A parked approval — placed like the
                            // pending-action card above (under the last
                            // assistant message), but driven purely off the
                            // engine's approval state: it appears MID-turn
                            // while the engine parks on an answer, and
                            // survives a failed submit so the action can
                            // retry. NOT gated on the turn's origin — the
                            // Mac panel owns the shared engine, so a
                            // phone-driven turn's approval renders here too.
                            // `kind` distinguishes the two P2 shapes: a
                            // "ToolApproval" (either engine's gated run-bash,
                            // Tasks 7-8) renders the deny/allow/always-allow
                            // card; anything else (only "AskUserQuestion"
                            // today, v2-only, P1) renders the existing
                            // question form — never both for one approval.
                            if let approvalState = engine.pendingApproval,
                               turn.id == history.last?.id,
                               turn.role == .assistant {
                                if approvalState.approval.kind == "ToolApproval" {
                                    ToolApprovalCard(
                                        state: approvalState,
                                        onDecide: { action in
                                            await engine.submitToolDecision(action: action)
                                        }
                                    )
                                    // Keyed by requestId: a second approval must
                                    // not inherit the previous card's @State.
                                    .id(approvalState.approval.requestId)
                                    .padding(.top, 4)
                                    .transition(.opacity)
                                } else {
                                    ApprovalQuestionCard(
                                        state: approvalState,
                                        onSubmit: { answers in
                                            await engine.submitApproval(answers: answers)
                                        },
                                        onDismiss: { engine.dismissApproval() }
                                    )
                                    // Keyed by requestId: a second approval must
                                    // not inherit the previous card's @State
                                    // selection.
                                    .id(approvalState.approval.requestId)
                                    .padding(.top, 4)
                                    .transition(.opacity)
                                }
                            }
                            // v2 plan-like RESULT turns: no save-plan
                            // pendingTool ever arrives (the plan IS the
                            // reply), so the one write action plan modes get
                            // is this message-level affordance on the LAST
                            // assistant message. Legacy engines never show
                            // it — their plan saves ride the pendingTool
                            // flow above.
                            if turn.role == .assistant,
                               turn.id == lastAssistantTurnId,
                               AgentV2Selection.showsSavePlanAction(
                                   mode: turn.metadata?.mode,
                                   v2Selected: engine.usesAgentV2Engine,
                                   hasPendingTool: pendingTool != nil,
                                   planSaved: turn.metadata?.planSaved == true) {
                                Button {
                                    onSavePlanFromMessage(turn)
                                } label: {
                                    Label("Save Plan", systemImage: "square.and.arrow.down")
                                        .font(Typography.caption)
                                }
                                .buttonStyle(.bordered)
                                .controlSize(.small)
                                .padding(.top, 4)
                                .help("Save this plan to llm-doc/plans/ in the open project")
                            }
                        }
                        if let pe = planExecution, pe.phase == .finished || pe.phase == .failed {
                            PlanExecutionCard(
                                tracker: pe,
                                liveTasks: tasks,
                                onReview: onReviewPlanExecution,
                                onCommit: onCommitPlanExecution,
                                onDismiss: onDismissPlanExecution
                            )
                            .padding(.top, 4)
                            .transition(.opacity)
                        }
                        if engine.busy {
                            HStack(spacing: 6) {
                                ProgressView().controlSize(.small)
                                Text(engine.statusText.isEmpty ? "Thinking…" : engine.statusText)
                                    .font(Typography.caption)
                                    .foregroundStyle(theme.current.textMuted)
                            }
                            .padding(.top, 4)
                            .id("typing-indicator")
                            .transition(.opacity)
                        }
                        if let err = engine.error {
                            errorBubble(err)
                                .transition(.opacity)
                        }
                        // Stale-server notice (v2 turn 404'd and the legacy
                        // engine completed it) — a condition, not a failure:
                        // warning-styled, dismissible, and cleared by the
                        // next turn's start.
                        if let notice = engine.agentV2Notice {
                            agentV2NoticeBubble(notice)
                                .transition(.opacity)
                        }
                    }
                    .padding(Spacing.md)
                    .animation(.easeOut(duration: 0.22), value: history.count)
                    .animation(.easeOut(duration: 0.2), value: pendingTool?.name)
                    .animation(.easeOut(duration: 0.2), value: engine.pendingApproval?.approval.requestId)
                    .animation(.easeOut(duration: 0.18), value: engine.busy)
                    .animation(.easeOut(duration: 0.2), value: engine.error)
                }
                .onChange(of: engine.messages.count) { _, _ in
                    if let last = engine.messages.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
                }
                .onChange(of: engine.busy) { _, b in
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

    /// An assistant turn renders in full iff it's the latest one or the user
    /// expanded it; otherwise it collapses to a preview.
    private func isAssistantExpanded(_ turn: ChatMessage, lastAssistantTurnId: UUID?) -> Bool {
        turn.id == lastAssistantTurnId || expandedTurns.contains(turn.id)
    }

    /// The text to actually render for an assistant turn: truncated to
    /// `revealedCount` while this turn is the one actively streaming (see
    /// `ChatEngine.appendStreamedChunk`), full content
    /// otherwise — including once streaming finishes, and always for
    /// history loaded from a saved session (which never sets
    /// `revealingTurnID` in the first place).
    private func displayedContent(for turn: ChatMessage) -> String {
        guard turn.id == engine.revealingTurnID else { return turn.content }
        return String(turn.content.prefix(engine.revealedCount))
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

    /// Tool-call acknowledgments (issue created, file updated, git op result,
    /// bash output, …) are their own role now — `.toolResult` — instead of
    /// `.user` turns the view had to recognise by their leading "(". The
    /// classification happens once, where the ack enters the transcript
    /// (`ChatEngine.appendTurn` → `ChatMessage.migrate`), so this view just
    /// reads the role, and an ack reloaded from a saved session is exactly as
    /// recognisable as one that just arrived live.
    private func toolNoticeIcon(_ payload: ChatMessage.ToolResultPayload)
        -> (name: String, color: Color)
    {
        if payload.isFailure {
            return ("exclamationmark.triangle.fill", theme.current.warning)
        }
        return ("checkmark.circle.fill", theme.current.success)
    }

    /// The steps the agent took before answering, as compact rows above the
    /// reply — the professional form of what used to be raw `<<<TOOL_CALL>>>`
    /// JSON streaming into the bubble. Read-only and non-interactive: it is a
    /// record of what happened, not a control.
    @ViewBuilder
    private func toolActivityView(_ steps: [ChatMessage.ToolStep]) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(steps) { step in
                HStack(spacing: 6) {
                    Image(systemName: step.icon)
                        .font(.system(size: 10))
                        .foregroundStyle(theme.current.textMuted)
                        .frame(width: 12, alignment: .center)
                    // The trailing "…" belongs to the live status line, not to a
                    // finished step — a completed action reads as "Read X", and
                    // leaving the ellipsis makes every past step look stuck.
                    Text(step.label.hasSuffix("…") ? String(step.label.dropLast()) : step.label)
                        .font(.system(size: 11))
                        .foregroundStyle(theme.current.textMuted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(.leading, 2)
        .padding(.bottom, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Steps taken: \(steps.map(\.label).joined(separator: ", "))")
    }

    @ViewBuilder
    private func toolNoticeView(_ payload: ChatMessage.ToolResultPayload) -> some View {
        let (icon, color) = toolNoticeIcon(payload)
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 10))
                .foregroundStyle(color)
            // `summary` IS the ack's first line, split off at classification
            // time — no runtime line-splitting needed here anymore.
            Text(payload.summary)
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
    private func turnView(_ turn: ChatMessage, lastAssistantTurnId: UUID?) -> some View {
        if turn.role == .toolResult, let payload = turn.toolResult {
            // Already typed — `CommandOutputView.init(message:)` reads
            // `turn.toolResult` directly; no string parsing happens at
            // render time (that lived in the now-deleted `BashResultDisplay
            // .parse`).
            if payload.kind == .bash {
                CommandOutputView(message: turn)
            } else if payload.kind == .plan {
                // A saved plan gets a full card (preview + Execute/Edit), not
                // a one-line capsule — the whole point of saving it is acting
                // on it. Centered like the other tool notices.
                PlanSavedCard(payload: payload,
                              actionTaken: turn.metadata?.planCardAction,
                              executingStepCount: planExecution?.planCardMessageId == turn.id
                                  ? planExecution?.steps.count : nil,
                              onExecute: { onExecutePlan(turn.id, payload) },
                              onEdit: { onEditPlan(turn.id, payload) })
                    .frame(maxWidth: .infinity, alignment: .center)
            } else {
                toolNoticeView(payload)
            }
        } else {
            let isUser = turn.role == .user
            HStack(alignment: .top, spacing: Spacing.sm) {
                if isUser { Spacer(minLength: 40) }
                VStack(alignment: isUser ? .trailing : .leading, spacing: 4) {
                    Text(isUser ? "You" : "llm-agent")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                    if !isUser, let raw = turn.metadata?.mode,
                       let mode = CodeAssistMode(rawValue: raw) {
                        ModeBadge(mode: mode)
                    }
                    if isUser {
                        // Plan-execute turns show a one-line summary, not the full prompt.
                        Text(turn.metadata?.planExecuteDisplay ?? turn.content)
                            .font(.system(size: 12))
                            .foregroundStyle(theme.current.text)
                            .textSelection(.enabled)
                            .frame(maxWidth: 720, alignment: .trailing)
                            .padding(10)
                            .background(theme.current.accent.opacity(0.14))
                            .cornerRadius(8)
                            .fixedSize(horizontal: false, vertical: true)
                    } else if isAssistantExpanded(turn, lastAssistantTurnId: lastAssistantTurnId) {
                        // Expanded assistant reply — full markdown render (web view).
                        VStack(alignment: .leading, spacing: 4) {
                            SelfSizingMarkdownView(
                                markdown: displayedContent(for: turn),
                                isDark: theme.current.isDark
                            ) { h in
                                if engine.bubbleHeights[turn.id] != h { engine.bubbleHeights[turn.id] = h }
                            }
                            .frame(maxWidth: 720, alignment: .leading)
                            .frame(height: max(engine.bubbleHeights[turn.id] ?? 24, 24))
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
                    // A stopped reply used to be marked by a literal
                    // "\n\n_(stopped)_" glued onto its text by the engine.
                    // The text is now left exactly as it streamed and the
                    // stop is a status, so the transcript says so itself.
                    if !isUser, turn.status == .stopped {
                        Text("Stopped")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                    }
                }
                if !isUser { Spacer(minLength: 40) }
            }
        }
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
                engine.error = nil
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

    /// `errorBubble`'s shape, warning-flavoured: the v2 stale-server notice
    /// says "this turn still completed (on the classic engine)", so the red
    /// failure treatment would misrepresent it.
    private func agentV2NoticeBubble(_ msg: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "arrow.triangle.2.circlepath")
                .foregroundStyle(theme.current.warning)
            Text(msg)
                .font(Typography.caption)
                .foregroundStyle(theme.current.warning)
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
            Button {
                engine.agentV2Notice = nil
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(theme.current.textMuted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss notice")
            .help("Dismiss notice")
        }
        .padding(10)
        .background(theme.current.warning.opacity(0.1))
        .cornerRadius(6)
    }
}
