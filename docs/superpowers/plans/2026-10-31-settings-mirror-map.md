# Settings mirror map (2026-10-31)

Decision (2026-10-31): "I like the existing look best: mirror the app and function too, like the existing Mac app."
The desktop Settings is now the Mac's single **App** page: a centred column (max 720 px) of collapsible group rows, in the
Mac's order, default collapsed, expanded state remembered per group id in the webview's localStorage
(`settings.group.<id>.expanded`). Source of truth for the list: `mac/Sources/LlmIdeMac/Features/Settings/Views/SettingsView.swift`
plus the cards `Shell/FeatureCatalog.swift` registers into its slots. `scripts/extract-settings-groups.mjs` parses both, and
`ui/screens/settings/tests/groups.test.ts` fails when the desktop list (titles, order, SF Symbols) drifts from the Mac.

## How the Mac page is built

- Header (`Core/DesignSystem/Components/SettingsSectionCard.swift`): SF Symbol (13 pt, accent2), UPPERCASE `SectionLabel` (12 pt),
  chevron.right rotating 90 degrees when open. Collapsed by default; state persisted per title in UserDefaults
  (`settings.section.<title>.expanded`). Content sits in a card below the header.
- The page: title "App" (muted), then the App groups, then (only with a project open) a "Project" block. Slots (`SettingsSectionSlot`)
  let features contribute cards; on the desktop a slot is a group id (`registry.registerCard(<groupId>, ...)`).
- Deep link: `.scrollSettingsToCard` scrolls to an anchor. On the desktop `goto-section` with `anchor: "<groupId>"` (or `settings:<groupId>`,
  or an old anchor such as `about`/`routing`) expands and scrolls to that group.

## Group by group

Statuses: WORKS NOW, PARTIAL, NEEDS HOST COMMAND, NEEDS CORE ROUTE UI, SWIFT-ONLY. A group that is not fully done still shows
its real header; when open it carries a note or an honest status card, never a control that does nothing.

