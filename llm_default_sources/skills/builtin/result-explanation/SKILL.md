---
name: result-explanation
description: >-
  Explain WHY a finished optimization run produced its result. Given the solved
  .lp / .mps model plus input/output Excel files (or .sol), find binding
  constraints, trace inputs that pin each output, break down the objective.
  Trigger on: "why is the output like this", "why did the optimizer choose X",
  "why is production only N", "explain this result", "is this correct given the
  inputs", or the user supplies a run's lp + input/output files asking what
  drove the numbers — even if they never say "binding constraint" or "dual".
  ALSO trigger whenever the user points at a run's input file(s) AND output /
  result file(s) — including an input folder + output folder, or a "result vs
  verification" (結果 vs 検証) / KPI・サマリ comparison — and asks to explain,
  check, or verify any number in them. The user need NOT name the .lp/.sol: the
  solved model lives in the run's `debug/<step>/*_model.lp` and its solution in
  `output/sol/*.sol`; locate them from the provided folders (see Orchestration).
  Also trigger when the question compares two runs/formulations of the same
  model: "why does run B differ from run A", "why did strict drop X to 0 when
  simple gave Y", "what makes this version produce a different result" — the
  user supplies two .lp files. Not for infeasible models (use
  iis-summarization for those).
---

# Result Explanation Skill

Two-stage diagnostic, same shape as `iis-summarization`. Python does ALL the
analysis and emits a compact `facts.json`; a summarizer subagent turns those
facts into prose; the orchestrator splices the prose into the report. The LLM
never reads the LP or the Excel files — that is what keeps token usage low.

See `README.md` for design, `agents/summarizer.md` for the subagent prompt.

---

## Orchestration

When invoked with an `.lp` / `.mps` model plus input/output files, execute
these three steps in order. `<skill-root>` is the folder containing this
SKILL.md.

### Step 0 — Locate the model when only folders are given

Often the user points at an input folder and an output folder (or a 結果/検証
pair) without naming the `.lp`. Resolve the run's artifacts from those folders
before Step 1:

- **Model `.lp`** — under the run root's `debug/<step>/<step>_model.lp` (e.g.
  `debug/step3_simple/step3_simple_model.lp`). Pick the step the question is
  about; "揚水 / pump" questions are usually `step3_simple`.
- **Solution `.sol`** — under `output/sol/<step>_model.sol`. Always pass it via
  `--sol`; it is the most reliable solution source.
- **Inputs** — every `*.xlsx` in the input folder (e.g. `input/all_input/`) →
  `--input-excel`.
- **Outputs** — the result workbooks in the output folder (KPI・サマリ結果, 水力
  結果, etc.) → `--output-excel`. The 検証 (verification) workbook is the
  baseline the user compares against; pass the 結果 (result) workbook as the
  solution under explanation.

Determine the focus variable from the question (e.g. Niikappu pump → `--focus
v_p_hp NIIKAPPU pump`).

### Step 1 — Python engine

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=<skill-root>/src \
python -m result_explanation <path/to/model.lp> \
  --input-excel <in1.xlsx> [<in2.xlsx> ...] \
  --output-excel <out.xlsx> [...] \
  [--sol <model.sol>] \
  [--focus <var-or-pattern> ...] \
  [--resolve]
