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
| Workspace | slider.horizontal.3 / sliders-horizontal | Profile preset picker, menu-bar toggles, Home opens, per-feature switches with dependency notes; hint that presets remove features and the server picks them up at next start. | PARTIAL | Shows the open project, notes folder and the core's feature set (read-only from /health) plus the Terminal switch. Profile presets, toolbar toggles and Home choice are not offered. | ui/screens/settings/sections/WorkspaceGroup.tsx, SimpleSections.tsx | Feature-profile host preference (presets, hidden toolbar items) and a Home-page preference. |
| Build | hammer / hammer | Apply & Rebuild (remove disabled code): compiled-feature status, staged build, Restart & Install. | SWIFT-ONLY | Group present; honest notice. | ui/screens/settings/sections/NoticeSections.tsx (BuildGroup) | Swift-only: Apply & Rebuild drives the Swift package build and swaps the installed .app. No desktop equivalent is planned. |
| Server & Backend | server.rack / server | Server URL (localhost only) + relaunch, Node binary and project folder paths, start backend on launch, Start/Stop/Kill & Restart, pid, live log with auto-scroll and clear. | PARTIAL | Read-only: backend status, API version, health checks, identity (spawned or adopted) and log file path from /health and host diagnostics. Server URL, paths, start/stop and the log viewer are not offered (the app starts and owns the core). | ui/screens/settings/sections/ServerSection.tsx, notices.ts (serverRows) | Host commands to restart the core and to tail its log (read-only tail). |
| Connections | tray.and.arrow.down / plug | Meetings (capture platforms + poll interval), Email, Slack, Box and catalog connector cards with fetch/sync actions. | NEEDS CORE ROUTE UI (routes exist) | Group present; notice pointing at the Library sources view. | ui/screens/settings/sections/NoticeSections.tsx (ConnectionsGroup) | Needs the connector catalog and per-source credential routes wired into a desktop card (the core routes exist; the desktop UI does not). |
| Updates & About | arrow.down.circle / circle-arrow-down | Automatic update checks (Sparkle) toggle, Check now, installed version and build, bundle id. | PARTIAL | App version, platform, core identity and log path, copyable diagnostics and the core request log (About). Update checks are not offered. | ui/screens/settings/sections/UpdatesSection.tsx, AboutSection.tsx | Host updater command (check, install, relaunch). |
| Mobile Control | iphone / smartphone | Enable, start on launch, port, pairing QR and PIN, paired devices with Revoke, phone permissions, iPhone browse indexes, connection log, Tailscale status. | SWIFT-ONLY | Group present; honest notice. | ui/screens/settings/sections/NoticeSections.tsx (MobileGroup) | Mobile Control hosting is Swift (WebSocket server, Bonjour, PIN cache). Needs a desktop host service and host commands before any control can be real. |
| General | globe / globe | Appearance (theme), menu-bar chat icon, synced Language (7 languages) and bilingual, 'Let plugins load natively'. | PARTIAL | WORKS: theme (host pref), Language and native plugins via /auth/me/prefs (whole-object PUT, rolled back on failure), and the Account sign-in/out (the Mac has it on its login screen). Menu-bar icon and bilingual are not offered. | ui/screens/settings/sections/GeneralSection.tsx, AccountSection.tsx, app-model.ts (UserPrefsModel) | Host tray command for the menu-bar icon; bilingual is a one-line addition once wanted. |
| Tool permissions | hand.raised / hand | Always-allow rules per project (tool + command prefix), revoke one, revoke all, legacy global grants. | WORKS NOW | Full: GET/DELETE /kb/agent/tool-approvals, rules grouped by project, typed REVOKE confirm for revoke-all, a failed load never reads as 'nothing allowed'. | ui/screens/settings/sections/ToolPermissionsSection.tsx, app-model.ts (ToolPermissionsModel) | - |
| Claude Agent SDK | shippingbox / package | Running / installed / latest version, Check now, Update (confirm, restarts the backend), restart note, remote-access guard. | WORKS NOW (no restart button) | Status, forced check (?force=1), Update behind a typed UPDATE confirm, scrubbed bounded log, canUpdate guard. After an update it says to restart the app (no host restart command). | ui/screens/settings/sections/AgentSdkSection.tsx, app-model.ts (AgentSdkModel) | Host command to restart the core, to offer a one-click restart. |
| Token Saving | leaf / leaf | rtk status, Homebrew install button, how to enable it. | NEEDS HOST COMMAND | Group present; notice. Prompt compression, router and token cap stay under Model routing. | ui/screens/settings/sections/NoticeSections.tsx (TokenSavingGroup) | Needs a host command that reports rtk's install state and runs the Homebrew install (a process the webview must not spawn). |
| Providers | key.horizontal / key-round | All connections in one list, add/test/disconnect, models, write-only keys. | WORKS NOW | Unchanged section, now the PROVIDERS group. | ui/screens/settings/sections/ProvidersSection.tsx | - |
| Model routing | dial.medium / gauge | Tiers and roles, fallback, per-model limits, switches. | WORKS NOW | Unchanged section (also holds router, token cap, compression and learned limits host prefs). | ui/screens/settings/sections/RoutingSection.tsx | - |
| Loop defaults | repeat / repeat | Protected-path policy, default stage timeouts, run summary note, templates. | NEEDS HOST COMMAND | Group present; notice. | ui/screens/settings/sections/NoticeSections.tsx (LoopDefaultsGroup) | Needs the Loop screen on the desktop and a host preference store for the defaults (the Mac keeps them in UserDefaults). |
| Doc Gen files | server.rack / hard-drive | Use-the-server-for-Doc-Gen-files switch (beta). | NEEDS HOST COMMAND | Group present; notice. | ui/screens/settings/sections/NoticeSections.tsx (DocGenGroup) | Needs a host preference (the Mac keeps docGenUseServerStore in UserDefaults) and the Doc Gen screen to honour it. |
| Agent history | clock.arrow.circlepath / rotate-ccw-clock | Storage, retention, clear, compact; Chat archive (live-then-archive) card. | WORKS NOW | Unchanged section; the Mac's separate Chat archive card is the archiving mode inside it (folded, test-pinned). | ui/screens/settings/sections/AgentHistorySection.tsx | - |
| Folder trust | lock.shield / shield-check | Trusted folders list with native consent before trusting. | WORKS NOW | Was half of 'Extensions trust'; now its own group. | ui/screens/settings/sections/ExtensionsTrustSection.tsx (TrustedFolders) | - |
| Extension sources | checklist / list-checks | Install allowlist: operator ceiling, your additions, add/remove. | WORKS NOW | Other half of 'Extensions trust'. | ui/screens/settings/sections/ExtensionsTrustSection.tsx (Allowlist) | - |
| Optional components | puzzlepiece.extension / puzzle | On-demand Mermaid download with pinned checksum, Remove. | NEEDS HOST COMMAND | Group present; notice. | ui/screens/settings/sections/NoticeSections.tsx (OptionalComponentsGroup) | Needs a host command that downloads a pinned component and verifies its checksum, plus the component store on disk. |
| Self-Heal | stethoscope / stethoscope | Record errors and propose fixes, incidents per run, proposals review (source checkouts only). | SWIFT-ONLY | Group present; notice. | ui/screens/settings/sections/NoticeSections.tsx (SelfHealGroup) | Swift-only (incident store and worktree repair). No desktop equivalent is planned. |
| Paths (Project) | folder.badge.gearshape / folder-cog | Project folders. | NEEDS HOST COMMAND | Notice; shown only while a project is open, like the Mac. | ui/screens/settings/sections/NoticeSections.tsx (PathsGroup) | Needs host commands to read and change the project's folder layout with a native folder dialog. |
| Repositories (Project) | arrow.triangle.branch / git-branch | GitHub and GitLab settings, repo allow-list. | NEEDS CORE ROUTE UI | Notice. | ui/screens/settings/sections/NoticeSections.tsx (RepositoriesGroup) | Needs the repo allow-list and provider token routes surfaced in a desktop card with write-only token fields. |
| Memory (Project) | brain / brain | Graph present?, agent memory files. | NEEDS HOST COMMAND | Notice. | ui/screens/settings/sections/NoticeSections.tsx (MemoryGroup) | Needs a host command that lists the project's system/memory files (a webview must not read the disk). |
| Code Graph (Project) | cube.transparent / network | Auto-update interval, truncation banner. | NEEDS HOST COMMAND | Notice. | ui/screens/settings/sections/NoticeSections.tsx (CodeGraphGroup) | Needs the graph auto-updater (Swift today) to exist on the desktop, and a host preference for its interval. |

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

1. Host commands: restart core + read core log (Server & Backend, Agent SDK restart); updater (Updates & About); tray icon (General); rtk install state (Token Saving);
   component download with checksum (Optional components); project folder layout and memory listing (Paths, Memory); feature-profile prefs (Workspace);
   Loop-defaults and doc-gen-server-store prefs (Loop defaults, Doc Gen files).
2. Desktop screens that own a setting: Loop (Loop defaults), Doc Gen honouring `docGenUseServerStore`, Code Graph auto-updater.
3. UI over existing core routes: connector catalog and per-source credentials (Connections); repo allow-list and provider tokens (Repositories).
4. Swift-only, no desktop equivalent planned: Build, Self-Heal, Mobile Control hosting.

## Needs a real window

Visual match of the header (icon colour, spacing, chevron rotation) against the Mac screenshot; keyboard Enter/Space on a header; focus ring;
scroll-into-view animation for a deep link; localStorage persistence across a webview reload; the Tauri webview's `scrollIntoView` inside the
scrolling `main`. Server-render and logic tests cover the structure, not these.
