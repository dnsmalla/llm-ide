---
name: solve-tuning
description: >-
  Explain a Gurobi solver log in plain language and recommend parameter or
  formulation changes to make a model solve faster, prove optimality, or behave
  numerically. A Python engine parses the log (no solver needed), flags the
  coefficient-range / numerical-conditioning issues and any Warning lines, reads
  the termination status / gap / work units, and maps each problem to concrete
  gurobipy parameter levers (NumericFocus, ScaleFlag, MIPGap, MIPFocus, Cuts,
  Heuristics, Presolve, Method, Threads, Symmetry). When the model file (.lp /
  .mps) is also given it classifies the model (LP / MILP / QP / MIQP / QCP /
  MIQCP / MINLP), judges whether it is linear, and suggests linearizations
  (max/min/abs/and/or/indicator, bilinear & binary products) and size/speed
  reductions (tighten big-M, sparsify dense rows, drop redundancy) to move it
  toward the faster LP/MILP class. A summarizer subagent writes Verdict / Why /
  What-To-Change. Trigger on: "read / explain this Gurobi log", "what does this
  log mean", "why is my model slow", "why is solving so slow", "Gurobi warning",
  "large matrix coefficient range", "numerical issues / unstable", "hitting the
  time limit", "large MIP gap", "how do I make Gurobi solve faster / better /
  more optimal", "is my model linear", "how do I linearize this", "make the
  model smaller / faster", "which parameters should I change", "tune my model",
  or Japanese phrasings such as ログを説明 / 遅い / 警告 / 数値が不安定 /
  線形化 / モデルを小さく / チューニング / パラメータ. Use whenever the user
  supplies or mentions a Gurobi log (`*.log`, gurobi.log) and/or a model file
  and wants it interpreted or wants to improve the solve. Not for explaining WHY
  a feasible result took its values (use result-explanation) and not for
  diagnosing an INFEASIBLE model (use iis-summarization).
---

# Solve-Tuning Skill

Two-stage diagnostic, same shape as the `result-explanation` and
`iis-summarization` skills. Python does ALL the analysis and emits a compact
`facts.json`; a summarizer subagent turns those facts into prose; the
orchestrator splices the prose into the report. The LLM never reads the raw log
— that is what keeps token usage low and the numbers exact.

See `README.md` for design, `agents/summarizer.md` for the subagent prompt.

---

## Orchestration

When invoked with a Gurobi log, execute these steps in order. `<skill-root>` is
the folder containing this SKILL.md.

### Step 0 — Locate the log

The user may give a `*.log` path directly, or point at a run folder. Gurobi
logs are commonly written as `gurobi.log`, `<model>.log`, or under a run's
`debug/<step>/` or `output/` folder. Pick the log for the step the question is
about. The engine reads only that one text file.

### Step 1 — Python engine

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=<skill-root>/src \
python -m solve_tuning <path/to/gurobi.log> [--lp <model.lp|.mps>] \
  [--baseline <earlier.log>] [--lang auto|en|ja]
