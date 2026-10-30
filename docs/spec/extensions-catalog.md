---
title: Extensions catalog (phases P0 to P5 server half and installed-item loading) — spec
status: draft
---

This is the contract for the first five phases of the extensions catalog ([plan](../superpowers/plans/2026-10-31-extensions-catalog.md)): one item model over plugins, MCP servers and LLM sources, a computed active set, consumers that honour it behind a flag, and extensions on provider-adapter turns. P4 adds four HTTP routes (API version 93, §9); the server half of P5 adds updates, rollback, repair, catalog indexes with search and the active view (API version 94, §9b). There is no new SSE event and no Mac UI yet: the Mac Extensions screen and the allowlist setting are the next step.

Governing decisions (user, 2026-10-30): every download is user-initiated; scan findings only warn; one global extension format where each engine uses what it supports and silently skips the rest; plugin hooks run only on Claude SDK turns; on a provider-adapter turn the user's active MCP servers and plugin tools are mounted automatically when provider tools are allowed and the model can call tools.

---

## §1 Files

| Path | Role |
|---|---|
| `extension/llm_agent/extensions/model.mjs` | Item model: kinds, ids, members, trust, `normalizeItem` |
| `extension/llm_agent/extensions/store.mjs` | The catalog's switch overlay file |
| `extension/llm_agent/extensions/gate.mjs` | The switch view consumers read; `gateFor`, `makeGate`, `mcpServerGate` |
| `extension/llm_agent/extensions/importer.mjs` | Reads the three legacy state files into items; writes nothing |
| `extension/llm_agent/extensions/active-set.mjs` | `computeActiveSet`, `summarizeActiveSet` |
| `extension/llm_agent/extensions/shadow.mjs` | Daily counts-only compare of the active set with what a turn loaded |
| `extension/llm_agent/extensions/view.mjs` | Generated plugin view for unchecked members |
| `extension/llm_agent/extensions/mcp-servers.mjs` | `buildUserMcpServers` (moved out of the engine; no SDK import) |
| `extension/llm_agent/extensions/flags.mjs` | The kill switches (`LLMIDE_EXT_ACTIVE_SET`, `_ADAPTER`, `_SHADOW`, `_CATALOG`, `_SCAN`) |
| `extension/providers/adapter/mcp-client.mjs` | The MCP client for adapter turns (the only importer of the MCP SDK besides `extension/connectors/mcp-client.mjs`) |
| `extension/llm_agent/adapter/mcp-mount.mjs` | Policy: which servers, approvals, framing, limits |

The layer rule is unchanged: `llm_agent/extensions/` may import core, kb, server, providers, graphkit, plugins, llm-sources and mcp. ESLint fences `@modelcontextprotocol/sdk` to `connectors/mcp-client.mjs` and `providers/adapter/` (`extension/tests/eslint-mcp-sdk-fence.test.mjs`). No new dependency: the SDK is already pinned exactly (1.30.0).

## §2 Item model

- **Kinds:** `skill`, `plugin`, `mcp`, `llm-source`. **Trust levels:** `official`, `verified`, `community`, `unknown`, `local`.
- **Id:** `<kind>:<publisher>/<name>`; publisher and name match `[a-z0-9][a-z0-9._-]{0,63}`. Anything else is slugged (a non-ASCII lookalike becomes `-`) or refused by `parseItemId`.
- **Member id:** `<type>:<name>`, type one of `skill command agent template hook mcp lsp bin`, name 1 to 120 printable characters (a third-party name may be any text). `hook`, `mcp`, `lsp` and `bin` are executable members.
- **Source:** the shape `plugins/source-store.mjs` already validates (`git`, `marketplace`, `zip`; https public host, no credentials, no query or fragment; `commit` is 40 hex and is the pin, `ref` only a hint), or `{ kind: 'local' }`.
- **Trust from source:** `github.com/anthropics/*` is `official`; any other recorded git or marketplace source is `unknown`; no source is `local`. An imported item is never reported as `verified` or `community` except a catalog-bundled MCP server (`community`); nothing here can earn more.
- **State per user:** `enabled`, `disabledMembers` (unchecked ids: a member nobody unchecked is on, including one that arrived with an update), `consents`.

## §3 State and the importer

The three legacy files stay the written source of truth and are never changed by this code:

