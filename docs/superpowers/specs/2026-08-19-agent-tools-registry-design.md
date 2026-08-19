# Agent Tools Registry — P2 Design (Unify Special Functions Across Legacy + v2 Engines)

- **Date:** 2026-08-19
- **Status:** Approved design (Approach A locked; build order below), pre-implementation
- **Precedes:** P2 implementation plan (writing-plans)
- **Groundwork:** P1 spec ([2026-08-18-agent-v2-engine-design.md](2026-08-18-agent-v2-engine-design.md)); 2026-08-19 root-cause audit of the assist-plan/mode-classification regression (fixed in `4778bf8`) that exposed the underlying problem this spec addresses; live review of the legacy dispatch table (`route.mjs`, `global-handlers.mjs`, `runtime/handlers/`) and the v2 tool surface (`sdk/tools.mjs`, `sdk/engine.mjs`, `sdk/decisions.mjs`)

## 1. Context

P1 shipped the SDK engine read-only, with its own hand-wired MCP tool file (`sdk/tools.mjs`: `kb_search`, `project_memory`). Everything else the legacy loop calls a "special function" — `ask-internal`, `ask-subagent`, `web-search`, `fetch-url`, `list-files`, `read-file`, `find-code`, `search-kb`, `task-list`, `task-create`, `task-update`, `run-bash` (the `GLOBAL_HANDLER_NAMES` in [global-handlers.mjs](../../../extension/llm_agent/runtime/global-handlers.mjs)) — exists only in the legacy fence-dispatch table and has no v2 equivalent.

