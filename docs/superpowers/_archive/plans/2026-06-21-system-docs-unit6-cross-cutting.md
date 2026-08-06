# System Docs — Unit 6 (Cross-cutting) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The final unit — a rebuild-grade `spec/cross-cutting.md` that ties the system-wide threads together (security model as hard constraints, config/env, build/run/deploy, observability, cross-subsystem invariants), wire the drift-guards built in units #1–#3 into the Makefile so they actually run, and fix a residual body-limit drift in `security-model.md`.

**Architecture:** This unit is mostly **synthesis + harvest** — most structured facts already live in extractor-generated reference pages and the per-unit specs. `cross-cutting.md` links them and adds the connective tissue + the threat model. Plus two concrete code changes: Makefile integration of the new checkers/extractor, and a drift fix.

**Tech Stack:** mkdocs (NOT installed locally — verify structurally), Python extractors (pytest via `python3`), GNU Make.

---

## Scope
Implements unit #6 (final) of [`2026-06-21-layered-system-docs-design.md`](../specs/2026-06-21-layered-system-docs-design.md). After this, the layered-docs set is structurally complete; the only remaining quality item is the unit-1 OpenAPI schema sweep (out of scope here).

## Source / harvest map
| Concern | Sources |
|---|---|
| Security | `explanation/security-model.md`, `explanation/server-internals.md` (threat table), spec `api-server.md` §4 (auth), spec `knowledge-base.md` §6 (vault), `reference/guardrail-rules.md` |
| Config/env | `reference/{env-vars,configuration}.md`, `extension/core/config.mjs` |
| Build/run/deploy | `Makefile`, `setup.sh`, `run.sh`, `reference/cli-scripts.md`, `how-to/{run-the-server-locally,ship-production-build,release,release-with-auto-update,build-the-macos-app}.md` |
| Observability | `explanation/server-internals.md` (Observability section), `/metrics`, `/health` |
| Invariants | `explanation/invariants.md`, tenancy (spec `knowledge-base.md` §4) |

---

## Task 1: `docs/spec/cross-cutting.md` (synthesis spec)

**Files:** create `docs/spec/cross-cutting.md`; modify `docs/spec/.pages`.

**Accuracy rule:** synthesis unit — prefer LINKING the per-unit specs and the extractor-generated reference pages over restating their numbers. Where you DO state a number, verify it against source and cite `file:line`. Do not reintroduce known-fixed drift (body limit is **8 MB**, vault allow-list is **10 keys**, JWT skew **2s**, schema is **schema_migrations head 0013**).

- [ ] **Step 1 — Frontmatter + §1 Scope.** `---\ntitle: Cross-cutting — spec\nstatus: draft\n---`. State what "cross-cutting" covers (security, config, build/deploy, observability, invariants) and that it's the connective layer over the four subsystem specs.

- [ ] **Step 2 — §2 Security model (hard constraints).** The threat model (in-scope / out-of-scope — harvest from `security-model.md`). Then a controls table, each row LINKING the authoritative spec/reference: network bind 127.0.0.1 + CORS echo-allowlist (link `api-server.md` §7); identity/JWT/bcrypt (link `api-server.md` §4); vault crypto (link `knowledge-base.md` §6); guardrails (link `../reference/guardrail-rules.md`); prompt-injection fences (link `agent-runtime.md` §3 + note server-side `sanitizeForPrompt` in `core/utils.mjs`); audit log; rate limiting (link `api-server.md` §6 + `../reference/rate-limit-profiles.md`). State the real DoS caps: body limit **8 MB** (`core/config.mjs` — verify), prompt cap **500 000 chars**. Cite file:line for any raw number.

- [ ] **Step 3 — §3 Configuration & environment.** Link `../reference/env-vars.md` (the canonical table) and `../reference/configuration.md`. State the prod-required vars (`LLMIDE_JWT_SECRET`, `LLMIDE_VAULT_KEY`, `NODE_ENV=production`) and that dev auto-generates secrets into `kb/.dev-secrets.json` (never use in prod). Note the loopback-bind override (`LLMIDE_ALLOW_REMOTE=1`). Don't restate the whole env table — link it.

