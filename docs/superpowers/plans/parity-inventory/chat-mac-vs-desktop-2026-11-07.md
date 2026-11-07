# Chat: retired Mac app vs desktop, element by element (2026-11-07)

Source of the Mac side: `git show 94ae1103~1:<path>` (the Swift app was deleted in `94ae1103`). Mac paths below are
relative to `mac/Sources/LlmIdeMac/`; desktop paths are relative to `ui/screens/chat/` unless they start with `ui/` or
`extension/`. Desktop line numbers are at `2993d1a3`.

This report does not repeat the label-level triage (`chat-triage.md`, 2026-11-02, Batch A/B now built). It compares
the **window and its functions**: where each control sits and what it does. The plan that closes the gaps is
`docs/superpowers/plans/2026-11-07-chat-mac-mirror.md`.

## The reported bug: the picker does not show the providers and their models

Root cause, verified in code: `loadModelGroups` (`route.ts:245-280`) lists fewer providers than the Mac did.

1. **Claude-compatible endpoints are never listed.** The desktop asks only `GET /kb/providers/catalog`, and that route
   leaves out every `anthropic-compatible` entry on purpose (`extension/routes/provider-catalog.mjs:52`). Those
   endpoints are only on `GET /kb/providers/custom` (`provider-catalog.mjs:93-96`, `listClaudeCompatible` :65-76).
   The desktop never calls that route. So a GLM / DeepSeek / Ollama endpoint connected in desktop Settings
   (`ui/screens/settings/providers-model.ts:130`, :305) has no group in the chat. A chat already on that provider shows
   "Current (not in the provider list)" (`Pickers.tsx:53`) and the false "This provider cannot run a chat any more"
   note (`ChatScreen.tsx:359`, `route.ts:137-140`). Yet the core runs it (`extension/server/provider-connections.mjs:223-236`).
   The Mac listed its custom providers as menu sections (`Features/Chat/Views/Panel/CodeAssistantModelState+Providers.swift:76-86`).
2. **Keyless local catalog connections are dropped.** `route.ts:263` keeps only `enabled && hasKey`. A local server
   (catalog `keyRequired: false`) never has a key, so it never shows. The Mac kept every enabled connection
   (`Core/Networking/API/LlmIdeAPIClient+ProviderCatalog.swift:186`). The core lists keyless models
   (`extension/providers/provider-models.mjs:114`).
3. **An empty Claude list hides its reason.** When the SDK and the key listing both fail, the core answers
   200 `{ models: [], detail }` (`extension/routes/router.mjs:242`). `route.ts:249-253` drops `detail` and adds no
   note. The picker then shows a bare "Default" with no explanation. A note is added only when the request throws
   (`route.ts:254-257`).

Today's commits did not cause it. `6669e115`/`b01220d5` changed only the empty option's label (`route.ts:180-184`,
`Pickers.tsx:43-46`), and they still need a loaded Claude list. The gaps above date from the picker's first version.

Runtime evidence still worth one look: the webview network panel (or the core log) for `POST /kb/providers/models`,
`GET /kb/providers/catalog` and `GET /kb/providers/custom` on the user's install. That shows which of the three
cases the user hits. All three are fixed by plan Task 1.

## Element table

Status: **same** · **differs** (present, different place or behaviour) · **missing** · **desktop-only**.