```

- **Pass `--lp <model.lp/.mps>` whenever the user provides the model file.** It
  adds, beyond the log: the *exact* coefficient ranges (the log only prints
  rounded ones) and WHICH constraint/variable carries the extreme coefficients;
  the **model class** (LP / MILP / QP / MIQP / QCP / MIQCP / MINLP) and whether
  it is linear; a breakdown of general-constraint types; and **linearization +
  size-reduction suggestions** (each general-constraint type, quadratic/bilinear
  terms, dense rows, loose big-M, oversized formulation). Reading the model
  needs `gurobipy` (and a license); if it is missing the engine logs a warning
  and continues log-only.
- For the log itself, no solver license and no `gurobipy` are needed — the
  engine parses text.
- **Pass `--baseline <earlier.log>`** to compare two runs (e.g. before/after a
  parameter change): the report gains a baseline-vs-current table (gap, runtime,
  nodes, status) showing whether the change helped.
- When the log shows a time-limit stop, the engine reads the node-log time
  series to decide whether the **incumbent** or the **dual bound** stalled and
  recommends the matching `MIPFocus` direction — no hedging.
- Confidently-recommended parameters are also written as a ready-to-load
  `<log>_recommended.prm` next to the report, and shown as a `model.setParam(…)`
  snippet in it.
- The report language auto-detects from the OS locale (`--lang auto`, default);
  pass `--lang ja` / `--lang en` to force it. The resolved language is written
  to `facts.json` as `meta.language` so the summarizer matches it.
- Do not pass `--output-dir` unless the user asks: the report lands in
  `solve_tuning/` under the run's nearest `debug/` ancestor, else
  `solve_tuning_report/` next to the log.

After it returns, the output directory contains:

- `<log>_log_facts.json` — compact facts for the summarizer (a few KB).
- `<log>_solve_tuning.md` — the report. The narrative summary sits between the
  `<!-- solve-tuning:summary:start -->` / `…:summary:end -->` markers
  (placeholder on first run); the deterministic technical sections (comparison,
  log overview, model structure, coefficient ranges, warnings, findings,
  apply-these-settings, presolve, non-default parameters) live in a collapsible
  `<details>` block.
- `<log>_recommended.prm` — present when there are confident parameter
  recommendations; a Gurobi parameter file the user can load directly.

### Step 2 — Summarizer subagent

1. `Read` the prompt at `<skill-root>/agents/summarizer.md`. Take everything
   after the `---` separator as the prompt body.
2. Spawn `Agent(subagent_type="general-purpose", prompt=<body>)` where `<body>`
   is that prompt followed by:

   ```
   ---

   ## This invocation

   Facts file (read this): <absolute path to *_log_facts.json>
   User's question, verbatim: <the user's original question>
   ```

   Never point the subagent at the raw `.log` — the facts file already contains
   every number the prose needs.

The subagent returns a string starting with `## Verdict` containing exactly
three sections: `## Verdict`, `## Why`, `## What To Change`, in the report
language (`meta.language`).

### Step 3 — Splice the agent output

Replace the report's summary region — everything **between** the markers
`<!-- solve-tuning:summary:start -->` and `<!-- solve-tuning:summary:end -->` —
with the agent's output. On a first run the region holds a placeholder line;
`Edit` it to the agent's three sections. On a re-run the engine carries the
previously spliced summary forward (see *Summary persistence*); `Read` the
report and `Edit` so everything between the two markers becomes the new three
sections.

### Summary persistence

`write_outputs` regenerates the technical sections on every run but carries
forward the already-spliced summary between the markers if the report exists, so
a bare CLI re-run never wipes the narrative. A localized one-line note records
that the summary came from a prior run; it is stripped on extraction so repeated
re-runs never stack duplicate notes.

Reply to the user with **only the report path** — `Report written to <path>`.
The file is the deliverable; chat stays short.

## Routing — when NOT to use this skill

- **Infeasible model** ("no solution exists", 実行不可能): use
  `iis-summarization`. This skill will note infeasibility but cannot tune a
  model into feasibility.
- **"Why did the optimizer choose these values"** on a solved model: use
  `result-explanation` (binding constraints, provenance, objective breakdown).
- This skill is about the *solve itself* — speed, optimality, numerical health.

## Do not

- Rewrite the agent's output. It is already final.
- Read the raw `.log` yourself to "add color" — the facts file is the contract.
- Recommend performance tuning before numerical issues are addressed: tuning a
  numerically unreliable model is premature (the summarizer already orders
  critical numerical findings first — keep that order).

---

## Direct CLI use (bypasses this skill)

`python -m solve_tuning <log>` runs the full deterministic pipeline and produces
the report with the placeholder still in place. Useful flags: `--lang`,
`--output-dir`, `--log-level DEBUG`.

Notes for operators:
- Coefficient-range thresholds follow Gurobi's guidance (verified against the
  Gurobi knowledge base): matrix ratio ≤1e6 ideal, 1e6–1e9 monitor, 1e9–1e12
  numerical risk, >1e12 high risk. The engine computes the ratio itself, so it
  flags a wide range even when the Gurobi version did not print a warning.
- Any literal `Warning:` line in the log is captured verbatim and surfaced.
- Parser fields are all best-effort: logs vary by version and algorithm, so a
  missing field is `None`, never an error.
