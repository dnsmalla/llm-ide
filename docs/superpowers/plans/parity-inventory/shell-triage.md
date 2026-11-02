# Shell parity triage (verified)

Scope: 44 Mac labels from `mac/Sources/LlmIdeMac/Shell/` (AppShell, crash banner, account menu, project switcher,
quick switcher, status bar, login/reconnect, recovery prompts, welcome) with no literal match in the desktop.
First pass by Haiku (`g13-out.json`); every REAL_GAP and MAC_ONLY row, the RUNTIME row and 15 of 25 REWORDED
rows re-checked by Opus against source on 2026-11-02. Per-label result: `scratchpad/triage/shell-verified.json`.

## Counts

| Class | Haiku | Verified |
|---|---|---|
| REWORDED | 25 | 26 |
| REAL_GAP | 14 | 11 |
| MAC_ONLY | 4 | 6 |
| RUNTIME | 1 | 1 |
| DEAD_ON_MAC | 0 | 0 |

10 class changes, 3 more rows with corrected needs/effort (13 rows changed).

## Reclassifications

1. **"Registration is closed on this server..." REAL_GAP -> MAC_ONLY.** On the Mac it shows only in a race:
   `registrationOpen` defaults to true (LoginView.swift:23), is fetched once (:42, :431-434), and the text renders
   only if the user already switched to Register before the answer came back closed (:106-125). In steady state the
   Mac just hides the toggle, like the desktop. The desktop defaults `canRegister` to false (Panels.tsx:113) and
   offers Create account only after the core says it is open (:119-123, :201), so the state cannot occur.
2. **Legacy meetings export prompt (5 labels) REAL_GAP -> MAC_ONLY.** It is reachable on the Mac (AppShell.swift:450,
   :957-963, /kb/stats + /kb/export-all). But the desktop core never opens the Mac's pre-file-based DB:
   core_host.rs:1143-1157 pins `LLMIDE_DATA_DIR` and `LLMIDE_DB_PATH` to `<desktop data>/core` (in source mode too),
   and the desktop has no live capture that writes meetings. There is no legacy store to migrate.
3. **"Server out of date", "API too old" x2: MAC_ONLY -> REAL_GAP.** The premise that the desktop only runs its
   bundled core is wrong. Settings > Server has "Use a source checkout instead of the bundled core"
   (ServerSection.tsx:207-208, shown in every build at :93) -> prefs.rs:72-77 -> core_host.rs:1085-1109 spawns
   that checkout. `LLMIDE_ADOPT_CORE=1` (core_host.rs:61-64) can also adopt a foreign core. The desktop has no API
   floor (no min-API constant in ui/ or src-tauri; apiVersion is only displayed, AboutSection.tsx:44). The Mac
   enforces one (BackendManager.swift:987-1088).
4. **"Configure the backend path in Settings -> Backend first." MAC_ONLY -> REWORDED.** The desktop has the same
   backend form. Empty fields auto-detect. A bad path fails `runtime_for` (core_host.rs:1092/1101/1105), which
   `attempt()` reports through `set_failed` (:648-654), and the UI shows "Core failed" with the reason
   (status-view.ts:123-128).
5. **"Sign out and disconnect all accounts": needs core -> ui, effort M -> S.** No new route is needed:
   `POST /auth/me/secrets {key, value:null}` already deletes and audits one vault key (auth-routes.mjs:683-708). The
   desktop already uses it per provider in RepositoriesSection.tsx:122-130.
6. **Export Project Data / Export Plans: needs ui -> rust+ui.** `/kb/project/:id/export` (router.mjs:404-418) returns
   only a JSON bundle; the Mac writes the files itself (ProjectExporter.swift). The desktop has no KB project id to
   call it with: `ProjectInfo` is `{name, root}` (project.rs:38-41). The id is in `system/project.json`, which
   project.rs:255 checks for but never returns.

## Haiku caveats resolved

