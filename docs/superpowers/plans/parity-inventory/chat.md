## chat: 53/253 Swift labels exact in desktop code (21%), 6 only inside a longer sentence, 194 missing

Swift files scanned: 108. Shortcuts in Swift (not machine-matched): 4.

| kind | total | missing |
|---|---|---|
| accessibilityHint | 2 | 2 |
| accessibilityLabel | 22 | 18 |
| alert | 1 | 1 |
| button | 37 | 21 |
| confirmationDialog | 5 | 4 |
| help | 35 | 30 |
| label | 16 | 9 |
| navigationTitle | 2 | 2 |
| picker | 1 | 0 |
| progressview | 2 | 2 |
| section | 1 | 1 |
| text | 105 | 84 |
| textfield | 24 | 20 |

### Missing

- [text] "Generating changes —" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/CliProgressView.swift:22
- [button] "Skip — mark issue done" - mac/Sources/LlmIdeMac/Features/Chat/Views/CodeWorkflowSheet.swift:277
- [button] "Close" - mac/Sources/LlmIdeMac/Features/Chat/Views/CodeWorkflowSheet.swift:506 (+6)
- [button] "Create Issue" - mac/Sources/LlmIdeMac/Features/Chat/Views/CodeWorkflowSheet.swift:520 (+1)
- [button] "Create Branch" - mac/Sources/LlmIdeMac/Features/Chat/Views/CodeWorkflowSheet.swift:528 (+1)
- [button] "Generate Changes" - mac/Sources/LlmIdeMac/Features/Chat/Views/CodeWorkflowSheet.swift:537
- [button] "Use These Changes" - mac/Sources/LlmIdeMac/Features/Chat/Views/CodeWorkflowSheet.swift:541
- [textfield] "Brief description of the change" - mac/Sources/LlmIdeMac/Features/Chat/Views/CodeWorkflowSheet.swift:188
- [textfield] "e.g. issue-42-fix-login-flow" - mac/Sources/LlmIdeMac/Features/Chat/Views/CodeWorkflowSheet.swift:234
- [textfield] "e.g. fix: resolve login flow (#42)" - mac/Sources/LlmIdeMac/Features/Chat/Views/CodeWorkflowSheet.swift:359
- [label] "View Issue" - mac/Sources/LlmIdeMac/Features/Chat/Views/CodeWorkflowSheet.swift:420
- [label] "View" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/CodeWorkflowSheet.swift:441 (+1)
- [text] "Pick existing issue" - mac/Sources/LlmIdeMac/Features/Chat/Views/CodeWorkflowSheet.swift:213
- [text] "Base: **" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/CodeWorkflowSheet.swift:243
- [text] "Generated" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/CodeWorkflowSheet.swift:288
- [text] "No changes to show" - mac/Sources/LlmIdeMac/Features/Chat/Views/CodeWorkflowSheet.swift:293
- [text] "No AI-generated files. Manually edit files in the Code tab and return here to commit." - mac/Sources/LlmIdeMac/Features/Chat/Views/CodeWorkflowSheet.swift:334
- [text] "Pushing…" - mac/Sources/LlmIdeMac/Features/Chat/Views/CodeWorkflowSheet.swift:396
- [text] "Change submitted!" - mac/Sources/LlmIdeMac/Features/Chat/Views/CodeWorkflowSheet.swift:407
- [text] "opened" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/CodeWorkflowSheet.swift:447 (+2)
- [textfield] "e.g., feature/new-auth" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/BranchCreationSheet.swift:49 (+1)
- [textfield] "e.g., main, HEAD~3" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/BranchCreationSheet.swift:65
- [text] "Create Branch" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/BranchCreationSheet.swift:41 (+1)
- [text] "Branch Name" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/BranchCreationSheet.swift:45
- [text] "Current branch:" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/BranchCreationSheet.swift:54
- [text] "Start Point (optional)" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/BranchCreationSheet.swift:61
- [text] "Leave empty to create from current HEAD" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/BranchCreationSheet.swift:69
- [text] "' created successfully" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/BranchCreationSheet.swift:80
- [button] "Add model…" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatComposer.swift:668
- [button] "Add" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatComposer.swift:694
- [textfield] "model id, e.g. gpt-5 / claude-opus-4-9 / gemini-2.5-pro" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatComposer.swift:693
- [section] "Effort" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatComposer.swift:655
- [help] "Cancel this queued message" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatComposer.swift:232
- [help] "↵ sends · ⇧↵ for a new line" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatComposer.swift:525
- [help] "Stop the running response (Esc)" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatComposer.swift:540
- [help] "Stop autonomous agent" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatComposer.swift:552
- [help] "Context used:" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatComposer.swift:777
- [alert] "Add a model" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatComposer.swift:692
- [accessibilityLabel] "Cancel queued message" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatComposer.swift:233
- [accessibilityLabel] "Project memory" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatComposer.swift:496
- [accessibilityLabel] "Last turn used" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatComposer.swift:754
- [accessibilityLabel] "Context used" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatComposer.swift:778
- [text] "Chat runs on Claude, a custom provider with an Anthropic-compatible URL, or a catalog model through the session router. This provider cannot run a chat any more: pick another model, or connect it in Settings, Providers." - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatComposer.swift:143
- [text] "Queued #" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatComposer.swift:216
- [text] "Adds a model id under the current provider. It's sent to the backend as-is and routed by id prefix — handy for a release not yet in the list." - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatComposer.swift:705
- [label] "Edit in chat" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatMessageList.swift:231 (+1)
- [label] "Collapse" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatMessageList.swift:879
- [help] "Save this plan to llm-doc/plans/ in the open project" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatMessageList.swift:211
- [help] "Read this plan as a document, edit it, then save it" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatMessageList.swift:227
- [help] "Keep refining this plan in this chat" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatMessageList.swift:236
- [help] "Follow the reply as it streams" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatMessageList.swift:396
- [help] "Send this message again" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatMessageList.swift:696
- [help] "Show full reply" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatMessageList.swift:915 (+1)
- [help] "Dismiss error" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatMessageList.swift:957
- [help] "Dismiss notice" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatMessageList.swift:984
- [accessibilityLabel] "Chat transcript" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatMessageList.swift:351
- [accessibilityLabel] "Dismiss error" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatMessageList.swift:956
- [accessibilityLabel] "Dismiss notice" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatMessageList.swift:983
- [text] "Attach context with the buttons below, then describe what you want." - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatMessageList.swift:419
- [text] ") tokens" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatMessageList.swift:803 (+1)
- [textfield] "none, 200k, 1.5m" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatRouteControl.swift:138
- [help] "This chat's model and token limit" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatRouteControl.swift:61
- [accessibilityLabel] "This chat's model and token limit" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatRouteControl.swift:62
- [text] "This chat's model" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatRouteControl.swift:70
- [text] "Applies to your next message:" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatRouteControl.swift:75
- [text] "Not pinned (the composer's model)" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatRouteControl.swift:115
- [text] "Counted: input + output + cache writes. Cached reads are shown, not counted." (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatRouteControl.swift:163
- [text] "The limit is saved but not enforced: the server runs without the cap switch." - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatRouteControl.swift:166
- [text] "History is unavailable right now. Routing is not affected." - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatRouteControl.swift:177
- [help] "Switch chat session" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatSessionHeader.swift:102
- [help] "Delete current chat" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatSessionHeader.swift:219
- [accessibilityLabel] "Switch chat session" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatSessionHeader.swift:103
- [accessibilityLabel] "Delete current chat" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatSessionHeader.swift:220
- [text] "The conversation and its memory are removed. This cannot be undone." - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ChatSessionHeader.swift:50 (+1)
- [text] "File update unavailable" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/CodeAssistant+Sheets.swift:98
- [text] "Agent's path" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/CodeAssistant+Sheets.swift:107
- [text] "Attached files (" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/CodeAssistant+Sheets.swift:118
- [text] "Listening... (Cmd+M to stop)" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/CodeAssistant+Voice.swift:46
- [button] "Switch to Plan" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/CodeAssistantPanel+Session.swift:29
- [text] "This reads as a planning request, but the mode is" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/CodeAssistantPanel+Session.swift:25
- [text] "times — save the answer to memory?" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/CodeAssistantPanel+Session.swift:54
- [button] "Post comment" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/CommentIssueSheet.swift:96
- [text] "Comment on issue" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/CommentIssueSheet.swift:56
- [text] "Read-only — cancel and re-ask if this isn't the right issue." - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/CommentIssueSheet.swift:64
- [text] "Change in Settings →" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/CommentIssueSheet.swift:78 (+1)
- [textfield] "comma, separated" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/CreateIssueSheet.swift:77
- [textfield] "@username (optional)" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/CreateIssueSheet.swift:81
- [text] "Create issue" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/CreateIssueSheet.swift:62
- [progressview] "Loading issue..." - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/GetIssueSheet.swift:31
- [text] "Failed to load issue" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/GetIssueSheet.swift:107
- [text] "This can discard or rewrite work. Review carefully." - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/GitOpSheet.swift:18
- [text] "Operation" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/GitOpSheet.swift:24
- [textfield] "Search issues" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ListIssuesSheet.swift:35
- [textfield] "Filter by label" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ListIssuesSheet.swift:59
- [progressview] "Searching issues..." - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ListIssuesSheet.swift:72
- [navigationTitle] "Issues" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ListIssuesSheet.swift:118
- [text] "All States" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ListIssuesSheet.swift:48
- [text] "Closed" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ListIssuesSheet.swift:50 (+1)
- [text] "Search failed" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ListIssuesSheet.swift:76
- [text] "No issues found" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ListIssuesSheet.swift:90
- [button] "Create \\(provider ==" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PRCreationSheet.swift:172
- [textfield] "PR title" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PRCreationSheet.swift:82
- [textfield] "e.g., main" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PRCreationSheet.swift:118
- [textfield] "bug, enhancement" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PRCreationSheet.swift:130
- [textfield] "username" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PRCreationSheet.swift:140
- [text] "PR creation is blocked by allow-list" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PRCreationSheet.swift:71
- [text] "Source Branch" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PRCreationSheet.swift:104
- [text] "Target Branch" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PRCreationSheet.swift:114
- [text] "Labels (comma-separated)" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PRCreationSheet.swift:126
- [text] "Assignee (optional)" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PRCreationSheet.swift:136
- [button] "Apply" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PendingActionCard.swift:69 (+1)
- [button] "Review diff" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PendingActionCard.swift:73
- [text] "→ Review Code for #" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PendingActionCard.swift:114
- [text] "On issue #" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PendingActionCard.swift:145
- [text] "Read issue #" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PendingActionCard.swift:176
- [text] "Show full issue details" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PendingActionCard.swift:179
- [text] "Update issue #" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PendingActionCard.swift:184
- [text] "Search issues" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PendingActionCard.swift:199
- [text] "Filter:" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PendingActionCard.swift:208
- [text] "from:" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PendingActionCard.swift:227
- [text] "Create merge request" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PendingActionCard.swift:233
- [label] "Show document" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PlanDocumentBubble.swift:74
- [help] "Render the full plan here as well as in the card below" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PlanDocumentBubble.swift:80
- [help] "Preview renders the plan; Markdown shows the exact text that gets saved." - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PlanEditSheet.swift:344
- [text] "Markdown" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PlanEditSheet.swift:339
- [text] "Saves to llm-doc/plans/ in the open project" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PlanEditSheet.swift:385
- [text] "Your edits are written to the plan file; the chat reply is left as the agent wrote it." - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PlanEditSheet.swift:408
- [button] "Merge & Push" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PlanExecutionCard.swift:331
- [help] "Run the code-review skill over the changes this execution made" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PlanExecutionCard.swift:298 (+1)
- [confirmationDialog] "Merge into the default branch and push?" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PlanExecutionCard.swift:329
- [text] ".rounded()))%" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PlanExecutionCard.swift:156
- [text] "Reviewing…" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PlanExecutionCard.swift:343
- [help] "Open the saved plan file" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PlanSavedCard.swift:159
- [help] "Switch to Execute mode with this plan attached" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PlanSavedCard.swift:248
- [help] "Keep refining the plan in this chat" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PlanSavedCard.swift:259
- [text] "PLAN WRITTEN" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PlanSavedCard.swift:127
- [text] "steps · executing one at a time" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/PlanSavedCard.swift:137
- [textfield] "Chat name" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/SessionRow.swift:28
- [help] "Still working in the background" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/SessionRow.swift:46
- [help] "Save name" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/SessionRow.swift:59
- [help] "Rename this chat" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/SessionRow.swift:70
- [accessibilityLabel] "Still working" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/SessionRow.swift:47
- [accessibilityHint] "Shows the subagents this turn delegated to" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/SubagentActivityChip.swift:22
- [text] "Subagents · this turn" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/SubagentActivityChip.swift:79
- [text] "No subagents used in this turn." - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/SubagentActivityChip.swift:83
- [help] "Double-click to show this step's input and output" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ToolActivityList.swift:153
- [accessibilityLabel] ".joined(separator:" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/ToolActivityList.swift:77
- [label] "Quick Fix\\(isShort ?" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/TriggerReviewCodeSheet.swift:69
- [label] "Guided" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/TriggerReviewCodeSheet.swift:75
- [text] "Review code for #" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/TriggerReviewCodeSheet.swift:24
- [text] "The Review Code workflow will attach a branch and MR to this issue." - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/TriggerReviewCodeSheet.swift:32
- [text] "No active, cloned repo. Add and clone one in Settings → GitLab or GitHub." - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/TriggerReviewCodeSheet.swift:55
- [text] "Start Code Update" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/TriggerReviewCodeSheet.swift:78
- [text] "Proposed content (editable)" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/UpdateFileSheet.swift:65
- [text] "Update file" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/UpdateFileSheet.swift:104
- [text] "Diff vs current file" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/UpdateFileSheet.swift:122
- [button] "Update Issue" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/UpdateIssueSheet.swift:115
- [textfield] "Issue title" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/UpdateIssueSheet.swift:65
- [textfield] "bug, enhancement, priority (comma-separated)" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/UpdateIssueSheet.swift:86
- [navigationTitle] "Update Issue #" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/UpdateIssueSheet.swift:123
- [text] "Labels" - mac/Sources/LlmIdeMac/Features/Chat/Views/Panel/UpdateIssueSheet.swift:83
- [textfield] "Message llm-chat…" - mac/Sources/LlmIdeMac/Features/Chat/Views/Quick/LlmChatSheet.swift:417
- [confirmationDialog] "Clear the conversation?" - mac/Sources/LlmIdeMac/Features/Chat/Views/Quick/LlmChatSheet.swift:170
- [accessibilityLabel] "Show full reply" - mac/Sources/LlmIdeMac/Features/Chat/Views/Quick/LlmChatSheet.swift:412
- [text] "This removes this chat's saved conversation and its memory." - mac/Sources/LlmIdeMac/Features/Chat/Views/Quick/LlmChatSheet.swift:180 (+1)
- [text] "llm-chat" - mac/Sources/LlmIdeMac/Features/Chat/Views/Quick/LlmChatSheet.swift:200 (+1)
- [text] "Ask LLM-IDE anything about the active project." - mac/Sources/LlmIdeMac/Features/Chat/Views/Quick/LlmChatSheet.swift:294
- [text] "Examples:" - mac/Sources/LlmIdeMac/Features/Chat/Views/Quick/LlmChatSheet.swift:297
- [help] "LLM Chat — shared with iPhone (⌘⇧L)" - mac/Sources/LlmIdeMac/Features/Chat/Views/Quick/LlmChatStatusBadge.swift:27
- [button] "Clear conversation" - mac/Sources/LlmIdeMac/Features/Chat/Views/Quick/MenuBarChatView.swift:279
- [button] "Quit" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/Quick/MenuBarChatView.swift:287
- [textfield] "Type / to use skills" - mac/Sources/LlmIdeMac/Features/Chat/Views/Quick/MenuBarChatView.swift:585
- [help] "Minimize chat" - mac/Sources/LlmIdeMac/Features/Chat/Views/Quick/MenuBarChatView.swift:258
- [help] "Open main window" - mac/Sources/LlmIdeMac/Features/Chat/Views/Quick/MenuBarChatView.swift:274
- [help] "Insert / for skills" - mac/Sources/LlmIdeMac/Features/Chat/Views/Quick/MenuBarChatView.swift:603
- [accessibilityLabel] "Signed in as" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/Quick/MenuBarChatView.swift:310
- [text] "Clear the conversation?" - mac/Sources/LlmIdeMac/Features/Chat/Views/Quick/MenuBarChatView.swift:220
- [text] "Hello," (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/Quick/MenuBarChatView.swift:372
- [text] "How can I help you today?" - mac/Sources/LlmIdeMac/Features/Chat/Views/Quick/MenuBarChatView.swift:375
- [label] "Open Issue" - mac/Sources/LlmIdeMac/Features/Chat/Views/QuickFixSheet.swift:221
- [label] "Switch to Guided" - mac/Sources/LlmIdeMac/Features/Chat/Views/QuickFixSheet.swift:240
- [text] "Quick Fix" - mac/Sources/LlmIdeMac/Features/Chat/Views/QuickFixSheet.swift:120
- [accessibilityLabel] "\\(isSelected ?" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/Shared/ApprovalQuestionCard.swift:149
- [button] "older chat\\(s.unowned == 1 ?" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/Shared/ChatArchiveSettingsCard.swift:25
- [button] "Archive as is" - mac/Sources/LlmIdeMac/Features/Chat/Views/Shared/ChatArchiveSettingsCard.swift:56 (+1)
- [button] "Keep on server" - mac/Sources/LlmIdeMac/Features/Chat/Views/Shared/ChatArchiveSettingsCard.swift:78
- [confirmationDialog] "Archive as is?" - mac/Sources/LlmIdeMac/Features/Chat/Views/Shared/ChatArchiveSettingsCard.swift:51
- [accessibilityLabel] "Archive" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/Shared/ChatArchiveSettingsCard.swift:76
- [accessibilityLabel] ") on the server" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Chat/Views/Shared/ChatArchiveSettingsCard.swift:81
- [text] "(preview truncated)" - mac/Sources/LlmIdeMac/Features/Chat/Views/Shared/ToolApprovalCard.swift:87
- [button] "Trust and allow its MCP servers" - mac/Sources/LlmIdeMac/Features/Chat/Views/Shared/WorkspaceTrustBanner.swift:92
- [confirmationDialog] "Trust this folder?" - mac/Sources/LlmIdeMac/Features/Chat/Views/Shared/WorkspaceTrustBanner.swift:91
- [accessibilityLabel] "Dismiss folder trust notice" - mac/Sources/LlmIdeMac/Features/Chat/Views/Shared/WorkspaceTrustBanner.swift:74
- [accessibilityHint] "Asks for confirmation before this folder's MCP servers can start" - mac/Sources/LlmIdeMac/Features/Chat/Views/Shared/WorkspaceTrustBanner.swift:81