The 2026-08-19 debugging session (assist-plan silently degrading to plain `execute` on v2) surfaced the actual failure mode this design fixes: **every special function currently has to be wired into both engines by hand**, in two unrelated files, with no mechanism forcing them to match. `GLOBAL_HANDLER_NAMES` already exists as a drift guard for the *legacy* dispatch table alone (`route.mjs` throws if its `handlers` object doesn't match); there is no equivalent guard between legacy and v2. Today that gap is silent — v2 simply doesn't have 10 of the 12 functions, and nothing fails loudly to say so. The next SDK upgrade (or the next engine, if the SDK is ever swapped) would otherwise force a second manual pass over every handler.

**P2 goal:** one engine-agnostic tool registry that is the single source of truth for every special function — name, schema, safety classification, and implementation — with the legacy fence dispatch and the v2 MCP server both *derived* from it instead of hand-maintained. SDK upgrades (or an engine swap) touch only the v2 adapter; the functions themselves never change.

## 2. Locked decisions

| # | Decision | Choice |
|---|---|---|
| E1 | Scope | **Full legacy parity** — every `GLOBAL_HANDLER_NAMES` entry plus `kb_search`/`project_memory` becomes one registry entry; no function is left engine-specific |
| E2 | Structure | **Approach A** — one registry module (`llm_agent/tools/registry.mjs`), two thin adapters (legacy fence dispatch, v2 SDK compiler). Rejected: hand-wire each handler into `sdk/tools.mjs` one-by-one (perpetuates the two-place drift that caused the 08-19 bug); external MCP server process (subprocess/wire overhead, tenancy-closure awkwardness, contradicts P1's in-process rationale) |
| E3 | Handler code | **Unchanged** — implementations stay in `runtime/handlers/`; the registry adds metadata and dispatch, not logic |
| E4 | Act-tool safety | **Blocklist → auto-safe allowlist → approval prompt**, extending run-bash's existing blocklist-only gate rather than replacing it. Applies uniformly to both engines — this *adds* approval prompting to legacy `run-bash` (today: anything not blocklisted runs silently), a deliberate behavior change called out explicitly below (§7) |
| E5 | Approval persistence | **Per (user, tool) "always-allow"**, new table, checked before the gate runs |
| E6 | Model-visible surface on v2 | **Both** — SDK built-ins (`Glob`/`Read`/`Grep`/`WebSearch`/`WebFetch`) stay allowed alongside `mcp__llmide__*`. Our `list-files`/`read-file`/`find-code` exist for cross-engine consistency of skill instructions and the KB/code-graph-aware variants (readable-roots gating, symbol index), not to replace the free SDK built-ins |
| E7 | Mode tool-restriction | **Re-derived from the registry's `kind` field**, replacing the hand-maintained name allowlist in `mode-personas.mjs` — see §8 |

Non-goals for P2 (stay P3+): checkpoints/rewind, canary CI, phone-side approval answering, ACP adapter, per-provider dispatch routing table.

## 3. Architecture

```
                    extension/llm_agent/tools/
                    ├── registry.mjs      ← engine-agnostic source of truth (this spec, new)
                    ├── gates.mjs         ← blocked/auto/prompt classification (new)
                    └── approvals.mjs     ← always-allow persistence (new; DB-backed)
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
   runtime/route.mjs (legacy)        sdk/tools.mjs (v2, rewritten)
   handlers = registry.buildDispatch(ctx)   buildLlmIdeServer → registry entries
   → mcp__llmide__* SDK tools, schema-converted
   (fence protocol unchanged)         (createSdkMcpServer unchanged shape)
              │                               │
              ▼                               ▼
   runtime/handlers/*.mjs  ◄── SAME implementations, untouched ──►  (called via registry.execute)
```

`runtime/handlers/*.mjs` keeps its current shape (`(args, ctx) => result`); the registry doesn't wrap or transform handler logic, only names, describes, and gates it.

## 4. The registry — `extension/llm_agent/tools/registry.mjs`

One array of entries, each:

```js
{
  name: 'run-bash',                 // matches GLOBAL_HANDLER_NAMES today; becomes derived FROM here instead
  kind: 'act',                      // 'read' | 'act' — a NEW safety axis, deliberately independent of the
                                     // .md frontmatter's existing 'read'/'write' kind (which drives the
                                     // unrelated pendingTool write-confirmation flow in loop.mjs and is left
                                     // untouched). run-bash's .md kind stays 'read' (unchanged); its registry
                                     // kind is honestly 'act' — see §8.
  execute: (args, toolCtx) => handleRunBash(args, toolCtx),   // thin reference to the existing handler
  gate: runBashGate,                // only 'act' entries carry a gate; defaults to `() => 'auto'` for act
                                     // tools with no meaningful safety tiering (task-create/task-update)
}
```

Deliberately **not duplicated** in the registry entry: `description` and `params`. Every existing global handler already has both, correctly, in its `llm_agent/global/<name>.md` frontmatter (loaded once at boot by `skills/registry.mjs` into `globalSkills`) — a third copy in the registry would recreate the very drift class this spec exists to close. Both adapters (§5, §6) read schema/description from the loaded skill via its `name`; the registry supplies only what the `.md` files don't carry: `kind` (the new safety axis) and `execute`/`gate` (dispatch). `kb_search`/`project_memory` (today `sdk/tools.mjs`-only, no `.md` file) are the exception — see below.

`toolCtx` is the same shape route.mjs already builds per-request: `{ userId, agentContext, runClaude, kb, userSkills, userSubagents, sessionId, requestApproval }`. `project_memory` moves in as a first-class `kind: 'read'` entry — legacy gains it as a side effect (parity fix, see §9), which means it ALSO needs a new `llm_agent/global/project-memory.md` file (schema/description live there, per the rule above; see §9). **`kb_search` and legacy's `search-kb` are the same function under two names** (both call `kb.search(userId, {q, kind, limit})`; v2's version is a near-duplicate written during the P1 spike, exactly the two-place-drift class this spec exists to close) — they unify into ONE registry entry named `search-kb` (the name with an existing skill doc and established prompt-facing contract, whose `.md` gets a `limit` param added to match `kb_search`'s richer schema), adopting `kb_search`'s `{hits, total}` shape; v2's SDK tool is exposed as `mcp__llmide__search-kb`, not a separately-named `kb_search`.

**Legacy-only prompt documentation stays legacy-only.** The `.md` files under `llm_agent/global/` (frontmatter `name`/`kind`/`schema` + prose "When to use"/"Call shape"/"Result shape") remain the model-facing instructions for the fence-protocol engine — the registry does not replace or generate them, it cross-references them by `name`. A new legacy-reachable entry (e.g. `project_memory`) needs its own `.md` file in `llm_agent/global/` in addition to its registry entry, exactly as every existing handler already has one; `assertReadSkillsWired` (`skills/registry.mjs`) already enforces every global `kind: read` skill file has a wired handler name, and continues to do so unchanged.

`GLOBAL_HANDLER_NAMES` (`runtime/global-handlers.mjs`) becomes `registry.names()` — a thin re-export for the handful of callers (`skills/registry.mjs`'s startup check) that only need the name list. The name-drift bug class this spec exists to close is now structural: there is exactly one array of names, and both engines read from it.

## 5. Legacy adapter

`route.mjs`'s hand-built `handlers` object (the literal keyed to `GLOBAL_HANDLER_NAMES` today, ~70 lines) is replaced by `registry.buildDispatch(toolCtx)`, which maps every entry to `name → (args, loopCtx) => entry.execute(args, {...toolCtx, loopCtx})` — `loopCtx` (carrying the loop-incremented `depth` that `ask-internal`/`ask-subagent` need) rides alongside the per-request `toolCtx` exactly as it does in today's hand-built closures, just merged instead of hand-threaded per handler. The existing drift-guard throw (comparing `Object.keys(handlers)` against `GLOBAL_HANDLER_NAMES`) becomes unreachable by construction and is deleted rather than kept as dead ceremony — the registry itself is now the single list, so there is nothing left to drift.

Fence protocol, prompt composition, and per-handler behavior are otherwise byte-identical. This step alone (no gate changes yet) should be shippable with the full existing suite green and zero user-visible behavior change — see Build order §13, P2a.

## 6. v2 adapter — `sdk/tools.mjs` becomes a compiler

`buildLlmIdeServer` (today: two hand-written `tool()` calls) becomes `for (const entry of registry.entries()) tools.push(toSdkTool(entry, skillFor(entry.name), toolCtx))`, where `skillFor` looks up the already-loaded `globalSkills.skills.get(name)` for `description`/`schema` (kb_search/project_memory's schema lives inline in `sdk/tools.mjs` today and moves to their new `.md` files, per §4) and `toSdkTool` is one ~20-line helper converting that same plain-JSON schema shape (`{type, required, default, enum, maxLength, ...}`) into the zod shape `tool()` requires (`string`→`z.string()`, etc. — the vocabulary the current 12 handlers actually use, not a general JSON-Schema compiler). This file becomes the *only* module that imports zod for tool definitions; the registry itself stays zod-free so it never depends on an SDK-versioned library. `mcp__llmide__*` is already in v2's `allowedTools` — no allowlist change needed for read tools. Act tools (`run-bash`, and the two task-mutation tools once they're added — see below) need a v2 allowlist addition, gated by §7's `canUseTool` change.

## 7. Gates & approvals

**Gate module** (`tools/gates.mjs`), applied identically by both engines for every `kind: 'act'` entry:

- **Blocked** — the existing `BLOCKED_PATTERNS` in `run-bash.mjs` (root wipe, `sudo`, `mkfs`, raw disk writes) moves here unchanged and is checked first, always denied, never overridable by always-allow.
- **Auto-safe allowlist** (run-bash only) — a fixed prefix/pattern list: `git status`, `git diff`, `git log`, `ls`, `cat`, `grep`/`rg`, `find` (read-only flags), test runners (`npm test`, `swift test`, `node --test`) — matched against the command string, conservative (unmatched commands fall through to prompt, never silently allowed).
- **Prompt** — everything else. `task-create`/`task-update` have no meaningful tiering (session-scoped, non-destructive bookkeeping — already unauthenticated in legacy today) so their gate is the constant `() => 'auto'`; only `run-bash` gets the three-tier command classification.

**Always-allow persistence** — new migration `0030_tool_approvals.sql`: `tool_approvals(user_id, tool_name, created_at, PRIMARY KEY(user_id, tool_name))`. Checked *before* the gate runs: a row present → skip straight to auto-run (blocked patterns are NOT re-checked against always-allow — a blocked command stays blocked even if the tool was always-allowed, since the block is a hard safety rail, not a prompt tier). The Mac approval card answers `allow` (once) / `deny` / `always-allow` (writes the row).

**v2 mechanics** — `canUseTool` in `sdk/engine.mjs` currently denies every tool name except `AskUserQuestion` with `DENY_NEXT_RELEASE`. It becomes: for `mcp__llmide__*` tools whose registry entry is `kind: 'act'`, consult the gate (skipping it if `tool_approvals` has a row) → `blocked` denies with the existing message; `auto` allows immediately; `prompt` parks a decision in `decisions.mjs` exactly like `AskUserQuestion` does today, but with `kind: 'ToolApproval'` on the SSE `approval_request` event (carrying `{toolName, argsSummary}` instead of `questions`) and a decision-route `action` of `allow` / `deny` / `always-allow` (new third action; `always-allow` inserts the `tool_approvals` row then behaves as `allow`). SDK built-in write tools (`Write`, `Edit`, `Bash`) **stay denied** in v2's `allowedTools` — `run-bash` (our gated tool) remains the single sanctioned shell choke point on both engines, never the SDK's raw `Bash`.

**Legacy mechanics — the deliberate behavior change.** Today legacy `run-bash` runs anything not blocklisted with zero confirmation. Post-P2, legacy consults the same gate: `auto` behaves as today; `prompt` reuses the existing `pendingTool` ack channel, extended from a bare "(continue)" acknowledgment to carry `{name, arguments, requiresApproval: true}` and a client decision of allow/deny/always-allow answered via a **new** `POST /code-assist/decision` route (mirrors `/agent/v2/decision`'s shape so the Mac approval-card component is engine-agnostic and shared). This is new friction on the legacy engine that did not exist before — flagged here explicitly per the spec's own rule (architectural changes state consequences, not just mechanics) so it can be called out to the user as a real UX change, not an incidental side effect.

## 8. Mode-restriction unification (bonus fix, folds into E7)

`mode-personas.mjs` today hand-maintains an explicit tool-name allowlist for plan/review/document modes, with an extensive comment explaining *why* it can't just filter by each skill's `kind: read/write` label — because `run-bash` is mislabeled `kind: read` in its own skill file despite executing arbitrary shell, and `task-create`/`task-update` are `kind: read`-adjacent but excluded for UX reasons (no task-tracking UI in single-turn-output modes). That hand-maintained list is exactly the kind of second copy this spec exists to eliminate.

The registry's `kind` field is defined honestly from day one (`run-bash: 'act'`, `task-create`/`task-update: 'act'` despite being auto-gated, everything else `'read'`), so `restrictsTools`/`allowedToolNames` in `mode-personas.mjs` become `registry.entries().filter(e => e.kind === 'read' || ALWAYS_ALLOWED_WRITE.has(e.name))` — collapsing the hand-maintained list to the one genuine carve-out already documented (`save-plan`, which takes no arbitrary path). The extensive existing comment block moves to the registry's `kind` field documentation instead of living beside a special-cased allowlist.

## 9. Small parity items folded in

- `project_memory` becomes available to the **legacy** engine too (today v2-only) — a registry entry plus a new `llm_agent/global/project-memory.md` skill doc (see §4's note on legacy prompt docs) so the model actually learns it exists.
- Persona suffix (`kb.getAgentPersona`) gets injected into the v2 system prompt (today legacy-only) — unrelated to the registry mechanically, but was flagged in the same audit and is cheap to include in the same pass.
- Session-task store (`session-tasks.mjs`) gets keyed by the same chat-session id on both engines, so tasks created via legacy show up if a chat is ever resumed on v2 (today: v2 has no task tools at all, so this is new rather than a fix).

## 10. Testing

- **Registry unit tests** (pure, no engine): every entry has a valid name/description/params/kind; `params`→zod conversion round-trips for every entry actually used (string/number/enum/default/required); `registry.names()` matches the literal list that used to be `GLOBAL_HANDLER_NAMES` (regression pin — the list itself must not silently shrink or grow unnoticed).
- **Gate matrix tests**: blocked / auto-safe / prompt for a representative command set per tier, plus the always-allow short-circuit and its non-override of blocked patterns.
- **Legacy adapter tests**: `route.mjs`'s dispatch built from the registry produces byte-identical behavior to today's hand-built object for every existing handler (golden-output comparison against the pre-change suite).
- **v2 adapter tests**: `InMemoryTransport`-based tests (P1 pattern) covering every registry entry mounted as an SDK tool, not just `kb_search`/`project_memory`.
- **Approval round-trip tests**: `ToolApproval` decision kind — allow/deny/always-allow, tenancy rejection, timeout, abort — mirroring the existing `AskUserQuestion` round-trip tests in `agent-v2-routes.test.mjs`.
- **`global-handlers-sync` test upgrade**: today asserts `route.mjs`'s handler keys == `GLOBAL_HANDLER_NAMES`; extend to assert legacy keys == v2 mounted tool names == `registry.names()` — the actual regression class this spec closes, pinned in CI.
- **Mac**: the new approval card variant (`ToolApproval` vs `AskUserQuestion`) — decoding, three-button state, `always-allow` persistence round-trip against a live decision.
- **Full regression**: extension suite + Mac suite stay green after every phase in §13 (each phase is independently shippable).

## 11. Rollout & versioning

- `SERVER_API_VERSION` → 34 (P1 shipped 33); new route `POST /code-assist/decision` (legacy approval answers) added to `ENDPOINTS`.
- No client-visible change for P2a/P2b (registry + adapters, zero behavior change). P2c (gates) is the first phase with an observable UX change (legacy run-bash approval prompts) — call this out in the Mac release notes, not just the commit message.
- Migration `0030_tool_approvals.sql` follows the existing append-only numbering (`0029_agent_sessions.sql` was P1's).

## 12. Security & tenancy

Blocked patterns are a hard rail, never overridable by always-allow (§7). `tool_approvals` rows are scoped `user_id` first, same tenancy discipline as every other KB table. Approval decisions are tenancy-checked identically to the existing `AskUserQuestion` round-trip (deciding user must own the session/chat). The registry itself introduces no new trust boundary — it is a dispatch/metadata layer over handlers whose actual security properties (readable-roots gating, SSRF guards, redactFence on every tool result) are unchanged and unmoved.

## 13. Build order (each step independently shippable, suite green)

- **P2a — Registry + legacy adapter only.** `tools/registry.mjs` with all 12 `GLOBAL_HANDLER_NAMES` entries plus `kb_search`/`project_memory` (12+2=14 entries); `route.mjs` derives its dispatch from `registry.buildDispatch()`; delete the now-unreachable drift-guard throw and the literal `GLOBAL_HANDLER_NAMES` array (re-exported from the registry for the one remaining caller). Zero behavior change, zero gates yet — every act tool auto-runs exactly as today. Full suite green is the acceptance bar.
- **P2b — v2 adapter (read tools first).** `sdk/tools.mjs` becomes the schema-compiler; mount every `kind: 'read'` registry entry (10 of 12, plus `kb_search`/`project_memory`) into v2's MCP server and `allowedTools`. `run-bash`/`task-create`/`task-update` stay unmounted on v2 until P2c's gate exists — v2 remains read-only exactly as P1 promised, just with a much wider read surface (assist-plan's "ask me whatever you need" flow, for instance, gains `ask-internal`/`ask-subagent` on v2 for the first time).
- **P2c — Gates + approvals.** `tools/gates.mjs`, `tools/approvals.mjs`, migration `0030`; wire `canUseTool`'s `ToolApproval` branch in `sdk/engine.mjs`; mount `run-bash`/`task-create`/`task-update` on v2 behind it. This is the phase that changes legacy `run-bash` behavior (§7) — implement the legacy `pendingTool` extension + `POST /code-assist/decision` route in the same phase so both engines gain the gate together, not staggered (staggering would mean legacy run-bash is ungated while v2's is gated, an inconsistent security posture worth avoiding even for a few days).
- **P2d — Mode-restriction unification (§8).** Re-derive `mode-personas.mjs`'s `restrictsTools`/`allowedToolNames` from the registry's `kind` field; delete the hand-maintained allowlist and its explanatory comment block (superseded by the registry's own `kind` documentation). Lowest-risk phase, done last so it isn't entangled with the gate work.
- **P2e — Parity + test hardening (§9, §10 upgrades).** `project_memory` on legacy, persona suffix on v2, session-task-store key unification; upgrade `global-handlers-sync` to the three-way name assertion; Mac `ToolApproval` card.

## 14. Phase pointers

- **P3:** issue-dispatch actions (GitHub/GitLab/Backlog/Linear create/comment via `agents/dispatcher.mjs`) are a separate approval-gated pipeline today (`/kb/generate-code` → review → dispatch), **not** a chat-callable tool the model invokes mid-turn — they were named in the 08-19 conversation as part of "special functions" but audit found no such chat tool exists to port. If the user wants issue creation to become a model-invokable act tool (not just a plan-dispatch action), that is new scope for a dedicated design, not a P2 port.
- **P3/P4:** checkpoints (`enableFileCheckpointing`), context-meter UI, canary CI, SDK-native todos, phone-side approval answering, ACP adapter, provider-routing table (SDK vs native loop), fence-loop deprecation for anthropic.