- **"Couldn't Open LLM Doc Folder"**: Haiku was right that the scope differs. On the Mac, a failed AppEnvironment
  init blocks the whole window (AppShell.swift:257, :378). The desktop has no single environment-init step: each
  screen reads its own data and fails on its own, so the Library's `LoadError` (library/States.tsx:27-33) is the
  equivalent. REWORDED stands. This is a difference in architecture, not a gap.
- **Welcome project explainer**: neither copy is out of date. Both apps create the same layout
  (project_scaffold.rs:30-48 is a port of ProjectScaffolder: source/, code/, data/, llm-doc/, system/...). The Mac
  copy names source/, llm-doc/, code/; the desktop copy (welcome/model.ts:116-117) names system/ and llm-doc/ and
  mentions source, code and data. Both are accurate, and the desktop copy is the more complete one. No change needed.
- **Sign-out dialog body** (AccountMenu.tsx:11) is misleading. It says provider keys and saved repositories stay
  "unless you choose to forget this device", but forget (forget-device.ts) removes the saved repositories
  (`llmide.repos.config`) and never removes the vault tokens. The copy fix is in Batch A.
- **REWORDED with minor differences** (classification kept): the approval badge opens the Chat section, while the
  Mac jumps to the oldest blocked session (Shell.tsx:261-267). Quick Switch lists the active project too
  (Shell.tsx:274), while the Mac excludes it.

## REWORDED spot-checks (15 of 25, plus 1 new)

Same control and same behaviour were confirmed at: library/States.tsx:27-33; SettingsScreen.tsx:86,93;
Shell.tsx:198-201 (Home x2); Shell.tsx:261-267 (approval x3); Shell.tsx:270-290 (quick switch x3);
ShellTerminalDock.tsx:61; graph/index.tsx:57 (x2); Panels.tsx:52-100 and status-view.ts:75/100/116 (start / starting /
unreachable); WelcomeScreen.tsx:135, :138-142, :209 and :48; welcome/model.ts:116-117.

## RUNTIME

"Recent" (ProjectSwitcher.swift:25) is confirmed as a section header only. The desktop lists the same recent
projects with a checkmark on the active one (StatusBar.tsx:25-33).

## Merged table by feature

| Feature | Final class | Labels | Evidence / gap | Needs | Effort | Risky | Safe now |
|---|---|---|---|---|---|---|---|
| Notes folder load failure | REWORDED | 1 | Per-screen LoadError, States.tsx:27-33 | - | - | - | - |
| Settings loading / back to projects | REWORDED | 3 | SettingsScreen.tsx:86; Shell.tsx:198 Home | - | - | - | - |
| Pending approval badge | REWORDED | 3 | Shell.tsx:261-267 (opens Chat, not the specific session) | - | - | - | - |
| Quick switch dialog | REWORDED | 3 | Shell.tsx:270-290 | - | - | - | - |
| Terminal toggle | REWORDED | 1 | ShellTerminalDock.tsx:61 | - | - | - | - |
| Graph page switch | REWORDED | 2 | graph/index.tsx:57 identical aria-label | - | - | - | - |
| Start/unreachable core panels | REWORDED | 7 | Panels.tsx:52-100, status-view.ts | - | - | - | - |
| Backend path not configured | REWORDED | 1 | runtime_for errors -> "Core failed" | - | - | - | - |
| Sign-out confirmation copy | REWORDED | 1 | AccountMenu.tsx:11 (copy inaccurate, see Batch A) | - | - | - | - |
| Welcome copy, guide, reset notice | REWORDED | 4 | WelcomeScreen.tsx, model.ts | - | - | - | - |
| Project switcher "Recent" | RUNTIME | 1 | header only | - | - | - | - |
| Closed-registration text | MAC_ONLY | 1 | Mac race artifact | - | - | - | - |
| Legacy meetings export prompt | MAC_ONLY | 5 | desktop DB is its own `<data>/core` | - | - | - | - |
| Disabled section explanation | REAL_GAP | 1 | Mac placeholder (AppShell.swift:1322-1335), reachable via ActivityBell `.openSection` (ActivityBell.swift:123) with no feature check; desktop silently redirects home (Shell.tsx:116-121) | ui | S | no | yes |
| Core API floor warning | REAL_GAP | 3 | Source checkout / adopted core can be older; no warning | ui | S | no | yes (one decision: the floor value) |
| Crash report banner | REAL_GAP | 1 | Panic hook (lib.rs:433-438) only kills children; nothing writes or scans a crash file; ErrorBoundary is per section, in-session only | rust+ui | M | low (crash text may contain paths) | after B review |
| Sign out and disconnect all accounts | REAL_GAP | 1 | Forget keeps vault tokens; existing route can delete per key | ui | S | yes (credentials) | HOLD |
| Project export (data + plans) | REAL_GAP | 2 | No export; no project id on desktop; Mac also exports on close | rust+ui | M | yes (writes project data) | HOLD |
| Unfinished recording recovery | REAL_GAP | 3 | Desktop never writes partial recordings (no Live) | rust (Live) | L | no | no: blocked on Live |

