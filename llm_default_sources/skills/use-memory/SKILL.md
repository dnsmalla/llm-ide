---
name: use-memory
description: >-
  Read and write the agent memory store at `.auto_system/memory/` (flat
  markdown + a typed graph). Use at session start (ALWAYS read facts +
  skill-affinity), when answering "what depends on X / why did we pick Y /
  what connects to Z" (query the graph), and after meaningful events (record
  decisions, preferences, skill fires). Triggers: "what do we know about
  this project", "remember that …", "why did we pick X", "what depends on
  posts", "what skills apply here", "don't ask me again", start of any non-
  trivial task.
---

# Use the memory store

`.auto_system/memory/` is the agent's persistent, file-based memory. It exists so agents stop re-deriving facts the system already knows — what engine the DB uses, which skills fire here, why MFA is off, what the user prefers. Every file is markdown, git-trackable, and updatable via `./master.sh memory …`.

## Read protocol (at every session start, cheap → expensive)

1. **`facts.md`** — authoritative project snapshot. Read FIRST. Tells you: engine, entities count, compliance state, auth/backend summary. Refreshed automatically after `compliance`, so it's current as of the last run.
2. **`skill-affinity.md`** — top 20 skills that fire here, ranked by usage. Bias which skill descriptions you load first.
3. **`preferences.md`** — user/project conventions (pnpm vs npm, deploy target, editor). Use to avoid re-asking stable questions.
4. **`faults/INDEX.md`** — the known-bug knowledge base. **MUST read before any audit, debug, fix, or change to a critical path** (auth, payments, conversions/commissions, deploy). Each row links a per-fault `.md` with symptom → root cause → fix → **guard** (the lesson). Prevents re-discovering a known bug and re-introducing a past regression.
5. **`activity.md`** (last 10–20 entries) — recent events. Skim before making assumptions about current state.
6. **`decisions.md`** — consult ONLY when a design choice comes up ("why is MFA off", "why sqlite locally"). Rarely needed at every turn.

Typical read budget: ~1–2k tokens. Cheaper than grepping the repo.

## Write protocol (only when it adds durable value)

| Event | Command | Why |
|-------|---------|-----|
| System state changed (generators ran, compliance ran) | **automatic** — the command hooks `addActivity` + `refreshFacts` | Keep facts.md current without asking |
| Architectural decision made | `./master.sh memory add-decision "<message>" --why "<rationale>"` | Don't relitigate later; audit trail |
| User stated a stable convention | `./master.sh memory prefer <key> <value>` | Stop re-asking ("Use pnpm", "Deploy to Fly") |
| User said "remember that …" | `add-decision` (if why-bearing) or `add-activity` (if event-shaped) | |
| User said "don't do X again" | `add-decision` with the rationale | Surfaces on every future session |
| A skill fired and completed | `./master.sh memory record-skill <skill-name>` | Re-rank skill-affinity |
| **Fixed a bug that could recur** | `./master.sh memory add-fault "<title>" --symptom … --cause … --fix … --guard … --severity … --files … --commit …` | **After you FIX a bug, if you judge it could happen again, record it with the error (symptom/cause) and the solution (fix). `--guard` is the lesson: what to check so it can't recur. Faults are LOCAL-ONLY (gitignored) — safe to be specific. Skip purely one-off, never-again bugs.** |

> **Automatic capture:** a git **post-commit hook** auto-records a fault from every `fix(…)`/`bugfix`/`hotfix` commit (subject + body + files + sha) — so the normal debug→fix→commit loop populates the KB with **no extra step**. Install once per repo: `./master.sh memory install-fault-hook` (idempotent; run it at project setup). The auto-captured entry is a stub — enrich its root-cause + `--guard` when you know them (or let `faults-review` do it). Manual `add-fault` is still right for bugs fixed without a dedicated `fix` commit.

> **Feedback loop + threshold:** faults accumulate locally (short index: `faults/faults.csv` — recorded, severity, fault, reason, solution, commit; check it at production/upgrade time). When the KB passes **>5 faults**, the post-commit hook + `memory faults-status` nudge you to run the **`faults-review`** skill, then **`/upgrade-system`**, to upgrade the skills + auto-system from the recurring root causes. That's how the system *learns* from its bugs.

## Do NOT write

- Transient state (current file being edited, scratch work)
- Anything sensitive (secrets, PII)
- Anything derivable from `system.yaml` and already in `facts.md`
- Notes "for next time" that belong in a code comment or PR body

## The 6 files, exact usage

```
.auto_system/memory/
├── README.md              # static — documents the layout
├── facts.md               # auto-refreshed snapshot; never hand-edit
├── decisions.md           # append-only; newer entries supersede older
├── activity.md            # rolling 100-entry journal; auto-pruned
├── preferences.md         # key/value; authoritative
├── skill-affinity.md      # rank-ordered top-20; auto-sorted
├── faults/                # known-bug KB: one .md per fault + INDEX.md (read before audits/fixes)
└── graph.json             # typed nodes + edges; rebuilt by `memory graph build`
```

## The graph layer — when to use it

