# Extensions catalog: skills, MCP servers and plugins from GitHub, one switch per item, only active items loaded

Status: plan, **not started** (no code changed). Branch: `main` (no feature branches, no push). Date: 2026-10-31 (request 2026-10-30).
Research basis: read-only pass at `b1cb2817` (`SERVER_API_VERSION = 92`, `extension/server.mjs:298`). Inputs: [agent-kit](../../kits/agent-kit.md) (K0 map), [agent-kit K1](2026-10-30-agent-kit-k1.md) (Track Q, lean config, bench gates), [provider catalog spec](../../spec/provider-catalog.md) (the catalog pattern), [LLM-source items design](../specs/2026-09-25-llm-source-items-and-update-design.md). Every `path:line` was read in this pass. Nothing was run (no bench, no test, no Mac build). External facts carry a URL; anything I could not confirm is marked **(unverified)** and collected in section 15.

User request (2026-10-30): "upgrade plugin, skill, MCP to a more professional way; reduce OUR generated skills; use popular skills from GitHub; select/deselect each to use or not; do the same for MCP, plugin and skills; when updating, update the system so only ACTIVE ones are used."

## 0. Decisions and non-goals

### 0.1 Proposed decisions (all need the user's yes; see section 14 for options)

1. **One Extensions catalog**, one item model for four kinds: `skill`, `plugin`, `mcp`, `llm-source` (a bundle repo). One on/off switch per item, plus a switch per family and per bundle with per-member overrides (the `disabledItems` "unchecked set" rule that LLM sources already use).
2. **Install is fetch-at-pinned-SHA into a per-user store; enable/disable is metadata only.** Disabling never deletes bytes; it only changes what the *active set* contains.
3. **The active set is computed once per turn by one function and consumed by every consumer** (SDK plugin delivery, skill listing and `load-skill`, MCP servers, provider-adapter turns, Mac UI, phone). No consumer reads enable state on its own any more.
4. **Our own skills shrink to the product control plane.** 18 of 47 central skills are replaced by (or are candidates for) upstream; 15 move to an optional pack that is off by default; the 7 classic-loop tool definitions that duplicate SDK natives go when the classic loop goes (K1 P6/P7). Section 4.
5. **Sources, not a homegrown registry.** Anthropic's official skills repo and plugin marketplaces (marketplace.json), the official MCP Registry, and user-added GitHub repos. We **index and cache**; we do not crawl "all of GitHub".
6. **Updates are never silent for executable content.** Check, show a diff, user approves, apply atomically at the new pinned SHA, keep the previous one for rollback.
7. **Token-affecting behaviour ships default OFF until the user's token bench passes** (K1 rule, `run-the-token-bench.md`): the active-set-driven prompt trimming, the adapter parity, and any "default enabled" change each get a kill switch.

### 0.2 Non-goals

- Re-implementing Claude Code's own plugin manager. We use its formats (marketplace.json, `.claude-plugin/plugin.json`, SKILL.md) and the SDK's `plugins` option; we keep our per-user, per-item layer and consent gates on top.
- Crawling GitHub or scoring "popularity" ourselves. Ranking inputs are the registries' own fields plus stars read at index time **(unverified field availability)**.
- Auto-enabling anything fetched. Auto-update of executable content. Running a plugin's `command` source (section 7).
- Moving the Mac UI again (Track Q already created the sealed `Features/Extensions`); changing the 16 SSE events; the Tauri screens.
- A new model-facing "skill marketplace" tool. The agent never installs anything; only the user does.

## 1. Findings: what exists and what is missing

### 1.1 Already strong (build on it, do not redo)

| Capability | Where | Note |
|---|---|---|
| Per-user plugin enable, hook trust with kinds | `extension/plugins/state.mjs:1-36` (`{enabled, hooksTrusted, hooksTrustedKinds}` per user, atomic write) | A grant covers only the executable kinds it named; a plugin that later gains monitors/bin loses trust (`registry.mjs` `trustStatusFor`) |
| Commit-pinned provenance | `plugins/source-store.mjs:15,98-120` (kinds `git`, `marketplace`, `zip`; `commit` and `tree` are validated 40-hex SHAs; `url` must be https, public host, no credentials, no `?`/`#`) | This **is** the pinned-install record the catalog needs; we extend it, not replace it |
| Marketplace install, client-side clone | `Features/Extensions/Services/PluginMarketplace.swift:1-30` (reads `.claude-plugin/marketplace.json`, packages one entry as a zip), `PluginGitInstaller.swift` | The server "fetches no URLs" (SSRF posture, `plugins/installer.mjs` header), so cloning is on the Mac today |
| Update detection and apply | `plugins/claude-update.mjs:1-30` (two tiers: reimport vs upstream via `claude plugin update --json`), `Features/Extensions/Services/PluginUpdateCenter.swift`, `PluginSourceUpdateChecker.swift`, `PluginSourceReinstaller.swift`; MCP: `mcp/registry-versions.mjs`, `McpUpdateCenter.swift`; hook/MCP trust reset when executable components change | Update/repair exists per kind; it is three separate flows |
| All `claude plugin …` argv in one file | `providers/claude-plugin-cli.mjs:1-30` (`marketplace update`, `list --available --json`, `update --json`) | Claude linker rule from [claude-linker](../../explanation/claude-linker.md) |
| Native SDK plugin delivery | `llm_agent/skills/registry.mjs:213-258` (`buildUserPluginDelivery` → `{ type:'local', path, skipMcpDiscovery:true }`; hooks gated by trust; never both native and translated), consumed at `sdk/engine.mjs:1721-1738` | MCP stays ours: `skipMcpDiscovery` always set |
| MCP: enabled AND consented, none in restricted modes | `mcp/state.mjs` (registry file shared, state per user), `sdk/engine.mjs:439-474` (`buildUserMcpServers`; reserved name `llmide` cannot be shadowed), `mcp/catalog.mjs` (curated list; its header says the official registry "would be the way to make this dynamic later") | |
| LLM sources (skill bundles) with per-item unchecked set | `llm-sources/state.mjs:1-18` (`disabledItems` keyed `<kind>:<name>`; "an item that only arrived with the latest update is on, and an uncheck survives updates"), `llm-sources/registry.mjs` (`listSourcesWithState`, `sourceDiscoveryDetail`), `skills/skill-library.mjs` (catalog gated on enabled sources and `disabledItems`) | The per-item model the user wants already exists for one kind |
| Skills are on demand, gated by the same state | `load-skill` handler `llm_agent/tools/handlers/load-skill.mjs:1-12`: reads only skills in the user's **enabled sources**, never a wire path; chat "/" menu attaches a SKILL.md | |
| Catalog pattern to copy | `docs/spec/provider-catalog.md` (static `provider-catalog.json`, per-user connections, vault keys, capability flags, eight routes, pinned fetch, base-URL guard) | Same shape: catalog file + per-user connection + `pinned-fetch.mjs` for server-side fetches |
| Routes | 28 routes under `/auth/me/plugins*`, `/auth/me/mcp-plugins*`, `/auth/me/llm-sources*` (counted from `routes/extension-routes.mjs` and `server/*.mjs`) | |
| Mac UI | `Features/Extensions/` (6 491 lines in `Models/`, `Services/`, `Views/`), sealed per [agent-kit K1](2026-10-30-agent-kit-k1.md) 0.1b | Rows, detail views, add sheets, update sections exist per kind |

