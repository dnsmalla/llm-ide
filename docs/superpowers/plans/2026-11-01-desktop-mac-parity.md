# Desktop ↔ Mac end-to-end parity

Date: 2026-11-01. Goal: every top-level menu and shared surface matches the frozen Swift Mac app in structure,
views, controls and functions; Mac-only limits are stated in the UI, not faked. Parity first, upgrades after.

## Method

1. Per-surface audits compare the Swift feature folder with the desktop screen folder and the shell wiring.
2. Every gap is classified: **Fix** (desktop can match), **Bridge** (Mac engine via Mobile Control), **Mac-only**
   (architecture/host limit), or **Upgrade** (after parity).
3. Slices land menu by menu, each with its own tests and a rebuilt app; gates: `make test-desktop`,
   `node desktop/scripts/check-capabilities.mjs`, `make contract-gates`, Mac build/tests when Mac code changes.

## Surfaces

| # | Surface | Mac source | Desktop source | Status |
|---|---|---|---|---|
| 1 | Explorer | `Features/Explorer/` | `ui/screens/explorer/` | reveal/copy, previews, clipboard, replace-all, PDF open |
| 2 | Chat | `Features/Chat/` | `ui/screens/chat/` | badge, context/memory, dictation, copy, usage, retry, dock rename/delete |
| 3 | Terminal | `Features/Terminal/` | terminal dock | shell dock/status/persistence/title/cwd done |
| 4 | Graph (System + Code graph) | `Features/CodeGraph/` | `ui/screens/graph/` | modes + scan target; routines/storage Mac-only |
| 5 | Auto Tasks | `Features/AutoTask/` | `ui/screens/autotasks/` | bridge, list+detail, logs, setup snapshot; custom/editing Mac-only |
| 6 | Review Conflicts | `Features/ReviewConflicts/` | `ui/screens/review/` | tabs/linked/refresh/viewer done |
| 7 | Issues | `Features/Issues/` | `ui/screens/issues/` | detail/columns/filter/shortcuts/saved-repo picker done |
| 8 | Gantt | `Features/Issues/Gantt/` | `ui/screens/gantt/` | month/today/filters/validation done |
| 9 | Loop | `Features/Loop/` | `ui/screens/loop/` | bridge, history/poll; budgets/policy Mac-only |
| 10 | Doc Gen | `Features/Generation/DocGen/` | `ui/screens/docgen/` | destination, Use chat, templates/import, commands, chat column |
| 11 | Visual | `Features/Generation/Visual/` | `ui/screens/docgen/visual.tsx` | image sources, source preview and sibling-source thumbnails done; result viewer pending |
| 12 | Library | `Features/Library/` | `ui/screens/library/` | single scroll, gist, toolbar/re-summarize/export, menus/prefs/⌘F |
| 13 | Settings | `Features/Settings/` | `ui/screens/settings/` | toolbar/SDK/login/providers edit/sign-out-forget; updates honest note |
| 14 | Home / Welcome | `Shell/Welcome/` | `ui/screens/welcome/` | Home target, reset banner; recency timestamps Mac-only |
| 15 | Shell chrome | `Shell/AppShell.swift`, status bar, app menu | `ui/screens/shell/`, `src-tauri/src/menu.rs` | activity/home/approvals/terminal + native app menu |

## Final state (round 40)

### Explorer / Chat / Terminal
- **Explorer**: Reveal in Finder, Copy Absolute Path, Markdown Preview/Source, PNG/JPEG/GIF/WebP preview, internal cut/copy/paste, Replace All, and PDF **Open in Preview** (the webview cannot embed PDFs). Still absent: inline PDF, Find in Folder, git gutter, line-number hand-off.
- **Chat**: active-file auto-attach, pending-approval badge, context breakdown, memory chip, upload/turn copy, token usage, per-message retry, dictation where the webview exposes a recogniser, and dock rename/delete. Still absent: project-memory viewer, grouped model/effort picker, cross-chat approval aggregation (the shell badge follows the active chat).
- **Terminal**: shell-wide dock, persisted height, status-bar toggle, OSC titles, new shells in the active repository clone.

### Graph / Doc Gen / Visual
- **Graph**: Code / InfiniteBrain / All generation through the Mac-style left run panel; no desktop-only mode/scan presets, no arbitrary graph.json opener. The bundled GraphKit CLI runs from a temp `.cjs` copy (a checkout app under `desktop/` otherwise makes Node treat it as ESM and every generate fails); a lost WebGL context rebuilds the view automatically with the saved camera. Empty `llm-doc` reports why InfiniteBrain has nothing to draw. Routines/storage, the Mac Library tree/quick-pick and 3D canvas remain Mac-local.
- **Doc Gen**: editable result, Preview/Raw, configurable project-relative destination, Use-chat source, Markdown template import, template/command management, embedded Chat column. The Mac-only destination providers (Box/Slack/email) are shown as not wired.
- **Visual**: image sources, source preview and a sibling-source thumbnail strip are real. The core returns text for Visual, so there is no image result viewer to mirror; the Mac’s local result image viewer has no desktop equivalent.

### Issues / Gantt / Review Conflicts
- **Issues**: read-only cached detail, Mac column order, label/state filters, saved-repository picker, shortcuts. Create/comment/close/drag need provider write routes the core does not expose, so they remain absent; metadata is core-limited.
- **Gantt**: month zoom, today, filters, due-before-start rejection, reload, paging. Milestones/edges are not in the core issue model.
- **Review Conflicts**: tabs, resizable persisted chat, project-change reload, linked repo, Markdown rendering. “New Change” remains a Mac/chat-workflow surface.

