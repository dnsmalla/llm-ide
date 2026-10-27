# Plan: kit-by-kit migration (replaces the Phase 2 / 3 / 5 ordering)

**Date:** 2026-10-27
**Status:** Proposed — revised after review (Fable 5.1, verdict "rework"); for approval before any work starts
**Parents:** [Tauri desktop + relay](2026-10-24-tauri-desktop-and-relay.md) ·
[Phase 0 report](2026-10-25-tauri-phase0-report.md) ·
[Phase 1 core contract](2026-10-26-phase1-core-contract.md) ·
[Token efficiency](2026-10-26-token-efficiency.md)

## Principle: a skeleton for ever-improving LLMs

LLM-IDE is the **skeleton**; the model and the Agent SDK are the **muscle**.
Every kit is judged by one question: *does this get better on its own when the
model or SDK improves?* If not, the kit may own it only when it is one of the
things the project must control.

| Delegated to the model / SDK | Owned by LLM-IDE (project control) |
|---|---|
| reasoning, coding, tool use, planning | **permission** — approvals, guardrails, secrets, sandbox |
| context handling, compaction, subagents, caching | **budget** — token limits, model routing, usage ledger |
| new tools / features each SDK release adds | **knowledge** — project memory, KB, sources, code graph |
| model quality and speed | **workflow** — plans, review queue, dispatch, Loop checks |
| | **observability** — Agentic OS view, activity, usage |
| | **contract** — stable HTTP/wire surface across every client |

Rules that follow:

- **K0 labels every piece** of a kit *delegated* or *owned*. Delegated pieces
  stay thin adapters over the SDK/provider; owned pieces get the tests.
- **SDK upgrade-and-tune loop** (agent-kit): on every SDK release, diff
  `sdk-surface.json`, adopt what helps, and **retire our code the SDK now
  supersedes** — measured by the token bench before/after. First retirement
  candidates: the classic `/code-assist` engine and the homegrown agent loop.
- **Model-agnostic:** a new model or vendor is configuration (`providers/`,
  tier routing), never a code change; the token bench also runs on a second
  model so an upgrade is a measured setting change.
- **Never re-implement** a capability the SDK ships just to "own" it.

## Why change the plan

