# Chat parity triage (verified)

Input: the 194 Mac Chat labels that `scripts/parity-inventory.mjs` could not find in the desktop (`chat.md`).
Four Haiku agents classified them first. An Opus pass then checked every REAL_GAP and MAC_ONLY claim against the
code, re-opened the desktop file:line cited by every REWORDED claim, and checked every RUNTIME claim. The per-label
result is in the scratchpad file `triage/chat-verified.json` (same schema, plus `verifiedBy` and `changed`).

## Counts

| Class | Haiku | Verified |
|---|---|---|
| REAL_GAP | 78 | 51 |
| REWORDED | 77 | 52 |
| MAC_ONLY | 24 | 19 |
| RUNTIME | 15 | 7 |
| DEAD_ON_MAC (new) | 0 | 65 |
| Total | 194 | 194 |

81 labels changed class. 51 REAL_GAP labels collapse into 23 features. 19 of those labels are one held workflow.

## Key finding: the legacy proposal sheets are dead on the Mac too

The Mac's `PendingActionCard` and every sheet it opens can no longer be reached:

- `ChatTransportFactory.makeTransport` only builds `AgentV2EngineTransport(v2: AgentV2Transport(...))`
  (`mac/Sources/LlmIdeMac/Features/Chat/Transport/AgentV2Selection.swift:161`).
- `AgentV2Transport` returns `pendingTool: nil` (`mac/Sources/LlmIdeMac/ClaudeLink/AgentV2Transport.swift:494`).
- `engine.agent.pendingTool` is set only from that result (`Features/Chat/Engine/ChatEngine.swift:1397`).
- Every `sheets.showingXxxSheet = true` for Create/Comment/Get/Update/List issue, Create branch, Create PR,
  Review Code, Update file and Git op sits inside `PendingActionCard`'s `onOpen` (`ChatMessageList.swift:513-543`).
  The other path to the update-file sheet (`CodeAssistant+Edits.swift:95`) also needs `pendingTool.updateFileArgs`.

The only `ChatTransportResult(...)` that carries a real `pendingTool` is the classic `/code-assist` initializer
(`Core/Contracts/ChatTransport.swift:272-283`), and nothing calls it. These 65 labels are marked **DEAD_ON_MAC**.
Do not mirror them. They are candidates for a Mac dead-code cleanup, which is outside this frozen-Chat audit.

There is one exception. `CodeWorkflowSheet`, `QuickFixSheet` and `CliProgressView` are still live on the Mac, but
they open from Review Conflicts (`Features/ReviewConflicts/Views/ReviewView.swift:220-227`, through the
`CodeWorkflowSheetView` seam), not from chat. `TriggerReviewCodeSheet`, the chat way into them, is dead.

## Reclassifications (every change and why)

