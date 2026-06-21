# System Docs — Unit 3 (Agent Runtime) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the rebuild-grade spec + explanation layer for the agent runtime (`extension/llm_agent/`, `extension/agents/`) — the loop, fence protocol, skill system, the prompts, sub-model routing, `runClaude`, and dispatch/outcomes — the single biggest regeneration gap in the system.

**Architecture:** Reuse the unit-1 template: a drift-guarding extractor for the structured part (the skill catalog), then `docs/spec/agent-runtime.md` written section-by-section with verified `file:line` citations, then an explanation page harvested from the two existing agent docs. The verbatim prompts are version-controlled markdown already — the spec **links** them and documents the *assembly + contracts*, never copies them.

**Tech Stack:** Node/ESM source under `extension/`, Python extractors under `docs/_scripts/` (pytest), mkdocs (NOT installed locally — verify structurally).

---

## Scope

Implements unit #3 of [`2026-06-21-layered-system-docs-design.md`](../specs/2026-06-21-layered-system-docs-design.md). Out of scope: units #4–6, and the unit-1 OpenAPI schema sweep.

## Source map (what governs this unit)

| Area | Files |
|---|---|
| Loop engine | `extension/llm_agent/runtime/loop.mjs`, `fence.mjs`, `redaction.mjs`, `model-tier.mjs` |
| Routing + handlers | `runtime/route.mjs`, `runtime/handlers/{ask-internal,ask-subagent,search-kb}.mjs` |
| Skills | `extension/llm_agent/skills/{loader,registry,index}.mjs` (verify real paths; some may live under `runtime/`) |
| Prompts (verbatim, link these) | `llm_agent/global/{prompt,ask-internal,ask-subagent,update-file}.md`, `llm_agent/internal/prompt.md`, `internal/skills/*.md`, `internal/context/app-capabilities.md` |
| Prompt composition | `llm_agent/global/compose-prompt.mjs`, `internal/context/compose.mjs` + `internal/context/render-*.mjs` |
| LLM call | `extension/agents/runtime.mjs` (`runClaude`, `DEFAULT_MODEL`, provider routing) |
| Dispatch/outcomes | `extension/agents/dispatcher.mjs`, `outcome-watcher.mjs`, `outcome-providers.mjs` |

## File structure

| File | Responsibility | New? |
|---|---|---|
| `docs/_scripts/extract_agent_skills.py` | Parse skill `.md` frontmatter → `docs/reference/agent-skills.md` | create |
| `docs/_scripts/test_extract_agent_skills.py` | Test the extractor | create |
| `docs/reference/agent-skills.md` | Generated skill catalog (name, kind, schema, location) | generate |
| `docs/spec/agent-runtime.md` | The rebuild-grade spec | create |
| `docs/spec/.pages` | Add `agent-runtime.md` to nav order | modify |
| `docs/explanation/agent-runtime.md` | Explanation layer (harvest meeting-agent + agent-tools) | create |
| `docs/explanation/{meeting-agent,agent-tools}.md` | Add cross-links to the spec | modify |

---

## Task 1: Skill-catalog extractor + reference page (drift guard)

**Files:** create `docs/_scripts/extract_agent_skills.py`, `docs/_scripts/test_extract_agent_skills.py`; generate `docs/reference/agent-skills.md`.

**Goal:** A generated catalog of every agent skill so the spec's skill list can't drift. Source of truth = the YAML frontmatter of the skill `.md` files.

- [ ] **Step 1 — Inventory the skill files and their frontmatter shape.** Read `extension/llm_agent/skills/loader.mjs` (or wherever `loadSkills` lives — find it) to learn the exact frontmatter fields it parses (`name`, `kind`, `description`, `schema`, `confirmation`, `model`?). Read 2–3 real skill files (`internal/skills/search-kb.md`, `internal/skills/create-gitlab-issue.md`, `global/ask-internal.md`) to confirm the real field set. Report the field set you found before writing the extractor.

- [ ] **Step 2 — Write the failing test** `docs/_scripts/test_extract_agent_skills.py`:
```python
from extract_agent_skills import parse_skill, discover

def test_parse_skill_reads_frontmatter():
    md = "---\nname: search-kb\nkind: read\ndescription: Search the KB.\n---\n# When to use\n..."
    s = parse_skill(md, "internal/skills/search-kb.md")
    assert s["name"] == "search-kb" and s["kind"] == "read"
    assert s["path"].endswith("search-kb.md")

def test_real_source_has_known_skills():
    skills = discover()  # scans extension/llm_agent for *.md with a name+kind frontmatter
    names = {s["name"] for s in skills}
    assert {"search-kb", "ask-internal", "ask-subagent"} <= names
```

- [ ] **Step 3 — Run it, confirm FAIL:** `python3 -m pytest docs/_scripts/test_extract_agent_skills.py -v` → ImportError/FAIL.