| Group | SF Symbol / icon | Mac content | Status | Desktop today | Files | Blocked by |
|---|---|---|---|---|---|---|
| Workspace | slider.horizontal.3 / sliders-horizontal | Profile preset picker, menu-bar toggles, Home opens, per-feature switches with dependency notes; hint that presets remove features and the server picks them up at next start. | PARTIAL | Real: the open project, Home page picker (`llmide.home`, applied at once), the full feature profile, and Build (source checkouts): compiled vs stored profile and Apply & Rebuild — presets (Full / Focused / Minimal / Custom), one switch per feature with the Mac's dependency rule (turning File Explorer off drops Graph, Gantt and Doc Gen), compiled-out features disabled with a reason, stored vs running shown, and “applies the next time the app opens”. Toolbar visibility toggles are not offered. | ui/screens/settings/sections/WorkspaceGroup.tsx, FeatureProfileSection.tsx, BuildSection.tsx, ui/screens/shell/features.ts | Per-section toolbar visibility (hidden toolbar items). |
| Server & Backend | server.rack / server | Server URL, Node/project paths, launch toggle, status, Kill & Restart, log viewer; the Claude Agent SDK update and restart are folded in. | PARTIAL | Real: source-checkout mode with editable Node binary, extension folder and loopback URL/port (host pickers/auto-detect), the launch toggle (next app start), live server URL, status/version/health/identity/log path, full log viewer, and Start / Stop / Kill & Restart through host commands. Source paths apply on Kill & Restart. The bundled core remains the default. | ui/screens/settings/sections/ServerSection.tsx, desktop/src-tauri/src/core_host.rs, backend_pick.rs | Pull-to-restart/backoff editing per Mac UI is not offered. |
| Updates & About | arrow.down.circle / circle-arrow-down | Automatic update checks (Sparkle) toggle, Check now, installed version and build, bundle id. | PARTIAL | App version, platform, core identity and log path, copyable diagnostics and the core request log (About). Update checks are not offered. | ui/screens/settings/sections/UpdatesSection.tsx, AboutSection.tsx | Host updater command (check, install, relaunch). |
| Phone and browser | iphone / smartphone | Host API pairing (PIN and QR, paired devices with Revoke) and offline sync for the iPhone and web apps. The Mac app's Mobile Control was retired with the Swift app (2026-11-06). | WORKS | Live sections. | ui/screens/settings/sections/MobileBridge.tsx (HostApiPairing, SyncSection) | — |
| Team | person.3 / circle-user | Not on the Mac (new in ADR 0021): the hub's members and their single-use invites. | WORKS NOW (H2 local/UI part) | Owner/admin only (`/auth/me.member.teamRole`); members with email, display name, role, max mode, monthly USD cap and status; PATCH role/max mode/cap with the server's self-grant, owner and last-owner rules enforced in the form; invite flow with the token shown once, Copy, and an explicit cannot-be-shown-again warning; invites listed without tokens and revoked behind a confirmation. The group is hidden for member/viewer and while the role is unknown. VPS/TLS hub mode remains H2 work. | ui/screens/settings/sections/TeamSection.tsx, team-view.tsx, team-model.ts | Hub reachability (VPS/TLS, `LLMIDE_HUB=1`) is the remaining H2 part; the UI talks to API 123 on the core it is signed in to. |
| General | globe / globe | Appearance (theme), menu-bar chat icon, synced Language (7 languages) and bilingual, 'Let plugins load natively'. | PARTIAL | WORKS: theme (host pref), the menu-bar icon switch (host tray; hiding it also turns close-to-tray off), Language and native plugins via /auth/me/prefs (whole-object PUT, rolled back on failure), and the Account sign-in/out (the Mac has it on its login screen). Bilingual is not offered. | ui/screens/settings/sections/GeneralSection.tsx, misc-model.ts, AccountSection.tsx, app-model.ts (UserPrefsModel) | Bilingual is Planned; the menu-bar icon is real. |
| Providers | key.horizontal / key-round | All connections in one list, add/test/disconnect, models, write-only keys; the built-in Claude subscription row and the CLI checks for Codex and Gemini. | WORKS NOW | Connections (catalog + Claude-compatible), test/models/remove, write-only keys; plus the built-in rows: Claude on the local `claude login` (CLI check + keyless model count via `/kb/providers/verify` mode cli and `/kb/providers/models`), Codex and Gemini CLI checks, and DeepSeek key-only. Built-in cards hold no key. | ui/screens/settings/sections/ProvidersSection.tsx, BuiltinProviders.tsx, builtin-providers.ts | - (keyless Codex/Gemini selection in the chat picker is not offered yet) |
| Model routing | dial.medium / gauge | Tiers and roles, fallback, per-model limits, switches. | WORKS NOW | Unchanged section (also holds router, token cap, compression and learned limits host prefs). | ui/screens/settings/sections/RoutingSection.tsx | - |
| Agent history | clock.arrow.circlepath / rotate-ccw-clock | Storage, retention, clear, compact; Chat archive (live-then-archive) card. | WORKS NOW | Unchanged section; the Mac's separate Chat archive card is the archiving mode inside it (folded, test-pinned). | ui/screens/settings/sections/AgentHistorySection.tsx | - |
| Trust & permissions | lock.shield / shield-check | Always-allow rules, trusted folders, and the install allowlist. | WORKS NOW | One security group: revocable tool rules, native consent before trusting a folder, and add/remove of extension sources. | ui/screens/settings/sections/TrustGroup.tsx, ExtensionsTrustSection.tsx | - |
| Optional components | puzzlepiece.extension / puzzle | On-demand Mermaid download, plus the rtk Token Saving card. | WORKS NOW | Mermaid status/install/remove with pinned checksum; rtk detection, Homebrew install and enable hint folded in. | ui/screens/settings/sections/OptionalComponentsSection.tsx, components-model.ts | - |
| Self-Heal | stethoscope / stethoscope | Record errors and propose fixes, incidents per run, proposals review (source checkouts only). | DEBUG-ONLY | Debug builds: the recorded incidents with Ignore, Refresh and Clear all; Try to fix (one agent run in a git worktree of the source checkout, then make test and make regression there) and the proposals it leaves, with Review, Apply (into the checkout, never a commit) and Discard; release builds hide the group. | ui/screens/settings/sections/SelfHealSection.tsx | None (plan 2026-11-07-self-heal-b-fix-loop.md). |
| Paths (Project) | folder.badge.gearshape / folder-cog | The project folders with descriptions, Reveal in Finder, the notes folder/+index strip, and Rebuild missing folders. | PARTIAL | The project root and every canonical folder with the Mac's explanations, Present/Missing and Show in Finder (from `project_paths`, active root only); a notes-folder row with the sync badge and an Open Library link; and Rebuild missing folders through `project_rebuild_folders` (idempotent, never overwrites existing files). The layout itself is not editable, and the index rebuild stays in Library. | ui/screens/settings/sections/PathsSection.tsx, project-model.ts | Host commands to change the project's folder layout with a native folder dialog; a notes-index rebuild entry point here. |
| Repositories (Project) | arrow.triangle.branch / git-branch | GitHub and GitLab tabs: access token + Save & verify/Clear, primary provider, per-provider automation allow-list, saved repositories with clone/sync. | PARTIAL | The Mac's two provider tabs, write-only token fields (saved to the core vault, only names read back), primary-provider switch, the full per-provider automation checklist, and saved repository rows (display name, URL, clone path defaulting to the project's `code/` from Paths, active, remove) are real. Tokens persist in the core vault (`github.token`, `gitlab.token`); the rest is local app config. Clone repository is real (host git clone into `code/`, token from the session or pasted for one clone, registered with the core allow-list, Library picks it up on its next visit). Not yet: verifying the token against the provider, pull/re-sync, and the Mac's resolve step. The desktop-only folder allow-list was removed (Library → Sources owns that list). | ui/screens/settings/sections/RepositoriesSection.tsx, repo-config.ts, sources-model.ts, desktop/src-tauri/src/repo_clone.rs | Token verification and pull/re-sync need provider HTTP and git pull; the card says so. |
| Memory (Project) | brain / brain | Graph present?, agent memory files. | WORKS NOW | Knowledge graph row (generated or not, size) and the plain files under `system/` (name, size), each with Show in Finder, from `project_memory` (active root only, databases and dotfiles hidden, 200-file bound). | ui/screens/settings/sections/MemorySection.tsx, project-model.ts | - |
| Code Graph (Project) | cube.transparent / network | Auto-update interval, truncation banner. | DONE (timer; file-watch and truncation banner Mac-only) | Real card. | ui/screens/settings/sections/CodeGraphSection.tsx | Host timer reads the stored interval live. |