Totals: 26 REWORDED, 1 RUNTIME, 6 MAC_ONLY, 11 REAL_GAP = 44.

## Implementation batches

**A. Small, pure UI, safe now**
- Disabled section explanation: before redirecting, show a dismissible notice: "<Section> is turned off. Turn it on
  in Settings > Workspace" (or "not included in this build" when it was not compiled in).
- Core API floor warning: add a `MIN_CORE_API` constant beside the generated contract types, compare it with
  `/health.apiVersion`, and show a status-bar chip plus a hint in the core panel when the core is older. Product
  input needed: the floor value, and whether to tie it to SERVER_API_VERSION at build time.
- Sign-out dialog copy fix (AccountMenu.tsx:11): say that forget clears this device's settings and saved
  repositories, and that provider tokens stay until cleared in Settings > Repositories. Text only.
- Optional: exclude the active project from Quick Switch.

**B. UI plus a small host change**
- Crash report banner: the panic hook writes a bounded, redacted crash file (message, location, backtrace; no env)
  to `<data>/crashes/`. A startup command lists and reads pending files. The UI shows a banner with
  View / Copy / Reveal / Dismiss, where Dismiss moves the file to the trash or archives it. Unclean-exit detection
  (a sentinel file written at launch and removed on clean quit) is optional.

**C. Rust/core work or a product decision**
- Unfinished recording recovery: belongs to the Live capture feature (desktop Live is not built). Track it there.

**HOLD**
- **Sign out and disconnect all accounts** (revokes credentials). Recommendation: implement it in the UI with the
  existing route; no core change is needed. Safeguards:
  - a typed confirmation (the existing TypedConfirm), naming exactly what is removed;
  - delete only the keys `GET /auth/me/secrets` lists for this user, then clear `llmide.repos.config`;
  - report each key's result and never claim success on a partial failure;
  - sign out only after the deletes;
  - make no call when the core is untrusted (`trusted()` in core.ts);
  - keep project files and chat files.
  - Decide whether provider keys (not just git tokens) count as "accounts".
- **Project export / export on close** (writes project data). Recommendation: one host command,
  `project_export(kind)`. It reads the project id from `system/project.json`, fetches `/kb/project/:id/export`, and
  writes only under source/meetings and llm-doc/plans. Safeguards:
  - never overwrite: use create-new, and write a suffixed copy on a name clash or when the hash differs;
  - bounded size and file count;
  - a dry-run count shown before writing;
  - one export at a time;
  - no write outside the canonical project root;
  - a result summary with Reveal.
  - Product decision: whether Close project should export automatically, as on the Mac. Recommendation: no;
    keep export explicit.

## Not verified

- The remaining 10 REWORDED rows were not opened (Welcome guide hover and the quick-switch empty-state wordings
  were sampled through their neighbours).
- Whether the desktop's chat unbinding on sign-out matches "clears local chat history" exactly
  (chat_cmds.rs:148 unbinds; files are not deleted).
- That `spawn_server` passes `runtime_for` errors through unchanged. The call path was inferred from
  real_launch -> attempt; it was not traced line by line.
