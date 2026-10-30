---
title: Extensions catalog (phases P0 to P4) — spec
status: draft
---

This is the contract for the first five phases of the extensions catalog ([plan](../superpowers/plans/2026-10-31-extensions-catalog.md)): one item model over plugins, MCP servers and LLM sources, a computed active set, consumers that honour it behind a flag, and extensions on provider-adapter turns. P4 adds four HTTP routes (API version 93, §9); there is no new SSE event and no Mac UI yet. Updates, rollback, the index/search of catalogs and the Mac screen are P5 and later and are not specified here.

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

A user's request is the only trigger: nothing is fetched in the background, and the server never reads a catalog or index in this phase. Flags: `LLMIDE_EXT_CATALOG` (default on; `off` refuses install with 404 `CATALOG_DISABLED`), `LLMIDE_EXT_SCAN` (default on; `off` skips the scan), `LLMIDE_EXT_ALLOWED_SOURCES` (comma list of `owner/repo` globs; unset means any GitHub repository the user names).

| Path | Role |
|---|---|
| `extension/llm_agent/extensions/sources/github.mjs` | `parseRepoUrl`, `resolveCommit`, `downloadArchive`, `sourceAllowed` |
| `extension/llm_agent/extensions/sources/tar.mjs` | `extractTarGz`: in-memory reader for the gzip'd tar |
| `extension/llm_agent/extensions/inspect.mjs` | `inspectTree`: kind, name, members, declared executable kinds, permission summary |
| `extension/llm_agent/extensions/scan.mjs` | `scanTree`: the warn-only instruction scan |
| `extension/llm_agent/extensions/installed.mjs` | The installed registry file and store paths |
| `extension/llm_agent/extensions/install.mjs` | `installFromGithub`, `listInstalled`, `setInstalledEnabled`, `setInstalledMembers`, `uninstall`, `forgetUserExtensions` |
| `extension/routes/extensions-catalog.mjs` | The four routes below |