| # | Element / function | Mac (file:line) | Desktop (file:line) | Status | What to change |
|---|---|---|---|---|---|
| 1 | Provider groups in the model menu (Claude, Claude-compatible, catalog) | `CodeAssistantModelState+Providers.swift:52-88`; `LlmIdeAPIClient+ProviderCatalog.swift:179-194` | `route.ts:245-280` | differs (bug) | Plan Task 1: add `/kb/providers/custom` connections, keep keyless local connections, show the core's `detail` |
| 2 | Closed picker names provider + model ("Opus 5 High" chip) | `ChatComposer.swift:670-681`, `:827-845` | `Pickers.tsx:51-63` shows only the model name (no provider) | differs | Task 2: the chosen option reads "Provider · model" |
| 3 | "More providers: Settings → Providers" row | `Models/ComposerCatalog.swift:64`, `ChatComposer.swift:648-651` | none | missing | Task 2 |
| 4 | Context meter (ring + %, popover of SDK categories, warn at 80%) | `ChatComposer.swift:741-818`; `Core/Platform/ContextUsagePresentation.swift` | removed in `6669e115`; `state.context` is set (`state.ts:425-426`) and never rendered | missing | Task 3: `ContextMeter` in the composer bar via the existing `meter` prop |
| 5 | Last-turn tokens chip when there is no context report | `ChatComposer.swift:742-757` | per-reply tokens `MessageView.tsx:179`, header total `ChatScreen.tsx:311` | differs | Later (the same numbers are already on screen) |
| 6 | Composer toolbar order: Library +, file count, subagents, model, permission, memory · context, ↵, voice, send | `ChatComposer.swift:413-433` (stacked fallback :436-466) | pickers in a row above the composer `ChatScreen.tsx:360-370`; bar `Composer.tsx:173-186` (memory first, Dictate second) | differs | Task 4: pickers move into the bar in Mac order; the bar wraps (Mac's stacked layout); notices stay above |
| 7 | Mode picker | none on the Mac composer (mode is Auto, set by flows; `CodeAssistantModelState.swift:126-153`) | `Pickers.tsx:11-22` | desktop-only | Keep (user value); it moves into the bar with the others |
| 8 | Effort | inside the model menu, "Effort" section (`ChatComposer.swift:653-665`) | own select `Pickers.tsx:179-189` | differs | Keep the separate select (native menus cannot nest sections); Later if a custom menu lands |
| 9 | Permission (Ask / Accept Edits / Bypass) | `ChatComposer.swift:820-825` | `Pickers.tsx:109-119`, Bypass gate `ChatScreen.tsx:285-296` | same | Moves into the bar (Task 4) |
| 10 | Memory button (project memory, last memory tokens) | `ChatComposer.swift:481-513` | `ChatScreen.tsx:376-381` (session memory popover, then Project memory) | differs | Placement fixed by Task 4; the token count on the button is Later |
| 11 | Subagent chip | `ChatComposer.swift:471-476` | header badges `badges/HeaderBadges.tsx:11` | differs | Later (move into the bar) |
| 12 | Header: "Code Assistant" label, turn/file count, tokens | `ChatSessionHeader.swift:7-31` | `DockHeader.tsx:57-58`, meta `ChatScreen.tsx:311` (no file count) | differs | Later: add the "N files" count |
| 13 | Header route chip: pinned model + meter, popover | `ChatRouteControl.swift:42-63` (`pinnedLabel ?? "Route"`, `Engine/ChatRouteModel.swift:85-88`) | `Pickers.tsx:139-176` (meter text only), `DockHeader.tsx:59` | differs | Task 5: the chip names the pinned model |
| 14 | Route popover "This chat's model" picker + switch history | `ChatRouteControl.swift:71-140` | pin through the composer picker `ChatScreen.tsx:190-201`; history `badges/Badges.tsx` `RouteHistory` | differs | Same behaviour in another place; no change |
| 15 | Session dropdown (title, search, New chat, 20 recent, running marker) | `ChatSessionHeader.swift:73-190` | `DockHeader.tsx:61-76` (50 loaded, search, "(running)") | same | none |
| 16 | Session row rename / delete inside the dropdown | `Views/Panel/SessionRow.swift`; `ChatSessionHeader.swift:168-181` | rename/delete only for the open chat, ⋯ menu `DockHeader.tsx:77-98` | differs | Later: per-row Rename/Delete |
| 17 | Header trash: delete the open chat, confirm only when it has messages | `ChatSessionHeader.swift:192-213` | ⋯ menu Delete, always confirms `DockHeader.tsx:85-94` | differs | Task 8: a direct trash button |
| 18 | Delete confirmation copy | `ChatSessionHeader.swift:44-52` | `route.ts:143-144`, `DockHeader.tsx:87` | same | none |
| 19 | Background sessions (busy chats keep running, running marker) | `Services/ChatEngineRegistry.swift` | `controller.busyIds()` `ChatScreen.tsx:243`; `DockHeader.tsx:16` | same | none |
| 20 | New chat | `ChatSessionHeader.swift:135-152` | `DockHeader.tsx:74`, `:99` | same | none |
| 21 | Slash menu (/clear, /model, /config, sections, skills) | `Core/Editor/ChatSlashCommands.swift`; `ChatComposer.swift:911-938` | `slash/builtins.ts:25-32`, `slash/extras.tsx` | same | none |
| 22 | @ mentions / completion menu | `ChatComposer.swift:249-256` | `mentions/`, `slash/CompletionMenu.tsx` | same | none |
| 23 | Attachments: Add from Library, attach files, chips, skill chips | `ChatComposer.swift:154-203`, `:416-424` | `slash/extras.tsx:143-149`, `attach/AttachmentChips.tsx`, `LibraryNotePicker.tsx` | same | none (Mac's icon-only "+" is styling) |
| 24 | Paste a screenshot as an image attachment (⌘V) | `ChatComposer.swift:335-337` | none (`Composer.tsx` has no paste handler) | missing | Later: needs a host path for pasted bytes (`attach/manager.ts:83` takes host handles only) |
| 25 | Approvals and questions | `Views/Shared/ToolApprovalCard.swift`, `ApprovalQuestionCard.swift` | `approvals/ApprovalCard.tsx`, `approvals/QuestionCard.tsx` (Mac-style since `d85de7c8`) | same | none |
| 26 | Plan flow: cards, save, edit, refine, execute, progress | `CodeAssistant+Plan*.swift`, `PlanSavedCard.swift`, `PlanExecutionCard.swift` | `plan/`, `ChatScreen.tsx:342-357` | same (review and Merge & Push held, see `chat-triage.md`) | none |
| 27 | Plan-mode mismatch banner | `CodeAssistantPanel.swift:440`; `CodeAssistantPanel+Session.swift:25-35` | `plan/PlanSwitchNotice.tsx`, `ChatScreen.tsx:400` | same | none |
| 28 | Stop (button + Esc from anywhere) | `ChatComposer.swift:530-541` (`.keyboardShortcut(.cancelAction)`) | Stop button `Composer.tsx:184`; Esc only while the textarea has focus `Composer.tsx:166` | differs | Task 9: Esc stops from anywhere on the active chat surface |
| 29 | Queue while busy, remove a queued message | `ChatComposer.swift:207-238` | `Composer.tsx:145-152` | same | none |
| 30 | Retry a failed turn | `ChatMessageList.swift:645-706` | `ChatScreen.tsx:332-334`, `MessageView.tsx:178` | same | none |
| 31 | Autonomous continue + "Stop autonomous agent" | `ChatComposer.swift:543-552`; `Engine/ChatEngine.swift:1426-1438` | `continueNeeded` parsed `events.ts:179`, never acted on | missing | Later: it spends tokens, so it must stay off by default |
| 32 | Streaming render, Thinking…, Jump to latest | `ChatMessageList.swift:299-345`, `:379-398` | `MessageView.tsx:163-176`, `MessageList.tsx:116` | same | none |
| 33 | Reply header: role, mode badge, tokens | `ChatMessageList.swift:783-806`; `Views/Panel/ModeBadge.swift` | role + tokens `MessageView.tsx:161`, `:179`; `badges/Badges.tsx:10` `ModeBadge` exists and is rendered nowhere | missing | Task 6: stamp each reply with `mode_set`, render the badge |
| 34 | Tool-call rendering (steps, outputs, file links) | `Views/Panel/ToolActivityList.swift`, `CommandOutputView.swift` | `MessageView.tsx:97-130` | same | none |
| 35 | Code blocks, copy, edit diffs | `ChatMessageList.swift` markdown + `DiffStats.swift` | `MarkdownView.tsx`, `plan/EditPreview` (`MessageView.tsx:117`) | same | none |
| 36 | Copy a reply / a user message | `ChatMessageList.swift` context menu | `MessageView.tsx:162`, user copy `87185199` | same | none |
| 37 | Collapse older replies | `ChatMessageList.swift:879-915` | `MessageView.tsx:164-180` | same | none |
| 38 | Export a chat | none on the Mac chat panel | none | same | none |
| 39 | Empty state: title, line, 4 suggestion chips | `ChatMessageList.swift:402-451` | `ChatScreen.tsx:340` "Ask anything. Mode and model are below." | differs | Task 7 |
| 40 | Composer placeholder | `ChatComposer.swift:265` "Ask Claude about the attached code…" | `Composer.tsx:157` "Message" | differs | Task 7 |
| 41 | Ghost prediction from history (Tab accepts, Esc hides) | `ChatComposer.swift:289`, `:1021-1027` | none | missing | Task 10 (a hint line: a textarea cannot draw inline ghost text) |
| 42 | ↑/↓ history recall | `ChatComposer.swift:1029-` | `Composer.tsx:167-170` | same | none |
| 43 | Key hint ↵ | `ChatComposer.swift:520-526` | `Composer.tsx:37-39`, `:183` | same | none |
| 44 | ⌘↵ sends | `ChatComposer.swift:568` | Enter without Shift sends, which includes ⌘↵ (`Composer.tsx:165`) | same | none |
| 45 | Dictation (Cmd+M) | `CodeAssistant+Voice.swift`, `ChatComposer.swift:430` | `Composer.tsx:96-127`, `:175` | same | Position fixed by Task 4 (next to Send) |
| 46 | Plain-chat (no tools) bar + Allow tools | `ChatComposer.swift:107-136` | `Pickers.tsx:67`, `model-notices.tsx` | same | none |
| 47 | Provider-blocked bar | `ChatComposer.swift:138-152` | `ChatScreen.tsx:359` | same (false positive fixed by Task 1) | none |
| 48 | Pending model switch "Applies to your next message" | `ChatRouteControl.swift:76-79` | `Pickers.tsx:104-107` | same | none |
| 49 | Workspace trust banner | `CodeAssistantPanel.swift:420-428` | `surface.tsx:167` `TrustBanner` | same | none |
| 50 | Repeat-question save-to-memory nudge | `CodeAssistantPanel.swift:444-446` | none | missing | Later (needs a Rust write into the memory folder, `chat-triage.md` Batch B5) |
| 51 | Docked Code Assistant beside the editor | `Features/Explorer/Views/ExplorerView.swift:186-196` | `dock.tsx`, `ChatScreen.tsx:307` (`dock`) | same | none |
| 52 | Full-page Chat section | none (the Mac's chat was the docked panel) | `index.tsx:26-31` | desktop-only | Keep |
| 53 | Status bar chat item | AppShell status bar `llm-chat` badge | `ui/screens/shell/StatusBar.tsx:167-180` | same | none |
| 54 | Errors: turn error banner + Retry, store errors | `ChatMessageList.swift:940-990` | `ChatScreen.tsx:317-334` | same | none |
| 55 | Mac-synced custom providers (`source: "synced"`) | `CodeAssistantModelState+Providers.swift:76-86` (local list) | not listed (the route returns no models for them) | missing | Later: the core would need to return their model ids (API 123) |

## Counts

55 rows: 30 same, 15 differs (row 1 is the bug), 8 missing, 2 desktop-only. Row 47 is "same" but shows a false
positive today; Task 1 fixes that too.
The plan's 10 build tasks close rows 1-4, 6, 13, 17, 28, 33 and 39-41. Rows 5, 8, 10-12, 16, 24, 31, 50 and 55
are in its Later list.
