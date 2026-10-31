# Desktop first-look audit (Mac app vs Tauri shell)

Date: 2026-10-31. Trigger: first real run of the Tauri app. User report: "there are no managed like the
current existing Mac app. I found nothing working; check the main page; the first look is very different."

Scope: what a brand-new user sees from launch to the first useful action. Read for the Mac:
`Shell/ContentView.swift`, `Shell/AppShell.swift`, `Shell/Welcome/{WelcomeView,RecentProjectsList}.swift`,
`Shell/Chrome/{HeaderAccountMenu,ProjectSwitcher}.swift`, `Shell/{LoginView,ReconnectView}.swift`,
`Core/Platform/ShellState.swift` (`resolveHome`), `Core/Contracts/ShellSection.swift` (`toolbarOrder`),
`Core/Platform/Config.swift` (`homeSection`, `hiddenSidebarSections`), `Core/Project/{ProjectStore,ProjectScaffolder,
ProjectSkillsInstaller}.swift`, `Features/Settings/Views/HelpGuideView.swift`. For the desktop:
`ui/screens/shell/{Shell.tsx,Panels.tsx,StatusBar.tsx,sections.ts,screens.tsx,project-store.ts,gate.ts,host.ts,use-shell.ts}`,
`desktop/src/{App,main}.tsx`, `desktop/src-tauri/src/project.rs`.

## 1. What a new user sees, step by step

| Step | Mac app | Desktop shell (before this work) |
|---|---|---|
| Launch | `ContentView`: "Connecting..." spinner while the session bootstraps | "Starting LLM-IDE..." splash, then the shell frame with the core chip "Starting core..." |
| Core down | `ReconnectView` / `LoginView` "Start Server" with plain reasons | `CoreDownPanel` over the content (equivalent, already good) |
| Login / register | Full-window `LoginView`; register link, "Registration is closed" note | `LoginPanel` overlay on top of the Chat screen (equivalent; the screen behind is a dead Chat) |
| After login, no project | `WelcomeView`: hero, "New Project" and "Open Existing" cards, "What counts as a project folder?" explainer, recents list, corrupt-recents banner, "New here? Open the guide" | Lands on **Chat** (`DEFAULT_SECTION`), composer disabled, tiny text "Open a project to send messages." No Welcome, no new-project path |
| Start a project | "New Project": save panel (parent + name), creates `<parent>/<name>`, scaffolds `source/ code/ data/ llm-doc/ templates/ commands/ system/ .claude/` + README/CLAUDE.md/AGENTS.md/GEMINI.md/.cursorrules/.gitignore, writes `system/project.json`, installs the skills kit through the server | Only the status-bar project switcher: "Open Folder..." (existing folder only). Nothing creates or scaffolds a project |
| Open existing | "Open Existing": folder panel; adopts any folder | Same host dialog, but hidden in a status-bar menu |
| Project home | `effectiveHome()`: the user's `homeSection` (default Code Graph, falls back to System, then Library) | Stays on whatever section was last stored; first run: Chat |
| Toolbar | `toolbarOrder`: Explorer, Code Graph, Auto Tasks, Review Conflicts, Issues, Gantt, Loop, Doc Gen, Visual, Library, Live (while recording); user can hide sections; Settings, Help, Permissions, Sign out in the account menu | Left nav: Chat, Explorer, Library, Settings, Code Graph, Issues & Gantt (disabled), Doc Gen, Visual, Auto Tasks (disabled), **Spike** (always visible) |
| Leave a project | Project switcher: "Close Project", recents, "Open Folder...", reveal/export | No close; only switch |
| Help | "New here? Open the guide" on Welcome; account menu "Help & Guide" | none |
| Recents | `ProjectStore.recents` (cap 10), unmounted-volume aware, corrupt-state archive + banner | Host `recent-projects.json`; invalid entries are silently dropped; no UI beyond the switcher menu |

## 2. Gaps ranked by user impact

1. **No Welcome / dead landing.** The first screen after sign-in is a Chat with a disabled composer. A new user has
   no visible next step. (Fix: Welcome page, shown whenever no project is active.)
2. **No way to create a project.** Only "open an existing folder". The Mac scaffolds the layout and registers the
   project; without it Doc Gen, skills, and `system/`/`llm-doc/` do not exist. (Fix: `project_create` + core register + skills install.)
