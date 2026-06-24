---
title: Agent runtime — spec
status: draft
---

This is the rebuild-grade contract for the agent runtime; verbatim prompts are linked by repo path (version-controlled), the spec documents assembly logic and invariants.

---

## §1 Scope

The following files are governed by this document.

**Core runtime loop and protocol**

- `extension/llm_agent/runtime/loop.mjs` — iteration engine, prompt assembly, caching, depth guard
- `extension/llm_agent/runtime/fence.mjs` — fence parser and argument validator
- `extension/llm_agent/runtime/redaction.mjs` — sentinel neutralisation shared by all handlers
- `extension/llm_agent/runtime/model-tier.mjs` — per-tier model resolution
- `extension/llm_agent/runtime/route.mjs` — `/code-assist` orchestrator; wires global loop, handlers, skill views

**Read handlers (server-executed)**

- `extension/llm_agent/runtime/handlers/ask-internal.mjs`
- `extension/llm_agent/runtime/handlers/ask-subagent.mjs`
- `extension/llm_agent/runtime/handlers/search-kb.mjs`
- `extension/llm_agent/runtime/handlers/web-search.mjs` — web search; backed by `extension/agents/web-client.mjs`
- `extension/llm_agent/runtime/handlers/fetch-url.mjs` — URL fetch (SSRF-guarded); same backend

**Skill loading and registry**

- `extension/llm_agent/skills/loader.mjs` — parses and validates skill `.md` files
- `extension/llm_agent/skills/registry.mjs` — core/plugin skill state, per-user views, catalog
- `extension/llm_agent/skills/index.mjs` — public re-export surface

**Prompt and skill content** (linked, not reproduced here)

- `extension/llm_agent/global/prompt.md` — global agent role
- `extension/llm_agent/global/ask-internal.md`, `ask-subagent.md`, `update-file.md`, `web-search.md`, `fetch-url.md` — global skill bodies
- `extension/llm_agent/global/compose-prompt.mjs` — global prompt assembly
- `extension/llm_agent/internal/prompt.md` — internal agent role
- `extension/llm_agent/internal/skills/*.md` — internal skill bodies (`_base.md`, `search-kb.md`, `create-gitlab-issue.md`, `comment-gitlab-issue.md`, `trigger-review-code.md`)
- `extension/llm_agent/internal/context/app-capabilities.md` — static app-capabilities section
- `extension/llm_agent/internal/context/compose.mjs` and `render-*.mjs` — internal context renderers

**Covered in a later section (named here for completeness)**

- `extension/agents/runtime.mjs`
- `extension/agents/dispatcher.mjs`
- `extension/agents/outcome-watcher.mjs`

---

## §2 The loop

Source: `extension/llm_agent/runtime/loop.mjs`

### Caps and limits

| Constant | Value | Line |
|---|---|---|
| `DEFAULT_MAX_ITERATIONS` | 10 | loop.mjs:44 |
| `DEFAULT_DEADLINE_MS` | 180 000 ms | loop.mjs:49 |
| `MAX_TOTAL_SKILL_BYTES` | 131 072 bytes (128 KB) | loop.mjs:55 |
| `MAX_USER_MESSAGE_BYTES` | 500 000 bytes (500 KB) | loop.mjs:121 |
| `MAX_LOOP_DEPTH` | 2 | loop.mjs:128 |
| `MAX_CACHE_SIZE` | 100 entries | loop.mjs:162 |

The global agent overrides `maxIterations` to **3** (route.mjs:168) because it is user-facing and delegates depth to internal. The internal sub-loop runs with the default 10 iterations and a 120 s deadline (ask-internal.mjs:57). Plugin subagents use a 90 s deadline (ask-subagent.mjs:104).

### Depth model

`runAgentLoop` receives a `depth` parameter (default 0). The guard at loop.mjs:137–138 throws immediately if `depth > MAX_LOOP_DEPTH` (2). Depth is incremented **once**, at loop.mjs:236, when the loop dispatches a read handler — the handler receives `ctx.depth = depth + 1` and forwards it verbatim to any nested `runAgentLoop` call. This is the single enforcement point; handler authors cannot forget the increment.

Practical depth levels:

- **depth 0** — global agent (`handleCodeAssist` in route.mjs calls `runAgentLoop` at depth 0)
- **depth 1** — internal agent (ask-internal.mjs) or plugin subagent (ask-subagent.mjs); both receive `ctx.depth` from the loop (already +1)
- **depth 2** — any further nesting (not currently wired but bounded by the cap)

### Per-turn algorithm

Each iteration of the `for` loop (loop.mjs:171–261) executes the following steps:

1. **Deadline check** — if wall-clock elapsed exceeds `deadline`, return `{ reply, pendingTool: null }` with a deadline-expired annotation (loop.mjs:172–176).
2. **Prompt assembly** — `buildIterationPrompt` (loop.mjs:96–117) concatenates:
   - The composed system prompt (base role + optional context block + skill bodies)
   - Up to 8 recent history messages (loop.mjs:84), each truncated to 6 000 chars, with fence sentinels redacted
   - The user message (fence-redacted, loop.mjs:103)
   - The previous assistant output `prevOutput`, if any
   - A `<<<TOOL_RESULT>>>` block (or tool-error block), if the previous iteration produced one (loop.mjs:111–113)
   - A trailing `Assistant:` marker
