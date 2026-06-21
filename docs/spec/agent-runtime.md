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

**Skill loading and registry**

- `extension/llm_agent/skills/loader.mjs` — parses and validates skill `.md` files
- `extension/llm_agent/skills/registry.mjs` — core/plugin skill state, per-user views, catalog
- `extension/llm_agent/skills/index.mjs` — public re-export surface

**Prompt and skill content** (linked, not reproduced here)

- `extension/llm_agent/global/prompt.md` — global agent role
- `extension/llm_agent/global/ask-internal.md`, `ask-subagent.md`, `update-file.md` — global skill bodies
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
| `confirmation` | no (required for write) | write skills must have `confirmation: editable-sheet` | loader.mjs:130–132 |
| `model` | no | model string (used by subagent frontmatter, not core skills) | — |

**Per-file size cap:** `MAX_SKILL_BYTES = 32_768` bytes (32 KB) per skill file including `_base.md` (loader.mjs:17). Files exceeding this limit are dropped with a warning. `_base.md` is rejected entirely (not truncated) because truncating the fence-protocol contract mid-sentence produces subtly malformed tool calls (loader.mjs:93–99).

**Name must match filename** (loader.mjs:121–125): `fm.name` is compared against the filename with `.md` stripped. A mismatch is a loader error, not a warning, so skill files cannot be silently mis-keyed.

**Write skills require `confirmation: editable-sheet`** (loader.mjs:130–132). This field is the wire contract with the client: the client receives `pendingTool` and shows an editable confirmation sheet before applying the change.

Valid `schema` argument types: `string`, `number`, `boolean`, `string[]` (loader.mjs:12).

### Read-vs-write semantics

**Read skills** have a server-side handler function registered in `INTERNAL_HANDLERS` (ask-internal.mjs:21) or the global handler map (route.mjs:115–146). When the loop dispatches a read skill, the handler runs server-side and its result is fed back into the loop as `<<<TOOL_RESULT>>>`. The model sees the result and may make further tool calls.

**Write skills** cause the loop to exit immediately, returning `{ reply: preToolText, pendingTool: { name, arguments } }` to the caller (loop.mjs:218–223). No server-side code executes; the client is responsible for showing the editable sheet and applying the change. A write fence surfaced from a nested internal loop is propagated up through any intermediate read-handler results unchanged (loop.mjs:252–258).

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
- `extension/llm_agent/internal/prompt.md` — internal agent role and rules
- `extension/llm_agent/internal/skills/search-kb.md`
- `extension/llm_agent/internal/skills/create-gitlab-issue.md`
- `extension/llm_agent/internal/skills/comment-gitlab-issue.md`
- `extension/llm_agent/internal/skills/trigger-review-code.md`
- `extension/llm_agent/internal/context/app-capabilities.md` — static app-capabilities section

### Prompt composition

**Global agent** (`extension/llm_agent/global/compose-prompt.mjs`)

`composeGlobalPrompt({ skills })` (compose-prompt.mjs:16–23) assembles:

1. `rolePrompt` — contents of `global/prompt.md`, cached at module load (compose-prompt.mjs:14)
2. `# Available skills` heading
3. All global skill bodies joined with `\n\n---\n\n`

This is computed once at server start as `globalPromptBase` (route.mjs:37) and passed into `runAgentLoop` as `agentContext.base`. The global agent's context block is intentionally empty — no app-state leaks to it (route.mjs:162).

**Internal agent** (`extension/llm_agent/internal/context/compose.mjs`)

`composeSystemContext(agentContext, userId)` (compose.mjs:21–38) assembles the `# System context` block in this order:

1. `# System context` heading
2. `appCapabilities` — contents of `internal/context/app-capabilities.md`, cached at module load (compose.mjs:19)
3. `renderActiveProject(agentContext)` — `## Active project` with name, URL, default branch (render-active-project.mjs:5–16)
4. `renderIndexedRepos(agentContext)` — `## Indexed code repositories` list (render-indexed-repos.mjs:3–15)
5. `renderRecentIssues(agentContext)` — `## Recent open issues` list; omitted when empty (render-recent-issues.mjs:6–22)
6. `renderRecentMeetings(agentContext)` — `## Recent meetings` list; omitted when empty (render-recent-meetings.mjs:4–15)
7. `renderGraphifyMemory(agentContext, userId)` — Graphify-generated repo memory (repo.md, graph-notes.md, prior Q&A); gated on user's repo allow-list (compose.mjs:35)

Empty sections (empty string return) are filtered before joining (compose.mjs:37). This block is only injected when `agentContext.includeSystemContext === true` (loop.mjs:148), which is set only by `askInternal` (ask-internal.mjs:42).

The internal agent's `base` string is assembled in `askInternal` (ask-internal.mjs:29–32) as:

1. `internalRolePrompt` — contents of `internal/prompt.md`, cached at module load (ask-internal.mjs:16)
2. `internalSkills.base` — contents of `internal/skills/_base.md` (the fence-protocol contract)

These are joined with `\n\n` and passed as `agentContext.base` to the internal `runAgentLoop`.