| File (next to the plugin dir) | Read as |
|---|---|
| `plugin-state.json` (+ `plugin-sources.json`) | plugin `enabled`, hook trust and kinds, provenance |
| `llm-sources.json` + `llm-sources-state.json` | source `enabled` (no entry means the builtin source is on) and per-source `disabledItems` as unchecked members |
| `mcp-plugins.json` + `mcp-plugins-state.json` | MCP `enabled` AND `consented`; a plugin-declared server also needs its plugin on |

`importCatalogItems(userId, { plugins })` returns `{ items, warnings, corrupt }`. A reader that fails or finds an odd shape costs its section (empty, which reads as "nothing enabled") and adds a warning; an invalid provenance record is ignored with a warning and the plugin imports as local. Each item keeps `legacy` (what the old file said) beside `state` (after the overlay).

**Store decision.** A JSON overlay, not a SQL table: the three sources are files, the overlay can only restrict until P4 installs anything, and no migration is needed (next free migration number when P4 needs SQL: 0055). File: `<plugin dir>/../extensions-state.json`, `{ "version": 1, "users": { "<userId>": { "items": { "<itemId>": { "enabled": false, "disabledMembers": ["skill:x"] } } } } }`, atomic tmp+rename, mode `0600`, writers merge. Only `enabled: false` and `disabledMembers` have an effect; `enabled: true` is recorded and changes nothing. A file that exists but cannot be read is reported `corrupt`: writers refuse to overwrite it and consumers fail closed (§4).

## §4 The gate

A gate only restricts what the legacy builders already allow. Items match by kind and name (the publisher segment of an overlay id is ignored: a mismatch can only switch more off). Methods: `pluginActive`, `pluginMemberActive`, `pluginDisabledMembers`, `llmSourceActive`, `librarySkillActive`, `mcpActive`, `signature`, `failClosed`. With `failClosed` (corrupt overlay) every method answers off, so nothing loads for a flag-on consumer; the legacy files already fail toward "nothing enabled".

`gateFor(userId)` returns `null` unless `LLMIDE_EXT_ACTIVE_SET` is on. Every legacy builder takes an optional `gate`: `undefined` resolves `gateFor`, `null` forces the legacy behaviour, an object forces that gate.

## §5 Consumers behind `LLMIDE_EXT_ACTIVE_SET` (default off)

| Consumer | With the flag on |
|---|---|
| `buildUserPluginDelivery` (SDK `plugins`, translated hooks) | a switched-off plugin is not delivered; unchecked skill, command or agent members are absent from a generated view (§6); unchecking `hook:hooks` removes the hooks and the trust requirement for that plugin; a plugin the view cannot filter exactly is not delivered (`onExcluded` reports why) |
| `buildPerUserSkillSet` | plugin and member switches apply to skills, commands, subagents |
| `listSkillLibrary`, `readSkillInstructions`, `load-skill`, the `/` menu | the source switch and `skill:<name>` members apply inside the build, before the first-wins dedupe, so a same-id skill from a later source can stand in; the gated result is cached under the gate `signature`, never in the legacy slot |
| `buildUserMcpServers` | a server switched off is not mounted or pre-approved; a plugin-declared server also follows its plugin and its `mcp:<server>` member |

With the flag off nothing reads the overlay. `extension/tests/extensions-baseline.test.mjs` pins today's output (golden `extension/tests/fixtures/extensions-baseline/baseline.json`); `extension/tests/extensions-consumers.test.mjs` proves flag off and flag on with nothing switched off are byte-identical to it, and that switched-off items never load.

## §6 The generated plugin view

For a Claude-format plugin with unchecked members, `materializePluginView` builds `<plugin dir>/../extensions/views/<sha256(userId)[0..16]>/<plugin>-<stamp16>/`, where the stamp covers user, plugin, version, unchecked set and the plugin's mtimes. It copies every top-level entry except `skills`, `commands`, `agents`, `.mcp.json` and `.git`, rebuilds those three from the checked members, omits `hooks`, `bin` or `.lsp.json` when that member is unchecked, never copies a symbolic link, and removes views of the same plugin with an older stamp. It refuses (the plugin is then not delivered) when the manifest relocates `skills`, `commands` or `agents`, or declares hooks inline while hooks are unchecked. Whether the SDK honours a generated subset root exactly like a full plugin is the plan's open item R3, unverified.

## §7 Active set and shadow compare

