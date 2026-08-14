# Large Model Fast Filter Pipeline — Design Spec

**Date:** 2026-05-28  
**Status:** Approved  
**Scope:** `iis-summarization` skill — new pipeline for LP/ILP files with 10,000+ line models

---

## Problem

For large LP models (10,000+ constraints), the existing Chinneck deletion filter runs O(N)
Gurobi feasibility solves — one per IIS constraint. A 10,000-constraint IIS requires ~10,005
total solver calls, taking potentially hours. The summarizer subagent cannot work on a 10,000-
constraint IIS anyway (LLM context limits); the pipeline needs to narrow to a small true root
cause regardless.

**Goal:** Reduce solver calls from O(N) to O(k·log(n/k)) where k = true minimal IIS size
(typically 2–20) and n = filtered candidate set (typically 5–50). Target: < 60 solver calls
for any model size.

---

## Research Basis

Based on web research into Chinneck (1991), Guieu & Chinneck (1999), Junker QuickXplain (2004),
G-CSEA (2025), FICO Xpress infeasibility docs, and Gurobi official documentation.

Key insight: commercial solvers (Xpress, CPLEX) use a 3-stage pipeline internally:
1. Farkas dual certificate (0 extra calls) → drops 60–80% of constraints
2. Elastic filter / FeasRelax (1 LP solve) → drops remaining to ~5–50 candidates
3. QuickXplain divide-and-conquer → O(log n) calls to find minimal IIS

This pipeline reduces 10,000 solves to ~35–60 regardless of model size.

---

## Architecture

### Routing Logic

```
|IIS| < 20          → existing BatchRefiner (fast path, unchanged)
20 ≤ |IIS| ≤ 200    → existing DeletionFilter (Chinneck, unchanged)
|IIS| > 200         → NEW: LargeModelFilter (automatic)
any size + --fast-mode → NEW: LargeModelFilter (forced)
```

The threshold (default 200) is configurable via `--large-model-threshold N`.

### Output Contract

`LargeModelFilter.minimize()` returns a `DeletionFilterResult` — the same dataclass as
`DeletionFilter.minimize()`. The rest of the pipeline (classifier, relaxation, summarizer)
is completely unchanged.

---

## New Modules

### `src/iis_summarization/large_model_filter.py` (~250 lines)

Main orchestrator. Implements `ILargeModelFilter` (extends existing interface pattern).

Runs 5 phases in sequence. Short-circuits after any phase if candidate set drops below 20:

```
Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5
  │          │         │         │         │
rule-base  Farkas   elastic  QuickX-    verify
(0 calls)  filter  filter   plain     minimal
           (0)     (1 call)  (O(log))
```

If Phase 3 produces 0 candidates (degenerate), falls back to full Chinneck on original IIS.
If QuickXplain result fails `verify_subset_infeasible()`, falls back to Chinneck on candidates.

**Key method:**
```python
class LargeModelFilter(ILargeModelFilter):
    def minimize(
        self,
        lp_file: Path,
        iis_constraint_names: list[str],
        feasibility_timeout: int,
        budget_seconds: float | None = None,
    ) -> DeletionFilterResult: ...
```

Internal phase methods:
- `_phase1_rule_based(names, lp_file) -> list[str]`  
  Bound propagation + trivial RHS check. Returns confirmed-essential names (short-circuits
  to result) and filtered candidates. O(nnz), no Gurobi.
- `_phase2_farkas(names, model) -> list[str]`  
  Extract `constr.FarkasDual` from already-solved model. Returns names where
  `abs(FarkasDual) > 1e-8`. Graceful fallback if attribute unavailable.
- `_phase3_elastic(names, lp_file, timeout) -> list[str]`  
  FeasRelax with L1 norm (`relaxobjtype=0`, `minrelax=True`, objective zeroed out).
  Returns constraints where `ArtP_<name>` or `ArtN_<name>` > 1e-9.
- `_phase4_quickxplain(candidates, lp_file, timeout) -> list[str]`  
  Calls `QuickXplain.find_iis()`.
- `_phase5_verify(result_names, lp_file) -> bool`  
  Calls existing `verify_subset_infeasible()`. Falls back to Chinneck if False.

---

### `src/iis_summarization/quickxplain.py` (~100 lines)

Pure implementation of Junker (2004) divide-and-conquer IIS algorithm.

```python
class QuickXplain:
    @staticmethod
    def find_iis(
        lp_file: Path,
        candidates: list[str],
        timeout: int,
        gp: object,
        GRB: object,
    ) -> list[str]:
        """Return minimal IIS subset of candidates."""
```

Algorithm:
```
find_iis(C, background=∅):
    if is_infeasible(background ∪ C) is False: return []
    if |C| == 1: return C
    split C into C1, C2 (by index)
    D2 = find_iis(C2, background ∪ C1)
    D1 = find_iis(C1, background ∪ D2)
    return D1 ∪ D2
```

Implementation detail: each `is_infeasible()` call uses `base_model.copy()` then removes
all constraints not in `background ∪ C`, exactly like `DeletionFilter`. Warm-start is
implicit via Gurobi's presolve.

Complexity: O(k · log(n/k)) feasibility tests where k = |IIS|, n = |candidates|.
For k=5, n=50: ~30 tests. For k=10, n=50: ~50 tests.

---

### `src/iis_summarization/farkas_filter.py` (~60 lines)

```python
def extract_farkas_candidates(
    model: object,          # Gurobi model after infeasible optimize()
    iis_names: list[str],
    tolerance: float = 1e-8,
) -> list[str]:
    """Return constraint names with non-zero FarkasDual multiplier."""
```