| Labels (Haiku id) | Haiku → Verified | Why |
|---|---|---|
| BranchCreationSheet: Create Branch, Branch Name, Current branch:, Start Point, Leave empty..., ' created successfully, 2 placeholders (1.19-1.26) | REWORDED/REAL_GAP/RUNTIME → DEAD_ON_MAC | Only opened from PendingActionCard. |
| Update-file fallback: File update unavailable, Agent's path, Attached files ( (1.27-1.29) | MAC_ONLY/REWORDED → DEAD_ON_MAC | `showingUpdateFileSheetContent` needs `pendingTool.updateFileArgs`, which is always nil. |
| Issue write sheets: Post comment, Comment on issue, Read-only..., Change in Settings →, Create issue, 2 placeholders, Update Issue, Issue title, Labels, Update Issue #, placeholder (1.30-1.36, 1.72-1.76) | REAL_GAP/RUNTIME → DEAD_ON_MAC | Only reachable through PendingActionCard. The provider issue-write gap still exists, but it belongs to the Issues feature (`ui/screens/issues/IssuesScreen.tsx:257-266` already says it is Mac-only until the core has write routes), not to Chat. |
| GetIssue/ListIssues sheets: Loading issue..., Failed to load issue, Search issues, Filter by label, Searching issues..., Issues, All States, Closed, Search failed, No issues found (1.37, 1.38, 1.41-1.48) | REWORDED → DEAD_ON_MAC | Dead sheets. The IssuesScreen look-alikes Haiku cited are real, but they are a different feature. |
| GitOpSheet: This can discard..., Operation (1.39, 1.40) | REWORDED → DEAD_ON_MAC | Opened only from `ChatMessageList.swift:543` inside PendingActionCard. |
| PRCreationSheet: 10 labels (1.49-1.58) | REAL_GAP/RUNTIME → DEAD_ON_MAC | Dead sheet. |
| TriggerReviewCodeSheet: Quick Fix(isShort, Guided, Review code for #, The Review Code workflow..., No active cloned repo..., Start Code Update (1.63-1.68) | REAL_GAP → DEAD_ON_MAC | Opened only from PendingActionCard. The live workflow it hands off to is counted below. |
| UpdateFileSheet: Proposed content (editable), Update file, Diff vs current file; PendingActionCard Apply (1.69-1.71, 3.34) | REAL_GAP/REWORDED → DEAD_ON_MAC | Dead. The desktop's live equivalent is the SDK approval card (ApprovalCard.tsx: Allow once, Show diff). Editing before allowing is not a Mac behaviour today. |
| PendingActionCard: Review diff, → Review Code for #, On issue #, Read issue #, Show full issue details, Update issue #, Search issues, Filter:, from:, Create merge request (4.0-4.9) | MAC_ONLY → DEAD_ON_MAC | Haiku's reason checked and confirmed. Relabelled so the cleanup is not lost. |
| Create Issue, Create Branch, View Issue, View, No changes to show, opened, Open Issue (1.2, 1.3, 1.9, 1.10, 1.14, 1.18, 1.84) | REWORDED → REAL_GAP (workflow, HOLD) | These are step states of the live CodeWorkflowSheet/QuickFixSheet. "Create Branch" there is a remote branch made through the provider API (`CodeWorkflowService.swift:213`), not the local `git_create_branch` in BranchesView. "opened" is "No MR opened". The desktop controls Haiku cited are different controls. |
| LlmChatSheet: Message llm-chat…, Clear the conversation?, Show full reply, This removes..., Ask LLM-IDE anything..., Examples: (1.77-1.80, 1.82, 1.83) | REAL_GAP/REWORDED → MAC_ONLY | The ⌘⇧L sheet (`AppShell.swift:90`) runs on the shared `.quick` engine that the menu-bar popover and the iPhone also drive (`LlmChatSheet.swift:3-8`). The desktop has no shared quick scope. Its "Chat from every screen" entry is `StatusBar.tsx:157`. This is the same decision as the menu-bar popover (parity plan line 97). Haiku's own 3.24-3.33 rows were already MAC_ONLY. |
| Claim N older chats (2.1) | REAL_GAP → MAC_ONLY | By design. The desktop store gives unowned chats to the first user who opens it (`desktop/src-tauri/src/chat_store.rs:148-152`, which names the Mac button as the difference), so nothing is left to claim. |
| Per-reply ") tokens" (2.32) | REAL_GAP → REWORDED | Already shipped: `ui/screens/chat/MessageView.tsx:152` shows `{compactTokenCount(billableTokens(m.usage))} tokens` with the breakdown tooltip. The scanner missed the template string. |
| Subagent chip "No subagents used in this turn." (4.29) | REAL_GAP → REWORDED | Haiku said "empty button", which is wrong. `SubagentChip` returns null when there are no runs (`badges/Badges.tsx:20`), so the desktop hides the chip instead. |
| "Counted: input + output + cache writes..." (3.10) | REWORDED → REAL_GAP (ui S, copy only) | See the note below. Neither number is wrong. The desktop popover does not say what the cap counts. |

Changes inside REAL_GAP (class kept): the archive attention list goes from rust M to **rust L, decision needed**.
Plan review/merge-push is split into a safe **review** (ui M) and a held **Merge & Push**. For the effort picker
the core already accepts `effort` and lists `effortLevels`, so the work is UI only.

### Token note: is the desktop 1.25x wrong?

No. There are two counts, and both sides agree on both:

- Per-reply label: cache writes 1.25x, cache reads 0.1x (`mac/.../ClaudeLink/TokenCostPolicy.swift`), mirrored
  exactly in `ui/screens/chat/usage.ts` (`CACHE_WRITE_MULTIPLIER = 1.25`).
- Session cap meter: input + output + cache writes at 1x, reads not counted. The server computes it
  (`extension/routes/agent-v2-router.mjs:102` `billableOf`, `extension/llm_agent/sdk/engine.mjs:1853`). Both
  clients only display `route.used.billable`.

The Mac's "Counted:" sentence describes the cap meter and is correct. The desktop popover (`Pickers.tsx:88`) only
says "Billable tokens used", which is the same word as the weighted per-reply count. The fix is copy only: add the
Mac sentence to the popover. No number changes.

## Feature table

| Feature | Class | Labels | Evidence (one line) | Missing | Needs | Effort | Safe now |
|---|---|---|---|---|---|---|---|
| Legacy pendingTool sheets and cards | DEAD_ON_MAC | 65 | pendingTool always nil (AgentV2Transport.swift:494) | none (do not mirror) | - | - | - |
| Code-change workflow (CodeWorkflowSheet, Quick Fix, CLI progress) | REAL_GAP | 19 | CodeWorkflowService.swift:169-785 does provider issue/branch/MR writes, local commit and push; reached from ReviewView.swift:220 | Issue → remote branch → codegen → commit → push → MR/PR → issue note/close | core | L | **HOLD** (provider writes + push) |
| Chat archive attention list | REAL_GAP | 5 | Mac archives extension chats via /kb/chat/sessions/:id/archive/begin+commit (routes/chat.mjs:135-190); desktop chat_archive.rs never calls them | Extension-chat archive pipeline, then the Archive as is / Keep on server list | rust | L | No: decision first |
| Add custom model id | REAL_GAP | 4 | Mac per-provider custom ids (CodeAssistantModelState+Models.swift:99-111); desktop ModelPicker has a fixed list | Add-model dialog + per-provider persisted list | ui | M | Yes (check the core accepts unknown ids per provider) |
| Plan execution review | REAL_GAP | 2 | PlanExecutionCard.swift:298-343; desktop PlanCard has only Save/Edit/Refine/Execute | "Review changes" on a finished execution (Review-mode turn over its diff) | ui | M | Yes (read-only) |
| Plan execution Merge & Push | REAL_GAP | 2 | CodeAssistant+PlanExecution.swift:344-372 commits, merges to the default branch, git push | Merge + push | rust | M | **HOLD** |
| Plan editor Preview/Markdown toggle | REAL_GAP | 2 | PlanEditSheet.swift:339-344; desktop PlanCard edit is a plain textarea | Preview/source toggle while editing | ui | S | Yes |
| Plan-mode mismatch notice + Switch to Plan | REAL_GAP | 2 | PlanRequestPolicy.swift:44-63; desktop looksLikePlan (plan/detect.ts:91) checks replies, not requests | Notice when a planning request is sent outside Plan, with a one-click switch | ui | S | Yes |
| Collapse older replies | REAL_GAP | 2 | ChatMessageList.swift:457-459, 879, 915; desktop MessageView has only Show more | Older replies collapsed to a preview row; Collapse / Show full reply | ui | S | Yes |
| Effort picker | REAL_GAP | 1 | Core: agent-v2.mjs:744-746 accepts `effort`, sdk/models.mjs:81-98 lists `effortLevels` | Effort section in the model picker, sent with the turn | ui | M | Yes |
| Autonomous continue and stop | REAL_GAP | 1 | Mac auto-chains on `continueNeeded` (ChatEngine.swift:1426-1438); desktop parses it (events.ts:179) and ignores it | Auto-continue rounds + "Stop autonomous agent" | ui | M | Yes, with the cap and Stop honoured |
| Repeat-question save-to-memory nudge | REAL_GAP | 1 | CodeAssistantSession.swift (threshold 3) + `memoryStore.writeQA` into the repo memory | Nudge banner + host command that writes the Q&A entry | rust | M | Yes (write only into the memory folder) |
| Pending model switch notice | REAL_GAP | 1 | ChatRouteModel.swift:89 `server.pending`; desktop RouteView (route.ts:126-137) drops `pending` | "Applies to your next message: X" | ui | S | Yes |
| Unpin chat model ("Not pinned") | REAL_GAP | 1 | ChatRouteControl.swift:115 sends provider ""; desktop "Default" option never calls putRoute (Pickers.tsx:31, ChatScreen.tsx:330) | Unpin back to the composer's model | ui | S | Yes |
| Token limit not-enforced warning | REAL_GAP | 1 | Core returns capEnforced; desktop declares it (route.ts:128) and never reads it | Warning when a limit is saved but the cap switch is off | ui | S | Yes |
| Token meter explanation | REAL_GAP | 1 | See the token note | "Counted: ..." sentence in the cap popover | ui | S | Yes |
| Delete chat confirmation copy | REAL_GAP | 1 | Desktop says only "Delete this chat?" (DockHeader.tsx:71, SessionList.tsx:87-90) | "The conversation and its memory are removed. This cannot be undone." | ui | S | Yes |
| Composer key hint | REAL_GAP | 1 | Keys already work (Composer.tsx:127); no hint shown | "↵ sends · ⇧↵ for a new line" | ui | S | Yes |
| In-chat provider-blocked notice | REAL_GAP | 1 | CodeAssistantPanel.swift:156/442; desktop shows only the plainChat note (Pickers.tsx:44) | Bar when the selected provider can no longer run a chat, pointing to Settings, Providers | ui | S | Yes |
| Plan execution progress | REAL_GAP | 1 | PlanExecutionCard.swift:150-160; desktop lists tasks only (ChatScreen.tsx:312-314) | Step n of N, done count, percent | ui | S | Yes |
| Open saved plan file | REAL_GAP | 1 | PlanSavedCard.swift:159; desktop prints "Saved to {path}" (PlanCard.tsx:39) | Open control (reuse `files.open`, MessageView.tsx:113) | ui | S | Yes |
| Folder trust banner dismiss | REAL_GAP | 1 | WorkspaceTrustBanner.swift:74; desktop TrustBanner.tsx has no dismiss | Hide the notice without trusting | ui | S | Yes (grants nothing) |
| Quick chat on the shared .quick engine (LlmChatSheet + menu-bar popover) | MAC_ONLY (+1 RUNTIME) | 17 | LlmChatSheet.swift:3-8; parity plan line 97 | - | - | - | - |
| Claim older chats | MAC_ONLY | 1 | chat_store.rs:148-152 auto-claims for the first opener | - | - | - | - |
| Plan document bubble | MAC_ONLY | 2 | PlanDocumentBubble.swift:5-14: WKWebView re-measure workaround | - | - | - | - |
| Chat sheet/issue look-alikes, queue, stop, retry, banners, route chip, history, rename, running chip, plan card actions, trust dialog, subagent chip, voice, tokens, context, transcript, jump pill | REWORDED | 52 | Each desktop file:line re-opened (Composer.tsx:107-145, ChatScreen.tsx:250-314, MessageView.tsx:83/106/151/152, MessageList.tsx:96/105, DockHeader.tsx:55-78, SessionList.tsx:76-96, Pickers.tsx:31/82-94, Badges.tsx:20-82, StatusBanner.tsx:21, ArgsPreview.tsx:17, TrustBanner.tsx:67-76, PlanCard.tsx:38-72, StatusBar.tsx:157, Dialogs.tsx:228) | - | - | - | - |
| Workflow field placeholders, runtime a11y strings, model-id example | RUNTIME | 6 | TextField prompts and joined/runtime labels | - | - | - | - |

Notes on REWORDED with a caveat: "Project memory" (2.11). The desktop chip shows session memory. The project memory
viewer lives in Settings > Memory (`ui/screens/settings/sections/MemorySection.tsx`), not one click from the composer.
This is acceptable as REWORDED. A link from the chip to that section would be a nice-to-have.

## Implementation batches

### Batch A: pure UI, effort S, no host or core change

1. Token meter explanation ("Counted: ..." sentence in the cap popover)
2. Token limit not-enforced warning (`capEnforced`)
3. Pending model switch notice (add `pending` to `RouteView`)
4. Unpin chat model ("Not pinned": `putRoute` with an empty provider, as the Mac does)
5. Delete chat confirmation copy (DockHeader + SessionList)
6. Composer key hint
7. In-chat provider-blocked notice
8. Plan-mode mismatch notice + Switch to Plan (port `PlanRequestPolicy` as a pure function with tests)
9. Collapse older replies (Collapse / Show full reply)
10. Plan editor Preview/Markdown toggle
11. Plan execution progress (step n of N, done, percent)
12. Open saved plan file (existing `files.open`)
13. Folder trust banner dismiss (session-only; never changes trust)

### Batch B: UI effort M, or small host/core work

1. Effort picker: UI only. Core already takes `effort` and lists `effortLevels`.
2. Add custom model id: UI and prefs. First confirm `/agent/v2` accepts an unlisted id for each provider kind.
3. Autonomous continue and stop: controller work. Must stop at the token cap, on Stop, and on any approval wait.
4. Plan execution review: a Review-mode turn over the execution's diff. Read-only.
5. Repeat-question save-to-memory nudge: needs a Rust command that writes one Q&A entry, only into the project
   memory folder, and only when Workspace Trust allows it.

### Batch C: needs a core route or a product decision

1. **Chat archive attention list.** Decision: should the desktop archive Chrome-extension chats from the server
   (archive/begin + commit, `acceptIncomplete`) the way the Mac does? If yes, build that in Rust first. The list
   (Archive as is / Keep on server) comes after.
2. **Code-change workflow (HOLD).** Needs core provider write routes: issue create/note/update, remote branch,
   MR/PR for GitHub and GitLab, plus push. Today only `/kb/review/approve` → `agents/github-pr.mjs` writes, for
   GitHub only, after review approval and a secret scan. Decision: is this workflow wanted on the desktop at all,
   and if so, must every write go through the review/approval queue?
3. **Plan execution Merge & Push (HOLD).** Merges into the default branch and pushes without a PR. Decision: keep
   push off the desktop (the current credentials stance in `ui/screens/explorer/scm/api.ts`), or route it through a
   PR via the approval flow instead.

### Hold list: do not mirror as-is

- Code-change workflow, and Merge & Push: GitHub/GitLab writes, remote branch creation, push to the default branch.
  These bypass the desktop's approval flow and credentials stance.
- Everything marked DEAD_ON_MAC: issue/PR/branch/git-op/update-file sheets. They would mirror code the Mac no
  longer runs. Editing proposed content before allowing an SDK edit (UpdateFileSheet) is not live behaviour on the
  Mac either.

## Could not verify

- Whether `normalizePinnedProvider('')` in the core accepts an empty provider as "unpin". The Mac relies on it
  (`ChatRouteModel.swift:193-195`), so it is very likely, but it was not traced into `kb/`.
- Whether the core routes a hand-typed model id for catalog connections (affects Batch B item 2).
- The desktop QuestionCard selected-state a11y (RUNTIME 2.0) was accepted on Haiku's citation without re-opening.
