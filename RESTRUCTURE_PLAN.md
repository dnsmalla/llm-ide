# LLM-IDE Restructuring Plan — Reviewed & Corrected

**Status:** Draft for review · 2026-08-13
**Supersedes:** `gemini-code-1786574142228.md` (external analysis — fact-checked below)

The original plan was written without running the code. This version was produced by
verifying every claim against the actual repository. Several of its headline actions
would **break the product or violate documented ADRs**; several real problems it
missed are added here.

---

## 1. Fact-Check of the Original Plan

| # | Original claim / action | Verified reality | Corrected action |
|---|---|---|---|
| 1 | "Standardize under **Express** router factories" | [ADR 0002](docs/decisions/0002-no-server-framework.md) explicitly decides **no server framework** (pure Node HTTP, minimal dependency surface). | **Rejected.** Keep the framework-free server. Consolidate the *route-module convention* instead (§4.2). |
| 2 | "`extension/agents/` and `extension/llm_agent/` are redundant parallel implementations — **delete `extension/agents/`**" | They are **two different systems** that share a provider layer. `llm_agent/` imports `agents/providers.mjs`, `agents/web-client.mjs`, `agents/prompt-utils.mjs`, `agents/runtime.mjs`, `agents/mode-classify.mjs` ([route.mjs:18-31](extension/llm_agent/runtime/route.mjs#L18-L31)). `agents/` = server pipeline agents (planner, risk, codegen, dispatcher, source ingestion). `llm_agent/` = interactive Code Assistant loop (fence parser, skills, global/internal split). Deleting `agents/` breaks the Code Assistant. | **Rejected as stated.** The *real* refactor: extract the shared **model-provider layer** (`providers.mjs`, CLI spawn + retry in `runtime.mjs`, `backoff.mjs`, `web-client.mjs`, usage metering) into its own module; keep pipeline agents and the interactive loop as separate consumers (§4.3). |
| 3 | "Delete `LegacyExporter.swift`, `NotesToLlmDocMigration.swift`, `SourceFolderMigration.swift`, `SourceNestedLlmDocMigration.swift` (dead code)" | **All four are live.** The three migrations run at every app startup to upgrade existing users' on-disk data ([AppEnvironment.swift:27-32](mac/Sources/LlmIdeMac/Services/AppEnvironment.swift#L27-L32)); `LegacyExporter` is used by [AppShell.swift:768](mac/Sources/LlmIdeMac/Views/AppShell.swift#L768). | **Rejected.** Keep them. Optionally: add a version-stamp so migrations short-circuit after first success, and schedule removal after a deprecation window (§5, Phase 0). |
| 4 | "Purge `extension/.code-notes/` and exclude via `.gitignore`" | **Partially right.** It *is* already in `.gitignore` (line 98) but **174 files are still tracked** — committed before the ignore rule was added. | **Accepted, corrected mechanics:** `git rm -r --cached extension/.code-notes` (it's a regenerated runtime cache — don't delete the working copy). |
| 5 | "Configure root `package.json` workspaces" | Confirmed: **no root `package.json` exists.** `extension/` is a single npm package containing server + React UI + 8 library layers. | **Accepted in principle**, but staged and gated (§5, Phase 3) — see risk analysis (§6). |
| 6 | "Shared Swift Package ensuring type parity between macOS and iOS" | **Already exists.** `ios_app/SharedProtocol/` is a standalone SPM package consumed by both apps, with its own tests (`make test-shared-protocol`). | **Drop from plan** — this is done. Only open question is whether to relocate it under a future `packages/` root (cosmetic; defer). |
| 7 | "Refactor macOS views into feature-driven structure (`Features/`)" | `mac/` has **381 Swift files** organized by an established, documented convention (Views/ViewModels/Services + suffix taxonomy in CLAUDE.md), plus domain dirs that already exist (`Agent/`, `CodeGraph/`, `CodeNotes/`, `SourceConnectors/`). A pre-push hook runs full `swift build && swift test` on every push. | **Rejected.** Massive churn, zero behavior change, conflicts with the documented convention, and every historical doc/memory reference breaks. Not professional-grade — it's rename theater. |
| 8 | "Dedicated repositories with `makeChatRepository(db)` factories" | `kb/*.mjs` already *is* a per-domain repository layer (`meetings.mjs`, `plans.mjs`, `usage.mjs`, `activity.mjs`, …) with a **stronger convention**: every state-mutating helper takes `userId` first, multi-step mutations wrap `db.transaction()`. The factory pattern in the plan drops both invariants. | **Rejected.** Keep the existing convention; it exists because of real tenancy regressions (see [invariants.md](docs/explanation/invariants.md)). |
| 9 | "Migrations 0001 to 0027" | Correct — 27 migrations exist. (CLAUDE.md still says 0024; **update it**.) | Accepted; fix CLAUDE.md. |
| 10 | Connectors fragmented across `connectors/`, `llm-sources/`, `mcp/` | Confirmed — three small dirs plus the hub in `kb/sources.mjs`. But `connectors/` mixes **outbound dispatch** (GitHub/GitLab/Backlog) with **inbound source adapters** (box, git, scip) — the plan didn't notice this axis. | **Accepted, refined** (§4.4). |

**What the original plan missed entirely:**

- The **documented layering rule is already violated in the direction it didn't check**: CLAUDE.md declares `core ← kb ← server ← agents/llm_agent`, yet [server/ai-routes.mjs:3-7](extension/server/ai-routes.mjs#L3-L7) imports `llm_agent/`, and [kb/routes/agent.mjs](extension/kb/routes/agent.mjs) imports `llm_agent/skills`. The dependency graph needs a *routes* layer on top, not a bigger diagram lie (§4.1).
- **Nothing enforces the layering.** `eslint.config.mjs` has no `no-restricted-imports` / boundary rules — the single highest-leverage, lowest-risk improvement available (§5, Phase 1).
- **Docs are load-bearing.** `docs/explanation/invariants.md`, the `docs/spec/` rebuild-grade layer, `make docs-check` drift guards, ADRs, and CLAUDE.md all pin file paths. Any move without a doc-update step silently rots the whole documentation system.
- The build/release surface pins paths too: `Makefile`, `setup.sh`, `scripts/install-skills.sh`, the `.skills` submodule symlinks, git hooks, `manifest.json`, `vite.config.ts`, `start.sh`.
- **SQLite is single-writer** (better-sqlite3, WAL). Splitting "apps" must never produce two Node processes writing the same DB — a workspace split makes this *easier* to get wrong, not harder.

---

## 2. Verified Current State

```
llm-ide/                      (no root package.json — not a JS workspace)
├── extension/                ONE npm package containing:
│   ├── core/                 framework-free primitives          (library)
│   ├── kb/                   SQLite + migrations 0001–0027,     (library + routes!)
│   │   ├── router.mjs        1,212-line route table
│   │   └── routes/           agent, chat, live, planning, review, issue-schedule
│   ├── server/               auth/jwt/vault/rate-limit/metrics  (library + routes!)
│   │   └── *-routes.mjs      ai (726 l), auth (1,213 l), export, control-plane
│   ├── agents/               pipeline agents + SHARED provider/CLI/backoff layer
│   ├── llm_agent/            interactive agent loop (imports agents/providers)
│   ├── connectors/           outbound dispatch + inbound source adapters (mixed)
│   ├── llm-sources/          source registry/state (2 files)
│   ├── mcp/                  MCP config + claude-source (3 files)
│   ├── graphkit/             code-graph model + memory writer
│   ├── guardrails/           secret/PII scanners
│   ├── plugins/              extension plugin loader
│   ├── src/                  React sidepanel/popup/content (Chrome extension UI)
│   ├── server.mjs            886-line entry point
│   └── tests/                147 test files, one flat pool
├── mac/                      SwiftUI app, 381 files, established taxonomy
├── ios_app/                  iOS app + SharedProtocol SPM package (shared w/ mac)
├── docs/                     mkdocs (strict), invariants, ADRs 0001–0016, spec/
└── kb/                       runtime data (live SQLite db)
```

Actual import graph today (arrows = "imports"):

```
core ──> (nothing internal)
kb   ──> core
server (libs: auth, vault, jwt, rate-limit) ──> core, kb
agents ──> core, kb, server/vault            ← shared provider layer lives here
llm_agent ──> core, kb, agents               ← cross-dependency the docs deny
connectors / guardrails / graphkit / plugins ──> core, kb
ROUTES (server.mjs, kb/router.mjs, kb/routes/*, server/*-routes.mjs)
       ──> everything                        ← this is the real top layer
```

---

## 3. Verdict on "Adopt the Full apps/ + packages/ Monorepo Now"

**Not yet.** The apps/packages split is the *last* step, not the first, because:

1. There is **one deployable Node artifact** (the local server) and one Vite bundle.
   Workspaces pay off when packages ship or version independently; none do today.
2. The repo's quality gates (pre-push swift build, `make regression`, `make docs-check`,
   147 tests, invariants doc) all encode current paths. A big-bang move invalidates
   every one of them simultaneously — the worst possible risk profile.
3. The two genuinely painful problems — **unenforced layering** and the
   **provider-layer entanglement** — are fixable *in place* with near-zero risk,
   and fixing them first makes the eventual physical split mechanical.

So: **modular monolith first, physical split when a driver appears** (e.g. publishing
`graphkit`, a second server, or CI needing independent package caching).

---

## 4. Target Architecture (Corrected)

### 4.1 Honest layering, with a routes layer

Replace the current diagram with the one that can actually be enforced:

```
Layer 0  core/                      Node built-ins + 3rd-party only
Layer 1  kb/ (data access only)     ──> core
Layer 2  providers/  (NEW)          ──> core, kb, server-libs   (extracted from agents/)
         server-libs (auth, vault, jwt, rate-limit, metrics)
Layer 3  agents/ (pipeline)         ──> 0–2
         llm_agent/ (interactive)   ──> 0–2      (no longer imports agents/)
         connectors/, guardrails/, graphkit/, plugins/
Layer 4  routes/ (NEW home)         ──> everything; nothing imports routes
         server.mjs                 entry point only
```

### 4.2 Route consolidation — without Express

Keep pure Node HTTP (ADR 0002). The consolidation is conventional, not framework:

- One directory `extension/routes/` (or `server/routes/`) where every module exports
  the same shape: `export const routes = [{ method, path, handler, auth, timeout }]`.
- `kb/router.mjs` (1,212 lines) and `server/{ai,auth,export}-routes.mjs` split into
  domain modules registered by a single tiny dispatcher.
- Middleware pipeline (CORS → JWT → rate-limit → timeout → route) stays exactly as is.
- `kb/` stops owning HTTP: `kb/routes/*` moves out, `kb/router.mjs` dissolves.
  After this, `kb/` is purely the data layer its name claims.

### 4.3 Provider layer extraction (the real "duplication" fix)

Create `extension/providers/` (later `packages/model-providers/`) from:

| Moves in | From |
|---|---|
| `providers.mjs` (provider resolve/dispatch, custom base URLs, CLI spawn) | `agents/` |
| CLI wrapper + JSON extraction + metering from `runtime.mjs` | `agents/` |
| `backoff.mjs` | `agents/` |
| `web-client.mjs` | `agents/` |
| `model-tier.mjs` | `llm_agent/runtime/` |
| usage metering wrappers (`meterUsage`/`meterQuota`) | `agents/runtime.mjs` |

Then:
- `agents/` keeps only pipeline agents (planner, risk, codegen, dispatcher, sources).
- `llm_agent/` imports **providers/**, never `agents/` — the cross-dependency dies.
- `prompt-utils.mjs` / `mode-classify.mjs` land wherever their only consumers live.

This is the corrected version of the original plan's "unified agent-runtime": unify
the *provider mechanics* both systems share; do **not** merge two agents with
different jobs into one runtime.

### 4.4 Source & connector consolidation — CORRECTED after implementation

Two of this section's original premises turned out wrong once verified in code:

1. **`connectors/` was already purely inbound** — every module is an indexer
   (`box`, `git`, `issues` = `indexGithubIssues`, `qa` = `indexJUnit`, `scip`,
   `structure-graph`). The "outbound dispatch lives in connectors" description
   came from a stale CLAUDE.md line, not the code. Outbound ticket/PR/Slack
   dispatch lives in `agents/` (`dispatcher`, `github-pr`, `slack`) — defensible
   as pipeline *actions*; no `dispatch/` directory is needed.
2. **`llm-sources/` is NOT a data-source module** — it's the registry of *skill*
   sources (central skills repos). Merging it into a data-ingestion directory
   would have been semantically wrong. It stays. Same for `mcp/` (agent tooling).

What was actually done: the four inbound source adapters that lived in
`agents/` (`email-source`, `slack-source`, `google-oauth`, `slack-oauth`)
moved to `connectors/`, so `connectors/` = all inbound adapters and
`agents/` = pipeline agents only. `kb/sources.mjs` remains the hub.

### 4.5 Eventual physical layout (Phase 3, gated)

When a driver appears, the split is then mechanical because boundaries are already lint-enforced:

```
llm-ide/
├── apps/
│   ├── server/          entry + routes + middleware      (pure Node, ADR 0002 intact)
│   └── extension-ui/    Chrome extension (Vite, manifest, src/)
├── packages/
│   ├── core/  ├── kb/  ├── model-providers/  ├── agents/  ├── agent-loop/
│   ├── sources/  ├── dispatch/  ├── guardrails/  ├── graphkit/  └── plugins/
├── mac/                 unchanged (SwiftPM is already its own workspace)
├── ios_app/             unchanged (SharedProtocol already shared)
└── package.json         npm workspaces: apps/*, packages/*
```

Deliberately **not** in the target: Express (ADR 0002), a mac `Features/` reorg (§1 #7),
merging mac's Swift graph renderer into a JS "knowledge-graph package" (it's a renderer,
not an engine — the wire DTO is the boundary, and it already exists).

---

## 5. Phased Roadmap

Every phase ends with the same gate: `make test && make lint && make docs-check`,
mac untouched phases skip `make test-mac`.

### Phase 0 — Hygiene (½ day, zero risk, do immediately)
- [ ] `git rm -r --cached extension/.code-notes` — 174 tracked cache files out of the index
- [ ] Sweep for other tracked artifacts: `git ls-files | grep -E '\.log$|scan-cache|\.db$'`
- [ ] CLAUDE.md corrections: migrations 0001–0027 (says 0024); add `llm-sources/`, `mcp/` to the structure listing (currently invisible to agents reading it)
- [x] Mac migrations: verified already idempotent with cheap `fileExists` guards ("safe to call every launch" by design) — **no stamp needed**. Only remaining action: a tracking issue to delete them after a deprecation window (e.g. 2 released versions)

### Phase 1 — Enforce boundaries in place (1–2 days, low risk, highest leverage)
- [ ] Add ESLint `no-restricted-imports` (or `eslint-plugin-boundaries`) zones encoding §4.1
- [ ] Grandfather current violations with a tracked allowlist; **ratchet**: new violations fail `npm run lint` (already `--max-warnings 0`)
- [ ] Document the corrected layer diagram in CLAUDE.md + `docs/explanation/architecture.md`

### Phase 2 — Logical extraction, no directory earthquake (1–2 weeks, incremental PRs)
- [x] 2.1 Extract `extension/providers/` per §4.3 — done. `providers/{providers,runtime,backoff,web-client,prompt-utils}.mjs` moved from `agents/`; `mode-classify.mjs` moved into `llm_agent/runtime/` (its only consumer); `redact` → `core/redact-object.mjs`; `resolveCentralSkillsRepo` → `core/skills-repo.mjs` (killed the registry↔skill-library cycle). **Grandfather list is now empty.**
- [ ] 2.2 Move `kb/routes/*` + `kb/router.mjs` contents into the unified route convention (§4.2); `kb/` becomes data-only
- [x] 2.3 Regroup sources vs dispatch (§4.4, as corrected) — `email-source`, `slack-source`, `google-oauth`, `slack-oauth` moved from `agents/` to `connectors/`; connectors got their own lint block (they legitimately reach `server/vault`). No `dispatch/` dir — outbound is pipeline actions in `agents/`.
- [~] 2.4 Tests stay a flat pool — deliberate. 147 files move cleanly with the glob today; per-layer subdirectories would churn every historical reference for zero enforcement gain (the lint ratchet, not test location, guards the boundaries).
- [ ] Each PR updates: invariants.md sections it touches, `docs/spec/` drift-guards, CLAUDE.md "Where to Add X" table

### Phase 3 — Physical workspace split (gated; only with a concrete driver)
- [ ] Preconditions: Phase 1 lint ratchet at zero violations; a named driver (package publishing, second deployable, CI caching need)
- [ ] Root `package.json` workspaces; move layers to `packages/*`, entry+routes to `apps/server/`, UI to `apps/extension-ui/`
- [ ] **Single-writer guard:** `apps/server` remains the only process opening the DB; add a startup lockfile check so a second writer fails loudly
- [ ] Update every path-pinning surface in one PR series: Makefile, setup.sh, install-skills.sh, git hooks, mkdocs, CI, `start.sh`, `vite.config.ts`, manifest build
- [ ] Full gate: `make regression` + real-meeting checklist from CLAUDE.md + mac/iOS smoke

### Explicit non-goals
- Express or any HTTP framework (ADR 0002)
- Deleting `extension/agents/` or the mac legacy migration/exporter files
- mac `Features/` reorg; renaming Views/ViewModels/Services
- Merging Swift graph renderers into a JS package
- A second SQLite-writing process, ever

---

## 6. Risk Register

| Risk | Phase | Mitigation |
|---|---|---|
| Docs/spec/invariants silently rot as paths move | 2–3 | `make docs-check` in every PR gate; doc updates in the *same* PR as the move |
| Layering refactor breaks tenancy (`userId`-first) invariants | 2 | Repos keep existing function signatures; no factory rewrite (§1 #8) |
| Two processes writing SQLite after app split | 3 | Startup lock check; single `apps/server` owns the DB |
| Pre-push swift hook deadlocks on concurrent builds | any mac change | Pre-warm build, push once (known behavior) |
| Import churn breaks the Chrome extension bundle | 2–3 | `npm run build` (tsc + vite) in every PR gate; extension load-test before merge |
| Big-bang temptation | 3 | Phase 3 is **gated on a named driver**, not a date |