`computeActiveSet(userId, mode, opts)` runs the same builders through `makeGate` and returns `skills`, `pluginSkills`, `commands`, `subagents`, `sdkPlugins`, `nativePlugins`, `translatedPlugins`, `hooks`, `mcpServers` (configs, which can hold a vault-resolved credential: never log), `allowedTools`, `items`, `excluded`, `failClosed`, `warnings` and `fingerprint` (sha256 over active item ids with pin or version, unchecked members, loaded skill, command and subagent identities, delivery names and a hash of each MCP config). It is always computable; the flag decides who reads it. `summarizeActiveSet` is counts only.

`runTurnShadow` runs from the v2 engine once per user per local day: it compares the active set with the plugins, plugin skills, commands, subagents and MCP servers the turn actually loaded and logs counts only (`extensions_shadow`, or `extensions_shadow_mismatch` as a warning when the flag is on and anything differs). With the flag off, an item the overlay switched off appears as `onlyLegacy`: exactly what turning the flag on would change. It is off under `NODE_ENV=test` unless `LLMIDE_EXT_SHADOW` is set.

## §8 Provider-adapter turns

`runProviderTurn` calls `mountMcpTools` after building its own tools, only when provider tools are allowed and the model is tool-capable.

- **Which servers:** `buildUserMcpServers(userId, mode, { gate: makeGate(userId) })`: enabled, consented, catalog-active, none in a restricted mode (`plan`, `assist_plan`, `review`, `ask`, `document`), a server named `llmide` never. The catalog overlay is honoured here whatever `LLMIDE_EXT_ACTIVE_SET` says.
- **Switch:** `LLMIDE_EXT_ADAPTER`, default on; `off`, `0` or `false` mounts nothing and starts no process.
- **Names:** `mcp__<server>__<tool>`, characters outside `[A-Za-z0-9_-]` become `_`, at most 64 characters (longer pairs keep an 8-hex hash), collisions get a numeric suffix.
- **Permission:** every call ALWAYS parks a `ToolApproval` request (the existing card, answered by `POST /agent/v2/decision`); egress auto-approve (fetch-url, web-search) does not apply and there is no switch yet; a denial never reaches the server.
- **Untrusted data:** results go through `fenceToolResult`; each tool description is prefixed with a note that the server wrote it and it is untrusted, stripped of C0/C1 controls, zero-width and bidi characters and `<<<...>>>` markers, and cut to 1 000 characters (1 200 with the prefix).
- **Limits:** connect and list 15 s per server (in parallel), one call 60 s, 48 tools per server, 96 per turn, a tool schema over 16 000 characters of JSON is skipped, all tools of a turn share a 60 000-character budget of tool JSON (tools past it are dropped and reported), connect and list share one 15 s budget, at most 4 list pages, a non-streaming HTTP response is cut at 5 MB (event streams excepted), a result is cut at 30 000 characters while it is read (the wire event keeps the existing 20 000), non-text content becomes a placeholder.
- **Transport:** stdio runs `command` with the SDK's default safe environment plus the record's `env`, stderr ignored, with cwd the workspace root when there is one, else an empty private temp dir removed at close. The command is launched through `providers/adapter/spawn-group.mjs`, which gives it its own process group and kills the group when the server exits, on SIGTERM/SIGINT/SIGHUP, or when the parent disappears. Every string in a tool schema is cleaned like a description; a schema key carrying hidden text drops the tool. The client declares no capabilities (no sampling, roots or elicitation). HTTP and SSE go through `makePinnedFetch` with `allowPrivate: false` and `assertProviderBaseUrl` (a query string is allowed on an MCP url and is checked separately): a local or private address is refused before any connection, so a local server is a stdio one on this path. Redirects are refused.
- **Lifecycle:** connected per turn, closed (process group killed) when the turn ends, on cancel, when the model cannot be created, and when anything throws after connecting. A notice of kind `extensions_mcp` (level `info`) lists the connected servers and tool counts and says each call asks first; a server that fails costs its tools and one `warning` notice, and tools dropped by the 60 000-character budget cause another (all sent before `init`).
- **Reporting:** `init.mcpServers` is `[{ name, status }]` with `connected` or `failed` (the existing schema); `init.tools` lists the mounted names. Skills are not added to `init` (no schema field); `load-skill` is already one of the mounted tools.
- **Hooks:** plugin hooks do not exist on this path and are skipped without a notice or error.
- **Audit:** `mcp_tool_invoked` with tool name, user, milliseconds and outcome, never arguments or results.