```

- Pass every input workbook the user mentions via `--input-excel` and every
  result workbook via `--output-excel`. If a Gurobi `.sol` exists, pass it via
  `--sol` — it is the most reliable solution source.
- If the user's question names specific outputs ("why is production for
  plant 2 so low?"), pass the matching variable names or substrings via
  `--focus` so they are explained in depth (e.g. `--focus prod plant2`).
  Substring and glob matching are both supported.
- Add `--resolve` when the user asks "is this optimal?", "what should I
  change?", or wants quantified levers — it re-solves with Gurobi and adds
  shadow prices, reduced costs, and an optimality gap. Otherwise omit it; the
  default path reads existing files only and needs no solver license time.
- The engine auto-falls back to a solve if it cannot read enough variable
  values from the provided files (coverage < 30%) — that is expected, not an
  error.
- Do not pass `--output-dir` unless the user asks: the report lands in
  `result_explanation/` **directly under the run's `debug/` folder** (the engine
  walks up from the `.lp` to the nearest `debug/` ancestor; e.g.
  `…/mode_all_split/debug/result_explanation/`). Only if there is no `debug/`
  ancestor does it fall back to a `result_explanation/` next to the model.
- The report language is auto-detected from the OS locale (`--lang auto`, the
  default; `LANG`/`LC_ALL` naming Japanese → Japanese report). Pass `--lang ja`
  or `--lang en` to force it. The resolved language is written to
  `facts.json` as `meta.language` so the summarizer matches it.

After it returns, the output directory contains:

- `<model>_facts.json` — compact facts for the summarizer (a few KB), including
  `meta.language`.
- `<model>_result_explanation.md` — the report. The narrative summary sits
  between the `<!-- result-explanation:summary:start -->` /
  `…:summary:end -->` markers (placeholder on first run); all technical sections
  (run summary, consistency, objective, constraint bodies) live inside a
  collapsible `<details>` block below it.

### Step 2 — Summarizer subagent

1. `Read` the prompt at `<skill-root>/agents/summarizer.md`. Take everything
   after the `---` separator as the prompt body.
2. Spawn `Agent(subagent_type="general-purpose", prompt=<body>)` where
   `<body>` is the prompt from (1) followed by:

   ```
   ---

   ## This invocation

   Facts file (read this): <absolute path to *_facts.json>
   Comparison CSV (only for two-model questions; omit otherwise): <lp_family_comparison.csv produced by the lp-compare run in the "Comparative explanation" section above>
   User's question, verbatim: <the user's original question>
   ```

   Pass the facts file path always, and the lp-compare family CSV path **only**
   in comparative mode. Never point the subagent at the `.lp` or the Excel
   files — they can be tens of MB and the facts file already contains every
   number the prose needs.

The subagent returns a string starting with `## Verdict` containing exactly
three sections: `## Verdict`, `## Why`, `## What Would Change It`, written in
the report language (`meta.language` in the facts file).

### Step 3 — Splice the agent output

Replace the report's summary region — everything **between** the markers
`<!-- result-explanation:summary:start -->` and
`<!-- result-explanation:summary:end -->` — with the agent's output. These
markers are stable and language-independent (they do not change when the report
is Japanese or when the technical block is restructured).

- On a **first** run the region holds this placeholder line; `Edit` it to the
  agent's three sections:

  ```
  > Verdict / Why / What-Would-Change-It are produced by the summarizer subagent. Run `/result-explanation <path>` via Claude Code to populate this section. When run from the bare CLI the report contains only this placeholder and the technical details below.
  ```

- On a **re-run** the engine preserves the previously spliced summary (see
  *Summary persistence*), so the region holds the earlier summary plus a
  regeneration note instead of the placeholder. `Read` the report and `Edit` so
  everything between the two markers becomes the agent's new three sections.

### Summary persistence

`write_outputs` (in `report_generator.py`) regenerates the technical sections on
every run but **carries forward the already-spliced summary** between the
markers if the report file already exists. A bare engine re-run (verification,
CLI, `--resolve`) no longer wipes the narrative — only the collapsible technical
block is refreshed, and a one-line note (localized) records that the summary
came from a prior run. The note is stripped on extraction (in any supported
language), so repeated re-runs never stack duplicate notes. A fresh
`/result-explanation` invocation still overrides the summary via the Step 3
splice above.

Reply to the user with **only the report path** — no summary, no excerpt, no
follow-up suggestions. Format: `Report written to <path>`. The file is the
deliverable; chat must stay short.

---

## Comparative explanation — two models ("why does B differ from A")

When the question is about the *difference* between two runs/formulations of
the same model (e.g. `step3_simple` produced 1047 MW but `step3_strict`
produced 0), the single-model engine above cannot see what changed between the
two LPs. Do the structural diff first, then explain.

**REQUIRED SUB-SKILL:** Use `lp-compare` for the LP-to-LP structural diff —
do **not** diff the two `.lp` files by hand. These models are index-heavy
(one constraint per time step), so run it in family mode:

```bash
python <lp-compare-path>/scripts/lp_comparator.py <A.lp> <B.lp> \
  --label1 <A> --label2 <B> --group-families [--filter '<pattern>']
```

Add `--filter` (case-insensitive regex on the family name) when the question
names a subsystem — e.g. `--filter 'pump|_hp'` for pumped-hydro. The output
CSV's `status` column (`only_in_file2` = added in B, `only_in_file1` = removed
in B, `count_differs`, `same`) is the candidate set of constraint families that
could explain the difference.

Then attribute the difference to a specific added constraint:

1. Run **Step 1 (Python engine)** above on the model with the surprising
   result (usually B), with `--focus <the surprising variable>` so its binding
   constraints are explained in depth.
2. Cross the two: the family that is `only_in_file2` in the lp-compare CSV
   **and** appears as a binding constraint in B's `facts.json` is the driver.
   That is the clean answer — "B differs because it adds constraint family
   `X`, which is binding on the focus variable and pins it to its value."
3. Spawn the summarizer (Step 2) with the focus-model facts file, and pass the
   lp-compare CSV path as comparison context (see `agents/summarizer.md`).

Keep the deliverable a single report. Present the structural diff **grouped by
constraint family** (the lp-compare CSV) — never as a raw per-index dump.

## Consistency findings outrank explanation

If the engine reports violated constraints or an objective mismatch
(`consistency.objective_mismatch`), the run's output does not actually match
the model. The summarizer prompt already makes the Verdict lead with that —
do not soften it or reorder it. Explaining an inconsistent result as if it
were valid is the one way this skill can actively mislead.

## Do not

- Rewrite the agent's output. It is already in final form.
- Read the `.lp` or Excel files yourself to "add color" — the facts file is
  the contract, and reading the big files burns the tokens this design saves.
- Run with `--resolve` by default. It costs a full solve; the algebraic path
  answers "why is the result this" without it.
- Use this skill on an INFEASIBLE model — route that to `iis-summarization`.

---

## Direct CLI use (bypasses this skill)

`python -m result_explanation <lp> --input-excel ... --output-excel ...` runs
the full deterministic pipeline and produces the report with the placeholder
still in place. Useful flags: `--focus`, `--resolve`, `--top-k N`,
`--time-limit SEC`, `--log-level DEBUG`.

Notes for operators:
- MIPs: shadow prices come from the fixed model (integers fixed at their
  solution values) — the standard Gurobi recipe; interpret them as marginal
  values *given the integer decisions*.
- Shadow prices/reduced costs come from Gurobi's re-solved **optimum**. When the
  reported solution differs from that optimum (`consistency.reported_is_optimal`
  false / `meta.duals_describe_reported` false), they describe the optimum, not
  the reported point — the report says so rather than over-promising.
- Shadow-price direction is precomputed sign-correctly for the objective sense
  in each binding constraint's `raising_rhs_improves_objective`; the narrator
  uses that flag instead of guessing from the raw `Pi` sign. (Verified against
  Gurobi's documented convention: `Pi = d(obj)/d(RHS)`, sign flips with sense.)
- With `--resolve`, each binding constraint also carries `rhs_valid_range`
  (`[SARHSLow, SARHSUp]`): the shadow price is only the valid derivative while
  the RHS stays inside it. The report shows it inline; the narrator uses it to
  bound "raise this limit" levers.
- Reduced costs are reported **only for continuous variables** — Gurobi warns
  that the fixed-model reduced cost of an integer/binary variable is
  meaningless, so the engine omits it for those.
- Quadratic / SOS / general constraints are counted in the run summary but
  not analyzed for binding-ness in v1; the report says so.
- Provenance matches input cells by value (0, 1, -1 skipped as too common);
  a value appearing in many cells is flagged ambiguous rather than guessed.
  Japanese sheet/row/column labels are reported verbatim.
- Robustness: a corrupt / locked / non-XLSX workbook or a non-UTF-8 (CP932 /
  Shift-JIS) `.sol` is skipped or transcoded with a warning, never a crash; an
  invalid model exits non-zero with a message instead of a traceback.
