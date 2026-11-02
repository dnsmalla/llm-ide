# Extensions parity triage (verified)

Date: 2026-11-02. Scope: the Mac labels under `mac/Sources/LlmIdeMac/Features/Extensions/Views/` that `scripts/parity-inventory.mjs` could not find in the desktop code. Three Haiku passes (g04, g05, g06) classified them. One Opus pass checked them against the Mac and desktop sources and the server routes. Per-label results: `scratchpad/triage/extensions-verified.json` (152 objects: one per text and site, `verifiedBy: "opus"`, `changed`, `changeReason`, `batch`, `route`).

## Counts

| Class | Haiku (objects) | Verified (objects) | Haiku (unique texts) | Verified (unique texts) |
|---|---|---|---|---|
| REAL_GAP | 92 | 90 | 89 | 87 |
| REWORDED | 45 | 48 | 43 | 46 |
| RUNTIME | 15 | 14 | 13 | 12 |
| MAC_ONLY / DEAD_ON_MAC | 0 | 0 | 0 | 0 |
| Total | 152 | 152 | 145 | 145 |

The total is 145 unique texts and not 146 because "Git URL", "Branch or tag (optional)" and "main" appear on three sheets each, and "Retry" sits in both a gap feature and a reworded one. When a text has several sites, the unique-text count uses its REAL_GAP class.

Four labels changed class. 35 objects changed in some way (class, needs, effort or risk). The REAL_GAP count fell only 2%, much less than the roughly 40% in the Chat round. Here, every Mac view is reachable and nearly all the legacy dialogs really are missing on the desktop. The larger correction is where the work goes: 47 of the 90 gap objects (F01, F04, F06, F07, F14, F16, F18) are held, because they install or run code, register commands or write secrets. 31 are safe pure UI (Batch A) and 12 need a small host or core-client change (Batch B).

## Checks

- **Reachability on the Mac.** All the sheets, panes and rows run in the live app. `ExtensionsSeams.install` (ExtensionsLibrarySections.swift:532-576) supplies the Library's Plugins, LLM Sources, MCP Plugins and Extensions sections and their detail panes, and `LibraryView.swift:272,706` embeds them through `ExtensionsLibraryRegistry`. The header menus open each sheet: Plugins at :60-153, LLM Sources at :258-284, MCP at :372-452. `PluginUpdateSection` is used by `PluginDetailView.swift:56`. `PluginUpdateConfirmSheet` is presented at :145-154. No label is DEAD_ON_MAC.
- **What the desktop has.** The desktop's legacy panes (`LegacyPane.tsx`, `legacy.ts`) support listing, the on/off switch, MCP consent and revoke, plugin hook trust and revoke, and "Reload list". "Reload list" only re-reads the list with GET; it does not call `/plugins/reload`. `ExtCore.request` (api.ts:37) takes only JSON GET and POST requests. The panes have no detail views and no add, import, update or remove actions.
- **REWORDED.** I opened the cited desktop file and line for 38 of the 48 REWORDED objects (79%). All 38 are the same control with the same behaviour: `ExtensionsTrustSection.tsx:20-96` (7), `Sheets.tsx:36-112,215-236` (9), `ExtensionsScreen.tsx:44-63` (4), `InstalledTab.tsx:170-272` (7), `InstallTab.tsx:19-83` (6), `BrowseTab.tsx:74-130` (6, including Indexes) and `LegacyPane.tsx:15,91,145-153` (2). The 10 I did not reopen are short phrasings of the same controls. Haiku's REWORDED calls held up with no errors.
- **RUNTIME.** 12 of the 13 are decoration: placeholders such as `main`, `/path/to/repo`, `my-server`, the npx example and the example URLs; the middle-dot separator; and accessibility strings ("Allow <kind>", "<name>, <type> member", "Extensions: browse and manage", "mcp__<id>"). "Claude" is the exception. It is a provenance badge built from the `origin` field, so I moved it into F09.
- **Haiku caveats.**
  1. g04 said the schema fixtures were missing. They exist under `schema/http/fixtures/health-auth/` (claude-plugins and codex-plugins installed, marketplace, updates, import 400/401/404, refresh 200, and so on). What is really missing is the 200 fixtures for `claude-plugins/import`, `codex-plugins/import`, `plugins/install`, `llm-sources/add` and `llm-sources/update`.
  2. g06 said `plugin_git_install` might be superseded. It is (F05).
  3. g05 said several gaps need Rust. Only F03 (Reveal plugin folder) needs a host command. Zip install needs a binary body in the core client, not Rust. Git install is superseded. Marketplace should be a server-side catalog index source, not a Rust clone.