## §9 Sources and install (P4)

A user's request is the only trigger: nothing is fetched in the background, and the server never reads a catalog or index in this phase. Flags: `LLMIDE_EXT_CATALOG` (default on; `off` refuses install with 404 `CATALOG_DISABLED`), `LLMIDE_EXT_SCAN` (default on; `off` skips the scan), `LLMIDE_EXT_ALLOWED_SOURCES` (comma list of `owner/repo` globs; unset or blank means `anthropics/*,modelcontextprotocol/*`; a `*/*` entry allows any GitHub repository; the operator adds repositories through this variable, `extension/.env.example` documents it; a Settings screen for it is pending).

| Path | Role |
|---|---|
| `extension/llm_agent/extensions/sources/github.mjs` | `parseRepoUrl`, `resolveCommit`, `downloadArchive`, `sourceAllowed` |
| `extension/llm_agent/extensions/sources/tar.mjs` | `extractTarGz`: in-memory reader for the gzip'd tar |
| `extension/llm_agent/extensions/inspect.mjs` | `inspectTree`: kind, name, members, declared executable kinds, permission summary |
| `extension/llm_agent/extensions/scan.mjs` | `scanTree`: the warn-only instruction scan |
| `extension/llm_agent/extensions/installed.mjs` | The installed registry file and store paths |
| `extension/llm_agent/extensions/installed-runtime.mjs` | Installed items as plugin objects, library skills and MCP configs (§9a) |
| `extension/llm_agent/extensions/install.mjs` | `installFromGithub`, `listInstalled`, `setInstalledEnabled`, `setInstalledMembers`, `uninstall`, `forgetUserExtensions` |
| `extension/routes/extensions-catalog.mjs` | The four routes below, and the P5 routes of §9b |