Flat markdown answers "what are the project's facts / recent events / decisions." **The graph answers "what connects to what."** It's derived from the same sources (system.yaml + flat files) and stored as `graph.json`.

**Node types** (9): `project`, `platform`, `entity`, `skill`, `decision`, `preference`, `role`, `feature`, `extension`.

**Edge types** (11): `has_platform`, `declares_entity`, `has_feature`, `uses_extension`, `defines_role`, `knows_skill`, `references` (FK between entities), `skill_applies_to`, `decision_about`, `supersedes`, `prefers`.

**Query playbook:**

| Question | Command |
|----------|---------|
| "What touches the posts entity?" | `memory graph edges entity:posts` |
| "What depends on / relates to auth?" | `memory graph related role:user --hops 2` |
| "How does `configure-database` connect to `posts`?" | `memory graph path skill:configure-database entity:posts` |
| "All declared entities?" | `memory graph list entity` |
| "All decisions ever made?" | `memory graph list decision` |
| "Summary: node + edge type counts" | `memory graph show` |

**When to prefer graph over flat files:**
- Anything relational ("what connects to …", "what depends on …", "what's the FK path")
- Disambiguating a decision ("which entity does this decision affect")
- Finding nearby context ("what's 1–2 hops from this concept")
- Skill routing when the match isn't obvious from the skill name

**When to prefer flat files:**
- Human-readable summaries (`facts.md`)
- Recent-event chronology (`activity.md`)
- Prose decision rationale (`decisions.md`)

**Rebuild:** automatic after every `compliance` (hooks: compliance → facts.md → activity.md → graph.json). Also run manually via `./master.sh memory graph build` after bulk changes (new entity declarations, multiple decisions in one session).

## Commands (short reference)

```bash
./master.sh memory init                             # create the directory + templates (idempotent)
./master.sh memory show                             # dump every file to stdout
./master.sh memory refresh                          # regenerate facts.md from current config

./master.sh memory add-decision "Use Fly.io" --why "Simpler than k8s for our team size"
./master.sh memory add-activity "deploy: staging OK" --detail "v1.3.2 at 14:02"
./master.sh memory prefer package-manager pnpm
./master.sh memory prefer deploy-target fly
./master.sh memory record-skill configure-database
./master.sh memory add-fault "Self-referral guard rejected all conversions" \
  --severity High --files "tracking/attribution.ts" --commit "reverted b702b899" \
  --symptom "no commission; dashboard not updating" \
  --cause "guard rejected whole conversion when buyer==affiliate (single-account demo)" \
  --fix "removed blanket reject" \
  --guard "zero only affiliate commission, keep conversion; verify the single-account flow before deploy"
```

## When memory replaces work

| Without memory | With memory |
|----------------|-------------|
| Agent re-reads `system.yaml`, counts entities, inspects compliance every session | `facts.md` tells it in 20 lines |
| User re-explains "we use pnpm" every new chat | `preferences.md` surfaces at start |
| Agent re-derives which skill to fire for a DB question | `skill-affinity.md` shows `configure-database` in the top 3 |
| Team re-debates "why did we pick postgres?" | `decisions.md` has the answer from the day it was made |
| Agent repeats a failed generator sequence the user said not to | `activity.md` has the recent failure logged |

## Integration with `orchestration_policy.mdc`

The policy's **§0.5 Memory** instructs every agent to read `.auto_system/memory/facts.md` (always) and `skill-affinity.md` + `preferences.md` (first-turn) before any Tier A / Tier B work. This runs **after** `MASTER.md` / `CLAUDE.md` / `AGENTS.md` load and **before** classification — it's the cheapest way to narrow the search space.

## Output format when applying memory changes

1. **Commands run** — one line per `memory` invocation
2. **Files touched** — which of the 5 files changed
3. **What the agent now knows** — a one-line summary of what's remembered that wasn't before
4. **Rule stack** — `.cursorrules → orchestration_policy.mdc → use-memory/SKILL.md → AGENT_GUIDE.md`

## Ready-to-paste: session-start boilerplate (for agent prompts)

```
Read `.auto_system/memory/facts.md` first. If skill routing is ambiguous,
read `.auto_system/memory/skill-affinity.md`. For stable conventions, read
`.auto_system/memory/preferences.md`. Only consult `decisions.md` when a
design choice is being questioned. After any meaningful action, record
it via `./master.sh memory …` — never hand-edit the files.
```

## Troubleshooting

- **`facts.md` is empty** — run `./master.sh memory refresh` (or any `./master.sh compliance`, which hooks it automatically)
- **`preferences.md` not honored** — the key may be wrong; agent reads by the exact key in backticks
- **`activity.md` is polluted with noise** — trim to last 100 happens automatically; if it still feels noisy, stop calling `add-activity` for transient events — it's for the journal, not a log
- **Contradicting decisions** — newer decision wins. Add the new one rather than deleting the old; the log is the audit trail.

## Hand-off

- DB decisions are usually questions for → `configure-database`
- Auth trade-offs usually belong in → `configure-auth` with a memory decision recording the why
- Deploy-target preference lands in memory; details in → `deploy-prod`