## Feature table

| ID | Feature (sheet or control) | Final class | Labels | Evidence | Missing / needs / effort / risky | Safe now |
|---|---|---|---|---|---|---|
| F01 | Claude/Codex plugin import sheets plus the two menu items | REAL_GAP | 11 (14 objects) | No desktop caller of `/auth/me/{claude,codex}-plugins/*` | Missing: scan list, filter, Import button, Retry. Needs ui, M, risky | HOLD |
| F02 | Plugins: Reload from disk | REAL_GAP | 1 | Desktop "Reload list" only re-GETs | Missing: call `POST /auth/me/plugins/reload {}` (admin) and show `count`/`warnings`. ui, S | Yes (A) |
| F03 | Plugins: Reveal plugin folder | REAL_GAP | 1 | `reveal_in_os` takes a project-relative path only | Missing: a host reveal of `pluginDir` (absolute path from `GET /auth/me/plugins`). shell, S | B |
| F04 | Install or replace a plugin from a .zip (menu item, install alert, replace alert, "Replace from file") | REAL_GAP | 6 | ExtCore has no binary body | Missing: file pick, `POST /auth/me/plugins/install[?replace=1&expect=]` with a raw zip body (5 MB cap) and the `X-LLMIDE-Plugin-Source` header, admin, 409 leads to the Replace prompt. shell + ui, M, risky | HOLD |
| F05 | Plugin install from a Git URL | REWORDED (was REAL_GAP) | 3 | The catalog Install tab does this server-side (`POST /auth/me/extensions/install`, pinned commit, allowlist, installed off) | Residue: hosts other than GitHub and `git@` URLs (product decision C-1) | n/a |
| F06 | Plugin marketplace sheet (Add marketplace, Choose another, Filter, Replace, Not installable) | REAL_GAP | 6 | No server route. The Mac clones client-side. Catalog `install` refuses marketplace repos (422 `MARKETPLACE`) | Missing: browsing an arbitrary marketplace repo. Needs a core route and a product decision (C-2), L, risky | HOLD |
| F07 | Legacy plugin update: apply, Update all, confirm sheet (Command, Accept and update), Check for plugin updates (forced) | REAL_GAP | 4 | Update preview exists for catalog items only | Missing: `POST /auth/me/claude-plugins/update {name, acceptCommand?}` (admin; runs `claude plugin update`, re-imports), `GET …/updates?force=1`. Git and marketplace origins re-clone client-side on the Mac. ui, L, risky | HOLD |
| F08 | Legacy plugin update status (row badge, Checking, No update reported) | REAL_GAP | 3 | Not shown | Missing: read-only `GET /auth/me/claude-plugins/updates` and `/auth/me/codex-plugins/updates` (cached, no admin). ui, S | Yes (A) |
| F09 | Plugin detail pane (About, slash commands, subagents, components, unsupported/pending notes, "Imported from Claude Code", origin badge, not-found state) | REAL_GAP | 10 | `GET /auth/me/plugins` already returns `commands`, `subagents`, `origin`, `sourceVersion`, `installSource`, `unsupportedComponents`, `pendingComponents`, `nativePluginsOn`, `trustOutdatedKinds` (registry.mjs:389-457); legacy.ts decodes none of them | Missing: decoders and a read-only pane; hook trust stays on the existing sheet. ui, M | Yes (A) |
| F10 | Add LLM source sheet (Git URL, branch, local folder with Choose, name) | REAL_GAP | 9 | Not on the desktop | Missing: `POST /auth/me/llm-sources/add {url or path, ref?, name?}` (admin; the server clones shallowly, no Rust). Choose needs `pick_folder` + `pick_folder_redeem` (exist in shell/settings-adapter.ts) wired into Library extensions. ui + small host wiring, M | B |
| F11 | LLM source detail pane (discovery lists for skills, agents, hooks and MCP; per-item checkboxes with All/None; New marker; update status; Update; not-found state) | REAL_GAP | 9 | Not on the desktop; MASTER-PLAN lists "per-item LLM-source checkboxes" as open | Missing: `GET /auth/me/llm-sources/<id>/discovery` (admin, read-only), `POST /auth/me/llm-sources/items {sourceId, kind, names[], enabled}`, `GET …/updates[?force=1]`, `POST …/update {id}` (admin). ui, M (Haiku said L) | Yes (A) |
| F12 | LLM source: Apply to Project and its "Selection changed" line | REAL_GAP | 2 | Not on the desktop | Missing: `POST /kb/project/install-skills {path, language}` with the open project's absolute path from the host. shell + ui, S | B |
| F13 | LLM source row status (update available, not installed) | REAL_GAP | 2 | `installed` is decoded but not shown | Missing: the badge (from `GET /auth/me/llm-sources/updates`) and the "not installed" tag. ui, S | Yes (A) |
| F14 | MCP add: from the catalog (plus the argument sheet), from Claude Code, from Codex, Rescan, the manual sheet (stdio/http/sse, command line, OAuth note) | REAL_GAP | 14 | Not on the desktop | Missing: `GET /auth/me/mcp-plugins/catalog`; `GET …/claude-sources` and `…/codex-sources` (admin); `POST /auth/me/mcp-plugins/add` taking `{catalogId, arg?, name?}`, `{claudeName}`, `{codexName}` or `{name, transport, command, args, url}` (admin). ui, M, risky | HOLD |
| F15 | MCP plugin detail pane (not-found state; command, env names, source) | REAL_GAP | 1 | Rows only | Missing: a read-only pane over `GET /auth/me/mcp-plugins`. ui, M | Yes (A) |
| F16 | MCP credential save ("will fail to authenticate", Save Credential) | REAL_GAP | 2 | The desktop shows only a "Credential missing" badge | Missing: decode `credential.vaultKey` and label; write-only `POST /auth/me/secrets {key, value}` (already used by sources/source-core.ts). ui, S, risky | HOLD |
| F17 | MCP version status (Version, lookup error, newer-version badge) | REAL_GAP | 3 | Not shown | Missing: `GET /auth/me/mcp-plugins/updates` (force is admin-only). ui, S | Yes (A) |
| F18 | MCP version update and Re-sync from Claude Code/Codex | REAL_GAP | 1 | Not on the desktop | Missing: `POST /auth/me/mcp-plugins/<id>/update {to?, expectArgs?}`, `GET\|POST …/<id>/resync` (admin). Both change what runs. ui, M, risky | HOLD |
| F19 | Catalog empty state: "Install from URL" button | REAL_GAP | 1 | InstalledTab.tsx:268-271 has the text but no button | Missing: a button that calls `model.showTab("install")`. ui, S | Yes (A) |
| F20 | Catalog: "Open repository" link | REAL_GAP | 1 | The repo name is shown as text only (BrowseTab.tsx:29, InstalledTab.tsx:43,144) | Missing: pass `open_external_url` (library/index.tsx) into ExtensionsScreen; validate with safe-url.ts. ui, S | Yes (A) |
| F21 | Catalog screen: Installed, Browse, Install, consent, update preview, confirms | REWORDED | 35 (36 objects) | Verified line by line above | none | n/a |
| F22 | Folder trust and Extension sources (Settings) | REWORDED | 7 | ExtensionsTrustSection.tsx:20-96 | none | n/a |
| F23 | Legacy list error text and MCP consent rule | REWORDED | 2 | LegacyPane.tsx:15,145-153; legacy.ts:318-326 | none | n/a |
| F24 | Decoration | RUNTIME | 12 (14 objects) | Placeholders, separator, accessibility strings | none | n/a |