3. **Model call** — `runClaude(prompt, { userId, model, maxTokens })` (loop.mjs:189–193). `maxTokens` defaults to 2048 when not provided.
4. **Parse** — `parseFence(out)` (loop.mjs:195) extracts any fence call from the raw model output (see §3).
5. **No fence** — if `parseFence` returns no fence:
   - If `parseError` is set, record it as `toolError` and continue to next iteration (loop.mjs:199–201).
   - Otherwise, return `{ reply: preToolText, pendingTool: null, iterations, cacheHits }` (loop.mjs:203).
6. **Skill lookup** — look up `fence.name` in `skills` map; unknown name → `toolError`, continue (loop.mjs:206–210).
7. **Validate args** — `validateArgs(skill.schema, fence.arguments)` (loop.mjs:212–216). Validation error → `toolError`, continue.
8. **Write skill** — if `skill.kind === 'write'`, return immediately with `{ reply: preToolText, pendingTool: { name, arguments } }` (loop.mjs:218–223). The loop does NOT execute write tools; they go to the client.
9. **Read skill cache** — key shape: `"<toolName>:<JSON-stable-args>"` (loop.mjs:227). Cache hit → return cached result, increment `cacheHits`. Cache stores only successes (loop.mjs:241). Cache capped at 100 entries; oldest entry evicted when full (loop.mjs:238–240).
10. **Read skill execution** — `runReadHandler(name, args, { userId, kb, handlers, depth: depth + 1 })` (loop.mjs:236).
11. **Handler error** → `toolError`, continue.
12. **Pending tool from nested loop** — if the handler returns `result.pendingTool`, propagate it up unchanged (loop.mjs:252–258). This is how an internal write fence surfaces to the client through the global loop.
13. **Feed result** — `toolResult = result`; next iteration embeds it as `<<<TOOL_RESULT>>>`.

When the iteration cap is exhausted, the loop returns with an iteration-limit annotation (loop.mjs:263–264).

### System prompt assembly

`buildSystemPrompt` (loop.mjs:57–80) takes `{ base, skills, agentContextBlock }` and joins them in this order:

1. `base` — the pre-composed role/rules prompt for the active agent
2. `agentContextBlock` — the rendered `# System context` block (internal only; empty string for global)
3. `# Available skills` heading
4. Skill bodies joined with `\n\n---\n\n`

Skill bodies are iterated in `skills.values()` order and skipped once their cumulative UTF-8 size exceeds `MAX_TOTAL_SKILL_BYTES` (131 072 bytes). Core skills load first and are never skipped (loop.mjs:60–72).

---

## §3 Fence protocol

### Parse sentinels

Source: `extension/llm_agent/runtime/fence.mjs`

The two sentinel strings (fence.mjs:5–6):

```
<<<TOOL_CALL>>>
<<<END_TOOL_CALL>>>
```

The tool-result sentinels embedded by the loop (loop.mjs:111):

```
<<<TOOL_RESULT>>>
<<<END_TOOL_RESULT>>>
```

### Parse rules (`parseFence`, fence.mjs:8–42)

1. If the raw output contains no `<<<TOOL_CALL>>>`, return `{ text: raw, fence: null }`.
2. If `<<<END_TOOL_CALL>>>` is missing after the open sentinel, return `parseError: 'unterminated fence: missing <<<END_TOOL_CALL>>>'`.
3. Extract the JSON blob between the two sentinels and `JSON.parse` it. Parse failure → `parseError`.
4. The blob must be a non-array object; must have a non-empty string `name`; must have a non-array object `arguments`. Any violation → `parseError`.
5. Return `{ text: <text-before-sentinel>, fence: { name, arguments } }`.

Text before the open sentinel is accumulated into `preToolText` across iterations (loop.mjs:196), forming the plain-text portion of the final reply.

### Argument validation (`validateArgs`, fence.mjs:44–92)

Iterates the skill's `schema` object. For each declared argument:

- **Missing + required** → error `"missing required argument '<name>'"` (fence.mjs:52)
- **Missing + optional** → skipped (not included in validated value)
- **type `string`** — checks `typeof v !== 'string'`; checks `v.length > maxLength` if set (fence.mjs:56–59)
- **type `number`** — checks `typeof v !== 'number' || !Number.isFinite(v)` (fence.mjs:61–63)
- **type `boolean`** — checks `typeof v !== 'boolean'` (fence.mjs:65–66)
- **type `string[]`** — checks array-of-strings; checks element count against `maxItems` (default 512, fence.mjs:74); applies `maxLength` per element (fence.mjs:78–85)
- **Unsupported type** → error (fence.mjs:87)
- **Enum constraint** — a `string` arg with a non-empty `enum` array in its schema rejects any value not present in that list, returning `"must be one of: <values>"`.
- **Undeclared-key rejection** — any key present in `fence.arguments` that is not declared in the skill's schema is rejected with `"unexpected argument '<key>'"`. This prevents the model from passing extra keys that the handler never reads, which would otherwise be silently ignored.