- **Source:** only `https://github.com/<owner>/<repo>` (optionally `.git`; no other host, port, credentials, query or fragment). Two hosts are contacted, over https, through the SSRF-pinned fetch (`makePinnedFetch`, no private addresses), without credentials and without following redirects (a 3xx is refused): `api.github.com` to resolve a ref, `codeload.github.com` for the archive at `/<owner>/<repo>/tar.gz/<commit>`.
- **Pin:** a supplied 40-hex `commit` is used as given; a `ref` (or none: `HEAD`) is resolved once and the 40-hex result is what is recorded (`source = { kind: 'git', url, ref?, commit }`, validated by `plugins/source-store.mjs`). A path inside the repository (`path`, a marketplace entry's folder) is installed alone.
- **Caps:** download 10 MB, unpacked 40 MB, kept files 25 MB in total, one file 2 MB (a larger file is skipped and reported), 3000 files, a path of 240 characters and 20 levels. A path that is absolute, has `..`, a backslash or a control character, or is a file and a directory at once, rejects the whole archive (`UNSAFE_PATH`). Symbolic and hard links and special files are skipped, never created.
- **What is read:** `inspectTree` recognises a plugin (`.claude-plugin/plugin.json`, `plugin.json`, `.codex-plugin/plugin.json`: skills, commands, agents, hooks, `.mcp.json`, `bin/`, LSP), a single skill (root `SKILL.md`), a skill bundle (`skills/*/SKILL.md`, kind `llm-source`) and an MCP registry `server.json`. A marketplace repository is refused with 422 `MARKETPLACE` and the entry names. Item id is `<kind>:<owner lowercased>/<name>`; trust is `official` for `github.com/anthropics/*`, else `unknown`.
- **Nothing executes at install:** files are written with mode 0644 to `<plugin dir>/../extensions/store/<sha256(userId)[0:24]>/<kind>__<publisher>__<name>/<commit>/` through a staging directory and a rename; no manifest, hook, script or server is run, and no dependency is installed.
- **Default off, per user:** the record goes to `extensions-installed.json` (per user, atomic, mode 0600, unreadable means refuse to write) and the switch overlay gets `enabled: false`. A second user installing the same repository gets an independent copy and independent switches. Installing the same commit again is a no-op (`alreadyInstalled`); another commit of an installed item is 409 `ALREADY_INSTALLED` (updating is P5).
- **Consent:** enabling an item whose `declared.executableKinds` is not empty (`hook`, `mcp`, `lsp`, `bin`) needs every such kind named in `consents`; otherwise 409 `CONSENT_REQUIRED` with `details.kinds`. Grants are stored with the commit.
- **Scan:** advisory only. Rules: `hidden_characters`, `injection_phrase`, `pipe_to_shell`, `network_command`, `secret_path`, `destructive_command`, `base64_blob`, `external_host`, `long_line`, `binary_file`, `link_skipped`, `large_file_skipped`; at most 200 findings per scan, 50 kept in the record, every one `severity: 'warn'`, excerpts at most 80 characters. A finding never blocks an install or an enable. It is a heuristic, not a safety verdict.
- **Not wired yet:** an installed item that is switched on is recorded but no consumer loads it into a turn; the active set reads the three legacy files plus the restrict-only overlay. Wiring installed bytes into the SDK plugin delivery, the skill set and the MCP builder is the next phase.
- **Account deletion:** `forgetUserExtensions` removes a user's records, switches and bytes; it is called after `deleteUserCascade` in `DELETE /auth/me` and the admin delete.

Routes (module `routes/extensions-catalog.mjs`, dispatched by `routes/extension-routes.mjs`; all need a signed-in user and act on that user only):

| Route | Body | Result |
|---|---|---|
| `GET /auth/me/extensions/installed` | | `{ corrupt, items[] }`; an item carries `id kind name description version publisher source subpath? pinnedCommit installedAt members declared permissions scan consents state{enabled, disabledMembers}` |
| `POST /auth/me/extensions/install` | `{ url, ref?, commit?, path? }` | `{ ok, alreadyInstalled?, item }`; 400 `INVALID_URL/REF/COMMIT/PATH`, 403 `SOURCE_NOT_ALLOWED/BLOCKED`, 404 `NOT_FOUND/CATALOG_DISABLED`, 409 `ALREADY_INSTALLED/BUSY`, 422 `MARKETPLACE/NOTHING_INSTALLABLE/UNSAFE_PATH/TOO_LARGE/BAD_ARCHIVE`, 502 `UPSTREAM`. Rate bucket `dispatch` |
| `POST /auth/me/extensions/toggle` | `{ id, enabled, consents?, members? }` | `{ ok, item }`. With `members` (member ids of the item) it checks or unchecks those members instead of the item |
| `POST /auth/me/extensions/uninstall` | `{ id }` | `{ ok }`; removes the record, the switches and every stored commit of that item for that user |

Audit actions: `extension.install`, `extension.enable`, `extension.disable`, `extension.members`, `extension.uninstall` (with the commit, trust and finding count, never file content).

## §10 Not in these phases

Catalog sources other than a GitHub repository the user names (marketplace and MCP-registry indexes, search, `GET /auth/me/extensions/catalog|active|updates`), loading installed items into turns, unified update with diff, rollback, the Mac Extensions screen, an `extensionsFingerprint` column in `turn_composition`, the adapter's skills catalog block (it would add tokens to every provider turn), per-tool MCP deny lists, and write-through to the legacy files.

## §11 Tests

`extensions-baseline`, `extensions-model`, `extensions-store`, `extensions-importer`, `extensions-active-set`, `extensions-consumers`, `extensions-adapter`, `extensions-sources`, `extensions-install`, `extensions-catalog-routes` and `eslint-mcp-sdk-fence` under `extension/tests/`, with the synthetic world in `extension/tests/helpers/extensions-world.mjs`, in-memory archives in `extension/tests/helpers/tar-fixture.mjs` and a real local stdio MCP server in `extension/tests/fixtures/fake-mcp-stdio-server.mjs`. No test reaches the network or a paid model.

## Regeneration checklist

- [ ] Every governed symbol/endpoint/table/prompt is present with its exact shape (no "etc.", no "see code").
- [ ] Every magic number, timeout, cap, regex, and crypto parameter is stated.
- [ ] Spot-check: one representative piece rebuilt from this page alone matches source.
- [ ] Structured facts link to their extractor-generated reference page (no hand-copied drift).