## Reclassifications and corrections

- **F05, three labels from REAL_GAP to REWORDED** ("Install from Git URL…", "Install plugin from Git URL", "Public HTTPS or git@ URL…"). The catalog Install tab already installs a plugin from a GitHub URL. It does this server-side, pinned to a commit, behind the allowlist and the consent sheet, which is safer than the Mac's client-side clone. Only hosts other than GitHub are uncovered.
- **"Claude" (PluginLibraryRow.swift:31), from RUNTIME to REAL_GAP.** It is a provenance badge built from the `origin` field, not decoration. It belongs to F09.
- **F04 needs: rust to shell.** The webview can read a picked file. The core client needs a binary body and one header.
- **F06 needs: rust to core plus a product decision.** Marketplace browsing should be a server-side user-added catalog index source. `docs/spec/extensions-catalog.md:246` lists that as out of scope today.
- **F11 effort: L to M.** All four routes exist, have fixtures, and discovery is read-only.
- **F12 needs: ui to shell.** The route needs the open project's absolute path.
- **F07 and F08 split.** The read-only status (badge, Checking, No update reported) is safe UI and goes to Batch A. Applying an update and the forced check run the claude CLI and code, so they are held.
- **Haiku risk flags corrected.** F09, F13, F15, F17 and the F11 display were flagged risky; they are read-only displays, so not risky. F02 (Reload) is not risky: it rescans the plugin folder, new plugins come up off, and hooks stay untrusted.
- **g04's fixture claim was wrong.** The fixtures are under `fixtures/health-auth/`. Only the success (200) fixtures for the write routes are missing.
- **Gap the scanner hides.** The desktop has no Remove or Uninstall for legacy plugins, LLM sources or MCP servers (`DELETE /auth/me/plugins/uninstall/<name>`, `DELETE /auth/me/llm-sources/<id>`, `DELETE /auth/me/mcp-plugins/<id>`; ExtCore also lacks DELETE). The scanner saw the labels "Uninstall" and "Remove" only because the catalog uses them. Treat it as Batch B: core-client DELETE plus a confirm dialog.

