# IIS Summarization

Diagnose infeasible Gurobi optimization models and produce **actionable, numeric remediation reports**.

The skill goes beyond a raw IIS list:
- Runs Gurobi's IIS, then verifies it is minimal via Chinneck's deletion filter.
- Groups constraints into independent conflict subsystems by shared variables.
- Classifies each IIS constraint as a **DATA** problem (unreachable given variable bounds) or a **STRUCTURE** problem (reachable in isolation, conflicts with another constraint).
- Quantifies the **minimum RHS adjustment** per constraint via `feasRelax`, so users know by how much to loosen each constraint to restore feasibility.
- Produces a ranked remediation plan with concrete numeric fixes.

See [`FLOWCHART.md`](./FLOWCHART.md) for a visual pipeline diagram and data-contract reference. See [`SKILL.md`](./SKILL.md) for the skill-runner orchestration contract.

---

## Quick start

### Prerequisites

- Python >= 3.10
- Gurobi >= 10.0 with a valid license (`gurobipy` importable). Academic/trial licenses are free from [gurobi.com](https://www.gurobi.com/downloads/).
- An infeasible `.lp` file.

### Install

```bash
# Runtime-only
pip install -r requirements.txt

# With dev tools (pytest, ruff, mypy) — exposes the `iis-analyze` console script
pip install -e .[dev]
```

### Run

```bash
# Full pipeline (after `pip install -e .`)
iis-analyze path/to/model.lp

# Without installing
python -m iis_summarization path/to/model.lp

# Use a pre-computed ILP file (skip Step 1)
iis-analyze path/to/model.lp --ilp model_iis.ilp

# Fast mode — skip classifier, grouping, deletion filter
iis-analyze path/to/model.lp --skip-minimize --skip-classify --skip-grouping
```

Reports land in `<lp_dir>/iis_summary/` by default (override with `--output-dir`).

---

## Example output

Given the tiny infeasible model:

```lp
Minimize  x + y
Subject To
  demand_min:   x + y >= 10
  capacity_max: x + y <= 5
Bounds
  0 <= x <= 100
  0 <= y <= 100
End
```

The skill produces a report that includes:

### Relaxation analysis (the "by how much" answer)

| Constraint | Current RHS | Sense | Min Δ | Suggested New RHS | Direction |
|------------|-------------|-------|-------|-------------------|-----------|
| `demand_min` | 10 | `>=` | 5.0000 | 5 | decrease RHS (or increase LHS contribution) |

### Remediation plan (ranked, actionable)

> 1. **Relax `demand_min` by 5.0000 units** — decrease RHS (or increase LHS contribution)
>    - Current: `demand_min >= 10`
>    - Suggested: `demand_min >= 5`

### Data vs. Structure diagnosis

| Constraint | Type | LHS Range | RHS | Reason |
|------------|------|-----------|-----|--------|
| `demand_min` | **STRUCTURE** | [0, 200] | 10 | LHS reachable >= RHS in isolation — conflict arises from interaction with `capacity_max`. |
| `capacity_max` | **STRUCTURE** | [0, 200] | 5 | LHS reachable <= RHS in isolation — conflict arises from interaction with `demand_min`. |

### Conflict subsystems

> All 2 IIS constraint(s) form **a single connected conflict subsystem** (sharing 2 variable(s)). They must be resolved together.
>
> **Variables involved:** `x`, `y`

---

## Pipeline at a glance

```
[.lp]
  |
  v Step 1  computeIIS -> .ilp
  v Step 2  parse ILP -> ParsedILP
  v Step 3  iterative removal
  v Step 4  Chinneck deletion filter -> minimal IIS
  v Step 5  data vs structure classifier
  v Step 6  semantic grouping (union-find on constraint-variable graph)
  v Step 7  feasRelax -> minimum RHS delta per constraint
  v Step 8  template substitution -> Markdown report
  |
  v
[*_infeasibility_report.md]
```

Full diagrams (Mermaid + ASCII + data contracts) live in [`FLOWCHART.md`](./FLOWCHART.md).

---

## CLI reference

| Flag | Default | Description |
|------|---------|-------------|
| `lp_file` | *required* | Positional argument — path to infeasible `.lp` model |
| `--ilp FILE` | auto | Pre-computed `.ilp` file; skips Step 1 if provided |
| `--output-dir DIR`, `-o` | `<lp_dir>/iis_summary/` | Report + intermediate output directory |
| `--iis-timeout SEC` | 300 | Wall-clock limit for Step 1 |
| `--max-iter N` | 10 | Max iterations for Step 3 |
| `--batch-fraction F` | 0.10 | Fraction of constraints removed per Step 3 iteration |
| `--feasibility-timeout SEC` | 30 | Per-trial Gurobi TimeLimit for Steps 3/4 |
| `--skip-minimize` | off | Skip Chinneck's deletion filter (Step 4) |
| `--skip-classify` | off | Skip DATA/STRUCTURE classification (Step 5) |
| `--skip-grouping` | off | Skip semantic grouping (Step 6) |
| `--log-level` | `INFO` | One of `DEBUG`, `INFO`, `WARNING`, `ERROR` |

---

## Programmatic API

```python
from pathlib import Path
from iis_summarization import Analyzer, run_analysis
from iis_summarization.analyzer import AnalysisOptions

# Functional shortcut
report_path = run_analysis(
    lp_file="production_model.lp",
    output_dir="results/",
    iis_timeout=60,
)
print(f"Report: {report_path}")

# Class-based (dependency-injectable)
analyzer = Analyzer.create()
report_path = analyzer.run(
    lp_file=Path("production_model.lp"),
    output_dir=Path("results/"),
    options=AnalysisOptions(iis_timeout=60, max_iterations=10),
)
```

Each pipeline step can also be called individually. Each module returns a typed dataclass — see the [data-contract table in FLOWCHART.md](./FLOWCHART.md#data-contract-reference).

```python
from iis_summarization import (
    run_iis,
    parse_ilp,
    minimize_iis,
    classify_iis_constraints,
    group_by_shared_variables,
    compute_relaxations,
)

iis = run_iis("model.lp", timeout_seconds=60)
parsed = parse_ilp(iis.ilp_file)
names = list(parsed.constraints.keys())

minimal = minimize_iis("model.lp", names)
diag    = classify_iis_constraints("model.lp", minimal.minimal_iis)
groups  = group_by_shared_variables("model.lp", minimal.minimal_iis)
relax   = compute_relaxations("model.lp", minimal.minimal_iis)

for r in relax.constraint_relaxations:
    print(f"{r.constraint_name}: delta={r.violation:.4f}  {r.direction}")
```

---

## Output files

| File | Description |
|------|-------------|
| `{model}_infeasibility_report.md` | Primary human-readable report (all 8 sections) |
| `{model}_iis.ilp` | Gurobi IIS file (if auto-generated) |
| `iterations/{model}_iter_NN.lp` | Step 3 intermediate LP files |

---

## Project layout

```
iis-summarization/
├── SKILL.md                        Skill-runner orchestration contract
├── README.md                       This file — user-facing overview
├── FLOWCHART.md                    Visual pipeline + data contracts
├── pyproject.toml                  Package metadata, ruff/mypy/pytest config
├── requirements.txt                Runtime deps (gurobipy)
├── src/
│   └── iis_summarization/
│       ├── __init__.py             Public API + __version__
│       ├── __main__.py             python -m iis_summarization
│       ├── cli.py                  iis-analyze console script
│       ├── analyzer.py             Orchestrator (Analyzer + run_analysis)
│       ├── interfaces.py           Abstract base classes for every step
│       ├── models.py               Typed result dataclasses
│       ├── errors.py               Exception hierarchy
│       ├── logging_config.py       configure_logging() helper
│       ├── _gurobi.py              Lazy gurobipy import
│       ├── iis_runner.py           Step 1
│       ├── ilp_parser.py           Step 2
│       ├── feasibility.py          Helper for Steps 3/4
│       ├── constraint_remover.py   Step 3
│       ├── deletion_filter.py      Step 4 (Chinneck)
│       ├── classifier.py           Step 5
│       ├── semantic_groups.py      Step 6
│       ├── relaxation.py           Step 7
│       └── report_generator.py     Step 8
├── templates/
│   └── infeasibility_report.md     string.Template layout
└── tests/
    ├── conftest.py
    ├── fixtures/                   small .lp/.ilp test models
    ├── test_analyzer.py
    ├── test_classifier.py
    ├── test_cli.py
    ├── test_constraint_remover.py
    ├── test_ilp_parser.py
    ├── test_relaxation.py
    ├── test_report_generator.py
    └── test_semantic_groups.py
```

---

## Testing

```bash
# All tests (Gurobi tests auto-skip when gurobipy is missing)
pytest tests/ -v

# Non-Gurobi only
pytest tests/test_ilp_parser.py tests/test_report_generator.py -v

# If your environment has incompatible pytest plugins:
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 pytest tests/ -v
```

---

## Design philosophy

Traditional IIS tools answer *"which constraints are in conflict?"*. That's only part of what an engineer needs. This skill additionally answers:

- *Is this a data problem or a model-structure problem?* → `classifier.py`
- *Are there multiple independent conflicts?* → `semantic_groups.py`
- *By how much does each constraint need to be loosened?* → `relaxation.py`
- *What's the smallest blocking set?* → `deletion_filter.py`

Each of these is a dedicated Gurobi capability (`IIS`, `feasRelax`) or a textbook algorithm (Chinneck 1991, union-find). The skill composes them into a single pipeline and renders a ranked, numeric remediation plan.

Architectural principles:
- **Interfaces first.** Every step has an abstract base class (see `interfaces.py`) and is instantiated through a `.create()` factory. Callers depend on the interface.
- **No project-specific heuristics.** The skill stays domain-neutral; downstream projects layer their own naming conventions and data lookups on top.
- **Structured logging only.** Library code never prints; the CLI configures a single handler via `configure_logging()`.
- **Specific exception handling.** Modules catch `gurobipy.GurobiError`, `FileNotFoundError`, and `OSError` explicitly; pipeline-fatal issues raise `AnalysisAbortedError`.

---

## References

- Chinneck, J. W. (1991). *Localizing and diagnosing infeasibilities in linear programming models.* Computers & Operations Research.
- Gurobi documentation: [IIS Overview](https://www.gurobi.com/documentation/current/refman/iis.html)
- Gurobi documentation: [feasRelax](https://www.gurobi.com/documentation/current/refman/py_model_feasrelax.html)

---

## License

Proprietary. See project owner for terms.