- [ ] **Step 4 — §4 Build, run & deploy.** From `Makefile` (list the real targets: `build`, `test`, `lint`, `test-mac`, `regression`, `hooks`, `docs-*` — verify), `setup.sh`, `run.sh` (link `../reference/cli-scripts.md`). State: server is Node ≥ 20; **`better-sqlite3` is a native module** that must compile against the running Node ABI (route dep bumps through CI; don't build on bleeding-edge Node). The two client builds (link `../how-to/build-the-macos-app.md` and `../how-to/ship-production-build.md`). The production systemd pattern (link `../reference/env-vars.md` which has the unit example). Cite file:line where you state a target/flag.

- [ ] **Step 5 — §5 Observability.** Logs (`LLMIDE_LOG_JSON`, `LLMIDE_LOG_LEVEL`, `requestId` threading), metrics (`GET /metrics`, Prometheus text), health (`GET /health` — apiVersion/schema/uptime/endpoint list, public). Link `server-internals.md`. Cite where a flag/endpoint is defined.

- [ ] **Step 6 — §6 Cross-subsystem invariants.** Link `../explanation/invariants.md` as the operational checklist. State the load-bearing system-wide ones as MUST: per-row `user_id` tenancy (link `knowledge-base.md` §4), the `SERVER_API_VERSION` + `REQUIRED_ENDPOINTS` stale-server contract (link `api-server.md` §2), append-only migrations, single-writer SQLite.

- [ ] **Step 7 — §7 See also + regen checklist.** Link `../explanation/{security-model,architecture,invariants}.md`. Append the ticked regeneration checklist (same 4-item format as `api-server.md`, with a spot-check line naming the security controls + config + build).

- [ ] **Step 8 — Nav + commit.** `docs/spec/.pages`: add `- cross-cutting.md` after `- macos-app.md`.
```
git add docs/spec/cross-cutting.md docs/spec/.pages
git commit -m "docs: add cross-cutting spec (security, config, build, observability, invariants)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Wire drift-guards into the Makefile + fix residual drift

**Files:** modify `Makefile`; modify `docs/explanation/security-model.md`.

**Verified background:** `docs-refresh-reference` (Makefile:72–78) runs 6 extractors but OMITS the new `extract_agent_skills.py`. No Make target runs the `docs/_scripts` pytest suite or the two checkers (`check_api_coverage.py`, `check_rate_limit_mapping.py`) — so the drift guards built in earlier units only run when invoked by hand. Also `security-model.md` still states the body limit as **2 MB** (real default is **8 MB**, `core/config.mjs` `bodyLimitMB` default 8).

- [ ] **Step 1 — Add the new extractor to `docs-refresh-reference`.** In `Makefile`, append `$(PY) docs/_scripts/extract_agent_skills.py` to the `docs-refresh-reference` recipe (after the other extractors). Run `make docs-refresh-reference` is not required (no venv), but run the script directly to confirm no diff: `python3 docs/_scripts/extract_agent_skills.py` then `git diff --stat docs/reference/agent-skills.md` (should be empty — already up to date).

- [ ] **Step 2 — Add a `docs-check` target that runs the guards.** Add to `Makefile` (and to its `.PHONY` line):
```make
docs-check:
	$(PY) -m pytest docs/_scripts/ -q
	$(PY) docs/_scripts/check_api_coverage.py
	$(PY) docs/_scripts/check_rate_limit_mapping.py
```
Use the same `$(PY)` variable the other docs targets use (check the top of the Makefile for its definition; if docs targets use a venv python, match that — but these scripts only need stdlib + PyYAML, so `$(PY)`/`python3` is fine; verify which variable resolves to a working interpreter and use it consistently).

- [ ] **Step 3 — Run the new target's commands** (directly, to confirm they pass): `python3 -m pytest docs/_scripts/ -q` (0 failures), `python3 docs/_scripts/check_api_coverage.py` (OK), `python3 docs/_scripts/check_rate_limit_mapping.py` (OK). Paste output.

- [ ] **Step 4 — Wire into CI if a docs workflow exists.** Check `.github/workflows/` for a docs job. If one exists and runs `make docs-*`, add a `make docs-check` step. If none exists, skip (note it in your report — do NOT create a new workflow without need).

- [ ] **Step 5 — Fix the `security-model.md` body-limit drift.** Change "Request bodies are capped at 2 MB" to "Request bodies are capped at 8 MB by default (`LLMIDE_BODY_LIMIT_MB`)". Verify the real default in `extension/core/config.mjs` first. While there, grep `security-model.md` for other stale numbers and cross-check against source: the vault allow-list (should be 10 keys, not 5 — fix if it lists fewer), any popup/`setServerUrl` mention (should be gone), JWT skew (should be 2s if mentioned). Fix any drift you confirm against source; report each.

- [ ] **Step 6 — Commit:**
```
git add Makefile docs/explanation/security-model.md
git commit -m "build: wire docs drift-guards into Makefile (docs-check) + fix security-model body-limit drift

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Explanation page + cross-links + final gate

**Files:** create `docs/explanation/cross-cutting.md`; modify `docs/index.md` (optional: note the spec set is complete).

- [ ] **Step 1 — Create `docs/explanation/cross-cutting.md`.** Concise orientation (explanation altitude): the system-wide concerns that don't belong to one subsystem — the local-first security posture, the one-config/one-DB/one-backend model, how to build/run/deploy, and where the invariants live. Frontmatter `title: Cross-cutting concerns`, `status: draft`. Add:
```markdown
!!! info "Rebuild-grade detail"
    Exact security controls, config matrix, build/deploy, and invariants are in [`../spec/cross-cutting.md`](../spec/cross-cutting.md).
```
Link `security-model.md`, `invariants.md`, and the build how-tos.

- [ ] **Step 2 — Mark the spec set complete in `docs/index.md`.** Under the "Two reading depths" note added earlier, add a one-line: "The `spec/` set covers all six subsystems: knowledge base, API & server, agent runtime, Chrome extension, macOS app, and cross-cutting concerns."

- [ ] **Step 3 — Final gate.** Run + paste:
```
python3 -m pytest docs/_scripts/ -q
python3 docs/_scripts/check_api_coverage.py && python3 docs/_scripts/check_rate_limit_mapping.py
make -n docs-check    # dry-run: confirm the new target parses
```
Plus a link check over `docs/spec/cross-cutting.md` + `docs/explanation/cross-cutting.md`. Paste results.

- [ ] **Step 4 — Commit:**
```
git add docs/explanation/cross-cutting.md docs/index.md
git commit -m "docs: cross-cutting explanation page + mark spec set complete

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review
- **Spec coverage:** design-spec unit-6 items (security model, env/config matrix, build/deploy, invariants as constraints) → Task 1 (the synthesis spec). Plus two concrete improvements the effort surfaced: Makefile guard-wiring + security-model drift fix (Task 2). ✓
- **Placeholder scan:** Task 1 links the authoritative specs/refs (synthesis, not placeholders); Task 2 has literal Make recipes; Task 3 has concrete prose targets. ✓
- **Name consistency:** `cross-cutting.md`, `docs-check`, `check_api_coverage.py`, `check_rate_limit_mapping.py`, `extract_agent_skills.py`, body limit `8 MB` used consistently. ✓
- **Risk:** confirm the Makefile `$(PY)` variable resolves to a working interpreter for `docs-check` (don't assume a venv is present); the target must work with plain `python3` since the scripts are stdlib+PyYAML only.