## Implementation batches

**A. Small, pure UI, safe now.** These use existing routes, are read-only or switch things off only, and run no code.
F19 Install-from-URL shortcut. F20 Open repository link (`open_external_url` plus safe-url). F02 Reload from disk. F13 LLM source row status. F17 MCP version status. F08 legacy plugin update status (cached GET only). F09 plugin detail pane (decode the fields that already exist). F15 MCP detail pane. F11 LLM source detail pane: discovery, per-item checkboxes, update status, and Update. Update re-pulls an already registered source; its agents and hooks are listed only and never run (registry safety note).

**B. UI plus a small host or core-client change.**
F03 Reveal plugin folder: a host command that reveals only the `pluginDir` the core reports, compared against the host's own resolved path, never an arbitrary one. F10 Add LLM source: wire `pick_folder`/`pick_folder_redeem` into Library extensions, show a confirm naming the URL or path, and show whether the new source starts on. F12 Apply to Project: the host passes the open project root. Legacy Remove/Uninstall (hidden gap): DELETE in ExtCore plus a confirm.

**C. Core route or product decision.**
- C-1: Do we want installs from hosts other than GitHub or from `git@` URLs? Recommendation: no. Keep the catalog's GitHub-only, allowlisted, pinned path.
- C-2: Marketplace repos (F06). Recommendation: build them as user-added catalog index sources on the server, using the same pin, allowlist and scan rules. Do not build a Rust clone.
- C-3: Add the missing 200 fixtures for import, install, `llm-sources/add` and `llm-sources/update` before any HOLD item is built.

**HOLD.** Each of these installs or runs plugin code, registers a stdio command or writes a secret.
- **F01 Claude/Codex import** (admin-only, copies vendor plugin code). Safeguards: admin-only on the server stays; the import never enables the plugin; hooks and MCP stay untrusted until the existing hook-trust and consent sheets (the server's `importWithTrustCheck` clears old grants on re-import); show the `alreadyImported` and `importedVersion` diff; no bulk import.
- **F04 zip install and replace.** Safeguards: a host file picker, never a typed path; size cap enforced on the client too; `expect=<name>` on every replace; the 409 Replace prompt names the installed version; installs come up off and trust is reset (the server already does this); show `trustReset`.
- **F06 marketplace.** Hold until C-2 is decided.
- **F07 legacy plugin update apply.** Safeguards: show the exact `claude plugin update` command; `acceptCommand` must equal the hash of the command shown; refuse while a chat turn runs (the server checks this); no "Update all" without a per-item preview; git and marketplace origins wait for C-2.
- **F14 MCP add.** Safeguards: an add never consents or enables; the consent sheet shows the full command, arguments and URL, as the desktop already does; the manual form splits arguments exactly as the server stores them and previews them; imported env values are never shown (the server redacts them); admin-only stays; prefer catalog entries, resolved by id on the server.
- **F16 MCP credential.** Safeguards: the key comes only from the server-declared `credential.vaultKey`; write-only field; never echoed; cleared after save; reuse `source-core.ts writeSecret`. Lowest risk of the HOLD items, so it can go first.
- **F18 MCP update and Re-sync.** Safeguards: show the before and after command; send `expectArgs`; confirm whether consent resets when the command changes (not verified in this pass).

## Not verified

- Whether a newly added LLM source starts on or off for the user. Check `llm-sources/registry.mjs addSource` and `state.mjs` before F10.
- Whether `POST /auth/me/mcp-plugins/<id>/update` clears MCP consent when the pinned arguments change.
- How the Mac checks updates for git and marketplace plugin origins on the client (`PluginSourceUpdateChecker`). It is not mirrored by any server route, so F08 covers only Claude- and Codex-imported plugins.
- Nothing was run in a real window.