Returns `{ value }` on success or `{ error }` on first failure.

### Error → retry behavior

A `parseError` or validation error sets `toolError` and the loop continues to the next iteration (loop.mjs:199–201, 215–216). The error is embedded in the next iteration's prompt as a `<<<TOOL_RESULT>>>` block containing `{ "error": "<message>" }` (loop.mjs:113). The model is expected to correct its call.

### Redaction (`redaction.mjs`)

Source: `extension/llm_agent/runtime/redaction.mjs`

`redactFence(s)` (redaction.mjs:16–19) neutralises both `<<<` and `>>>` by inserting a Unicode zero-width joiner (U+200D) between the angle brackets:

- `<<<` → `<<​<` (with ZWJ after the second `<`)
- `>>>` → `>​>>` (with ZWJ after the first `>`)

The result is visually identical but is no longer matched by the `indexOf`-based parser.

**Where redaction is applied** (defense-in-depth):

- User message: redacted before embedding in `buildIterationPrompt` (loop.mjs:103)
- History messages: each content string is redacted and truncated to 6 000 chars (loop.mjs:90)
- Tool results (nested agent answers, KB snippets): `redactDeep` is applied recursively before embedding as `<<<TOOL_RESULT>>>` (loop.mjs:111)
- Tool errors: redacted inline (loop.mjs:113)
- Sub-loop replies: redacted at the handler boundary before returning — `ask-internal` (ask-internal.mjs:64) and `ask-subagent` (ask-subagent.mjs:113) both call `redactFence(result.reply)` — providing defense-in-depth before the outer loop's `redactDeep` runs
- Internal system context: the entire `composeSystemContext` block — app state (issues, meetings, project, repos) plus the Graphify repo-memory — is redacted before it becomes the internal agent's `# System context` (compose.mjs)
- Global repo-memory: the Graphify memory block injected into the global agent's base is redacted before injection (route.mjs)

**Threat addressed:** a meeting title, issue body, or KB snippet containing the literal string `<<<TOOL_CALL>>>` would otherwise survive `JSON.stringify` as a parseable sentinel and forge a write-tool invocation when the outer loop embeds the answer (loop.mjs:9–13).

---

## §4 Skills and prompts

### Skill frontmatter schema

Source: `extension/llm_agent/skills/loader.mjs`

Each skill is a Markdown file with a YAML frontmatter block. The loader validates the following fields:

| Field | Required | Values / constraints | Source |
|---|---|---|---|
| `name` | yes | non-empty string; must match filename (without `.md`) | loader.mjs:113–125 |
| `kind` | yes | `'read'` or `'write'` | loader.mjs:117–129 |
| `description` | no | 1–2 sentence summary; falls back to first prose line of body | loader.mjs:143–145 |
| `schema` | no | object mapping arg name → `{ type, required?, maxLength?, description? }` | loader.mjs:52–73 |
| `confirmation` | no (required for write) | write skills must have `confirmation: editable-sheet` or `confirmation: gitop-sheet` | loader.mjs:130–132 |
| `model` | no | model string (used by subagent frontmatter, not core skills) | — |

**Per-file size cap:** `MAX_SKILL_BYTES = 32_768` bytes (32 KB) per skill file including `_base.md` (loader.mjs:17). Files exceeding this limit are dropped with a warning. `_base.md` is rejected entirely (not truncated) because truncating the fence-protocol contract mid-sentence produces subtly malformed tool calls (loader.mjs:93–99).

**Name must match filename** (loader.mjs:121–125): `fm.name` is compared against the filename with `.md` stripped. A mismatch is a loader error, not a warning, so skill files cannot be silently mis-keyed.

**Write skills require `confirmation: editable-sheet` or `confirmation: gitop-sheet`** (loader.mjs:130–132). This field is the wire contract with the client: the client receives `pendingTool` and shows a confirmation sheet before applying the change. `editable-sheet` is for file-edit and issue-create tools; `gitop-sheet` is for the `git-op` tool (which shows a git-specific confirmation UI, with a red warning banner for destructive ops).

Valid `schema` argument types: `string`, `number`, `boolean`, `string[]` (loader.mjs:12).

### Read-vs-write semantics

**Read skills** have a server-side handler function registered in `INTERNAL_HANDLERS` (ask-internal.mjs:21) or the global handler map (route.mjs:115–146). When the loop dispatches a read skill, the handler runs server-side and its result is fed back into the loop as `<<<TOOL_RESULT>>>`. The model sees the result and may make further tool calls.

**Write skills** cause the loop to exit immediately, returning `{ reply: preToolText, pendingTool: { name, arguments } }` to the caller (loop.mjs:218–223). No server-side code executes; the client is responsible for showing the editable sheet and applying the change. A write fence surfaced from a nested internal loop is propagated up through any intermediate read-handler results unchanged (loop.mjs:252–258).

