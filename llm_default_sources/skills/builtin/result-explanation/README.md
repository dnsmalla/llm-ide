# Result Explanation

Sibling of `iis-summarization`: that skill explains why a model is
**infeasible**; this one explains why a *solved* model's **result is what it
is** — which constraints pin each output value, which input Excel cells those
limits come from, and whether the output files actually satisfy the model.

## Design

Token-efficiency contract: **code does the work, the LLM narrates.**

```
[.lp/.mps] + [input .xlsx] + [output .xlsx / .sol]
   |
   v  load model (no solve)                      model_loader.py
   v  read reported solution from files          solution_reader.py
   |     .sol > exact Excel match > fuzzy match > (fallback/--resolve) solve
   v  algebraic binding analysis + consistency   binding.py
   v  objective breakdown by variable family     objective.py
   v  trace RHS/bounds to input cells            provenance.py
   v  optional re-solve for duals/RC             sensitivity.py
   v  compact facts.json + report template       facts.py / report_generator.py
   |
   v  summarizer subagent reads ONLY facts.json  agents/summarizer.md
   v  Verdict / Why / What-Would-Change-It spliced into the report
```

Key ideas:

- **No solve needed by default.** Binding constraints are computed
  algebraically by plugging the reported solution into the LP. Violated
  constraints are a first-class finding: they mean the output files don't
  match the model.
- **Provenance by value matching.** Every distinctive number in the input
  workbooks is indexed; binding RHS values and active bounds are looked up so
  the explanation can cite `input.xlsx › Capacity!B3`.
- **`--resolve` upgrades the answer** with shadow prices, reduced costs, and
  an optimality gap for the reported solution (MIPs: duals via the fixed
  model). The duals come from Gurobi's optimum; when the reported solution is
  *not* that optimum the facts flag it (`reported_is_optimal` /
  `duals_describe_reported`) so the narrative does not over-claim. Each binding
  constraint also carries a sign-correct `raising_rhs_improves_objective`.
- **Robust & encoding-safe I/O.** All workbook/.sol reads go through
  `safe_io`: a bad (corrupt / locked / non-XLSX) file is skipped with a
  warning, CP932 / Shift-JIS `.sol` files are transcoded, and tokenization is
  Unicode-aware so Japanese sheet/column names are not dropped.
- **facts.json is capped** (top-k drivers, ≤5 binding constraints each, ≤15
  other binding constraints, ≤3 provenance cells per number) so the
  summarizer's input stays at a few KB regardless of model size.

## Quick start

```bash
PYTHONPATH=src python -m result_explanation model.lp \
  --input-excel input.xlsx --output-excel output.xlsx \
  --focus prod --resolve
```

Outputs land in `<lp_dir>/result_explanation/`:
`<model>_facts.json` and `<model>_result_explanation.md`.

## Tests

```bash
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python -m pytest tests/ -p no:cacheprovider
```
