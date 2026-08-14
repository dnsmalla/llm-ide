# Solve-Tuning

Sibling of `result-explanation` and `iis-summarization`. Those explain *why a
result took its values* and *why a model is infeasible*; this one explains
**how the solve itself went** — reading a Gurobi log, flagging numerical and
performance problems, and recommending concrete parameter / formulation changes
to solve faster, prove optimality, or behave numerically.

When the model file (`--lp`) is supplied it also **classifies the model**
(LP / MILP / QP / MIQP / QCP / MIQCP / MINLP), judges whether it is linear, and
advises how to **linearize** the nonlinear/logical parts (max/min/abs/and/or,
indicators, bilinear & binary products) and **shrink** the model (tighten
big-M, sparsify dense rows, drop redundancy) — moving it toward the faster
LP/MILP class.

## Design

Token-efficiency contract: **code does the work, the LLM narrates.**

```
[gurobi .log]
   |
   v  encoding-safe text read              safe_io.py
   v  regex parse (no solver needed)        log_parser.py
   v  assess: ratios, warnings, status      assessment.py
   v  map symptoms -> parameter levers       recommendations.py
   v  compact facts.json + report template  facts.py / report_generator.py
   |
   v  summarizer subagent reads ONLY facts.json   agents/summarizer.md
   v  Verdict / Why / What-To-Change spliced into the report
```

Key ideas:

- **No solver, no gurobipy.** A log is text produced on some other machine; the
  engine just reads it. The package has zero runtime dependencies.
- **Thresholds are computed, not trusted to the log.** The matrix coefficient
  range ratio is computed and flagged (≤1e6 ideal, 1e6–1e9 monitor, 1e9–1e12
  risk, >1e12 high risk) even when the Gurobi version printed no warning. Any
  literal `Warning:` line is also surfaced verbatim.
- **Findings carry levers.** Each finding maps to concrete gurobipy parameters
  (`NumericFocus`, `ScaleFlag`, `MIPGap`, `MIPFocus`, `Cuts`, `Heuristics`,
  `Presolve`, `Method`, `Threads`, `Symmetry`) with a direction and a reason —
  encoded from Gurobi's documented parameter guidelines.
- **Numerical before performance.** A model under numerical risk is fixed first;
  tuning an unreliable model is premature.

## Quick start

```bash
PYTHONPATH=src python -m solve_tuning gurobi.log --lang en
```

Outputs land in `<debug>/solve_tuning/` (or `solve_tuning_report/` next to the
log): `<log>_log_facts.json` and `<log>_solve_tuning.md`.

## Tests

```bash
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 PYTHONPATH=src python -m pytest tests/ -p no:cacheprovider
```

Fixtures under `tests/fixtures/` are real Gurobi logs (optimal, node-log with a
Markowitz warning) plus a crafted time-limit-with-coefficient-warning log.