The original Phase 2 ("move all logic out of Swift") and Phase 3 ("build the
Tauri app") are each one big step across the whole product: hard to test, hard
to fix, and a failure in one area blocks the rest. `graph-kit` already shows a
better shape — one capability, its own tests and release, a narrow seam,
removable. This plan cuts the work into **kits** and moves one kit at a time
through the same fixed steps while the rest of the app keeps working.

## Non-negotiable invariants (checked at the end of every kit step)

1. **Mac module boundaries stay sealed.** `mac/Scripts/feature-boundaries.sh`
   passes; all 15 feature folders stay sealed; new cross-kit needs go through
   `Core/Contracts/`.
2. **Every removable feature stays removable.** For the kit's key in
   `mac/Package.swift` / `LLMIDE_FEATURES`: the reduced Mac builds still build,
   including closure rows (`file_explorer` off ⇒ `code_graph_3d`,
   `gantt_issues`, `doc_gen` off). **For the three keys that own a server route
   group** (`code_graph_3d`, `gantt_issues`, `auto_tasks` —
   `extension/routes/feature-routes.mjs`) the server answers
   `404 feature_disabled`; `doc_gen` is deliberately not gated (extension
   ExportMenu calls `/generate-docx`), and `file_explorer`, `terminal`,
   `mobile_sync` have no server routes.
3. **Server layering stays at zero violations**; the lazy-engine invariant
   holds.
4. **The contract holds.** `make contract-gates` + live contract test pass;
   K1 routes are **additive only**; wire changes bump `SERVER_API_VERSION`.
5. **The current app keeps working.** Mac XCTest + swift-testing, server
   tests, extension build green; the installed Mac app works against the new
   server at every merge. **Skew window:** app N-1 ↔ server N (matters for an
   adopted external server; the app normally spawns its own).
6. **Tokens and latency never regress** on the chat path (token bench incl.
   TTFT, once a baseline exists).
7. **The phone keeps working through the Mac** until sync-kit lands:
   `make build-mac-mobile-only`, `make test-shared-protocol` and the Mobile
   test files stay green.

## The kit step template

| Step | What | Exit gate |
|---|---|---|
| **K0 Map** | Kit README: code on every side (server modules, Mac feature folder + Core backing code, extension, contract groups, feature key, tests with counts), cross-kit edges, and the *delegated / owned* label per piece. | README committed; every edge goes through Core contracts / HTTP; no cycle. |
| **K1a Data** | Where the kit's state lives after K1 (Mac on-disk JSON/Markdown, UserDefaults, keychain, SQLite). One-way migration, N-1 readability, rollback: the Swift path stays one release behind a pref. | Migration test with a real old-format fixture; rollback tested. |
| **K1 Core** | Business logic the kit keeps in Swift moves into a Node kit module behind contracted routes; Swift keeps UI and calls the route. Tests move with logic: each Swift test for moved logic is ported to a node test or `*-contract-lab` **before** the Swift test is deleted. Latency budget per call (e.g. local list/load < 50 ms); streaming protocol unchanged. | Kit unit tests; live contract subset; Mac suites green; **behaviour unchanged (same fixtures)**; bench within budget. |
| **K2 Remove** | Prove removal for the kit's key + its closure neighbours (see Gates). | Kit-local feature matrix green. |
| **K3 Screen** | Kit screens in the Tauri app from ui-kit, matching the Mac app; honours the Tauri feature-off mechanism. | Side-by-side screenshot parity reviewed; desktop tests. |
| **K4 Retire** | After one release with both, remove the kit's Swift UI. | Mac builds without it; nothing references it. |

**K1-skip rule:** kits whose Swift logic is UI state only (CodeGraph render,
Terminal, Explorer, Search) go K0 → K2 → K3. **Behaviour-changing work** (token
items 2–10, SDK adoption) never rides in a K1; it ships on its own branch,
measured by the bench.

## The kits

| # | Kit | Owns — server · Mac · extension | Key | Contract groups | Depends on |
|---|---|---|---|---|---|
| — | **core** | `extension/core/`, `server/` (auth, vault, jwt, rate-limit, tier-routing, export-routes), `kb/db.mjs` + `migrations/`, `kb/` usage/user/tool-permissions/activity · `Core/Platform`, `Networking`, `Project`, `Repo`, `Contracts`, `Editor`, `Incidents`, `Memory`, `Notes`, `Shell/` · — | always | health-auth | — |
| — | **desktop-shell** | Tauri window, Node sidecar lifecycle (= `BackendManager`), login / reconnect / welcome / recovery, keychain, updater, TCC file dialog, Tauri capabilities, DOMPurify (Phase 0 conditions 2, 4) · `Shell/` screens · — | always | — | core, ui-kit |
| 0 | **ui-kit** | `schema/design/tokens.json` → Swift `ThemeTokens` + CSS; shared React components · `Core/DesignSystem` · — | always | — | — |
| 1 | **os-kit** | `GET /kb/os/state` aggregate + live stream (no model calls) · Mac web panel · Agentic OS view (see below) | always | os (new) | core, ui-kit; reads every kit |
| 2 | **docs-kit** | `/generate-doc(x)`, templates · `Features/Generation`, `Core/Generation` · ExportMenu | `doc_gen` (not server-gated) | notes-generation (generate-doc/docx) | knowledge, agent, core |
| 3 | **graph-kit** | `mac/LocalPackages/graph-kit`, `extension/graphkit/`, `kb/code-graph`, `graph_generation/` (contract doc) · `Features/CodeGraph` | `code_graph_3d` | live-loop-misc (code-graph) | core |
| 4 | **knowledge-kit** | `kb/` sources/exporter/project-export/install-project-skills, search; `connectors/`; `agents/` slack/email-classify/connector-classify/code-sync · `Features/Library`, `Features/ReviewConflicts` (code ↔ LLM-doc conflicts) · extension KB views | always | kb-sources | core, agent-kit (summaries via `providers/`) |
| 5 | **agent-kit** | `llm_agent/`, `providers/`, `mcp/`, `plugins/`, `llm-sources/`, `agents/agent-prompt`, `kb/` chat-sessions/agent-sessions/session-memory/turn-composition/personas/tool-* · `Features/Chat`, `ClaudeLink/` · side-panel chat | `agent_chat` (never off) | agent, providers-usage, health-auth plugin/MCP/LLM-source rows | core |
| 6 | **work-kit** | `agents/` planner/risk/codegen/codegen-apply/dispatcher/outcome-watcher/outcome-providers/github-pr, `guardrails/`, `kb/` plans/reviews/outcomes/issue-schedule/review-payload · `Features/Issues` (+Gantt) · `usePlan.ts`, `useAgent.ts`, `lib/plan.ts` | `gantt_issues` (Issues part) | planning, review, live-loop-misc (issue-schedule) + **new** GitHub/GitLab issue routes | core, agent, knowledge, graph (planner imports `graphkit/`, always loaded) |
| 7 | **workspace-kit** | file tree, search, source control, terminal (PTY in Rust) · `Features/Explorer`, `Search`, `SourceControl`, `Terminal` | `file_explorer`, `terminal` | (mostly local) | core, ui-kit |
| 8 | **capture-kit** | live sessions, `agents/` meeting-agent/summarize/live-sessions, `kb/meetings`, `/generate-notes`, `/generate-questions`, `/extract-entities` · `Features/Live` · `extension/src/content`, Notes/Questions/Transcript views + hooks | always | live-loop-misc (live), notes-generation | core, knowledge, agent |
| 9 | **automation-kit** | Loop + Auto Tasks + verify/repair · `Features/Loop`, `Features/AutoTask` | `auto_tasks` | live-loop-misc (`/kb/loop/*`) | core (**job runner**, Repo, Incidents, Memory), agent, knowledge |
| 10 | **sync-kit** | Mobile Control → relay + phone PWA · `Features/MobileControl`, `ios_app/SharedProtocol` | `mobile_sync` | relay (new) | every kit it mirrors; K3 after their screens |
| — | **Settings** | composition of settings cards via `SettingsSectionRegistry`; its own K3 | always | — | all |

**Cycle rule:** kit edges form a DAG through `core`. `Core/Repo` (used by
Issues, Chat, SourceControl, AutoTask, Loop, MobileControl) stays in core, and
the Issues seams (`RecentIssuesProviding`, picker) stay in `Core/Contracts` —
this removes the agent ↔ work cycle.

**Known hard spot:** knowledge-kit K1 is a **dual-store unification** (Mac
on-disk Markdown via `Core/Notes`, read by five features, vs server SQLite/FTS5),
not a folder move. Chat sessions are double-stored too (Mac JSON files vs
`unified_chat_sessions` / `agent_sessions`) — agent-kit K1a decides the home.

## os-kit — the Agentic OS view

One screen that shows everything the system is doing, read-only and free.

- **Data:** `GET /kb/os/state` aggregates existing tables (usage ledger,
  turn_composition, activity, Loop journal, agent sessions, sources, plans,
  outcomes, feature set, kit health) — **no model calls**. Live updates over
  the existing stream mechanism; no polling loop that costs tokens.
- **Views:** system map (kits as rings: on/off, health, delegated vs owned) ·
  activity timeline (chats, auto tasks, loops, ingests, dispatches) · token
  flow (per surface/model, cache read vs write, prefix vs transcript) ·
  memory & knowledge (what the agent knows per project) · running jobs with
  cancel.
- **Built once:** React + ui-kit (and the WebGL renderer from graph-kit for the
  map); shown in the Tauri app and as a web panel in the Mac app, so it ships
  before any K3.
- **Order:** right after ui-kit; it grows as each kit's K0 adds its health and
  metrics to the aggregate.

## Order and why

1. **Blocking gates (Phase 1 finish):** P12 Swift decode check
   (`api-contract-lab`), P14 openapi.yaml, P15 = ui-kit, P16 CI incl. the
   feature matrix, P17 committed token baseline; land the `desktop/` scaffold
   on `main` (decision needed — today it is untracked / spike branch).
2. **ui-kit** — unblocks every K3 and "one look".
3. **os-kit** — visibility first; read-only, low risk.
4. **docs-kit** — small, keyed, three surfaces: **dry run of the full
   K0–K4 template**.
5. **graph-kit** — already a kit; K1 = layout in Rust/WASM, K3 = WebGL view.
6. **knowledge-kit** — most kits read it; dual-store unification.
7. **agent-kit** — the north-star kit; largest UI coupling (Chat ~24 k lines,
   25 Mobile test files), so it goes after the template is proven.
8. **work-kit**, 9. **workspace-kit**, 10. **capture-kit**.
11. **core job runner** (persisted queue, lane lock, cancel on quit → journal
    `.aborted`, process-group kill, flake gate; "the sidecar never restarts
    under the app") — prerequisite for:
12. **automation-kit** — largest and riskiest; last of the logic kits.
13. **sync-kit** — after the kits it mirrors.

## Size

Porting with test migration is ~1.5–3 k Swift lines per task.

| Kit | K0–K2 tasks | K3–K4 tasks |
|---|---|---|
| ui-kit | 3 | — |
| os-kit | 3–4 | 2–3 |
| docs-kit | 2–3 | 2–3 |
| graph-kit | 3–4 | 3–4 |
| knowledge-kit | 10–14 | 6–8 |
| agent-kit | 15–20 (8–10 if K1 = sessions/history/plan-tracker only) | 8–10 |
| work-kit | 10–12 | 5–6 |
| workspace-kit | 3–4 | 6–8 |
| capture-kit | 3–4 | 4–5 |
| core job runner | 4–6 | — |
| automation-kit | 20–30 | 8–10 |
| sync-kit | 6–8 | 3–4 |
| desktop-shell + Settings | — | 12–15 |

**Total ≈ 125–160 tasks ≈ 50–110 M agent tokens** at 0.4–0.7 M per task
(implement + review + fix). The skeleton principle should shrink this: every
piece the SDK already does is retired, not ported.

## Gates added before the first kit

- **Feature matrix** (`make feature-matrix`):
  - **per merge (kit-local):** the kit's key off + its closure neighbours —
    reduced Mac build (own `--scratch-path`), server started with that
    `LLMIDE_FEATURES`, live contract test in a new **assert mode** that expects
    `404 feature_disabled` for the kit's routes (today the test only skips
    them), extension `REQUIRED_ENDPOINTS` checked against `/health endpoints`;
  - **nightly / CI (P16):** all 7 single-off rows, closure rows, and the pair
    quadrants (`build-mac-lite`, `build-mac-min`, `build-mac-mobile-only`),
    plus `make test-shared-protocol`.
  Status: **landed on `feat/phase1-gates`.** `make feature-matrix` (`scripts/feature-matrix.mjs`) covers the 7 single-off rows, the file_explorer closure row and the three quadrants; the server side runs per row (feature_disabled 404s, `/health` features + endpoints, REQUIRED_ENDPOINTS, live contract in assert mode `CONTRACT_EXPECT_DISABLED=1`); `--mac` adds the reduced Swift builds. Per merge: `--key <row>`. Nightly: `.github/workflows/feature-matrix.yml` (server rows; Mac rows on workflow_dispatch). The kit-local 'reduced Mac build' still needs `--mac`, so it is not automatic on push.

- **Tauri feature-off mechanism** decided before the first K3: build-time
  tree-shake by key vs runtime `/health features` (recommend both: runtime for
  hiding, build-time for the reduced bundles).
- **Kit README** per kit (K0 output).

## What does not change

- No big-bang rewrite: the Swift app stays the shipping product until each
  kit's K4.
- Pushes go to a branch and are reviewed before merge to `main`.
- Execution: Haiku 5.5 implements, Sonnet 5.5 reviews per task; Fable 5.1 for
  each kit's final review; the orchestrator builds Swift and runs the suites.
