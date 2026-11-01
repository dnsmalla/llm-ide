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
| 1 | Explorer | `Features/Explorer/` | `ui/screens/explorer/` | reveal/copy, previews, file clipboard done; PDF/search-replace pending |
| 2 | Chat | `Features/Chat/` | `ui/screens/chat/` | auto-attach done; memory/voice/pickers/approvals pending |
| 3 | Terminal | `Features/Terminal/` | terminal dock | shell-wide dock/status/persistence done; cwd/title pending |
| 4 | Graph (System + Code graph) | `Features/CodeGraph/` | `ui/screens/graph/` | Code/InfiniteBrain/All generate done; target picker/routines/storage pending |
| 5 | Auto Tasks | `Features/AutoTask/` | `ui/screens/autotasks/` | bridge, permissions, two-pane/logs done; setup/custom pending |
| 6 | Review Conflicts | `Features/ReviewConflicts/` | `ui/screens/review/` | tabs/linked/refresh/viewer done |
| 7 | Issues | `Features/Issues/` | `ui/screens/issues/` | detail/columns/filter/shortcuts done |
| 8 | Gantt | `Features/Issues/Gantt/` | `ui/screens/gantt/` | month/today/filters/validation done |
| 9 | Loop | `Features/Loop/` | `ui/screens/loop/` | bridge, permissions, history/poll done; budgets/approvals pending |
| 10 | Doc Gen | `Features/Generation/DocGen/` | `ui/screens/docgen/` | manual edit/Preview/Raw done; chat/output/templates pending |
| 11 | Visual | `Features/Generation/Visual/` | `ui/screens/docgen/visual.tsx` | audited, fixes pending |
| 12 | Library | `Features/Library/` | `ui/screens/library/` | project root, meetings-first, collapsible groups done; single-list merge pending |
| 13 | Settings | `Features/Settings/` | `ui/screens/settings/` | toolbar/SDK/notices/login done; updates/accounts/providers pending |
| 14 | Home / Welcome | `Shell/Welcome/` | `ui/screens/welcome/` | Home target done; recency/banner pending |
| 15 | Shell chrome | `Shell/AppShell.swift`, status bar | `ui/screens/shell/` | activity/home done; approvals/terminal pending |

## Findings (from the per-surface audits)

### Explorer / Chat / Terminal
- Terminal is now shell-wide with a status-bar toggle and persisted height; Explorer keeps its embedded dock.
- Explorer now has Reveal in Finder, Copy Absolute Path, Markdown Preview/Source, PNG/JPEG/GIF/WebP preview and an internal cut/copy/paste clipboard; still no PDF preview or search replace; no file cut/copy/paste; Search has no replace or
  Find-in-Folder hand-off; no Reveal in Finder per row; Project Folders sheet cannot create/reindex; no git
  gutter; open-file hand-off drops the line number.
- Chat now auto-attaches the active Explorer file in the Code Assistant; still no project-memory chip/viewer, voice dictation; flat
  model picker (no grouped/provider/effort/custom); no per-turn retry/usage/collapse/jump; dock header lacks
  counters/search/rename/delete; no app-wide pending-approval badge; context meter has no breakdown.
- Terminal: the dock is now shell-wide and its height persists; tab titles are still static and cwd is always
  the project root.

### Graph / Doc Gen / Visual
- Graph System: missing routines and storage card; stale on project switch; openFile unvalidated; failures not
  surfaced; no deep link to the Code page.
- Graph Code: Code/InfiniteBrain/All generation is done; no scan target/repo quick-pick/Library tree; only zoom controls; missing
  auto-update settings card (D→M and M→D gaps both exist).
- Doc Gen: manual edit and Preview/Raw are done; still no Use-chat toggle, output destination, chat panel/
  Save-chat-output, template import/command editing, or panel toggles.
- Visual: images cannot be sources or previewed; no thumbnail strip or visual result affordance; tab/panel
  state not persisted; checklist promises interactions that are not wired.

### Issues / Gantt / Review Conflicts
- Issues: no detail/editor surface (now a read-only cached detail pane), no create/comment/close/drag, thin
  filters, columns diverged (fixed), metadata missing (core lacks it), provider/repo ignores saved repos,
  silent 100-row cap, no screen shortcuts.
- Gantt: no milestone/edges, day/week only (month added), no today line/scroll, no legend, thin filters
  (search/state added), one-line rows, no issue detail/context menu, due<start was silently swapped (now
  rejected), silent 100-row cap, no ⌘R.
- Review: no tabs (done), no chrome/tree toggle, no New Change, chat state not persisted (done), fixed tree
  roots, no linked-repo banner (done), stale on project switch (done), raw `<pre>` viewer (markdown done).

### Auto Tasks / Loop
- Desktop toggles/templates were refused by the Mac tier gate before the bridge (fixed with a loopback
  desktop class that may use D-tier writes); bridge error frames are now surfaced.
- Auto Tasks is a flat list, not Mac's list+detail; no groups/filter/custom tasks/model-limits/banners;
  "History" is the action-items registry, not run history; live logs requested but dropped.
- Loop history is never requested; budgets/policy/wizard/multi-loop home are Mac-only over the wire;
  iteration is hard-coded 0 but rendered as authoritative; no live polling while running; shell-stage
  approvals have no desktop path.

### Library
- Desktop now uses the active project's `llm-doc` as its notes root (Settings → Paths owns the layout) and hides
  the separate notes-folder chooser while a project is open; Code/Data are top-level rows and Connections was
  renamed/moved to Connectors. Remaining: it is still a stacked nav+list, not Mac's one sectioned list; section set/order differs (no Connectors
  section, extra All notes); no collapse/persistence; filters are section-scoped; rows lack gist/counts/
  icons/states; detail chrome lacks Export/backfill/banners; no context menus; Code/Data refresh stale;
  extensions/connectors are panes, not counted list sections; no per-section empty/retry/index status.

### Settings / Home / Shell
- Settings: no toolbar visibility (now added), pending-approval badge, Updates controls, second account
  sign-out, full sign-in affordances, provider row editing, routing reconcile, agent-history fields. Server
  URL/log auto-scroll/pid/relaunch and Mobile Control/Loop defaults/Self-Heal/Code Graph auto-update are
  host/Mac limits or planned.
- Shell: Home always went to Welcome (now effective home); Activity rows were inert (now navigate); no
  pending-approval badge; no version-too-old state; crash/notification surfaces missing.

## Execution order

1. Shell + Library structure (the navigation frame users see first).
2. Settings groups with missing real controls.
3. Explorer + Chat + Terminal.
4. Issues + Gantt + Review Conflicts.
5. Graph + Doc Gen + Visual.
6. Auto Tasks + Loop bridge depth.
7. Home/status bar/account/activity.