Mac cards folded into another group: **Chat archive** (inside Agent history). **GitHub** / **GitLab** render inside Repositories on the Mac and
are not groups. The Mac's **Meeting capture matrix** lives inside Connections.

## Where the old desktop sections went

| Old desktop section | Now |
|---|---|
| Providers | Providers |
| Model routing | Model routing |
| Agent history | Agent history |
| Extensions trust (Trusted folders) | Folder trust |
| Extensions trust (Install allowlist) | Extension sources |
| Appearance | General (Appearance) |
| Account | General (sign in / out; the Mac has no Account card, its login screen does this) |
| Workspace | Workspace |
| Features (+ Terminal switch) | Workspace |
| About | Updates & About |

Old anchors still resolve (`routing`, `extensions-trust`, `about`, `account`, `appearance`, `features`).

## Blocked-by summary (what to build next)

1. Host commands: none outstanding for restart and log (both exist: host.coreRestart, host.coreLog); remaining: updater (Updates & About); tray icon (General); rtk install state (Token Saving);
   component download with checksum (Optional components); project folder layout and memory listing (Paths, Memory); feature-profile prefs (Workspace);
   Loop-defaults and doc-gen-server-store prefs (Loop defaults, Doc Gen files).
2. Desktop screens that own a setting: Loop (Loop defaults), Doc Gen honouring `docGenUseServerStore`, Code Graph timer (auto-updater is timer-based; file watch Mac-only).
3. UI over existing core routes: connector catalog and per-source credentials (Connections); repo allow-list and provider tokens (Repositories).
4. Swift-only, no desktop equivalent planned: Build, Mobile Control hosting. Self-Heal records incidents and runs its manual fix loop in debug builds (plans 2026-11-07-self-heal-a-incidents.md and 2026-11-07-self-heal-b-fix-loop.md).

## Needs a real window

Visual match of the header (icon colour, spacing, chevron rotation) against the Mac screenshot; keyboard Enter/Space on a header; focus ring;
scroll-into-view animation for a deep link; localStorage persistence across a webview reload; the Tauri webview's `scrollIntoView` inside the
scrolling `main`. Server-render and logic tests cover the structure, not these.