- [ ] **Step 4 — Implement `extract_agent_skills.py`.** `parse_skill(text, relpath)` parses the `---` frontmatter (reuse the YAML approach from `extract_*`/conftest patterns; `PyYAML` is available). `discover()` walks `extension/llm_agent/` for `*.md` files whose frontmatter has both `name` and `kind`, returns sorted dicts `{name, kind, description, path}`. `main()` writes `docs/reference/agent-skills.md` with a `<!-- generated ... do not edit by hand -->` header and a table (Name | Kind | Description | File). Mirror the style of `extract_error_codes.py`.

- [ ] **Step 5 — Run test + generate:** `python3 -m pytest docs/_scripts/test_extract_agent_skills.py -v` (PASS) then `python3 docs/_scripts/extract_agent_skills.py`. Open `docs/reference/agent-skills.md` and confirm every skill from the source tree appears with the right kind.

- [ ] **Step 6 — Commit:**
```
git add docs/_scripts/extract_agent_skills.py docs/_scripts/test_extract_agent_skills.py docs/reference/agent-skills.md
git commit -m "docs: add agent-skill catalog extractor + generated reference

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `docs/spec/agent-runtime.md` — engine, fences, skills, prompts

**Files:** create `docs/spec/agent-runtime.md` (sections 1–4); modify `docs/spec/.pages`.

**Accuracy rule (same as unit 1):** state ONLY what you verify in source; cite real `file:line` (open and confirm before citing). Link generated/reference pages and the verbatim prompt files — do not copy prompt text into the spec.

- [ ] **Step 1 — Frontmatter + §1 Scope.** Add `---\ntitle: Agent runtime — spec\nstatus: draft\n---`. List the governed files (use the Source map above; `ls` the dirs to confirm real names — note `skills/` may be under `llm_agent/skills/` or `runtime/`).

- [ ] **Step 2 — §2 The loop (`runtime/loop.mjs`).** Document the exact turn algorithm: prompt assembly → `runClaude` → `parseFence` → `validateArgs` against the skill schema → dispatch. State the read-tool result caching (key = `toolName:stableArgs`), the write-tool early-exit returning `pendingTool`, the plain-text exit, and the caps: `MAX_LOOP_DEPTH = 2` (loop.mjs:128), `MAX_USER_MESSAGE_BYTES = 500_000` (loop.mjs:121), plus any deadline/iteration cap (find and cite). Document the **depth model**: depth 0 global → depth 1 internal → depth 2 subagent, and the single enforcement point. Cite file:line for each.

- [ ] **Step 3 — §3 Fence protocol (`runtime/fence.mjs`, `runtime/redaction.mjs`).** State the EXACT sentinels (e.g. `<<<TOOL_CALL>>> … <<<END_TOOL_CALL>>>` — confirm the real strings), the parse rules, what `validateArgs` checks against the schema (types, required, maxLength), and the parse-error → tool-error → retry behavior. Document `redaction.mjs`: which sentinels are stripped from KB snippets / nested results before prompt assembly and why (forged-tool-call defense). Cite file:line.

- [ ] **Step 4 — §4 Skills + prompts.** From the loader/registry: the skill frontmatter schema (fields + validation, the 32 KB per-file cap, `name` must match filename, write skills require `confirmation: editable-sheet`), read-vs-write semantics, and `buildPerUserSkillSet` (internal + enabled plugin skills; core wins collisions). LINK the generated catalog [`../reference/agent-skills.md`](../reference/agent-skills.md) and the verbatim prompt files (`extension/llm_agent/global/prompt.md`, `internal/prompt.md`, `global/{ask-internal,ask-subagent,update-file}.md`, `internal/skills/*.md`, `internal/context/app-capabilities.md`) by repo path. Document prompt **composition** (`global/compose-prompt.mjs`, `internal/context/compose.mjs` + `render-*.mjs`): what context each renderer injects and in what order. Cite file:line. Do NOT paste prompt bodies.

- [ ] **Step 5 — Append the Regeneration checklist** (verbatim from `docs/spec/index.md`).

- [ ] **Step 6 — Add to nav.** Edit `docs/spec/.pages` to add `agent-runtime.md` after `api-server.md`.

- [ ] **Step 7 — Verify + commit.** Confirm internal links resolve; re-open a few cited lines to confirm. Then:
```
git add docs/spec/agent-runtime.md docs/spec/.pages
git commit -m "docs: agent-runtime spec part 1 — loop, fences, skills, prompts

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `docs/spec/agent-runtime.md` — sub-models, runClaude, dispatch, outcomes

**Files:** modify `docs/spec/agent-runtime.md` (append sections 5–7).

- [ ] **Step 1 — §5 Sub-model routing.** From `runtime/model-tier.mjs` and `runtime/route.mjs`: the tier→env mapping (`GLOBAL_AGENT_MODEL = LLMIDE_AGENT_MODEL`; `INTERNAL = LLMIDE_INTERNAL_MODEL || GLOBAL`; `SUBAGENT = LLMIDE_SUBAGENT_MODEL || GLOBAL` — confirm at route.mjs:29–31 and model-tier.mjs), the resolution order (explicit `model` arg → tier env → `LLMIDE_MODEL` → `DEFAULT_MODEL = 'claude-sonnet-4-6'` at `agents/runtime.mjs:23`), the plugin-subagent frontmatter `model:` override, and the `CLAUDE_MODEL_RE` filter that rejects non-Claude ids (`agents/runtime.mjs:43`). Cite file:line.

- [ ] **Step 2 — §6 `runClaude` (`agents/runtime.mjs`).** Document the two paths: HTTP per-user vault key (`api.anthropic.com/v1/messages`, prompt-cache `cache_control: ephemeral` on the fenced transcript, context-overflow retry) vs operator CLI fallback (`execFile('claude', ['-p', prompt])`, curated env allowlist, timeout). State the rule: a user-scoped key NEVER silently falls back to the CLI. State the 500 k-char prompt cap and the `<<<BEGIN>>>…<<<END>>>` fence + sanitize. Cite file:line. Cross-link [`api-server.md`](api-server.md) for where the prompt cap is also enforced.

- [ ] **Step 3 — §7 Dispatch + outcomes.** From `agents/dispatcher.mjs`: targets (preview/github/backlog/linear), idempotency via `task.meta.dispatched.url`, per-target concurrency, secret redaction. From `agents/outcome-watcher.mjs`: record-on-change, the per-(provider,userId) circuit breaker (open after N failures, backoff cap), client-supplied creds (no server-side persistence). Cite file:line and confirm the real numbers (don't carry over assumptions).

- [ ] **Step 4 — §8 See also** — link [`../explanation/agent-runtime.md`](../explanation/agent-runtime.md), [`../explanation/meeting-agent.md`](../explanation/meeting-agent.md), [`../explanation/agent-tools.md`](../explanation/agent-tools.md).

- [ ] **Step 5 — Commit:**
```
git add docs/spec/agent-runtime.md
git commit -m "docs: agent-runtime spec part 2 — sub-models, runClaude, dispatch, outcomes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Explanation page + cross-links

**Files:** create `docs/explanation/agent-runtime.md`; modify `docs/explanation/{meeting-agent,agent-tools}.md`.

- [ ] **Step 1 — Create `docs/explanation/agent-runtime.md`.** Harvest the *why/how* narrative from `meeting-agent.md` and `agent-tools.md` (don't duplicate — write a concise orientation: what the runtime is, the two-agent-one-engine model, the co-pilot stance) and add an admonition linking to the spec:
```markdown
!!! info "Rebuild-grade detail"
    Exact contracts (loop algorithm, fence protocol, skill schema, sub-model cascade, runClaude) are in [`../spec/agent-runtime.md`](../spec/agent-runtime.md).
```

- [ ] **Step 2 — Reciprocal links.** In `meeting-agent.md` and `agent-tools.md`, add a one-line "See also: [`spec/agent-runtime.md`](../spec/agent-runtime.md)" near the top.

- [ ] **Step 3 — Final gate.** Run:
```
python3 -m pytest docs/_scripts/ -q
python3 docs/_scripts/check_api_coverage.py && python3 docs/_scripts/check_rate_limit_mapping.py
```
Expect: only the known `test_extract_messages` failure remains; both checkers OK; the new `test_extract_agent_skills` green. Confirm all internal links in the three new pages resolve.

- [ ] **Step 4 — Commit:**
```
git add docs/explanation/agent-runtime.md docs/explanation/meeting-agent.md docs/explanation/agent-tools.md
git commit -m "docs: agent-runtime explanation page + explanation↔spec cross-links

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review

- **Spec coverage:** design-spec unit-3 items (prompts, skill schema, depth model, sub-model cascade, fence protocol, dispatch/outcomes) → Task 2 (loop/fence/skills/prompts), Task 3 (sub-models/runClaude/dispatch/outcomes), Task 1 (skill catalog guard). ✓
- **Placeholder scan:** extractor/test steps have literal code; spec-page steps give exact sections + source files + the verbatim regen checklist. The prompts are LINKED (version-controlled), not pasted — deliberate, not a placeholder. ✓
- **Name consistency:** `extract_agent_skills.py`, `agent-runtime.md`, `MAX_LOOP_DEPTH=2`, `DEFAULT_MODEL='claude-sonnet-4-6'`, `model-tier.mjs` used consistently. ✓
- **Risk note:** dispatch/outcome numbers (circuit-breaker thresholds) must be re-verified from source in Task 3, not carried from prior assumptions.