- Reads `constr.FarkasDual` for each constraint in `iis_names`
- Returns names where `abs(dual) > tolerance`
- If no duals available (old Gurobi, or model was not LP-solved): returns `iis_names` unchanged
- Logs coverage: "Farkas filter: kept N/M constraints (X% reduction)"

---

### Changes to existing files

**`interfaces.py`** — add:
```python
class ILargeModelFilter(Protocol):
    def minimize(self, lp_file, iis_constraint_names, feasibility_timeout,
                 budget_seconds=None) -> DeletionFilterResult: ...
```

**`models.py`** — extend `DeletionFilterResult`:
```python
large_model_pipeline_used: bool = False
phases_run: list[str] = field(default_factory=list)
# e.g. ["rule_based", "farkas", "elastic", "quickxplain", "verify"]
candidate_sizes: dict[str, int] = field(default_factory=dict)
# e.g. {"after_rule_based": 8500, "after_farkas": 3200, "after_elastic": 47, "final": 5}
```

**`analyzer.py`** — update routing logic in `_step4_chinneck()`:
```python
if opts.large_model_mode or len(iis_names) > opts.large_model_threshold:
    filter_cls = LargeModelFilter
else:
    filter_cls = DeletionFilter
result = filter_cls.create().minimize(...)
```

**`cli.py`** — add flags:
```
--fast-mode            Force large-model pipeline regardless of IIS size
--large-model-threshold N   Threshold for auto-routing (default: 200)
```

**`SKILL.md`** — document new flags in the `iis-analyze` CLI section.

---

## Phase 1 Rule-Based Pre-filter Details

For each constraint in the IIS (using already-loaded model variables):

| Rule | Check | Action |
|------|-------|--------|
| Trivial DATA — `<=` | `lhs_min > RHS + eps` | Mark as definitely-essential |
| Trivial DATA — `>=` | `lhs_max < RHS - eps` | Mark as definitely-essential |
| Trivial DATA — `=`  | `RHS not in [lhs_min, lhs_max]` | Mark as definitely-essential |
| Variable bound cross | `v.LB > v.UB + eps` | Flag variable; mark constraint essential |
| Free variable in equality | All coefficients can be ±∞ | Skip (indeterminate) |

Definitely-essential constraints are passed directly to output (they must be in any IIS).
Remaining constraints become candidates for Phases 2–4.

If all constraints are definitely-essential (all DATA), skip Phases 2–4, return immediately.

---

## Fallback Behavior

| Scenario | Fallback |
|----------|---------|
| Phase 3 elastic returns 0 candidates | Run Chinneck on original IIS names |
| Phase 4 QuickXplain result is feasible | Run Chinneck on Phase 3 candidates |
| Gurobi FarkasDual not available | Skip Phase 2, proceed to Phase 3 |
| Budget exhausted mid-Phase 4 | Return partial QuickXplain result with `success=True`, note in `error_message` |
| Any GurobiError | Log, return `DeletionFilterResult(success=False, error_message=...)` |

---

## Performance Targets

| IIS size | Solver calls (current) | Solver calls (new) | Speedup |
|----------|----------------------|-------------------|---------|
| 200 | ~200 | ~40 | 5× |
| 1,000 | ~1,000 | ~45 | 22× |
| 10,000 | ~10,000 | ~50 | 200× |
| 100,000 | ~hours | ~60 | >1000× |

---

## CLI Usage

```bash
# Auto-routing (activates when |IIS| > 200)
iis-analyze model.lp

# Force fast pipeline on any model size
iis-analyze model.lp --fast-mode

# Custom threshold
iis-analyze model.lp --large-model-threshold 50

# Combined with agent-mode
iis-analyze model.lp --agent-mode --fast-mode

# Pre-computed IIS + fast mode
iis-analyze model.lp --ilp model_iis.ilp --fast-mode
```

---

## Testing Strategy

| Test | Purpose | Pass criterion |
|------|---------|----------------|
| `test_farkas_filter.py` | Unit: Farkas extraction on tiny infeasible LP | Returns subset of IIS names |
| `test_quickxplain.py` | Unit: QuickXplain on 3-constraint IIS | Returns exact same 3 constraints |
| `test_large_model_filter.py` | Integration: 500-constraint synthetic LP, true IIS = 3 | < 60 solver calls, correct IIS |
| `test_fast_mode_correctness.py` | Correctness: `--fast-mode` on `tiny_infeasible.lp` produces same IIS as Chinneck | IIS names match |
| `test_fallback.py` | Fallback: elastic returns 0 candidates → Chinneck runs | `success=True`, valid IIS |
| `test_phases_run_field.py` | Metadata: `phases_run` list populated correctly | List contains executed phase names |

---

## Files Created / Modified

**New files:**
- `src/iis_summarization/large_model_filter.py`
- `src/iis_summarization/quickxplain.py`
- `src/iis_summarization/farkas_filter.py`
- `tests/test_farkas_filter.py`
- `tests/test_quickxplain.py`
- `tests/test_large_model_filter.py`

**Modified files:**
- `src/iis_summarization/interfaces.py` — add `ILargeModelFilter`
- `src/iis_summarization/models.py` — extend `DeletionFilterResult`
- `src/iis_summarization/analyzer.py` — routing logic
- `src/iis_summarization/cli.py` — `--fast-mode`, `--large-model-threshold`
- `SKILL.md` — document new CLI flags