### Auto Tasks / Loop
- **Auto Tasks**: bridge, desktop-class permission, list+detail, toggle/run/stop, per-task live log, setup snapshot. Pairing lives only in Settings → Mobile Control; the page states when the Mac app is not connected. Custom tasks/edits stay on the Mac.
- **Loop**: bridge, status/stages, start/stop, polling, past runs, honest max iterations. Budgets/policy/wizard/multi-loop and shell-stage approvals are Mac-only over the wire.

### Library
- **Library**: active project `llm-doc`, one continuous scroll with notes + Sources/Code/Data/LLM Doc/Extensions/Connectors sections, Mac search-bar wording, sections collapsed on open, gist rows, ⌘F, persisted filters/sort/group/section, row context menu, and detail toolbar with Re-summarise/⌘R, Copy path, Reveal, Export. The desktop-only New note/Select notes/filter/sort bars are hidden to match the Mac list; action/decision/blocker chips and platform icons would need the Mac’s local meeting index.

### Settings / Home / Shell
- **Settings**: toolbar visibility, provider edit, SDK restart, source/server controls, sign-out and Sign out-and-forget. Updates are the Mac’s Sparkle surface; the desktop shows the honest note. Account sign-out variants collapse to one local account.
- **Home / Shell**: effective Home, activity navigation, approval badge, version-too-old/crash/notification surfaces remain limited by the host. Welcome recency timestamps are not stored by the desktop recent-projects file.


### Native app menu (round 41)

The menu bar is built in `desktop/src-tauri/src/menu.rs` and checked against a SwiftUI menu dump of the same
`WindowGroup` + command groups. Commands emit one `app-menu` event; `ui/screens/shell/menu-model.ts` maps the
navigation commands. The matrix is item-by-item:

| Menu | Item | Desktop |
|---|---|---|
| LLM-IDE | About LLM-IDE | Working (native About) |
| LLM-IDE | Check for Updates… | Mac-only (Sparkle feed); omitted |
| LLM-IDE | Settings… | Not in the Mac app menu; the account menu owns Settings |
| LLM-IDE | Services / Hide / Hide Others / Show All / Quit | Working (native) |
| File | New Window (⌘N) | Disabled: a second window would start signed out (one authenticated webview) |
| File | Close (⌘W) | Working |
| File | Close All (⇧⌘W) | Working (closes every window) |
| Edit | Undo / Redo / Cut / Copy / Paste / Select All | Working (native) |
| Edit | Delete / Writing Tools / AutoFill / Dictation / Emoji | OS text services, handled by the webview; not duplicated as fake items |
| View | — | Empty, matching the Mac's View group |
| Window | Minimize / Zoom / Bring All to Front | Working (native) |
| Window | Quick Switch Project… (⌘P) | Opens Home (the Mac opens an overlay; no desktop overlay yet) |
| Window | LLM Chat… (⇧⌘L) | Opens the Chat section |
| Window | Start/Stop Recording (⌘N) | Mac-only live-capture engine; omitted |
| Window | LLM-IDE window list | Main Window entry focuses the window |
| Help | LLM-IDE Help | Opens the Welcome guide |
| Help | Toggle Sidebar (⇧⌘S) | Mac sidebar only; no desktop sidebar |

Desktop-only fields (mode/scan presets, pairing forms) were removed from the screens they did not belong to:
Auto Tasks/Loop pair in Settings → Mobile Control, and Graph uses the left run panel.

### Account menu and menu-bar extra

- The account menu now matches the Mac shape: name/email, Settings…, Help & Guide, Permissions…, a divider, and a
  single **Sign out** row. The confirmation dialog offers **Sign out** and **Sign out and forget this device**
  (local UI settings only; provider credentials are not revoked because the desktop has no Keychain wipe).
- The Mac's `MenuBarExtra` is a global quick-chat popover. The desktop tray is a project/window quick menu; the
  quick-chat popover is Mac-only and is not faked.


## Mac-only limits (stated in the UI, never faked)

| Area | Why the desktop cannot mirror it |
|---|---|
| Updates | The desktop bundle has no Sparkle/updater channel; Settings shows the Mac-only note. |
| Issues write actions | Core exposes read/index routes only; create/comment/close/drag need provider clients the desktop does not have. |
| Gantt milestones/edges | The core issue model has no milestone/edge fields. |
| Review New Change | Depends on the Mac’s chat/code-workflow sheet. |
| Graph routines/storage | Mac-local host state; there are no desktop host commands or routes. |
| Loop budgets/policy/wizard | Not in the Mobile Control wire; the Mac remains the source of truth. |
| Auto Task custom tasks/editing | The bridge carries a read-only setup snapshot; mutations stay on the Mac. |
| Visual image result | The core generation response is text; image artifacts are a Mac-local view. |
| Library entity chips | The Mac’s local meeting index supplies counts; the desktop has no equivalent SQLite index. |
| Welcome recency timestamps | The desktop recent-projects file stores paths only. |

## Execution order

1. Shell + Library structure (the navigation frame users see first).
2. Settings groups with missing real controls.
3. Explorer + Chat + Terminal.
4. Issues + Gantt + Review Conflicts.
5. Graph + Doc Gen + Visual.
6. Auto Tasks + Loop bridge depth.
7. Home/status bar/account/activity.
