# App Forge — full app generation skill (design)

**Date:** 2026-09-25 · **Status:** approved design, pending plan · **Home:** `.skills` kit (dnsmalla/agent-kit)

## Goal

A skill set that takes one app idea to a **built, verified app** through a staged,
multi-persona pipeline modelled on [MiroFish](https://github.com/666ghj/MiroFish)'s
shape (seed → knowledge graph → persona agents → simulation → report → deep
interaction), using web search for grounding and the kit's existing plan/execute
skills for building.

MiroFish is the **pattern**, not a dependency: nothing from it is vendored or called.

## Decisions (and why)

| Decision | Choice | Reason |
|---|---|---|
| Packaging | Kit skills in `.skills` | One source of truth for every agent CLI; appears in the Mac "/" menu via the existing skill library with no app code |
| Personas | In-skill role prompts | Zero server/Mac change. Kit `agents/` is not wired to any runtime and `ask-subagent` resolves only plugin subagents |
| End state | Built + verified app, two approval gates | Research/council value is only proven by a working artifact; gates keep the user in control before code |
| App types | Stack-agnostic from a curated menu | Every chosen stack must have known test/build/launch commands so verification is real |
| Structure | Orchestrator + 3 stage skills, reuse existing process skills | The Mac chat reads only `SKILL.md` (24k-char cap, `extension/llm_agent/skills/skill-library.mjs:112`); sibling reference files are not loaded there, so each stage is its own catalogued skill loaded by id |

## Components

All live under `.skills/skills/<name>/SKILL.md`, each **< 24,000 chars**.

| Skill | Purpose |
|---|---|
| `app-forge` | Orchestrator: intake, `.forge/state.json` state machine, gates, spec + report writing, persona follow-up Q&A, hand-offs |
| `app-research` | Web research into a citable Markdown "research graph" |
| `app-council` | Persona council: positions → challenge → synthesis, simulated users |
| `app-stack-menu` | Curated stacks with scaffold/install/test/build/launch commands |

Reused unchanged: `brainstorming` (spec shape), `writing-plans`,
`subagent-driven-development` / `executing-plans`, `test-driven-development`,
`systematic-debugging`, `verification-before-completion`.

**Hand-off mechanism.** In LLM-IDE chat the orchestrator calls
`load-skill` with id `skills/<dir>` (catalog-gated reader,
`extension/llm_agent/runtime/handlers/load-skill.mjs`); in Claude Code it uses
the Skill tool by name. The orchestrator states both forms.

Plus `commands/cli/app-forge.md` — `/app-forge <idea>` slash command for agent CLIs.

## Stage flow

Every stage writes one artifact to `<app-dir>/.forge/` and updates
`.forge/state.json` (`{ stage, status: done|failed|awaiting-approval, reason?, rounds, stack, updatedAt }`).
On start, if `state.json` exists, the orchestrator resumes from the last
incomplete stage and never re-runs a finished stage unless asked.

| # | Stage | Skill | Artifact | Gate |
|---|---|---|---|---|
| 0 | Intake | app-forge | `seed.md` — idea, target users, must-haves, constraints, **target directory** (confirmed; never the current repo), council rounds (1 default, max 2). ≤ 3 questions, each with a recommended answer | — |
| 1 | Research | app-research | `research.md` | — |
| 2 | Council | app-council | `council.md` | — |
| 3 | Spec | app-forge (brainstorming spec shape) | `spec.md` — scope, stack (from menu), architecture, data model, screens/endpoints, acceptance criteria, test strategy, toolchain check result | **Gate 1** |
| 4 | Plan | writing-plans + `save-plan` tool when present | `plan.md` | **Gate 2** |
| 5 | Build | subagent-driven-development (or executing-plans if no subagents) | app code; `git init`, one commit per plan task | — |
| 6 | Verify | verification-before-completion + stack commands | `verify.md` — real command output of install, test, build, launch check | — |
| 7 | Report | app-forge | `report.md` — what was built, how to run, deviations from spec, open items | — |

After stage 7 the user may ask "ask the architect / PM / user Mika …";
the orchestrator answers in that persona's voice grounded **only** in
`council.md`, `spec.md` and `report.md` (MiroFish's "deep interaction").

**Gates are hard stops**: the skill ends its turn with `status: awaiting-approval`
and writes no code before Gate 2 is approved. "Skip the questions / just build it"
does not bypass gates.

## `app-research`

Tools: `web-search` + `fetch-url` (LLM-IDE) or `WebSearch` + `WebFetch` (Claude Code).
Budget: **≤ 8 searches, ≤ 6 fetches**.

Five query lanes: (1) users & jobs-to-be-done, (2) 3–5 competitors — strengths,
gaps, pricing, (3) building blocks — libraries/APIs/SDKs with license and
maintenance status, (4) stack fit against the menu, (5) risks — legal, rate
limits, data/privacy.

Output format (Markdown graph):

```
## Entities
- [U1] segment: freelance designers (src: S3)
- [C1] competitor: Toggl — strong timer, weak invoicing (src: S1, S4)
- [L1] library: Stripe Checkout — MIT SDK, hosted UI (src: S5)
## Relations
- U1 --needs--> invoicing ; C1 --lacks--> invoicing  ⇒ gap G1
## Gaps
- G1 invoicing for freelancers (U1, C1)
## Sources
- S1 https://… (fetched YYYY-MM-DD)
```

Entity id prefixes: `U` segment, `C` competitor, `L` library/API, `K` stack,
`R` risk, `G` gap, `S` source. No search tool available → banner
`UNVERIFIED — model knowledge only` and every entry tagged `(model knowledge)`.

## `app-council`

Single-context role-play with strict turn-taking: each persona sees only
`seed.md`, `research.md`, and the positions written before its turn.

Roster (role card per persona: goal, bias, must-raise questions, required output):

| Persona | Pushes for | Must produce |
|---|---|---|
| Product Manager | smallest shippable value | problem statement; must / should / won't |
| Architect | simplicity, buildable stack | stack pick from `app-stack-menu`; components; data model |
| UX Designer | the core flow | screen list; primary flow in 5–7 steps |
| Security/Privacy | secrets, auth, PII | threat list with mitigations or explicit exclusions |
| QA | verifiability | acceptance criteria per must-have; test strategy |
| Skeptic | cutting weak features | top-3 cuts/risks with reasons |
| Simulated users ×3–5 | own job-to-be-done | reaction; first missing feature; drop-off point |
| Moderator | convergence | decisions; resolved conflicts with reasons; open questions for Gate 1 |

Simulated users are generated from `research.md` `U*` segments (name, context,
skill level, goal) — MiroFish's persona-generation step.

Round: **Positions** (PM → Architect → Designer → Security → QA → each user) →
**Challenge** (Skeptic attacks; each role gives one ≤ 3-line rebuttal or
concession) → **Synthesis** (Moderator). Rounds: 1 default, max 2.

Anti-bleed guards:
- Every claim cites a `research.md` id or a user segment; uncited claims are tagged `[opinion]`.
- The Moderator chooses only among proposals — it cannot add features.
- If every persona agrees in the first pass, the council is invalid: re-run the Skeptic with a sharper brief.

`council.md` sections: Positions, Simulated users, Challenge, Decisions,
Resolved conflicts, Open questions.

## `app-stack-menu`

Each entry fixes: *use when*, scaffold, install, test, build, launch check.

| Stack | Use for | Test | Launch check |
|---|---|---|---|
| Vite + React + TS | SPA, no backend | `npm test` (vitest) | `npm run build` then `vite preview` + curl 200 |
| Next.js + TS | full-stack web / SSR | vitest | `next build` + `next start` + curl 200 |
| FastAPI + SQLite (+ React) | Python API / data apps | pytest | uvicorn + curl `/health` |
| Node HTTP / Hono + SQLite | lightweight API | `node --test` | start + curl `/health` |
| Python CLI (uv) | tools, scripts | pytest | `--help` exits 0 |
| SwiftUI (SwiftPM) | macOS app | `swift test` | `swift build` succeeds |
| Expo (React Native) | mobile | jest | `npx expo export` succeeds |
| Docker Compose wrapper | multi-service | — | `docker compose up -d` + health checks |

Rules: the Architect picks from the menu; off-menu requires a written
justification in `spec.md` and verification falls back to that stack's own
test/build. Before Gate 1 the orchestrator runs the stack's toolchain probe
(`node -v`, `uv --version`, `swift --version`, `docker --version`) and records
the result in `spec.md`; a missing toolchain is surfaced before approval.
Launch checks run the server in the background, poll, then stop it.

## Error handling

- Stage failure → `state.json` `status: failed` + reason; next run offers resume/retry of that stage.
- No web search → research `UNVERIFIED`. No subagents → executing-plans. Missing toolchain → surfaced pre-Gate 1.
- Verify: ≤ 3 fix attempts per failing check (systematic-debugging); then stop and write real failure output to `verify.md`. Never claim success without command evidence.
- Blast radius: writes only inside the confirmed target directory; `git init` there; never pushes, never installs global packages, never writes to the invoking repo.

## Testing (writing-skills TDD)

1. **Baseline (RED):** run three seeds without the skills — habit-tracker SPA,
   FastAPI invoice API, markdown-notes CLI — and record failures (no research,
   no gates, unverified "done").
2. **With skills (GREEN):** same seeds; check every run for: all 8 `.forge/`
   artifacts; research cites sources; council has ≥ 1 resolved conflict and
   generated users; both gates stop; `verify.md` holds real passing output.
3. **Pressure (REFACTOR):** "just build it, skip questions" still gates;
   no web access; off-menu stack request; resume after a failed build.
4. **Kit gates:** `scripts/validate.sh`, `tests/registry_integrity.sh`,
   `scripts/test-install.sh`, `scripts/gen-catalog.sh`; every SKILL.md < 24,000 chars.

## Changes

**`.skills` kit** (branch in the kit repo; pushing is the user's call):
- `skills/app-forge/`, `skills/app-research/`, `skills/app-council/`, `skills/app-stack-menu/` — `SKILL.md` each
- `registry.yaml`: 4 entries — `family: process`, `tools: [claude, cursor, codex, agents, gemini]`, `stacks: []`, `version: 1.0.0`
- `commands/cli/app-forge.md` + `registry.yaml` `commands:` entry
- `CATALOG.md` regenerated, `CHANGELOG.md` entry

**llm-ide:** bump `.skills` submodule pointer + `.skills-lock`; this spec. No server or Mac code changes.

## Out of scope

- Real isolated persona subagents (would need wiring kit `agents/` into `buildPerUserSkillSet` — a possible v2).
- A Mac stage-progress UI for `.forge/` runs.
- Deploying generated apps; MiroFish's OASIS/Zep simulation engine.