3. **Wrong landing with a project.** Chat instead of a workspace home. (Fix: land on Explorer, remembered preference.)
4. **Navigation does not look like the Mac.** Order differs, Settings sits mid-list, a developer "Spike" item is shown
   to everyone. (Fix: Mac order, Spike behind a developer flag, Settings last.)
5. **Project-dependent screens explain themselves poorly.** One tiny line in Chat; other screens each have their own
   wording. (Fix: one shared "Open or create a project" card.)
6. **No way back to the start / no Close project / no Help.** (Fix: Home item, Close project, guide dialog.)
7. **Recents are opaque.** Missing or moved folders vanish silently; a reset list gives no explanation; no forget.
   (Fix: statuses with reasons, forget, reset notice.)
8. Not addressed in this pass (listed so they are not lost): auto-restore of the last project at launch (the Mac
   does it; the host's `ACTIVE` is process memory only), per-section hide list (`hiddenSidebarSections`), Account menu
   with Permissions, Help in a menu, Live in the toolbar, project export, ProjectMigrator.

## 3. Intentional differences (not gaps)

| Topic | Mac | Desktop | Decision |
|---|---|---|---|
| Chat | Embedded Code Assistant panel docked in Explorer/Library; no standalone Chat section | Chat is its own section AND a docked panel in Explorer (done 2026-10-31, shared runtime) | Keep Chat as a section (it is the only full-width, multi-session surface and the mobile/web parity target). **Follow-up, not built now:** an optional docked chat panel inside Explorer (`ChatPanelView` equivalent) reusing the same controller, so the Mac muscle memory works too. Recommendation: build it after the Explorer editor tabs settle; the dock must share the Chat section's session store, not fork it |
| Default home | Code Graph (System fallback) | Explorer | Explorer: it is the first section with real content on a fresh project; Code Graph needs a scan first. Users can change it (stored in shell prefs, localStorage `llmide.home`). **Decision needed:** match the Mac default (Code Graph) or keep Explorer |
| Settings placement | Account menu (gear) | Account menu (gear), Cmd/Ctrl+, | Done 2026-10-31: the toolbar's account menu mirrors the Mac's (Settings, Help & Guide, Permissions, Sign out) |
| Project folder rule | Empty or `system/project.json` folders only for "New" | Open accepts any folder (as before); New always creates a fresh folder | New creates `<parent>/<name>` and refuses an existing one (no overwrite) |
| Registration | The Mac client registers with the server | The webview registers with the core after the host creates the files | Failures are warnings; the project works without skills and Doc Gen registers again on open |
| Last project at launch | Restored | Not restored | **Decision needed.** Recommendation: restore (Welcome stays reachable via Home), after the Welcome work is verified in a real window |

## 4. Plan (this change set)

(a) Welcome page, (b) New project + `project_create`, (c) landing/home preference/Close project, (d) nav order and
Spike gating, (e)(f) shared "no project" card, (g) clean-data-dir end-to-end test. Security: project names and recents
are untrusted text (rendered as text, bidi/control stripped, length-capped); nothing here deletes user data; "forget"
edits only the recent list.

Settings now mirrors the Mac's single App page (collapsible groups, same order): see [2026-10-31-settings-mirror-map.md](2026-10-31-settings-mirror-map.md).

## 5. Status 2026-10-31 (mirror-the-Mac pass: toolbar, chrome, Explorer dock)

Built, unit-tested, not GUI-verified (user decision: the desktop mirrors the Mac's look and functions):

- Left nav replaced by the Mac's top toolbar (Home, section buttons in `ShellSection.toolbarOrder` order with icon and label, Soon for
  sections without a desktop screen, roving focus, More menu on narrow windows) and the account menu; the Mac order and labels are drift-checked.
- Native window chrome on macOS: overlay title bar, traffic lights in the toolbar row, drag regions, platform reported by the host.
- Status bar: project switcher and core chip (before), activity bell over `/kb/activity`, Chat item. Developer-tools switch in Settings > General.
- Explorer-first layout: panel switcher, editor tabs and the right-hand docked Code Assistant sharing the Chat section's runtime.

Gap 8 items now closed: Account menu with Permissions and Help, Settings in the account menu. Still open: auto-restore of the last project,
per-section hide list, Live in the toolbar, project export, ProjectMigrator. What only a real window verifies: traffic-light spacing and
drag, overflow at real widths, dock drag-resize, full-screen behaviour on macOS, focus order across toolbar, editor and dock.