### Web tools (`web-search`, `fetch-url`)

Both are global read skills. Their handlers resolve a backend at call time, reusing the app's existing Anthropic credential the same way `runClaude` does — no SerpAPI key required by default:

1. **Anthropic API key present** (`providerApiKey(userId, 'anthropic')`) → the Messages API's native `web_search` / `web_fetch` server tools (`web-client.mjs` → `searchWebViaAnthropic` / `fetchUrlViaAnthropic`).
2. **Otherwise** → the `claude` CLI's built-in `WebSearch` / `WebFetch` via the operator/subscription login. The CLI argv (`anthropicWebCliArgs`, providers.mjs) passes both `--tools <tool>` (makes it available) **and** `--allowedTools <tool>` (pre-approves it) — without the latter, headless `-p` mode declines the tool ("I don't have permission to use WebFetch yet").
3. **Fallback** → SerpAPI (`searchWeb`, `LLMIDE_SERPAPI_KEY` env var only) / a direct HTTP fetch with HTML stripped. Note: `serpapi.apiKey` is NOT in the vault `ALLOWED_KEYS` set (`extension/server/vault.mjs`), so any attempt to read it via `getSecret` silently no-ops. SerpAPI is only activated when `LLMIDE_SERPAPI_KEY` is set in the server process environment.

`web-search` returns `{ answer, sources: [{title, url}], count }`; `fetch-url` returns `{ title, text }`. `fetch-url` runs `assertSafeBaseUrlResolved` (providers.mjs) first as an SSRF guard (blocks localhost/private targets) — the only thing between the URL and the backend's own network on the direct-fetch path.

### Per-user skill set (`buildPerUserSkillSet`, registry.mjs:201–245)

Called once per request in `handleCodeAssist` (route.mjs:52). Algorithm:

1. Start with a copy of `internalSkills.skills` (registry.mjs:205).
2. For each plugin the user has enabled (`listEnabledPlugins(userId)`):
   - Load the plugin's `skills/` directory through the same validator as core skills.
   - For each plugin skill, if its name clashes with a core skill, **core wins** and the plugin version is not loaded (registry.mjs:220–226; logged as a warning).
   - Otherwise, add the skill to the map tagged with `pluginName`.
   - Add the plugin's slash commands to `commands`.
   - Add the plugin's subagents to `subagents` (first-declared name wins across plugins, registry.mjs:239–241).
3. Return `{ skills, commands, subagents }`.

The global agent always runs with `globalSkills.skills` (route.mjs:149), not the per-user internal set. The per-user set is the internal agent's effective skill map.

### Linked skill catalog and verbatim prompts

Full skill catalog (all global, internal, and plugin skills): [`../reference/agent-skills.md`](../reference/agent-skills.md)

Verbatim prompt and skill files (version-controlled; read the source, do not rely on this spec for wording):

- `extension/llm_agent/global/prompt.md` — global agent role and rules
- `extension/llm_agent/global/ask-internal.md` — `ask-internal` skill body
- `extension/llm_agent/global/ask-subagent.md` — `ask-subagent` skill body
- `extension/llm_agent/global/update-file.md` — `update-file` write skill body
- `extension/llm_agent/global/git-op.md` — `git-op` write skill body
- `extension/llm_agent/global/web-search.md` — `web-search` read skill body
- `extension/llm_agent/global/fetch-url.md` — `fetch-url` read skill body
- `extension/llm_agent/internal/prompt.md` — internal agent role and rules
- `extension/llm_agent/internal/skills/search-kb.md`
- `extension/llm_agent/internal/skills/create-gitlab-issue.md`
- `extension/llm_agent/internal/skills/comment-gitlab-issue.md`
- `extension/llm_agent/internal/skills/trigger-review-code.md`
- `extension/llm_agent/internal/context/app-capabilities.md` — static app-capabilities section

### Prompt composition

**Global agent** (`extension/llm_agent/global/compose-prompt.mjs`)

`composeGlobalPrompt()` (compose-prompt.mjs) returns the role **base only** — `rolePrompt`, the contents of `global/prompt.md` cached at module load. It does **not** embed skill bodies: `buildSystemPrompt` renders `# Available skills` + bodies exactly once (it already holds the skills map for dispatch — §2), so the base omits them. This mirrors the internal agent (role-only base, skills rendered by the loop); embedding them here too previously double-sent the global agent's skills.

This is computed once at server start as `globalPromptBase` (route.mjs) and used as `agentContext.base`. Per request, `route.mjs` appends to the base, in order:

1. an optional **persona** suffix (the user's configured voice), and
2. the **redacted Graphify repository-memory block** — the same `renderGraphifyMemory(agentContext, userId)` output the internal agent gets, run through `redactFence` before injection. This lets the global Code Assistant ground project answers in repo memory even when it answers directly instead of delegating to `ask-internal`.

The repo-memory block is the **only** app-specific context the global agent receives — active project, indexed repos, recent issues/meetings, and app-capabilities all stay internal-only (the global agent's `agentContext.includeSystemContext` is never set, so the loop composes no `# System context` for it — route.mjs).

**Internal agent** (`extension/llm_agent/internal/context/compose.mjs`)

`composeSystemContext(agentContext, userId)` (compose.mjs:21–38) assembles the `# System context` block in this order:

1. `# System context` heading
2. `appCapabilities` — contents of `internal/context/app-capabilities.md`, cached at module load (compose.mjs:19)
3. `renderActiveProject(agentContext)` — `## Active project` with name, URL, default branch (render-active-project.mjs:5–16)
4. `renderIndexedRepos(agentContext)` — `## Indexed code repositories` list (render-indexed-repos.mjs:3–15)
5. `renderRecentIssues(agentContext)` — `## Recent open issues` list; omitted when empty (render-recent-issues.mjs:6–22)
6. `renderRecentMeetings(agentContext)` — `## Recent meetings` list; omitted when empty (render-recent-meetings.mjs:4–15)
7. `renderGraphifyMemory(agentContext, userId)` — Graphify-generated repo memory (repo.md, graph-notes.md, prior Q&A); gated on user's repo allow-list (compose.mjs:35). Each present repo's block header carries a freshness clause — `(updated ~N ago)` from the memory files' mtime — and an indexed, allow-listed repo with **no** generated memory emits an explicit `No code-graph memory generated for this repo yet.` marker instead of silently contributing nothing, so the agent can weigh or caveat stale/absent grounding (facts only — no "stale" verdict; `memory.mjs`)

Empty sections (empty string return) are filtered before joining, and the **entire assembled block is run through `redactFence`** (compose.mjs) — issue titles, meeting content, repo names, and Graphify memory are all external/user-derived and flow into the internal agent's system prompt, so a `<<<TOOL_CALL>>>` smuggled via (say) a meeting title cannot prime a forged tool call. This block is only injected when `agentContext.includeSystemContext === true` (loop.mjs), which is set only by `askInternal` (ask-internal.mjs).

The internal agent's `base` string is assembled in `askInternal` (ask-internal.mjs:29–32) as:

1. `internalRolePrompt` — contents of `internal/prompt.md`, cached at module load (ask-internal.mjs:16)
2. `internalSkills.base` — contents of `internal/skills/_base.md` (the fence-protocol contract)

These are joined with `\n\n` and passed as `agentContext.base` to the internal `runAgentLoop`.

---

## §5 Sub-model routing

Sources: `extension/llm_agent/runtime/model-tier.mjs`, `extension/llm_agent/runtime/route.mjs`, `extension/agents/runtime.mjs`

### Tier→env mapping

Three named tiers are resolved at server startup in `route.mjs` (route.mjs:29–31):

| Tier constant | Env var | Fallback |
|---|---|---|
| `GLOBAL_AGENT_MODEL` | `LLMIDE_AGENT_MODEL` | `undefined` |
| `INTERNAL_AGENT_MODEL` | `LLMIDE_INTERNAL_MODEL` | `GLOBAL_AGENT_MODEL` |
| `SUBAGENT_MODEL` | `LLMIDE_SUBAGENT_MODEL` | `GLOBAL_AGENT_MODEL` |

`undefined` means the tier is unset; `runClaude` then falls back to its own default (see resolution order below).

`model-tier.mjs` exports a single pure function `resolveTierModel({ model, tier }, env)` (model-tier.mjs:12–16):

- If an explicit `model` argument is truthy, return it immediately.
- If `tier === 'subagent'`, return `env.LLMIDE_SUBAGENT_MODEL || undefined`.
- Any other or absent `tier` → return `undefined`.

This function is env-injectable so it can be unit-tested without a running server. It is currently used for request-level tier hints; the three `route.mjs` constants cover the per-agent-type wiring described below.

### Resolution order

For any call to `runClaude`, the model that executes is determined by the following cascade:

1. **Explicit `model` argument** — the caller passes a resolved model string (e.g. the value of `GLOBAL_AGENT_MODEL`). Wins immediately if truthy (route.mjs:167, ask-internal.mjs: model arg, ask-subagent.mjs:102).
2. **Plugin subagent frontmatter `model:`** — inside `askSubagent`, `subagent.model || ctx.defaultModel` is passed as the `model` arg (ask-subagent.mjs:102). The subagent's own frontmatter `model:` field wins over the deployment-wide `LLMIDE_SUBAGENT_MODEL`; when the field is absent or blank, `ctx.defaultModel` (which equals `SUBAGENT_MODEL` from route.mjs:31) is used.
3. **Tier env var** — resolved at server startup from `LLMIDE_AGENT_MODEL`, `LLMIDE_INTERNAL_MODEL`, or `LLMIDE_SUBAGENT_MODEL` (route.mjs:29–31).
4. **`LLMIDE_MODEL`** — `runClaude`'s own default: `const DEFAULT_MODEL = process.env.LLMIDE_MODEL || 'claude-sonnet-4-6'` (runtime.mjs:23).
5. **Hardcoded fallback** — `'claude-sonnet-4-6'` (runtime.mjs:23).

### `CLAUDE_MODEL_RE` filter

Before any model id reaches the Anthropic API, `resolveModel` validates it (runtime.mjs:41–44):

```js
const CLAUDE_MODEL_RE = /^claude-[a-z0-9.-]+$/;
function resolveModel(model) {
  return (typeof model === 'string' && CLAUDE_MODEL_RE.test(model)) ? model : DEFAULT_MODEL;
}
```

`resolveModel` is the **Anthropic-path** validator: an id that is empty, stale, or not a valid Claude id falls back to `DEFAULT_MODEL`, so new Claude ids (e.g. `claude-opus-5`) keep working without a code change and no malformed id reaches the Anthropic API as a hard error (runtime.mjs:36–44).

Since multi-provider routing landed (see §6 *Provider routing* below), this fallback is **not** universal: an id recognized as another provider (`gpt-…`, `gemini-…`, etc.) is routed to that provider by `resolveProvider` and used **as-is** — it does not collapse to `DEFAULT_MODEL`. The Claude-only fallback applies only to ids that route to the Anthropic provider (a `claude-…` id, or an unrecognized id, which defaults to Anthropic). `resolveClaudeCall` computes `resolvedModel` on every call (runtime.mjs:555), but the non-Anthropic HTTP path passes the caller's raw `model` to `completeViaApi`, so `resolvedModel` is consumed only on the Anthropic path.

---

## §6 `runClaude`

Source: `extension/agents/runtime.mjs`

`runClaude(prompt, { userId, model, maxTokens, cacheTranscript, provider })` is the shared LLM call primitive used by every Phase-4+ agent. Within a chosen provider it has two execution paths: an HTTP API path and a CLI fallback path.

### Provider routing

`resolveClaudeCall({ userId, model, provider })` (runtime.mjs:108) selects the target provider before execution. `resolveProvider(model)` (providers.mjs:132) maps a model id by prefix — `claude*` → `anthropic`, `gpt*`/`o<n>`/`codex` → `openai`, `gemini*` → `google` — defaulting to `anthropic`. The `custom` provider (a generic OpenAI-compatible endpoint: OpenRouter, Ollama/LM Studio, DeepSeek, …) is **not** id-prefix routable and must be selected explicitly via the `provider` argument (providers.mjs:22–33). For any non-Anthropic provider, `runClaude` calls `completeViaApi(provider, …)` — an OpenAI-compatible HTTP client (providers.mjs:229) — for the HTTP path, and `runViaCli(provider, …)` for the CLI path (runtime.mjs:115–124). A user-supplied `custom.baseUrl` is validated by an SSRF guard (`assertSafeBaseUrl`, providers.mjs:65 — https-only, rejects localhost/private IPv4+IPv6, with a DNS-resolution check) before any fetch. The per-provider API key comes from the user's vault first, then an operator env fallback (`providerApiKey`, providers.mjs:142), so spend bills the user's own account when they've configured a key.

The sections below detail the **Anthropic** provider's two paths; other providers follow the same HTTP-then-CLI shape through `providers.mjs`.

### Prompt cap

A hard cap of **500 000 characters** is enforced before either path executes (runtime.mjs:78, 90–92):

```js
const MAX_PROMPT_CHARS = 500_000;
if (prompt.length > MAX_PROMPT_CHARS) {
  throw new Error(`runClaude: prompt too long (${prompt.length} > ${MAX_PROMPT_CHARS} chars)`);
}
```

This cap is aligned with the server-level body cap documented in [`api-server.md`](api-server.md), which enforces 500 000 characters via `sanitizeForPrompt()` before calling into the agent layer.

### HTTP API path (per-user vault key)

**Trigger:** an API key is available — either from the user's vault (`getSecret(db, userId, 'claude.apiKey')`, runtime.mjs:523–528) or from `process.env.ANTHROPIC_API_KEY`.

**Prompt caching:** when `cacheTranscript` is `true` and the prompt contains the sentinel `<<<BEGIN>>>`, the prompt is split at that sentinel. The pre-sentinel portion is sent as a plain text content block; the post-sentinel portion (the fenced transcript) is sent with `cache_control: { type: 'ephemeral' }` (runtime.mjs:144–153). This cuts input-token cost by ~90% on repeated calls to long transcripts.

**Per-attempt HTTP timeout:** `AbortSignal.timeout(60_000)` — a 60-second ceiling per HTTP attempt (runtime.mjs:181). `TimeoutError` and `AbortError` are treated as transient and enter the retry path.

**Retry schedule:** transient errors (HTTP 529, 503, or 60-second timeout) retry using `RETRY_DELAYS_MS = [1_000, 3_000]` from `agents/backoff.mjs` (backoff.mjs:7) — two retry delays giving three total attempts. Delay is jittered ±25% (`jittered`, backoff.mjs:12–15).

**Context-overflow retry:** a 400 response whose body matches `/max_tokens|too long|context/i` triggers a single retry with `attemptMaxTokens` halved (runtime.mjs:226–230). Retrying stops if `attemptMaxTokens` would fall below `MIN_OVERFLOW_TOKENS = 256` (runtime.mjs:27, 227).

**`max_tokens` default:** `8192` when the caller does not supply `maxTokens` (runtime.mjs:97).

**User-scoped key — no silent fallback:** when a user-scoped key is in play, any HTTP failure (non-transient error, empty content, or thrown exception) throws immediately; it never falls through to the CLI (runtime.mjs:198–200, 234–237, 248–251, 267–269). The rationale: the caller's intent is to bill and quota against the user's own Anthropic account; falling back to the operator CLI would silently misattribute spend and sidestep the user's quota.

### CLI fallback path (operator subscription)

**Trigger:** no API key is available, or the HTTP path exits its retry loop without a successful response (operator-key only).

**Invocation:** `execFile('claude', ['--strict-mcp-config', '--setting-sources', '', '--tools', '', '-p', prompt], { timeout: CLAUDE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env })` (runtime.mjs:312–316, argv built by `CLI_ARG_BUILDERS.anthropic` in `providers.mjs:285`). The flags serve distinct purposes:

- `--strict-mcp-config` (with no `--mcp-config`) loads **zero** MCP servers, so a cold `claude` spawn skips booting every MCP server the user has configured — the dominant per-call cost in CLI mode.
- `--setting-sources ''` loads zero user/project/local settings, so the operator's hooks (e.g. a superpowers SessionStart plugin) do not inject into the agent's context.
- `--tools ''` makes `claude -p` a pure text-completion call — no built-in tools are available. (Web handlers opt in separately via `anthropicWebCliArgs`, which passes `--tools <tool> --allowedTools <tool>` instead.)

The agent supplies its own context via the prompt and never needs the user's MCP servers here.

**CLI timeout:** `CLAUDE_TIMEOUT_MS = 90_000` ms (90 seconds per attempt) (runtime.mjs:14).

**Env allowlist:** the subprocess receives only the following keys from `process.env` (runtime.mjs:288–310): `PATH`, `HOME`, `TMPDIR`, `TMP`, `TEMP`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `LANG`, `LC_ALL`, `NODE_ENV`, `ANTHROPIC_BASE_URL`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `APPDATA`, `USERPROFILE`. Empty-string entries are deleted before exec. Secrets such as `JWT_SECRET` and `LLMIDE_VAULT_KEY` are explicitly excluded. `ANTHROPIC_API_KEY` is included only if an API key was resolved (runtime.mjs:308).

**CLI overload retry:** uses the same `RETRY_DELAYS_MS` schedule. A stderr/stdout match against `/\b529\b|\boverloaded\b|\b503\b|\bservice unavailable\b/i` (runtime.mjs:54–56) sets `err.overloaded = true`, which triggers the retry loop (runtime.mjs:331).

**Key redaction:** `redactKey(text, apiKey)` (runtime.mjs:64–74) first masks the literal in-flight API key, then runs the shared `redactSecrets` pattern set (`extension/core/redact-secrets.mjs`) over the text — scrubbing every recognized credential shape (`sk-ant-*`, OpenAI `sk-proj-*` / `sk-…` classic, `ghp_*`, `github_pat_*`, Slack `xox*`, Google `AIza*`, AWS `AKIA*`, `Bearer …`, `apiKey=…`), not just Anthropic keys — before it reaches logs or client error envelopes. The pattern set is the single source of truth shared with the audit log and outcome watcher, so every sink redacts identically.

---

## §7 Dispatch + outcomes

### Dispatcher

Source: `extension/agents/dispatcher.mjs`

`dispatchPlan(userId, { planId, target, taskIds, config })` is the public entry point (dispatcher.mjs:401).

**Targets:** `preview`, `github`, `backlog`, `linear` (dispatcher.mjs:32). Any other value throws immediately. `preview` never calls an external API — it returns the exact payload that would be sent (dispatcher.mjs:249–258).

**Idempotency:** each task is checked for `task.meta?.dispatched?.url` before dispatch (dispatcher.mjs:70–71). Tasks where this field is truthy are returned as `{ status: 'skipped', reason: 'already dispatched' }` with no external call. Re-running a dispatch after a partial failure is therefore safe.

**Per-target concurrency:** each adapter calls `pMap(tasks, fn)` with no explicit concurrency argument, so it uses `pMap`'s default of **4** concurrent in-flight requests (p-map.mjs:19). The outcome watcher also uses `CONCURRENCY = 4` (outcome-watcher.mjs:19).

**Per-request HTTP timeout:** each external API call uses `AbortSignal.timeout(15_000)` — 15 seconds per issue-create request (dispatcher.mjs:105, 159, 215).

**Secret redaction on errors:** `redactErrorBody(text)` (dispatcher.mjs:24–30) runs all patterns from `SECRET_PATTERNS` (guardrails/rules.mjs) over the provider's error body before returning it in the result. The output is capped at 300 characters.

**Dispatch retry schedule** (dispatcher.mjs:271–278):

| Attempt | Base delay |
|---|---|
| 1 | 60 s (1 min) |
| 2 | 300 s (5 min) |
| 3 | 900 s (15 min) |
| 4 | 3 600 s (1 hr) |
| 5+ | 14 400 s (4 hr, cap) |

All delays are jittered ±25% via `jittered()` (backoff.mjs:12–15). Maximum retry attempts: `MAX_RETRY_ATTEMPTS = 5` (dispatcher.mjs:278). After the cap is reached, `gaveUp: true` is written to `task.meta.dispatchRetry` and no further retries are scheduled (dispatcher.mjs:299–309).

`retryFailedDispatches(userId, config)` processes at most `MAX_CONCURRENT_RETRIES = 5` tasks concurrently (dispatcher.mjs:284) and has an absolute sweep deadline of `RETRY_SWEEP_DEADLINE_MS = 120_000` ms (dispatcher.mjs:287). Tasks not reached in a sweep are deferred to the next call.

### Outcome watcher

Source: `extension/agents/outcome-watcher.mjs`

`refreshAllOutcomes(userId, { creds, taskIds })` polls all dispatched tasks via `pollOne` (from `outcome-providers.mjs`) and records state transitions.

**Record-only-on-state-change:** `recordOutcome` (outcomes.mjs:127) wraps its INSERT in a transaction. It reads the most recent outcome row for the task and returns `null` without inserting if both `state` and `meta` are unchanged (outcomes.mjs:148–151). `pollTask` in the watcher tests `!!recorded` to set `changed` on the result (outcome-watcher.mjs:185).

**Client-supplies-credentials rule:** tracker credentials (`github.token`, `linear.apiKey`, `backlog.apiKey`) are passed in the `creds` object from the client and live only for the duration of the HTTP call. They are never written to the server DB. The background poller reads them from the encrypted vault (`getSecrets(db, userId, [...])`, outcome-watcher.mjs:229–233); the client-triggered path receives them directly from `chrome.storage`. No server-side plaintext persistence of tracker tokens occurs.

**Background poller:** `startBackgroundOutcomePoller()` sets an interval of `OUTCOME_POLL_INTERVAL_MS` (default 5 minutes; overridable via `LLMIDE_OUTCOME_POLL_MS`) (outcome-watcher.mjs:204–207). It is unref'd so it does not block server shutdown (outcome-watcher.mjs:256).

**Per-(provider, userId) circuit breaker** (outcome-watcher.mjs:37–79):

| Parameter | Value | Source |
|---|---|---|
| `CB_FAILURE_THRESHOLD` | 3 consecutive failures | outcome-watcher.mjs:37 |
| `CB_BASE_COOLDOWN_MS` | 15 000 ms (15 s) first open | outcome-watcher.mjs:39 |
| `CB_MAX_COOLDOWN_MS` | 300 000 ms (5 min) | outcome-watcher.mjs:38 |
| Max CB entries (memory) | 10 000 | outcome-watcher.mjs:62 |

Circuit key shape: `` `${provider}::${userId}` `` (outcome-watcher.mjs:43).

Cooldown formula when `failures >= CB_FAILURE_THRESHOLD` (outcome-watcher.mjs:68–71):

```js
const exp = Math.min(cb.failures - CB_FAILURE_THRESHOLD, 5);
cb.openUntil = Date.now() + Math.min(CB_BASE_COOLDOWN_MS * (2 ** exp), CB_MAX_COOLDOWN_MS);
```

This produces: 15 s → 30 s → 60 s → 120 s → 240 s → 300 s (capped), for failure counts 3, 4, 5, 6, 7, 8+.

State is in-process/in-memory and resets on server restart — by design, so a fresh start re-probes rather than staying permanently open (outcome-watcher.mjs:34–35).

When the circuit is open, `pollTask` returns a synthetic `state: 'unknown'` result with `circuitOpen: true` and does not call `pollOne` (outcome-watcher.mjs:144–156). A successful probe clears the entry entirely via `circuitBreakers.delete(k)` (outcome-watcher.mjs:56).

---

## §8 See also

- [`../explanation/agent-runtime.md`](../explanation/agent-runtime.md) — narrative explanation of the agent runtime (forward-looking; document not yet created)
- [`../explanation/meeting-agent.md`](../explanation/meeting-agent.md)
- [`../explanation/agent-tools.md`](../explanation/agent-tools.md)

---

## Regeneration checklist
- [x] Every governed symbol/endpoint/table/prompt is present with its exact shape (no "etc.", no "see code").
- [x] Every magic number, timeout, cap, regex, and crypto parameter is stated.
- [x] Spot-check: the loop algorithm, fence sentinels, sub-model cascade, and runClaude paths were rebuilt from this page and match source.
- [x] Structured facts link to their extractor-generated reference page (no hand-copied drift).