### 1.2 Gaps (the work)

| # | Gap | Evidence |
|---|---|---|
| G1 | **Three unrelated state files, three different semantics.** Plugins: `plugin-state.json` enabled set. MCP: `mcp-plugins.json` registry + `mcp-plugins-state.json`. LLM sources: `llm-sources-state.json` enabled + `disabledItems`. No shared item id, no shared "active" notion, no family switch | `plugins/state.mjs:15`, `mcp/state.mjs:19-20`, `llm-sources/state.mjs:15` |
| G2 | **No per-item switch inside a plugin or an MCP server.** A plugin is all-or-nothing (its skills, commands, subagents, hooks, MCP servers). `buildPerUserSkillSet` adds every skill of every enabled plugin; the SDK is handed the whole directory | `skills/registry.mjs:452-496`, `:213-258` |
| G3 | **Provider-adapter turns see no extensions.** The adapter turn reports `mcpServers: []`, and `provider-turn.mjs` has no plugin/skill/MCP reference. The user's "active" choices therefore do not apply to DeepSeek/OpenAI/etc. turns: the parity gap the user asked to close | `llm_agent/adapter/provider-turn.mjs:147` |
| G4 | **Enable state is read in several places.** `buildUserMcpServers`, `buildUserPluginDelivery`, `buildPerUserSkillSet` (called from `engine.mjs:1697`, `routes/agent-v2.mjs:148`, `routes/agent.mjs:368`), `skill-library.mjs`, `extension-routes.mjs:808-824` each re-derive "what is on". Easy to drift | grep of the consumers (section 5.2) |
| G5 | **Discovery is a hand-curated list and manual add.** MCP: `mcp/catalog.mjs` (200 lines, only what was confirmed). Plugins: add a marketplace or git URL by hand. Skills: add a git source by hand. No search over upstream, no popularity, no publisher signal | `mcp/catalog.mjs:1-30` |
| G6 | **Update shows "update available" per kind but not a content diff, and does not roll back.** Plugin update swaps the copy "in whole"; `McpPluginDetailView`/`PluginUpdateConfirmSheet` exist but I found no previous-version slot or rollback route | `plugins/claude-update.mjs:1-12` (swap in whole); no `rollback` in `routes/extension-routes.mjs` **(grep, not exhaustive)** |
| G7 | **No token-cost figure per item.** Nothing tells the user what turning an item on costs per turn. Claude Code itself now shows "Every turn" and "When invoked" estimates and `claude plugin details` prints an `Always-on` line (<https://code.claude.com/docs/en/plugins/install.md>), so the concept is proven | docs; our `turn_composition` already logs tool definition size (`engine.mjs` `v2ToolDefinitionChars`, migration 0044) |
| G8 | **Our own skills are a large surface we maintain.** 86 skill-like artefacts (section 4); 15 are verbatim mirrors of upstream, 13 are GRID-company domain skills that are not LLM-IDE's product | `.skills/README.md:40-56`, `.skills/registry.yaml` |
| G9 | **Supply-chain controls are partial.** Hook/MCP consent and trust kinds exist; there is no publisher trust level, no scan of fetched SKILL.md/MCP descriptions for injection, no allowlist, and `mcp/catalog.mjs` commands run via `npx` at whatever version resolves unless a version is pinned (`mcp/package-spec.mjs`, `registry-versions.mjs` exist for this) | section 7 |

### 1.3 Corrections to the premise (read first)

- **Kit skills do not cost tokens every turn today.** The SDK runs with `settingSources: []` (`engine.mjs:853`, K1 2.1), so it does not scan a skills directory; kit skills reach the model only through `load-skill` or a chat "/" attach (on demand), and the llmide tool list carries one `load-skill` entry. So "reduce our generated skills" is mainly about **maintenance and trust**, not per-turn tokens. The per-turn levers are: (a) skills/commands/agents of plugins handed to the SDK natively (their descriptions are always in context, `description`+`when_to_use` capped at 1 536 chars each, <https://code.claude.com/docs/en/skills>), (b) user MCP tool definitions (K1 L10: two MCP servers added 6.7k to 8.8k tokens, `compact-system-prompt.mjs:7-11`), (c) our own 22 llmide tool definitions. All three are active-set-driven in this plan. Measured numbers: none in this pass.
- **MCP tool-definition cost has a deferral lever.** Claude Code makes tool search (deferred MCP tool loading) the default and `ENABLE_TOOL_SEARCH=false` turns it off (<https://code.claude.com/docs/en/mcp>); K1 L10 already schedules re-measuring it on CLI 2.1.301. The active set is the lever that is independent of it: an off server contributes zero.
- **The official MCP Registry is a preview.** One third-party guide (checked 2026-08-03) says its API spec is unstable and data may be wiped; the registry repo says "breaking changes or data resets may occur" (<https://github.com/modelcontextprotocol/registry>). So it can be a discovery source we cache, never the only record of an installed item.

## 2. External landscape (what to adopt)

| Source | What it gives | Use in the catalog |
|---|---|---|
| **Anthropic official marketplace** `claude-plugins-official` (`github.com/anthropics/claude-plugins-official`) and the community catalog (`claude-community`); also `anthropics/skills` (examples + the Agent Skills spec; official name `anthropic-agent-skills`) | `marketplace.json` catalogs; names are reserved: Claude Code accepts official/community names only for sources under `github.com/anthropics/` (<https://code.claude.com/docs/en/plugins/security.md>); community entries are pinned to commit SHAs "for nearly every entry" and Claude Code refuses another commit | Tier 1 publisher trust; default index sources |
| **marketplace.json format** | required `name`, `owner`, `plugins[]`; entry `source` types: relative path, `github`, `url`, `git-subdir`, `npm` (install scripts never run), `archive` (`sha256` pin), `command`; `ref` and `sha` pin (`sha` wins); `strict`, `defaultEnabled`, `dependencies`, `category`, `tags` (<https://code.claude.com/docs/en/plugins/marketplace-reference.md>) | Our index format for plugins (we already read it: `PluginMarketplace.swift`). Accept `github`, `git-subdir`, `url`, relative; **reject `command`**, treat `npm`/`archive` as later |
| **Agent Skills open format** | folder with `SKILL.md` (YAML `name`, `description`; optional `scripts/`, `references/`, `assets/`); progressive disclosure (names+descriptions at start, body on match); adopted by Claude Code, Codex, Cursor, Gemini CLI, Copilot, others (<https://inference.sh/blog/skills-agent-skills-overview>, secondary; primary spec at agentskills.io **not fetched**) | Our skill item is exactly this; `plugins/loader.mjs` and `skills/loader.mjs` already validate it |
| **Official MCP Registry** `registry.modelcontextprotocol.io` | preview since 2025-09-08, v0.1 API freeze announced 2025-10-24; `server.json` with `$schema` `https://registry.modelcontextprotocol.io/schemas/server.json`; namespaces `io.github.<user>/…` verified by GitHub OAuth/OIDC, `com.example/…` by DNS or HTTP; package ownership checked (npm `mcpName`, README comment, Docker label) (<https://github.com/modelcontextprotocol/registry>, third-party summary <https://smithery.ai/skills/enuno/mcp-registry>). Endpoint paths (`/v0/servers` vs `/api/v0/servers`) **unverified** | MCP discovery source; namespace = publisher identity; cache locally |
| **modelcontextprotocol/servers** reference servers | the seven references already in `mcp/catalog.mjs` | Keep as the bundled seed |
| **Curated "awesome" lists, GitHub topics** (`claude-code-plugin`, `mcp-server`, `agent-skills`) | breadth, no verification | **Not an index source.** A user can paste a repo URL; we classify it as Tier 3 (unknown) |
| **Claude Code's own enable/disable** | `enabledPlugins` in settings (user/project/local scope; local > project > user), `claude plugin enable|disable|install|uninstall|update`, `claude plugin details` (always-on tokens), `claude mcp add|remove|list|get`, `/mcp` toggles stored as `disabledMcpServers`, project `.mcp.json` approval via `enabledMcpjsonServers`; auto-update on only for official marketplaces and off by default elsewhere; `claude plugin validate` works offline (<https://code.claude.com/docs/en/plugins/install.md>, <https://code.claude.com/docs/en/mcp>); [memory: claude-cli-plugin-validate] | Same mental model (one switch per item, scope, validate before install); we do **not** share the user's `~/.claude` state (per-user server tenancy, `settingSources: []`) |

Supply-chain facts (secondary sources; figures vary, **unverified against primaries**): Snyk's ToxicSkills audit (Feb 2026, 3 984 skills: 36% flawed, 76 confirmed malicious, 91% of those mixed malware with prompt injection); the ClawHavoc campaign (1 184 poisoned skills on ClawHub, Antiy CERT); MCPTox (AAAI 2026, 353 tools from 45 servers, 20 models); OWASP Agentic AI Top 10 ASI04 "Agentic Supply Chain Compromise" and a dedicated Agentic Skills Top 10 (April 2026); CSA research notes June 2026 (<https://labs.cloudsecurityalliance.org/research/ai-coding-agent-attack-surface-mcp-repository-poisoning-v1-0/>, <https://obot.ai/blog/mcp-security-agent-skills-supply-chain/>, <https://www.agentready.it.com/blog/mcp-security-prompt-injection>). Anthropic's own page says a plugin "can execute arbitrary code on your machine with your user privileges", that skills/commands/agents "enter Claude's context as instructions", and that hooks, monitors, MCP/LSP servers run outside the sandbox (<https://code.claude.com/docs/en/plugins/security.md>).

## 3. Decisions in detail

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | Own the plugin/skill manager or wrap Claude's? | **Own the catalog, per-user state and consent; reuse formats and the SDK `plugins` option; keep `claude plugin …` calls only for Claude-imported plugins** (`claude-plugin-cli.mjs`) | Server is multi-user with a per-user config dir; Claude's settings are per machine user |
| D2 | Where do fetches happen? | **Server fetches index data over a host allowlist through `pinned-fetch.mjs`** (api.github.com, raw.githubusercontent.com, codeload.github.com, registry.modelcontextprotocol.io); **bytes of an item are cloned by the Mac (as today) or by a server-side `git` at a SHA**; the choice is Q-E3 | Today's rule is "server fetches no URLs"; the provider catalog already proved the guarded-fetch pattern |
| D3 | Version identity | **Commit SHA (40-hex) is the identity; `version` string is a label.** Tracking a branch/tag is allowed only to *propose* a new SHA | Matches `source-store.mjs` and marketplace `sha` semantics; a mutable tag is not a pin |
| D4 | Default state of a fresh install | **Installed = off.** Enabling is a second explicit act (this is stricter than Claude Code, where install also enables unless `defaultEnabled:false`) | The user asked "select/deselect each"; also stops fetched content entering prompts untouched |
| D5 | Per-item granularity | Bundle → members (`skill`, `command`, `agent`, `hook`, `mcp`) with an **unchecked set** per bundle (keep the LLM-source rule: new members arrive ON only if the bundle is on **and** the member kind is non-executable; new executable members arrive OFF) | Uncheck survives update; executable additions never self-enable |
| D6 | Family switch | `family` = `kind` + optional publisher/bundle. A family switch sets a family-level flag that **gates** items without rewriting each item's own flag | Re-enabling the family restores the user's per-item choices |
| D7 | Skills "loaded into prompts" | Active skills appear in **one compact catalog block** (id + one-line description, capped) and bodies load via `load-skill`; **inactive skills are absent from the block and from `load-skill`'s allowed list** | Progressive disclosure, same as upstream, with our gate |
| D8 | Plugins natively delivered to the SDK | **Materialise an "active view" directory per user** (symlinks or copies of only the enabled members under a generated plugin root) and hand that to `plugins`; do not hand the full upstream directory when any member is off | The SDK has no per-member switch; a filtered view is the only way to honour a member-level off **(whether the SDK honours a manifest subset is unverified)** |
| D9 | MCP | One entry per server; per-server switch plus consent (exists); **per-tool deny list** later (Phase 5, optional) | Tool-level filtering needs `disallowedTools` patterns; defer |

## 4. Inventory of what we ship or generate as skills

Counted from `.skills/registry.yaml` (registryVersion 3.0.0) and the files under `extension/llm_agent/`. "Artefact" = anything the agent can load as instructions or a tool definition.

| Family | Count | Where | Verdict |
|---|---:|---|---|
| Central kit `skills/` | 47 | `.skills/skills/*/SKILL.md` | split below |
| Kit `runtime/` app-skills (KB pipeline: `answer-question`, `atomize-text`, `classify-node`, `draft-document`, `draft-section`, `identify-missing-context`, `improve-note`, `infer-edges`, `plan-draft-outline`, `process-unit`, `reconcile-note`, `select-notes-for-question`, `summarize-note`) | 13 | `.skills/runtime/` | **Keep (must)**: product pipeline, surfaced by `skill-library.mjs` family `runtime` **(whether every one is invoked by server code: unverified)** |
| Global tool definitions (agent-loop tools) | 22 | `extension/llm_agent/global/*.md` (+ `prompt.md` role file) | 15 keep, 7 adapter-only (below) |
| Internal tool definitions | 4 | `extension/llm_agent/internal/skills/` (`comment-gitlab-issue`, `create-gitlab-issue`, `search-kb`, `trigger-review-code`; mirrors of kit `agent-tools/`) | **Keep (must)**: need our server |
| **Total artefacts** | **86** | | |

Not counted (not skills): kit `commands/` 15 and `templates/` 9 (Doc Gen / Visual menus, served by `generation-library.mjs`), `config/` 14, the `rtk` plugin, `agents/reviewer.md`.

### 4.1 The 47 central skills

| Verdict | Count | Skills | Reason |
|---|---:|---|---|
| **Replace with upstream (verbatim, pinned)** | 15 | `brainstorming`, `writing-plans`, `executing-plans`, `subagent-driven-development`, `dispatching-parallel-agents`, `finishing-a-development-branch`, `receiving-code-review`, `requesting-code-review`, `systematic-debugging`, `test-driven-development`, `using-git-worktrees`, `using-superpowers`, `verification-before-completion`, `writing-skills` (all tracking [obra/superpowers](https://github.com/obra/superpowers)) and `grilling` ([mattpocock/skills](https://github.com/mattpocock/skills), MIT) | `.skills/README.md:40-56` says these are copies of upstream. Becomes catalog items from the upstream repo at a pinned SHA. **Caveat:** the planning pipeline injects `brainstorming`, `grilling`, `writing-plans` and `executing-plans` verbatim (`runtime/plan-pipeline.mjs`), so those four stay a *required-by-feature* item (cannot be switched off while the planning modes are on; the UI says so) |
| **Replace candidate (evaluate)** | 3 | `code-review`, `reviewer` (+ the `reviewer` agent), `html-slides` | Anthropic ships code-review style plugins and slide skills; evaluate against ours on one real task each before dropping. `html-slides` has "diverged enough" from its vendored origin (`.skills/README.md`), so default is keep-as-pack unless the evaluation says otherwise |
| **Keep (control plane / product)** | 14 | `plan-director`, `plan-structure-index`, `assist-plan`, `app-forge`, `app-council`, `app-research`, `app-stack-menu`, `refactor-planner`, `refactor-apply`, `refactor-conform`, `test-structure-setup`, `test-gap-writer`, `doc-structure-index`, `doc-writer` | Used by default Loops, plan modes and App Forge; no upstream equivalent; contract-tested |
| **Move to an optional pack, off by default** | 15 | GRID domain: `docstrings`, `error-handling`, `type-hints`, `excel-io`, `excel-diff-extractor`, `gurobi-params`, `iis-summarization`, `lp-compare`, `math-olympiad`, `optimization-advisor`, `result-explanation`, `solve-tuning`, `grid-pptx`; scaffold: `mirror-web-to-native`, `performance-budget` | Company/domain skills, not LLM-IDE's product. Stay in the kit repo as a source named "GRID pack"; **not deleted**, no longer part of the default install and not shown first |
| **Total** | **47** | | 15 + 3 + 14 + 15 = 47 |

### 4.2 The 22 global tool definitions

| Verdict | Count | Items |
|---|---:|---|
| **Keep (must; need our server)** | 15 | `ask-internal`, `ask-subagent`, `ask-user`, `check-citations`, `code-relations`, `decide`, `find-code`, `git-op`, `load-skill`, `project_memory`, `save-plan`, `search-kb`, `task-create`, `task-list`, `task-update` |
| **Adapter-only; drop with the classic loop** | 7 | `bash`, `run-bash`, `fetch-url`, `list-files`, `read-file`, `update-file`, `web-search` | The SDK path uses native `Read/Glob/Grep/Bash/Edit/WebSearch/WebFetch` (`V2_BUILTIN_TOOLS`, `engine.mjs:337-410`); these remain only for provider-adapter and classic turns (K1 P6/P7). `task-*` may also go when SDK `Task*` is adopted (K1 A-list) |

Summary of the 86: **keep 46** (14 + 13 + 15 + 4), **replace by upstream 18** (15 + 3 candidates), **drop later 7** (with the classic loop), **optional pack 15**. Check: 46 + 18 + 7 + 15 = 86.

## 5. Architecture

### 5.1 One catalog model

```
CatalogItem {
  id            "<kind>:<publisher>/<name>"       stable, lowercase, validated
  kind          skill | plugin | mcp | llm-source
  source        { kind: github|git-subdir|marketplace|mcp-registry|zip|local,
                  url, ref?, commit (40-hex), tree?, path?, entry? }   // = plugins/source-store.mjs shape
  version       label only (semver or "git:<short>")
  publisher     { id, trust: official | verified | community | unknown | local }
  members[]     { memberId "<type>:<name>", type: skill|command|agent|hook|mcp|lsp|bin,
                  executable: bool, tokensEstimate? }            // discovered at install
  declared      { hooks, monitors, bin, lsp, mcpServers }        // the permission summary
  state (per user) { enabled: bool, disabledMembers: string[], consents: {...},
                     installedAt, pinnedCommit, previousCommit? }
  family        derived: kind + bundle id
}
```

State lives in **one new per-user file** `extensions-state.json` (atomic tmp+rename, merge-writes like `plugins/state.mjs`) plus an `extensions-installed.json` registry. The three existing files are **kept and read through adapters** for N-1 (section 10); the catalog does not delete them until a later release.

### 5.2 The active set (single source of truth)

New module `extension/extensions/active-set.mjs` (L3: imports core, kb, plugins, mcp, llm-sources; consumed by `llm_agent`, `routes`). One pure function:

```
computeActiveSet(userId, { mode, surface })  ->  {
  skills:     [{id, description, path}],          // for the catalog block + load-skill gate
  commands:   [...], subagents: [...],
  sdkPlugins: [{type:'local', path, skipMcpDiscovery:true}],   // active-view dirs
  hooks:      translated hook map (trust-gated),
  mcpServers: { name: cfg }, allowedTools: ['mcp__name'],      // consented AND enabled, none in restricted modes
  fingerprint: sha256 of the ids+commits+member flags          // cache key and "what is loaded" evidence
}
```

Rules inside it (all already true somewhere; now in one place): restricted modes (`plan`, `review`, `document`, `ask`) get no MCP (`engine.mjs:439-446`); core names win over extension names (`registry.mjs:452-496`); the reserved MCP name `llmide` cannot be shadowed; hooks only when trusted for the declared kinds; an item whose bytes are missing or whose SHA does not match the recorded commit is **excluded and reported**, never loaded.

Consumers switched to it (each is its own task and flag):

| Consumer | Today | After |
|---|---|---|
| SDK plugin delivery, hooks | `buildUserPluginDelivery` (`engine.mjs:1721`) | reads `active.sdkPlugins`, `active.hooks` |
| Skills for `load-skill`, chat "/" menu, `/kb/agent/catalog` | `buildPerUserSkillSet` (`engine.mjs:1697`, `agent-v2.mjs:148`, `agent.mjs:368`), `skill-library.mjs` | `active.skills/commands/subagents` |
| User MCP servers | `buildUserMcpServers` (`engine.mjs:1702`) | `active.mcpServers` |
| **Provider-adapter turns** | none (`provider-turn.mjs:147` `mcpServers: []`) | skills catalog block, `load-skill`, and (flag) MCP tools bridged through `llm_agent/adapter/tool-bridge.mjs` **behind the same permission gate**; plugin hooks do not run on the adapter path (stated in the UI) |
| Mac UI, phone | per-feature list calls | `GET` of the active set and fingerprint; the phone sees the same list read-only (Mobile Control bridge, **shape unverified**) |
| Health/evidence | n/a | `turn_composition` gets `extensionsFingerprint` + counts so a bench or a user can see "N items active" |

Recompute is per turn and cheap (reads small JSON; the current per-turn builders already do this), memoised by file mtimes. A toggle therefore applies to the **next turn**; no backend restart (matches the K1 rule never to auto-restart the backend).

### 5.3 Install, enable, update, rollback

- **Install** = resolve the user's choice to a commit SHA, fetch bytes at that SHA into `…/extensions/store/<id>/<sha>/` (per-user or shared-read-only with per-user state; Q-E4), validate (`claude plugin validate` offline for plugins, `skills/loader.mjs` for SKILL.md, `plugins/loader.mjs` for components), compute the permission summary and member list, run the scan (section 7), write `installed` with `enabled:false`. Zip-slip, symlink-out and size checks reuse `plugins/installer.mjs` listing checks. **Nothing executes at install.**
- **Enable** = flip metadata; for executable members show the consent sheet (hooks, monitors, bin, MCP) exactly as today; grants are per kind and are reset when a new SHA changes the declared set.
- **Update** = see section 6.
- **Disable** = metadata only; bytes stay; the active set drops it on the next turn.
- **Uninstall** = remove metadata, then bytes after a grace period (keep previous SHA 14 days, as Claude Code keeps cache 14 days).

### 5.4 Sources and registry adapters

`extension/extensions/sources/` with one adapter per source type, all returning `CatalogEntry` and sharing a cache (`index-cache.json`, TTL 6 h, ETag where offered):

| Adapter | Reads | Notes |
|---|---|---|
| `marketplace` | any `.claude-plugin/marketplace.json` (github, git, url) | default seeds: `anthropics/claude-plugins-official`, `anthropics/skills`; pins `sha` when present, else resolves the entry's `ref` to a SHA at index time |
| `skills-repo` | repo with `skills/*/SKILL.md` (Agent Skills layout) | covers `anthropics/skills`, `obra/superpowers`, `mattpocock/skills`, and our kit |
| `mcp-registry` | `registry.modelcontextprotocol.io` v0 list/search | publisher = verified namespace; cache and tolerate a wipe |
| `mcp-seed` | existing `mcp/catalog.mjs` | bundled, offline fallback |
| `github-url` | a repo the user pastes | Tier `unknown`; classification by contents (marketplace.json / `.claude-plugin/plugin.json` / `SKILL.md` / `server.json`) |

Search is over the cached index (name, description, tags, publisher). Ranking: trust tier, then registry-provided popularity if present **(unverified)**, then name match. No scraping.

## 6. Update flow

States per item: `current`, `update-available`, `updating`, `failed`, `blocked`.

1. **Check** (manual, plus a background check on app start, no more than once per 30 min as `claude-update.mjs` does): for each installed item re-read its source ref; if the resolved SHA differs from `pinnedCommit`, mark `update-available` with `{from, to, commitCount?}`. Never fetch content to the active location.
2. **Review**: fetch the new SHA into a **staging** dir. Show (a) changelog/commit titles, (b) **file diff summary** (added/removed/changed), (c) the **permission delta**: hooks, monitors, bin, MCP servers or LSP added; commands that changed; new network hosts in an MCP config, (d) scan findings (section 7), (e) token estimate delta. Executable changes are listed first and in red.
3. **Approve**: one button, per item. Updating an item whose publisher tier is `unknown` or whose executable set grew requires an explicit second confirmation and **resets consent** for the changed kinds (the rule `claude-update.mjs` already has for hook/MCP trust).
4. **Apply atomically**: validate staging; `rename` store dir into place; write `pinnedCommit` and `previousCommit`; recompute the active set. Failure at any step leaves the old SHA active (as the SDK updater already does, `sdk/updater.mjs`: install, prove it loads, roll back on failure).
5. **Repair**: if bytes are missing or the tree hash does not match `source.tree`, mark `blocked` and offer re-fetch at the **recorded** SHA (this is the "safe update/repair" the LLM-source design already has, generalised).
6. **Rollback**: swap `pinnedCommit` and `previousCommit`; one level (a second rollback slot is a later option). Mirrors the one-slot `.app.bak` rule in Apply & Rebuild.
7. **Active-only maintenance** (the user's last sentence): update checks, background fetches, token estimates and scans run for **active items first**; inactive items are only re-checked on demand or weekly, and an inactive item is never loaded after an update (D4/D5: new executable members arrive off). The update summary line reads "3 active items updated, 5 inactive items have updates (not loaded)".

## 7. Security model

| Control | Detail |
|---|---|
| **Trust levels** | `official` (sources under `github.com/anthropics/`, validated the way Claude Code validates reserved marketplace names), `verified` (MCP registry namespace proven by GitHub/DNS; pinned by SHA in an official/community catalog), `community` (listed in a catalog we index, not verified), `unknown` (pasted URL), `local` (the user's zip/dir; includes our own kit). Shown on every row and in every consent sheet |
| **Pin, never track** | Active content is always a recorded 40-hex SHA (D3). `ref` is only a hint. Mutable tags never auto-advance. npm MCP servers resolve through `mcp/package-spec.mjs` with an exact version |
| **No auto-run of new executable content** | New hooks/monitors/bin/MCP/LSP members arrive off and need a consent grant per kind; an update that adds executables resets the grant; `command` plugin sources are rejected; install scripts never run (npm `ignore-scripts`, same as Claude Code's npm source) |
| **Per-item permission summary** | Before enabling: what it can do, in plain words, from `declared` (mirrors Claude Code's "Will install" pane and the security page list: hooks, monitors, MCP/LSP, `bin/` on PATH, skills as instructions) |
| **Instruction scan** | At install/update, scan SKILL.md, command and agent bodies, and MCP tool descriptions (fetched on first connect) for: hidden/zero-width and bidi characters, base64 blobs, "ignore previous instructions" patterns, instructions to read secrets or call `curl`/`wget`, URLs to non-allowlisted hosts. Findings are **advisory and blocking for `unknown` trust** (cannot enable without an override). Heuristic only; stated as such. Reuse `guardrails/` pattern scanners (secrets/destructive ops) |
| **Description hygiene** | Skill/MCP descriptions are capped (1 536 chars as upstream) and rendered inside our "data, not instructions" fence rule (`compact-system-prompt.mjs:48`) so a description cannot carry a system-level instruction |
| **Typosquatting** | Show owner/repo and publisher tier; flag names within edit distance 2 of an official/popular item; the reserved-name rules of marketplaces are applied to our own item ids (reject `official`-lookalikes, non-ASCII, control/bidi characters) |
| **Allowlist of publishers/hosts** | Operator setting (`LLMIDE_EXT_ALLOWED_SOURCES`, glob list); default = official + community catalogs + user-pasted allowed; server-side index fetches only to the host allowlist via `pinned-fetch.mjs` |
| **Secrets** | MCP credentials only through the vault (existing `credential` shape in `mcp/catalog.mjs`); never in the registry JSON, never in a skill |
| **Least blast radius** | Restricted modes load no MCP (exists); an MCP server is mounted per turn only if enabled **and** consented **and** not blocked; `canUseTool` remains the permission path for MCP tool calls (server-level pre-approval exists today, `engine.mjs:466`; a per-tool deny list is Phase 5) |
| **Audit** | Every install/enable/update/consent writes an Activity entry (activity feed exists) with the SHA |

## 8. UI: one Extensions screen

Reuse `Features/Extensions/` (sealed). Target layout, one sidebar entry "Extensions":

- **Browse** tab: search box; filters kind (All, Skills, Plugins, MCP servers), trust tier, "installed"; each card: name, publisher + tier badge, one-line description, member counts, **"adds ~N tokens when active (estimate)"**, Install. Detail sheet: permission summary, members with checkboxes (greyed until installed), scan result, source link, commit SHA.
- **Installed** tab: grouped by family (Skills · Plugins · MCP servers · Source bundles); a **switch per item** and a **family switch** in each group header ("Skills: 12 of 31 on"); expanding an item shows member checkboxes (unchecked set). A footer shows "Active now: 12 skills, 2 plugins, 1 MCP server, about N tokens/turn (estimate)". Required-by-feature items show a lock and the reason.
- **Updates** tab: one list across kinds, split "Active" and "Inactive", with Review → Approve → Apply, Repair, Rollback.
- Token estimate source: the same estimator that `turn_composition` logs (`v2ToolDefinitionChars`, chars/4 style) for MCP and our tools, and description-length sums for skills; **labelled estimate**, replaced by a measured figure when the SDK `mcpServerStatus` (K1 A-list) is adopted. Not measured in this pass.
- Existing sheets (`ClaudePluginImportSheet`, `PluginGitInstallSheet`, `McpAddSheet`, `LlmSourceAddSheet`, `PluginMarketplaceSheet`) become "Add from URL / file" entries under Browse.
- Phone: read-only Active list and a per-item switch for non-executable items only (Q-E7).

## 9. API (additive)

New routes (one module `routes/extensions-catalog.mjs`, registered in `routes/extension-routes.mjs`, added to `ALL_ENDPOINTS`):

| Route | Purpose |
|---|---|
| `GET /auth/me/extensions/catalog?q&kind&trust` | search the cached index |
| `GET /auth/me/extensions/installed` | installed items with state, members, trust, token estimate |
| `GET /auth/me/extensions/active` | the active set summary + fingerprint |
| `POST /auth/me/extensions/install` `{id, source, commit}` | fetch at SHA into the store, `enabled:false` |
| `POST /auth/me/extensions/toggle` `{id, enabled, member?}` and `/family` `{family, enabled}` | switches |
| `POST /auth/me/extensions/consent` | per-kind executable consent (wraps hook-trust and MCP consent) |
| `GET /auth/me/extensions/updates[?force=1]`, `POST …/update/preview`, `…/update/apply`, `…/rollback`, `…/repair` | update flow |
| `POST /auth/me/extensions/uninstall` | remove |
| `GET/PUT /auth/me/extensions/settings` | allowed sources, kill switches |

Existing 28 routes stay unchanged and keep working (they become thin adapters over the same state). `SERVER_API_VERSION` 92 → 93 in Phase 1 (additive) and one more bump when the old routes are deprecated (not before K4). `MIN_SERVER_API_VERSION` unchanged (the Mac app falls back to the old Extensions screens on an older server, N-1). Contract: add `schema` entries and fixtures under `contracts/` like the provider catalog did **(exact location: confirm in P0)**; extend `sdk-surface.json` rows only if `options.skills` is adopted (it is on K1's top-15 as A10, so coordinate rather than duplicate).

## 10. Migration (existing choices preserved, N-1)

- **No data is rewritten in place.** A one-time idempotent importer builds `extensions-installed.json` from `plugin-state.json` + the plugin dir, `mcp-plugins.json` + `mcp-plugins-state.json`, and `llm-sources-state.json` + registry, assigning each existing item an id, trust `local` (or `official`/`community` when its recorded `source.url` matches), `pinnedCommit` from the stored provenance (`source-store.mjs` already records it; items with no commit are marked `unpinned` and offered "Pin to current"), and copying `enabled`, `disabledItems`, hook trust, MCP consent exactly. Nothing a user turned on becomes off; nothing off becomes on.
- **Dual read first.** Phase 1 runs the importer in memory and compares `computeActiveSet` to the legacy builders on a fixture matrix (shadow mode, logged, no behaviour change). Phase 2 switches consumers behind `LLMIDE_EXT_ACTIVE_SET=1` (default 0). The legacy files stay the written source for one release; the catalog writes both (write-through) until the flag becomes default, then the legacy writers are removed in a later release.
- **Mac N-1**: if `/health` lacks the new endpoints the Mac keeps the current screens (`REQUIRED_ENDPOINTS` unchanged).
- **Our skills move**: the 15 upstream mirrors become catalog items pointing at upstream SHAs; the kit keeps the files for one release. The 15 pack skills stay in the kit as source "GRID pack", off by default **only for new installs**; an existing user's enabled set is preserved by the importer.

## 11. Phases

Sizes: S under 1 day, M 1 to 3 days, L 3 to 6 days. Every phase ends with `make regression` green plus its gate. Token-affecting changes carry a kill switch and are measured on the token bench (paired runs at `--repeat 5`, K1 6.2) before their default flips.

| Phase | Tasks | Size | Tests / exit gate |
|---|---|---|---|
| **P0 baseline and decisions** | Fix section 14 answers; confirm unverified items in section 15 (SDK honours a filtered plugin dir; MCP registry endpoint shape; contract schema location); measure today's per-turn composition for a user with 2 plugins + 2 MCP servers + the kit via `turn_composition`; write the active-set fixture matrix from existing tests (`plugin-native-delivery`, `agent-v2-plugin-hooks`, `agent-v2-user-mcp`, `mcp-config`, `mcp-plugin-servers`) | M | numbers recorded in this plan's section 14; fixtures exist |
| **P1 model + active set (shadow)** | `extensions/model.mjs` (item, member, trust), importer from the three state files, `computeActiveSet`, shadow compare in `/health`-visible log; `GET installed/active` routes; API 93 | L | property test: for every fixture, `computeActiveSet` equals legacy builders; importer idempotent; no behaviour change; unit tests for trust and unchecked-set rules |
| **P2 consumers on the active set** (flag `LLMIDE_EXT_ACTIVE_SET`, default off) | switch SDK delivery, `load-skill`/skill catalog, MCP builder, chat "/" menu; active-view directory for member-level off (D8); `turn_composition` fingerprint | L | existing suites unchanged with flag 0 and 1; new test: unchecked member absent from SDK plugin view and from `load-skill`; bench: no regression flag-on vs flag-off with identical choices |
| **P3 provider-adapter parity** (flag `LLMIDE_EXT_ADAPTER`, default off) | skills catalog block + `load-skill` for adapter turns; MCP tools via `tool-bridge.mjs` behind the permission gate; restricted-mode rule shared | M | adapter conformance test with a fake MCP server; a disabled item never reaches an adapter turn; tools-supported flag respected (provider spec) |
| **P4 catalog sources + install** | `sources/` adapters (marketplace, skills-repo, mcp-registry, mcp-seed, github-url), host allowlist, index cache, install at SHA into store, validate, scan, permission summary, `install/toggle/consent/uninstall` routes | L | adapter tests against recorded fixtures (no live network in CI); SSRF tests like `base-url-guard`; zip/symlink/size tests; scan corpus tests (benign and adversarial samples) |
| **P5 updates, repair, rollback** | unified check, staging, diff + permission delta, apply atomically, rollback, active-first policy; reuse `claude-update.mjs`, `registry-versions.mjs` | L | failure-injection tests (kill mid-apply, bad SHA, bytes missing) leave the old SHA active; consent reset test; one-slot rollback test |
| **P6 Mac Extensions screen** | Browse / Installed / Updates tabs, family and item switches, member checkboxes, token estimate labels, lock for required items; fallback to old screens on N-1 server; swift tests for models; `feature-boundaries.sh` stays at zero | L | `make test-mac`, `make regression`; manual pass on a real project (not run here) |
| **P7 our skills diet** | swap the 15 mirrors to upstream catalog items; evaluate the 3 candidates on one real task each; move the 15 to the "GRID pack" source (off by default for new installs); update `scripts/install-skills.sh` and `kb/install-project-skills.mjs` so a **new project** gets only the keep set plus what the user switched on (the `--exclude` mechanism exists, `install-project-skills.mjs:20-26`); drop the 7 adapter-only defs with K1 P6/P7 | M | contract test pins content of the 14 keepers (`app-forge` contract test exists per memory); plan modes still pass with upstream-pinned `brainstorming/writing-plans` |
| **P8 default flips** | flip `LLMIDE_EXT_ACTIVE_SET`, then `LLMIDE_EXT_ADAPTER`, each by its own commit after the bench | S each | bench per K1 6.1; kill switches documented |
| **P9 per-tool MCP deny list and phone** (optional) | tool-level toggles via `disallowedTools` patterns; phone read-only list | M | after P8 only if asked |

Sizing: about **P0 M, P1 L, P2 L, P3 M, P4 L, P5 L, P6 L, P7 M, P8 S+S, P9 M**; roughly 5 L, 3 M, 2 S counts of work items, about 4 to 6 weeks of focused work for one engineer (estimate, not measured). P1 to P3 deliver the "only active items are loaded, including on provider turns" outcome with no new UI; P4 to P6 deliver discovery and updates; P7 delivers "reduce our skills".

## 12. Kill switches

| Switch | Default | Effect |
|---|---|---|
| `LLMIDE_EXT_ACTIVE_SET` | 0 until P8 | 0 = legacy builders; 1 = `computeActiveSet` drives every consumer |
| `LLMIDE_EXT_ADAPTER` | 0 until P8 | extensions on provider-adapter turns |
| `LLMIDE_EXT_CATALOG` | 1 | 0 hides Browse and refuses install/update routes (404 `feature_disabled` style); installed items keep working |
| `LLMIDE_EXT_ALLOWED_SOURCES` | official + community + pasted | operator allowlist |
| `LLMIDE_EXT_SCAN` | advisory | `off`/`advisory`/`block-unknown` |
| Mac pref "Use the Extensions catalog screens" | on | off falls back to current screens |

## 13. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Fetched skills or MCP descriptions carry prompt injection | trust tiers, scan, description cap + data fence, default-off, per-item consent; honesty that scans are heuristic |
| R2 | A pinned SHA is force-pushed away or the repo deleted | store the bytes at install; repair re-fetches only if reachable; show "source gone, running from local copy" |
| R3 | Member-level off cannot be honoured because the SDK loads a whole plugin dir | active-view directory (D8); verify in P0 |
| R4 | Two sources of truth during migration | write-through + shadow compare + fixture matrix; remove legacy writers only a release later |
| R5 | Token estimates mislead | label "estimate", replace with measured SDK status; never gate behaviour on the estimate |
| R6 | MCP Registry preview breaks or wipes | local cache, bundled seed, installed records never depend on the registry |
| R7 | Adapter MCP bridge widens the attack surface on providers with weaker tool discipline | flag default off; same permission gate; no MCP in restricted modes; `tools supported` capability required |
| R8 | Upstream mirrors change behaviour of plan modes (pinned verbatim today) | required-by-feature lock; pin SHA; contract test on plan pipeline |
| R9 | Scope creep into "app store" | non-goals; sources limited to five adapters |
| R10 | Update fatigue: users approve blindly | executable delta first and in red; second confirmation for growing executable set or unknown publisher; active-first |
| R11 | Server-side git/fetch widens SSRF | host allowlist + `pinned-fetch.mjs`; keep clone on the Mac if Q-E3 says so |
| R12 | Moving a skill to upstream drops our local fixes | diff review before the swap; keep fixes as an overlay skill with a different id, not an edit of the mirror |

## 14. Questions for the user (options and recommendation)

**Answered by the user, 2026-10-30:**

- **Q-E1, E2, E4, E5, E6, E7:** accept the recommendations (off after install; default sources Anthropic official + community + MCP registry + our kit with `obra/superpowers` and `mattpocock/skills` pre-listed; shared read-only store with per-user state; the 15 GRID skills become an off-by-default pack, not removed; evaluate the 3 candidates on one real task each; phone may toggle non-executable items after P8).
- **Q-E3 (downloads):** "user download as he like" — **every download is user-initiated** (explicit Install/Update click or pasted URL); nothing downloads automatically in the background. The user chooses the path: the Mac clone (as today, also for private repos) or the server fetch (public GitHub through `pinned-fetch` + host allowlist). Both stay supported; neither runs unprompted.
- **Q-E8 (scan findings):** **always just warn.** Findings are shown with the item and the per-item permission summary; the user decides. No blocking by trust level (unknown-publisher items still arrive off).
- **Q-E10 (hooks) and the general rule:** the user wants **one global extension format**; **each provider/engine uses only what it supports, and what it cannot support is skipped (not emulated, not an error)**. Plugin hooks run only where the engine has hook support (Claude Agent SDK turns, behind the existing consent gate); provider-adapter turns do not run hooks and silently skip them (the Providers list shows a capability note).
- **Q-E9 (MCP/plugin tools on provider turns):** **if the model can use tools, it uses the user's ACTIVE MCP servers and plugin tools** ("they are tools which make it fast"). So the adapter mounts the active MCP/plugin tools automatically whenever provider tools are allowed and the model is tool-capable; no extra per-feature switch is required. Safety is unchanged: the same approvals/consent gates, untrusted-data marking, egress approval, and only ACTIVE items; the kill switch `LLMIDE_EXT_ADAPTER=off` remains as an operator control.

| # | Question | Options | Recommendation |
|---|---|---|---|
| Q-E1 | Default state after install | (a) off until enabled, (b) on like Claude Code | **(a)**; matches "select/deselect"; costs one click |
| Q-E2 | Which sources ship as defaults | (a) Anthropic official + community + MCP registry + our kit, (b) also `obra/superpowers`, `mattpocock/skills` pre-listed, (c) only what the user adds | **(b)**: it covers the 15 replacements without a new trust decision beyond naming them |
| Q-E3 | Who fetches bytes | (a) Mac clones (today, no server network), (b) server `git` at SHA with host allowlist | **(b) for GitHub only** so phone/headless/Tauri work, with (a) kept for private repos; needs your OK on server egress |
| Q-E4 | Store scope | (a) per user, (b) shared read-only store + per-user state | **(b)**: one copy of bytes per SHA, tenancy in state |
| Q-E5 | Our 15 domain/scaffold skills | (a) off-by-default pack (proposed), (b) remove from kit | **(a)**; deleting is irreversible and they are GRID's |
| Q-E6 | The 3 replace-candidates | (a) evaluate then decide, (b) keep ours, (c) replace now | **(a)** |
| Q-E7 | Phone | (a) read-only, (b) toggle non-executable items, (c) none | **(b)** after P8 |
| Q-E8 | Scan strictness for unknown publishers | advisory / block | **block** for `unknown`, advisory otherwise |
| Q-E9 | Adapter MCP (P3) | (a) ship behind flag, (b) skills only | **(a)** since parity is the stated goal |
| Q-E10 | Do plugins' hooks run on adapter turns | yes / no | **no**; the SDK owns hooks; say so in the UI |

## 15. Could not verify

- Whether the SDK `plugins` option honours a generated subset directory exactly like a full plugin (assumed; P0 check).
- The primary Agent Skills spec at agentskills.io (only secondary summaries read); exact optional frontmatter fields beyond `name`/`description`.
- MCP Registry v0 endpoint paths and field names for search/popularity (third-party pages disagree: `/v0/servers` vs `/api/v0/servers`); the registry's own docs page returned only a title.
- Whether the MCP tool-search deferral threshold or token figures apply on our pinned CLI (the doc excerpt I could read did not state them; K1 L10 owns the measurement).
- Any token number for any extension (none measured); the user's `claude plugin details` Always-on figures were not run.
- The security statistics in section 2 are from secondary reports (Snyk, Antiy, Koi, CSA, OWASP as cited by blogs), not read in the primary documents.
- Whether all 13 kit `runtime/` skills are still invoked by server code; whether any route for rollback already exists (grep only, not exhaustive); the exact Mobile Control shape for listing plugins/skills; contract schema location for new routes.
- Nothing in this plan was run: no bench, no test, no Mac build, no network fetch of GitHub registries beyond the doc pages cited.
