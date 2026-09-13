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
    /// Wraps `CodeAssistantPanel.pushPlanExecutionChanges()` — merge to the
    /// default branch and push. The card confirms before calling it.
    let onPushPlanExecution: () -> Void
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
    /// Wraps `CodeAssistantPanel.beginPlanEdit(from:)` — opens the plan in the
    /// preview sheet (rendered, with a Markdown toggle for hand-editing)
    /// instead of saving the agent's text unread.
    let onPreviewPlanFromMessage: (ChatMessage) -> Void
    /// Wraps `CodeAssistantPanel.refinePlanInChat(from:)` — stays in a
    /// plan-like mode and seeds the composer with a revision instruction.
    let onRefinePlanFromMessage: (ChatMessage) -> Void
    /// Wraps `CodeAssistantPanel.executeSavedPlan(_:messageId:)` — the PlanSavedCard's
    /// "Execute plan" action (switch to Execute mode, attach the plan file).
    let onExecutePlan: (UUID, ChatMessage.ToolResultPayload) -> Void
    /// Wraps `CodeAssistantPanel.editSavedPlanInChat(_:messageId:)` — the card's "Edit
    /// in chat" action (stay in a plan-like mode, seed the composer with the
    /// card's own plan title).
    let onEditPlan: (UUID, ChatMessage.ToolResultPayload) -> Void

    @EnvironmentObject var theme: ThemeStore

    // MARK: - Chat scroll

    /// Whether the transcript should keep itself pinned to the newest text.
    ///
    /// True while the bottom of the list is on screen; the anchor row at the
    /// end of the stack flips it as it scrolls in and out of the `LazyVStack`'s
    /// realized range. That's what lets streaming follow the reply without
    /// yanking the view back down when the user has deliberately scrolled up
    /// to re-read something mid-turn.
    @State private var isPinnedToBottom = true

    /// Scroll target for "the very bottom", past the typing indicator and any
    /// error/notice bubbles — scrolling to the last MESSAGE would stop short
    /// of them.
    private static let bottomAnchorID = "chat-bottom-anchor"

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
            // Has this chat ever run a plan-like turn? The session half of
            // the plan-row visibility rule — see
            // `AgentV2Selection.showsSavePlanAction`. Computed once per render
            // alongside `lastAssistantTurnId` for the same reason: it is an
            // O(n) scan, and reading it inside the per-turn ForEach would make
            // the list render O(n^2).
            let sessionIsPlanning = AgentV2Selection.sessionIsPlanning(
                modes: history.map { $0.metadata?.mode })
            // Does this chat already have its plan file? Once it does, a
            // plan-shaped reply OUTSIDE a plan mode is execution narration,
            // not a plan — see showsSavePlanAction.
            let sessionHasSavedPlan = history.contains {
                $0.role == .toolResult && $0.toolResult?.kind == .plan && $0.toolResult?.isFailure == false
            }
            // Which replies ARE the plan document (collapse them) and which
            // saved-plan card holds a written plan rather than a design
            // (drop its "Write full plan" button). One ordered pass, computed
            // here for the same reason as the two flags above — reading it
            // per turn inside the ForEach would make the list O(n^2).
            let planMarks = PlanTranscriptPolicy.mark(history.map(Self.policyTurn))
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: Spacing.md) {
                        ForEach(history) { turn in
                            planCards(for: turn, lastAssistantTurnId: lastAssistantTurnId)
                            if turn.role == .assistant, !turn.toolSteps.isEmpty {
                                toolActivityView(turn.toolSteps)
                            }
                            turnView(turn, lastAssistantTurnId: lastAssistantTurnId, marks: planMarks)
                                .id(turn.id)
                                .transition(.opacity.combined(with: .scale(scale: 0.97, anchor: .bottom)))
                            pendingActionCardIfAny(for: turn, isLastTurn: turn.id == history.last?.id)
                            // A parked approval — placed like the
                            // pending-action card above (under the last
                            // assistant message), but driven purely off the
                            // engine's approval state: it appears MID-turn
                            // while the engine parks on an answer, and
                            // survives a failed submit so the action can
                            // retry. NOT gated on the turn's origin — the
                            // Mac panel owns the shared engine, so a
                            // phone-driven turn's approval renders here too.
                            // The `kind` dispatch itself lives in
                            // `ApprovalCardSlot`, shared with the menu bar and
                            // the quick-chat sheet. Only the GATE below is this
                            // surface's own: it renders inside a per-turn
                            // ForEach, so it must pick the last assistant turn.
                            if let approvalState = engine.pendingApproval,
                               turn.id == history.last?.id,
                               turn.role == .assistant {
                                ApprovalCardSlot(
                                    state: approvalState,
                                    onToolDecision: { action in
                                        await engine.submitToolDecision(action: action)
                                    },
                                    onSubmitAnswers: { answers in
                                        await engine.submitApproval(answers: answers)
                                    },
                                    onDismiss: { engine.dismissApproval() },
                                    transition: .opacity
                                )
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
                                   planSaved: turn.metadata?.planSaved == true,
                                   sessionIsPlanning: sessionIsPlanning,
                                   contentLooksLikePlan: PlanEditPolicy.looksLikePlan(
                                       content: turn.content),
                                   sessionHasSavedPlan: sessionHasSavedPlan) {
                                HStack(spacing: 8) {
                                    Button {
                                        onSavePlanFromMessage(turn)
                                    } label: {
                                        Label("Save Plan", systemImage: "square.and.arrow.down")
                                            .font(Typography.caption)
                                    }
                                    .buttonStyle(.bordered)
                                    .controlSize(.small)
                                    .help("Save this plan to llm-doc/plans/ in the open project")
                                    // Preview = read the plan as a rendered
                                    // document (and fix it by hand there, via
                                    // the sheet's Markdown toggle); Refine =
                                    // ask the agent for another revision. Both
                                    // were previously reachable only AFTER
                                    // saving (the PlanSavedCard), which forced
                                    // a wrong plan onto disk first.
                                    Button {
                                        onPreviewPlanFromMessage(turn)
                                    } label: {
                                        Label("Preview", systemImage: "doc.richtext")
                                            .font(Typography.caption)
                                    }
                                    .buttonStyle(.bordered)
                                    .controlSize(.small)
                                    .help("Read this plan as a document, edit it, then save it")
                                    Button {
                                        onRefinePlanFromMessage(turn)
                                    } label: {
                                        Label("Edit in chat", systemImage: "pencil")
                                            .font(Typography.caption)
                                    }
                                    .buttonStyle(.bordered)
                                    .controlSize(.small)
                                    .help("Keep refining this plan in this chat")
                                }
                                .padding(.top, 4)
                            }
                        }
                        if let pe = planExecution, pe.phase == .finished || pe.phase == .failed {
                            PlanExecutionCard(
                                tracker: pe,
                                liveTasks: tasks,
                                // The run is over; there is no live activity
                                // to narrate under the finish card.
                                statusLine: nil,
                                onReview: onReviewPlanExecution,
                                onPush: onPushPlanExecution,
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
                        // Bottom sentinel. A zero-height row the LazyVStack
                        // realizes when the end of the list comes into range
                        // and releases when it scrolls away — which is
                        // exactly the "is the user still at the bottom?"
                        // signal the follow-the-stream behaviour needs, at no
                        // layout or measurement cost.
                        Color.clear
                            .frame(height: 1)
                            .id(Self.bottomAnchorID)
                            .onAppear { isPinnedToBottom = true }
                            .onDisappear { isPinnedToBottom = false }
                            .accessibilityHidden(true)
                    }
                    .padding(Spacing.md)
                    .animation(.easeOut(duration: 0.22), value: history.count)
                    .animation(.easeOut(duration: 0.2), value: pendingTool?.name)
                    .animation(.easeOut(duration: 0.2), value: engine.pendingApproval?.approval.requestId)
                    .animation(.easeOut(duration: 0.18), value: engine.busy)
                    .animation(.easeOut(duration: 0.2), value: engine.error)
                }
                // A new message is an explicit act (the user sent something,
                // or a reply landed), so it always re-pins and scrolls —
                // matching the behaviour this view has always had.
                .onChange(of: engine.messages.count) { _, _ in
                    isPinnedToBottom = true
                    withAnimation { proxy.scrollTo(Self.bottomAnchorID, anchor: .bottom) }
                }
                // Follow the reply as it streams. Without this the transcript
                // only scrolled when the message COUNT changed, so a long
                // answer grew downward past the bottom of the window and the
                // user had to chase it by hand. Driven off `revealedCount`
                // (the engine's streamed-character counter), which the chunk
                // coalescer moves ~20 times a second rather than per token.
                .onChange(of: engine.revealedCount) { _, _ in
                    guard isPinnedToBottom else { return }
                    proxy.scrollTo(Self.bottomAnchorID, anchor: .bottom)
                }
                // The end of a streaming turn. `revealedCount` can't cover
                // this: the final `resp.reply` overwrite replaces the turn's
                // content without going through the chunk path at all, and on
                // the buffered-fallback route (no chunk events ever arrived)
                // the whole reply appears in one go with `revealedCount` still
                // at zero. Neither moves the counter, and the message count
                // doesn't change either, so without this the finished answer
                // could land entirely below the fold.
                .onChange(of: engine.revealingTurnID) { old, new in
                    guard old != nil, new == nil, isPinnedToBottom else { return }
                    withAnimation { proxy.scrollTo(Self.bottomAnchorID, anchor: .bottom) }
                }
                .onChange(of: engine.busy) { _, b in
                    if b { withAnimation { proxy.scrollTo("typing-indicator", anchor: .bottom) } }
                }
                // "Jump to latest" — only while there is live text to miss,
                // and only once the user has actually scrolled away from it.
                // Tapping re-pins, so streaming resumes following.
                .overlay(alignment: .bottom) {
                    if !isPinnedToBottom, engine.busy {
                        jumpToLatestButton {
                            isPinnedToBottom = true
                            withAnimation { proxy.scrollTo(Self.bottomAnchorID, anchor: .bottom) }
                        }
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                    }
                }
                .animation(.easeOut(duration: 0.18), value: isPinnedToBottom)
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Chat transcript")
        }
    }

    /// Floating pill offering to re-pin the transcript to the streaming reply.
    private func jumpToLatestButton(_ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: "arrow.down")
                    .font(.system(size: 10, weight: .semibold))
                Text("Jump to latest")
                    .font(.system(size: 11, weight: .medium))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.regularMaterial, in: Capsule())
            .overlay(Capsule().strokeBorder(theme.current.border, lineWidth: 1))
            .foregroundStyle(theme.current.text)
            .shadow(color: .black.opacity(0.16), radius: 6, y: 2)
        }
        .buttonStyle(.plain)
        .padding(.bottom, Spacing.md)
        .help("Follow the reply as it streams")
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

    /// The text to actually render for an assistant turn — always the full
    /// content.
    ///
    /// This used to truncate a streaming turn to `engine.revealedCount`, a
    /// leftover from the fixed-schedule reveal that real chunk streaming
    /// replaced: `revealedCount` IS the streamed length, so the prefix was
    /// always the whole string. It wasn't free, though — `String.prefix` is
    /// O(n) in grapheme clusters and ran on every render of a growing reply.
    private func displayedContent(for turn: ChatMessage) -> String {
        turn.content
    }

    /// A short plain-text preview of a markdown reply for the collapsed state —
    /// strips common markdown so the bubble reads cleanly without a web view.
    /// The implementation moved to `MarkdownRenderer` when the LLM Chat sheet
    /// needed the same thing; this stays as the local name the view reads with.
    private func markdownPreview(_ content: String) -> String {
        MarkdownRenderer.plainTextPreview(content)
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

    /// The confirmation card for a proposed tool action, under the last
    /// assistant turn. Extracted from `body` for the same reason as
    /// `planCards`: its `onOpen` closure is a twelve-arm switch, and inline
    /// it pushed the transcript body past what the type-checker will solve.
    @ViewBuilder
    private func pendingActionCardIfAny(for turn: ChatMessage, isLastTurn: Bool) -> some View {
            if let pt = pendingTool, isLastTurn, turn.role == .assistant {
                PendingActionCard(
                    pendingTool: pt,
                    diffPreview: diffPreview,
                    onOpen: {
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
                    },
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
                )
                .padding(.top, 4)
                .transition(.opacity)
            }
    }

    /// The plan cards that ride above the LAST assistant turn: the live
    /// execution card during a plan run, otherwise the task timeline. Both
    /// were written inline in `body` until the type-checker gave up on it
    /// ("unable to type-check this expression in reasonable time") — that
    /// body is one large ForEach with several nested branches, so anything
    /// with its own argument list belongs out here.
    @ViewBuilder
    private func planCards(for turn: ChatMessage, lastAssistantTurnId: UUID?) -> some View {
        if let pe = planExecution,
           pe.phase == .running,
           turn.role == .assistant,
           turn.id == lastAssistantTurnId {
            PlanExecutionCard(
                tracker: pe,
                liveTasks: tasks,
                statusLine: planExecutionStatusLine,
                onReview: onReviewPlanExecution,
                onPush: onPushPlanExecution,
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
    }

    /// The engine's live activity line for `PlanExecutionCard`, hoisted out
    /// of the transcript body: that body is already at the type-checker's
    /// limit, and a ternary inline in the call site tipped it over ("unable
    /// to type-check this expression in reasonable time").
    private var planExecutionStatusLine: String? {
        engine.busy ? engine.statusText : nil
    }

    /// The steps the agent took before answering. The rendering (including
    /// the >5-step scroller) lives in `ToolActivityList`.
    @ViewBuilder
    private func toolActivityView(_ steps: [ChatMessage.ToolStep]) -> some View {
        ToolActivityList(steps: steps)
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

    /// Full-bubble treatment for a reply that failed with no text: the reason
    /// the engine recorded, plus Retry when the turn is re-sendable.
    private func failedTurnView(_ turn: ChatMessage) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 11))
                    .foregroundStyle(theme.current.danger)
                Text(turn.metadata?.failedError ?? "The assistant couldn't answer.")
                    .font(.system(size: 12))
                    .foregroundStyle(theme.current.text)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            retryButton(turn)
        }
        .frame(maxWidth: 720, alignment: .leading)
        .padding(10)
        .background(theme.current.danger.opacity(0.08))
        .overlay(RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(theme.current.danger.opacity(0.35), lineWidth: 1))
        .cornerRadius(8)
    }

    /// Compact version of the above, for a turn that streamed partial text
    /// before failing — the text is already rendered, so this only has to
    /// explain and offer the retry.
    private func failedTurnFooter(_ turn: ChatMessage) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 10))
                .foregroundStyle(theme.current.danger)
            Text(turn.metadata?.failedError ?? "Interrupted")
                .font(Typography.caption)
                .foregroundStyle(theme.current.textMuted)
                .lineLimit(2)
            retryButton(turn)
        }
    }

    @ViewBuilder
    private func retryButton(_ turn: ChatMessage) -> some View {
        // Hidden rather than disabled when the turn isn't re-sendable (a
        // failed follow-up has no user prompt of its own) — a permanently
        // greyed-out button reads as a bug.
        if engine.canRetryFailedTurn(turn.id) {
            Button { engine.retryFailedTurn(turn.id) } label: {
                Label("Retry", systemImage: "arrow.clockwise")
                    .font(Typography.caption)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(engine.busy)
            .help("Send this message again")
        }
    }

    /// What a USER turn shows in the transcript: a plan-pipeline turn's
    /// one-line summary if it has one, otherwise the message itself. The
    /// canned prompts those turns carry run to several paragraphs and are
    /// written for the model, not for the person reading the chat.
    ///
    /// Hoisted out of the view body deliberately: inline, the `??` chain put
    /// that expression past the type-checker's budget ("unable to type-check
    /// in reasonable time"), and every label added would push it further.
    private static func userTurnLabel(_ turn: ChatMessage) -> String {
        guard let meta = turn.metadata else { return turn.content }
        return meta.planExecuteDisplay
            ?? meta.planWriteDisplay
            ?? meta.planReviewDisplay
            ?? turn.content
    }

    /// `ChatMessage` → the minimal shape `PlanTranscriptPolicy` reads. A
    /// failed `save-plan` is deliberately `.other`: no card renders for it,
    /// so it must not consume the write-in-progress marker either.
    private static func policyTurn(_ m: ChatMessage) -> PlanTranscriptPolicy.Turn {
        let kind: PlanTranscriptPolicy.Turn.Kind
        switch m.role {
        case .user: kind = .user
        case .assistant: kind = .assistant
        case .toolResult:
            kind = (m.toolResult?.kind == .plan && m.toolResult?.isFailure == false)
                ? .planResult : .other
        }
        return .init(id: m.id, kind: kind,
                     isPlanWriteRequest: m.metadata?.planWriteDisplay != nil,
                     isSavedPlanSource: m.metadata?.planSaved == true)
    }

    @ViewBuilder
    private func turnView(_ turn: ChatMessage, lastAssistantTurnId: UUID?,
                          marks: PlanTranscriptPolicy.Marks) -> some View {
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
                              stage: marks.writtenPlanCards.contains(turn.id) ? .written : .design,
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
                        // Plan-pipeline turns (execute / write / review) show a
                        // one-line summary, not the canned multi-paragraph
                        // prompt the button actually sent.
                        Text(Self.userTurnLabel(turn))
                            .font(.system(size: 12))
                            .foregroundStyle(theme.current.text)
                            .textSelection(.enabled)
                            .frame(maxWidth: 720, alignment: .trailing)
                            .padding(10)
                            .background(theme.current.accent.opacity(0.14))
                            .cornerRadius(8)
                            .fixedSize(horizontal: false, vertical: true)
                    } else if turn.content.isEmpty, turn.status == .failed {
                        // A round-trip that failed before any text arrived.
                        // This used to fall through to the markdown branch
                        // below and render an EMPTY web-view bubble — the
                        // reason was written to `metadata.failedError` and
                        // never shown, and there was no way to re-send short
                        // of retyping the prompt.
                        failedTurnView(turn)
                    } else if turn.content.isEmpty {
                        // Nothing to render yet (the streaming placeholder
                        // before its first chunk). Deliberately NOT the
                        // markdown branch: that would stand up a WKWebView
                        // and load the full document to display nothing, once
                        // per turn. The typing indicator already says what is
                        // happening.
                        EmptyView()
                    } else if marks.documentReplies.contains(turn.id),
                              !expandedTurns.contains(turn.id),
                              // While it streams, trust the position: the turn
                              // was fired BY "Write full plan", and the heavy
                              // render is exactly what must not happen per
                              // chunk. Once it lands, trust the content — an
                              // agent that answered a write request with a
                              // clarifying question wrote conversation, not a
                              // document, and collapsing that would hide the
                              // question behind "Implementation plan · 3 lines".
                              // Same `looksLikePlan` gate the auto-save uses,
                              // so the bubble collapses exactly when a card
                              // appears below carrying the text.
                              turn.status == .streaming
                                  || PlanEditPolicy.looksLikePlan(content: turn.content) {
                        // The plan document itself. Collapsed to a row: the
                        // saved-plan card below carries the same text with the
                        // buttons that act on it, and rendering thousands of
                        // words of markdown in a web view that re-measures on
                        // every streamed chunk is what made this turn jerk the
                        // transcript around. Explicitly expanding still opens
                        // it — `expandedTurns` is checked BEFORE the usual
                        // last-turn rule, which would otherwise force it open.
                        PlanDocumentBubble(
                            content: turn.content,
                            isStreaming: turn.status == .streaming,
                            onExpand: { expandedTurns.insert(turn.id) })
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
                    // A turn that streamed some text and THEN failed keeps
                    // the partial reply above and explains itself here, so
                    // the retry affordance is the same wherever the failure
                    // landed. (The no-text case renders `failedTurnView` in
                    // place of the bubble instead.)
                    if !isUser, turn.status == .failed, !turn.content.isEmpty {
                        failedTurnFooter(turn)
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
