---
name: iis-summarization
description: >-
  Diagnose an infeasible Gurobi .lp / .mps / .ilp model and produce a
  plain-language report (English or Japanese) naming constraints that conflict
  and what input changes restore feasibility. Trigger on: "model is infeasible",
  "IIS analysis", "debug this LP", "find the infeasibility", "why won't my LP
  solve", "no result / no solution", "optimization failed", "which constraints
  conflict", or Japanese: 実行不可能 / インフィージブル / 解が出ない / 最適化が失敗. Even if the user
  never says "IIS", use this immediately when a .lp/.mps/.ilp file accompanies
  any infeasibility or no-solution question. Not for feasible models — use
  result-explanation for "why is the output like this".
---

# IIS Summarization Skill

Two-stage diagnostic. Python runs Gurobi's `computeIIS` and emits a
reduced IIS plus a small agent-context file. A bundled subagent turns
those two files into Root Cause / Background / Alternatives prose. The
orchestrator splices the prose into the report via a script and returns
the report path. The orchestrator never reads the report, the `.lp`, or
the `.ilp` itself — that is what keeps token usage low.

Reference docs (do NOT read during normal orchestration):
`README.md` (design), `FLOWCHART.md` (data flow),
`docs/gurobi-notes.md` (Gurobi best practices baked into the engine,
deployment/license notes, full CLI flag examples),
`agents/summarizer.md` (subagent prompt — read only in Step 2).

---

## Orchestration

When invoked with a `.lp` / `.mps` / `.ilp` argument, execute these
three steps in order. `<skill-root>` is the folder containing this
SKILL.md.

### Step 1 — Python engine

If the argument is a `.ilp`, pass it as `--ilp` and use the paired
`.lp` (same stem) as the positional argument. Run:

```bash
iis-analyze <path/to/model.lp> [--ilp <path/to/model.ilp>] --agent-mode
```

- Do not pass `--output-dir` unless the user asks: everything lands in
  `iis_summary/` next to the model file.
- `--agent-mode` runs the fast path (compute IIS → parse → Chinneck
  reduction with early exit; plus the cheap diagnostic steps) and logs
  at WARNING, so a healthy run prints almost nothing but the report
  path. Reduction knobs if needed: `--reduce-target N` (default 100
  constraints), `--reduce-budget SEC` (default 600).
- Large models: add `--fast-mode` (10k+ constraints). Daily reruns:
  `--seed-ilp <yesterday_iis.ilp>`. Details in `docs/gurobi-notes.md`.

The output directory then contains (`<stem>` = model filename stem):

- `<stem>_iis_reduced.ilp` — reduced IIS for the subagent (falls back
  to `<stem>_iis.ilp` if no reduced file was needed).
- `<stem>_agent_context.txt` — classifier labels, default-LB warnings,
  root-cause hint, and the report `language:` — everything the
  subagent needs besides the IIS. Do not open it yourself; pass the
  path.
- `<stem>_infeasibility_report.md` — report with the narrative
  placeholder still in place.

### Step 2 — Summarizer subagent

1. `Read` `<skill-root>/agents/summarizer.md`; take everything after
   the `---` separator as the prompt body.
2. Spawn `Agent(subagent_type="general-purpose", prompt=<body>)` with
   this appended:

   ```
   ---

   ## This invocation

   Reduced IIS file (read this): <abs path to *_iis_reduced.ilp, else *_iis.ilp>
   Agent context file (read this too — classifier labels, default-LB
   warnings, root-cause hint): <abs path to *_agent_context.txt>
   Original LP file (do not read unless you must cross-check one
   coefficient): <abs path to *.lp>

   If the context file says `language: ja`, write your three sections
   in Japanese (技術用語と制約名はそのまま). Produce only the three
   required sections per the instructions above.
   ```

The subagent returns Markdown starting with `## Root Cause` containing
exactly `## Root Cause`, `## Background`, `## Alternatives` (the last
may be omitted).

### Step 3 — Splice and reply

1. `Write` the subagent's output verbatim to
   `<output-dir>/<stem>_narrative.md`.
2. Run:

   ```bash
   python <skill-root>/scripts/splice.py \
     <output-dir>/<stem>_infeasibility_report.md \
     <output-dir>/<stem>_narrative.md
   ```

   The script replaces the stable placeholder line and prints the
   report path. (Do not use Read + Edit on the report — that loads the
   whole report into context for no benefit.)
3. Reply to the user with **only** `Report written to <path>` — no
   summary, no excerpt, no follow-up suggestions. The file is the
   deliverable; chat must stay short.

---

## Do not

- Rewrite the agent's output. It is already in final form.
- Run `iis-analyze` without `--agent-mode` unless the user explicitly
  asks for numeric relaxation amounts (feasRelax) — the other steps
  are slow and the agent does not use their output.
- Read the report, the `.lp`, or any `.ilp` into your own context.
  Step 1's stdout, the two paths you pass in Step 2, and the splice
  script are all you need.
- Mention free-variable fixes. A variable declared `free` in the
  `.ilp` Bounds section is not the root cause — the agent's prompt
  already enforces this; don't re-introduce it in your own text.
- Use this skill on a model that solves fine — "why is my RESULT like
  this" questions route to the `result-explanation` skill instead.