- **Source:** only `https://github.com/<owner>/<repo>` (optionally `.git`; no other host, port, credentials, query or fragment). Two hosts are contacted, over https, through the SSRF-pinned fetch (`makePinnedFetch`, no private addresses), without credentials and without following redirects (a 3xx is refused): `api.github.com` to resolve a ref, `codeload.github.com` for the archive at `/<owner>/<repo>/tar.gz/<commit>`.
- **Pin:** a supplied 40-hex `commit` is used as given; a `ref` (or none: `HEAD`) is resolved once and the 40-hex result is what is recorded (`source = { kind: 'git', url, ref?, commit }`, validated by `plugins/source-store.mjs`). A path inside the repository (`path`, a marketplace entry's folder) is installed alone.
- **Caps:** download 10 MB, unpacked 40 MB, kept files 25 MB in total, one file 2 MB (a larger file is skipped and reported), 3000 files, a path of 240 characters and 20 levels. A path that is absolute, has `..`, a backslash or a control character, or is a file and a directory at once, rejects the whole archive (`UNSAFE_PATH`). Symbolic and hard links and special files are skipped, never created.
- **What is read:** `inspectTree` recognises a plugin (`.claude-plugin/plugin.json`, `plugin.json`, `.codex-plugin/plugin.json`: skills, commands, agents, hooks, `.mcp.json`, `bin/`, LSP), a single skill (root `SKILL.md`), a skill bundle (`skills/*/SKILL.md`, kind `llm-source`) and an MCP registry `server.json`. A marketplace repository is refused with 422 `MARKETPLACE` and the entry names. Item id is `<kind>:<owner lowercased>/<name>`; trust is `official` for `github.com/anthropics/*`, else `unknown`.
- **Nothing executes at install:** files are written with mode 0644 to `<plugin dir>/../extensions/store/<sha256(userId)[0:24]>/<kind>__<publisher>__<name>/<commit>/` through a staging directory and a rename; no manifest, hook, script or server is run, and no dependency is installed.
- **Default off, per user:** the record goes to `extensions-installed.json` (per user, atomic, mode 0600, unreadable means refuse to write) and the switch overlay gets `enabled: false`. A second user installing the same repository gets an independent copy and independent switches. Installing the same commit again is a no-op (`alreadyInstalled`); another commit of an installed item is 409 `ALREADY_INSTALLED` with `details.use = '/auth/me/extensions/update'` (§9b); the bytes stay per user.
- **Consent:** enabling an item whose `declared.executableKinds` is not empty (`hook`, `mcp`, `lsp`, `bin`) needs every such kind named in `consents`; otherwise 409 `CONSENT_REQUIRED` with `details.kinds`. Grants are stored with the commit.
- **Scan:** advisory only. Rules: `hidden_characters`, `injection_phrase`, `pipe_to_shell`, `network_command`, `secret_path`, `destructive_command`, `base64_blob`, `external_host`, `long_line`, `binary_file`, `link_skipped`, `large_file_skipped`; at most 200 findings per scan, 50 kept in the record, every one `severity: 'warn'`, excerpts at most 80 characters. A finding never blocks an install or an enable. It is a heuristic, not a safety verdict.
- **Loading:** an installed item that is switched on and consented reaches the turn builders as described in §9a.
- **Account deletion:** `forgetUserExtensions` removes a user's records, switches and bytes; it is called after `deleteUserCascade` in `DELETE /auth/me` and the admin delete.

Routes (module `routes/extensions-catalog.mjs`, dispatched by `routes/extension-routes.mjs`; all need a signed-in user and act on that user only):

| Route | Body | Result |
|---|---|---|
| `GET /auth/me/extensions/installed` | | `{ corrupt, items[] }`; an item carries `id kind name description version publisher source subpath? pinnedCommit installedAt members declared permissions scan consents state{enabled, disabledMembers}` |
| `POST /auth/me/extensions/install` | `{ url, ref?, commit?, path? }` | `{ ok, alreadyInstalled?, item }`; 400 `INVALID_URL/REF/COMMIT/PATH`, 403 `SOURCE_NOT_ALLOWED/BLOCKED`, 404 `NOT_FOUND/CATALOG_DISABLED`, 409 `ALREADY_INSTALLED/BUSY`, 422 `MARKETPLACE/NOTHING_INSTALLABLE/UNSAFE_PATH/TOO_LARGE/BAD_ARCHIVE`, 502 `UPSTREAM`. Rate bucket `dispatch` |
| `POST /auth/me/extensions/toggle` | `{ id, enabled, consents?, members? }` | `{ ok, item }`. With `members` (member ids of the item) it checks or unchecks those members instead of the item |
| `POST /auth/me/extensions/uninstall` | `{ id }` | `{ ok }`; removes the record, the switches and every stored commit of that item for that user |

Audit actions: `extension.install`, `extension.enable`, `extension.disable`, `extension.members`, `extension.uninstall` (with the commit, trust and finding count, never file content); P5 adds `extension.updates_check`, `extension.update`, `extension.rollback`, `extension.repair`.

## §9a Installed items in turns

Module `extension/llm_agent/extensions/installed-runtime.mjs` (`activeInstalled(userId, gate, { legacyPluginNames })`, `missingConsents`) turns a user's installed items into what the builders already consume. The builders call it only with a gate: `LLMIDE_EXT_ACTIVE_SET` on, or a caller that forces one (the active set and the provider adapter, as in §8). With no gate, with `LLMIDE_EXT_CATALOG=off`, with nothing installed, or with an unreadable overlay or installed record, it returns nothing, so the output is byte-identical to the baseline golden file (`extensions-baseline`, `extensions-installed-runtime`).

An item loads only when all of these hold, re-read on every turn (a switched-off or uninstalled item is absent from the next turn):

- the overlay has an explicit `enabled: true` for it and no entry for the same kind and name switches it off (`gate.installedActive`, `gate.installedMemberActive`; a corrupt overlay answers off);
- every executable kind it declares (`hook`, `mcp`, `lsp`, `bin`) has a consent recorded with this pinned commit;
- the store directory `<store>/<user>/<item>/<commit>/` exists, is not a symbolic link and resolves inside that user's own store;
- a plugin's manifest name equals its item name and no legacy plugin has that name (the legacy plugin wins, a warning says so).

| Kind | Where it lands |
|---|---|
| `plugin` | `buildUserPluginDelivery` (after the legacy plugins; SDK `plugins` path with `skipMcpDiscovery`, a generated view when members are unchecked, §6) and `buildPerUserSkillSet` (skills, commands, agents; a legacy command keeps its trigger). Hooks run only when every executable kind the loader sees is consented (`hooks`→`hook`, `lsp`, `bin`; `monitors` can never be, so such a plugin is not delivered). |
| `skill`, `llm-source` | `listSkillLibrary` entries `catalog/<publisher>__<item>/<dir>` (family `skills`, `sourceId` the item id), after every legacy source; member `skill:<name>` applies. They feed the `/` menu and `load-skill`. |
| plugin `.mcp.json` servers, `mcp` (registry `server.json`) | `buildUserMcpServers`, so Claude turns and provider-adapter turns both mount them. Server id is the slug of `<plugin>-<server>` (at most 40 characters; taken or reserved ids, including `llmide`, are skipped). A `server.json` item mounts its first `streamable-http`/`sse` remote only; a package that would need `npx`/`uvx` at turn time is not launched (a warning says so). Member `mcp:<server>` applies. Restricted modes mount nothing. |

Server configs from a third party are built conservatively: `${CLAUDE_PLUGIN_ROOT}` in the command and arguments becomes the item's directory; any other `${...}` in the command or arguments drops the server, and an env or header value still holding one is dropped (the host environment is never expanded into it); a http(s) server must be `https`, without credentials, on a dotted host that is not `localhost`, an address literal or a `.local`/`.internal`/`.lan`/`.home` name (the adapter path additionally refuses private addresses at connect time, §8). Nothing runs at install or at load; a stdio server starts only when a turn mounts it.

**Approvals.** The result of `buildUserMcpServers` carries `askServers` (the ids of installed servers; the key is absent when there are none) and leaves them out of `allowedTools`. On the Claude engine `canUseTool` parks a `ToolApproval` for every call of such a server (also in Bypass, with no "always allow" suggestion, nothing saved); an unlisted `mcp__` tool is still denied. The adapter already asks on every call. A third-party server does not get the server-level pre-approval a legacy registry server has.

**Limits stated plainly.** On the Claude engine the CLI spawns a stdio server, so its environment is whatever the SDK passes it (the configured `env` plus the CLI's own rules: unverified), unlike the adapter path, which gives it only the SDK's safe defaults plus the record's `env`. The consent covers the pinned commit; a reinstall at another commit is refused (409) and an update re-asks (§9b), so a consent never silently carries to new bytes. Account deletion also removes generated views (`removeAllViewsFor`), and uninstall removes the plugin's views.

`computeActiveSet` includes installed items in `items` and the fingerprint (id, commit, unchecked members) and their warnings in `warnings`.

## §9b Updates, rollback, repair, indexes and search (P5, API 94)

Every step is the user's: nothing runs on a timer, no GET reaches the network, and nothing installs by itself. Every route below acts on the signed-in user only. A route that reaches GitHub or the MCP registry is a POST on the `dispatch` rate bucket (`install`, `catalog/refresh`, `updates/check`, `update/preview`, `update`, `repair`); `rollback` and `toggle` are offline. `LLMIDE_EXT_CATALOG=off` refuses every network step with 404 `CATALOG_DISABLED`. Every download uses the pinned fetch, the §9 caps and tar rules, never follows a redirect and executes nothing. Scan findings stay warn-only.

| Path | Role |
|---|---|
| `extension/llm_agent/extensions/update.mjs` | `checkUpdates`, `listUpdates`, `previewUpdate`, `applyUpdate`, `rollback`, `repair` |
| `extension/llm_agent/extensions/integrity.mjs` | `treeHash` (sha256 over sorted `path NUL sha256(file)`), `readTreeFromDisk` (no links, same caps), `verifyDir`, `diffTrees` |
| `extension/llm_agent/extensions/indexes.mjs` | The four index adapters, the shared cache, `refreshIndexes`, `searchCatalog`, `sourceStatuses` |

**Updates.** A check resolves each installed item's `source.ref` (or `HEAD`) to a commit with one `api.github.com` call per item (at most 100 items, one item failing never stops the others) and remembers `update: { latest, checkedAt }` on the record; it downloads nothing. A preview downloads the candidate commit into memory (an explicit 40-hex `commit`, else the one the check found, else it resolves the ref now), reads the installed bytes from disk and returns: the file diff (added, removed, changed with sizes, at most 200 listed per list), the scan before and after with the new findings and the number resolved, the executable kinds and members that are new, the consent the commit needs (every executable kind it declares: a consent belongs to one commit), whether the item was on, and `flags` (`new_executable_kind`, `new_executable_member`, `new_findings`, `consent_required`). It writes nothing. A candidate that inspects as a different item id is refused (422 `IDENTITY_CHANGED`); the source allowlist is checked again (403); bytes already on disk that are missing or damaged refuse the preview (409 `BYTES_MISSING`, repair first); the same commit is 409 `ALREADY_CURRENT`.

**Apply.** `POST update { id, commit?, consents? }` writes the candidate to `<item>/<commit>/` (staging directory and rename), then moves the record: new members, declared kinds, permissions, scan, `integrity`, `source.commit`, `updatedAt`, `consents` limited to the kinds named in the request (stamped with the new commit), and `previous` set to a snapshot of the old record. The item stays in its prior state only while the new commit's consents are covered: if it was on and every declared executable kind is consented in the request (or it declares none) it stays on, otherwise the overlay is switched off and the answer says `update: { from, to, enabled: false, wasEnabled: true, reason: 'consent_required', kinds }`. An item that was off stays off. Unchecked members stay unchecked. Exactly one older version is kept: the one before the previous one is removed when a newer update lands, and the plugin's generated views and the parsed-plugin cache are dropped. A failed download or write leaves the record as it was. If the later overlay write failed the item would still not load, because the runtime requires a consent for the pinned commit (§9a).

**Rollback.** `POST rollback { id }` is offline: it verifies the previous version's directory against its recorded fingerprint (missing or damaged: 409 `PREVIOUS_UNAVAILABLE`; none: 404 `NO_PREVIOUS`; a record with no fingerprint is accepted when readable), then restores the previous snapshot with the consents it had (they are valid for that commit), swaps the two (the version rolled away from becomes `previous`, so a rollback is itself reversible) and applies the same enabled rule as an update (`rollback: { from, to, enabled, wasEnabled, reason?, kinds }`).

**Repair.** `POST repair { id }` recomputes the fingerprint of the pinned commit's directory. `ok` answers `{ repaired: false, status: 'ok' }` with no network. Missing, damaged or never-fingerprinted bytes are re-fetched at the PINNED commit (never a newer one), inspected, and compared with the recorded fingerprint: a difference is refused (409 `INTEGRITY_MISMATCH`, nothing is overwritten), because a commit's bytes do not change upstream. A record from before fingerprints is verified by comparing the disk to the archive and gets a fingerprint (`status: 'verified'` when the disk was already right, `'restored'` otherwise).

**Indexes.** A fixed seed list (code, not user input), each parsed in memory and never executed; every string is stripped of control and bidi characters and capped (name 120, description 300), at most 1500 entries per source:

| Source id | Adapter | Reads | Installable from here |
|---|---|---|---|
| `anthropics/skills` | skills repo | `[skills/]<dir>/SKILL.md` front matter | yes, by `path` |
| `anthropics/claude-plugins-official` | marketplace | `.claude-plugin/marketplace.json`; a relative `source` becomes a `path`, a `github` source its repository | yes when the source is `owner/repo` or a relative path (a traversal path, a URL source: no, `unsupported_source`) |
| `modelcontextprotocol/servers` | directory list | `src/<dir>/package.json` | no (`package_launcher`: no launcher is run, §9a) |
| `mcp-registry` | MCP registry | `https://registry.modelcontextprotocol.io/v0.1/servers?limit=100`, up to 3 pages, 2 MB per page, `servers[].server` (`name`, `description`, `version`, `repository.url`, `remotes`) | no (`registry_install_not_supported`; the repository link is shown) |

The GitHub adapters resolve `HEAD`, skip the download when the commit equals the cached one, else download the archive at that commit. The shared cache `<plugin dir>/../extensions/index-cache.json` (mode 0600, atomic) holds public metadata only and is shared between users; installed bytes stay per user. TTL 6 hours; `POST catalog/refresh { source?, force? }` refreshes one or all sources, skips a fresh one, and never retries a source within 60 seconds of its last attempt (`throttled`). A failing source reports `error` (`upstream`, `blocked`, `too_large`, `redirect_refused`, `aborted`, `state_unreadable`) and keeps its last entries; the others are unaffected. An unreadable cache file is reported and never overwritten. The registry URL layout (`/v0.1/servers`) and the codeload URL are unverified against the live services; every test uses fixtures.

**Search.** `GET catalog?q=&kind=&limit=&offset=` reads the cache only: every query token must appear in the name, publisher or description (name match first, then publisher, then description; ties by name), `limit` defaults to 25 and is capped at 100, and `kind` is `skill|plugin|mcp|llm-source` (else 400). Each result carries `installable` (the entry's own flag AND the operator allowlist; `reason` says why not) and `installed` (this user's item id). Choosing a result to install is a separate, user-initiated `POST install { url, path }`. `sources` lists every source's `status` (`fresh|stale|empty|error`), `count` and `fetchedAt`.

**Active view.** `GET active` runs `computeActiveSet` for the user and returns names and counts only: `fingerprint`, `failClosed`, `items`, `skills` (id, name, description, sourceId), `pluginSkills`, `commands`, `subagents`, `sdkPlugins` (a count), `mcpServers` (server ids, never configs: they can hold credentials), `excluded` and `warnings`; no file path is returned. `GET updates` returns `{ corrupt, items: [{ id, name, kind, current, latest, checkedAt, ref?, hasPrevious }] }` from the records (no network). The installed item gains `integrity`, `updatedAt?`, `update?: { latest, checkedAt }` and `previous?: { pinnedCommit, version, installedAt }`; the previous snapshot itself stays server side.

| Route | Body or query | Result |
|---|---|---|
| `GET /auth/me/extensions/catalog` | `q, kind, limit, offset` | `{ query, total, offset, results[], sources[] }`; 400 `VALIDATION_FAILED` |
| `POST /auth/me/extensions/catalog/refresh` | `{ source?, force? }` | `{ results: [{ id, status, count?, error? }] }`; 400, 404 `NOT_FOUND` (unknown source) / `CATALOG_DISABLED` |
| `GET /auth/me/extensions/active` | | the view above |
| `GET /auth/me/extensions/updates` | | `{ corrupt, items[] }` |
| `POST /auth/me/extensions/updates/check` | `{ id? }` | `{ checkedAt, results: [{ id, current, latest?, updateAvailable, error? }] }`; 404 for an unknown id |
| `POST /auth/me/extensions/update/preview` | `{ id, commit? }` | the diff above; 400 `INVALID_COMMIT`, 404, 409 `ALREADY_CURRENT/BYTES_MISSING`, 422 `IDENTITY_CHANGED/…` |
| `POST /auth/me/extensions/update` | `{ id, commit?, consents? }` | `{ ok, item, update }`; same errors, 403 `SOURCE_NOT_ALLOWED`, 409 `BUSY` |
| `POST /auth/me/extensions/rollback` | `{ id }` | `{ ok, item, rollback }`; 404 `NO_PREVIOUS`, 409 `PREVIOUS_UNAVAILABLE` |
| `POST /auth/me/extensions/repair` | `{ id }` | `{ ok, repaired, status, was?, item }`; 409 `INTEGRITY_MISMATCH` |

The contract is `schema/http/extensions.schema.json` (fixtures captured from the real handlers under `schema/http/fixtures/extensions/`); `scripts/lib/roster.mjs` reads `routes/extensions-catalog.mjs` for the roster.

## §10 Not in these phases

User-added index sources (the seed list is code), installing a registry `server.json` item or a package-launcher server, the Mac Extensions screen and the allowlist setting, an `extensionsFingerprint` column in `turn_composition`, the adapter's skills catalog block (it would add tokens to every provider turn), per-tool MCP deny lists, and write-through to the legacy files.

## §11 Tests

`extensions-baseline`, `extensions-model`, `extensions-store`, `extensions-importer`, `extensions-active-set`, `extensions-consumers`, `extensions-adapter`, `extensions-sources`, `extensions-install`, `extensions-update`, `extensions-index`, `extensions-catalog-routes`, `extensions-installed-runtime` and `eslint-mcp-sdk-fence` under `extension/tests/`, with the synthetic world in `extension/tests/helpers/extensions-world.mjs`, in-memory archives in `extension/tests/helpers/tar-fixture.mjs` and a real local stdio MCP server in `extension/tests/fixtures/fake-mcp-stdio-server.mjs`. No test reaches the network or a paid model.

## Regeneration checklist

- [ ] Every governed symbol/endpoint/table/prompt is present with its exact shape (no "etc.", no "see code").
- [ ] Every magic number, timeout, cap, regex, and crypto parameter is stated.
- [ ] Spot-check: one representative piece rebuilt from this page alone matches source.
- [ ] Structured facts link to their extractor-generated reference page (no hand-copied drift).
