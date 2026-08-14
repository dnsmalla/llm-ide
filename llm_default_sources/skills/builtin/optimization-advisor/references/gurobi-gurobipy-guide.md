# Gurobi / gurobipy Practical Cookbook

Concrete, code-level guidance for Gurobi's Python API. This complements the conceptual references (`modeling-techniques.md`, `parameter-tuning.md`) with copy-ready `gurobipy` idioms and Gurobi's own decision logic.

> **Source & attribution.** The guidance here is synthesized from Gurobi's official documentation (docs.gurobi.com) and answers from the **Gurobi AI Agent (Intelligence Hub – Modeler)**, then rewritten and cross-checked. Verify parameter names and APIs against your installed Gurobi version — the API evolves. Code/parameter names are factual; the framing is ours.

## Table of Contents

1. [Reading a Gurobi Log](#1-reading-a-gurobi-log)
2. [Conditional Logic: Tight Big-M, Indicators, SOS1](#2-conditional-logic-tight-big-m-indicators-sos1)
3. [Linearizing Products of Variables](#3-linearizing-products-of-variables)
4. [Diagnosing & Fixing a Stalled MIP Gap](#4-diagnosing--fixing-a-stalled-mip-gap)
5. [Soft Constraints & Slack Variables](#5-soft-constraints--slack-variables)
6. [Choosing Penalty Weights & Multi-Objective](#6-choosing-penalty-weights--multi-objective)
7. [Built-in General Constraints: abs / max / min / and / or / if-then](#7-built-in-general-constraints-abs--max--min--and--or--if-then)

> Sections 5-7 are drawn from Gurobi's official documentation and established modeling practice (the AI Agent errored on these prompts at capture time), then cross-checked.

---

## 1. Reading a Gurobi Log

A Gurobi log is a chronological record of the solve. Read it top-to-bottom:

1. **Header** — version, model fingerprint, and size: `Optimize a model with R rows, C columns and N nonzeros` (rows = constraints, columns = variables, nonzeros = constraint-matrix entries).
2. **Coefficient statistics / numerical warnings** — Gurobi prints the ranges of objective, RHS, bounds, and matrix coefficients. Keep them within ~`[1e-6, 1e+06]`; a range wider than `1e+09` triggers `Warning: Model contains large matrix coefficient range` and signals rescaling/reformulation is needed.
3. **Presolve** — `Presolve removed R rows and C columns`. Heavy reduction = the model had redundancy (good); no reduction = already compact.
4. **Root relaxation / LP** — simplex (`Iteration | Objective | Primal Inf | Dual Inf | Time`) or barrier (`Iter | Primal | Dual | Gap | Time`). Gurobi may run primal simplex, dual simplex, and barrier concurrently and keep whichever finishes first.
5. **MIP progress** (branch-and-cut tree) — the dense table:
   ```
   Nodes    | Current Node    | Objective Bounds      | Work
   Expl Unexpl | Obj Depth IntInf | Incumbent BestBd Gap | It/Node Time
   ```
   - **Expl / Unexpl** — nodes explored / still in the tree.
   - **Obj / Depth / IntInf** — current node's LP value, its depth, and how many integer vars are fractional there.
   - **Incumbent / BestBd / Gap** — best feasible solution, best bound from open nodes, and their relative gap (terminates when `< MIPGap`, default 1e-4).
   - **It/Node / Time** — avg simplex iterations per node, elapsed time.
   - Line-start symbols: **`H`** = incumbent found by a heuristic; **`*`** = incumbent found by branching.
   - The node count sitting at **0 for a long time is normal** — Gurobi is working the root (cuts + heuristics) to shrink the tree.
6. **Summary** — cutting planes by type/count, total nodes & simplex iterations, thread count, `Solution count`, `Best objective`, `best bound`, final `gap`.
7. **Status line** — `Optimal solution found`, `Infeasible model`, `Model is unbounded`, `Time limit reached` (always check the gap!), or `Suboptimal solution found`.

**Logging parameters**: `LogFile` (write to file — needed via APIs), `OutputFlag` (0 = silent), `LogToConsole`, `DisplayInterval` (seconds between MIP progress lines).

**Programmatic analysis**: the official **`gurobi-logtools`** package parses/compares/visualizes multiple logs as pandas DataFrames — ideal for tuning and benchmarking sweeps.

(Conceptual cross-ref: `parameter-tuning.md` §2. If the user hands you an actual log, route to the `solve-tuning` skill.)

## 2. Conditional Logic: Tight Big-M, Indicators, SOS1

**Rule:** `M` should be as small as possible while remaining valid. A loose `M` gives a weak LP relaxation, an enormous branch-and-bound tree, large-coefficient warnings, and a gap that won't close.

**Derive M from variable bounds — never an arbitrary `1e9`:**
```python
import gurobipy as gp
from gurobipy import GRB
m = gp.Model()
x = m.addVar(lb=0, ub=500, name="x")
b = m.addVar(vtype=GRB.BINARY, name="b")
M = 500                                  # = x.UB, the tightest valid M
m.addConstr(x <= M * b, name="bigM_switch")   # b=0 ⇒ x=0
```
For a **difference** condition, `M = max(x) - min(y) (+ eps)`:
```python
M = x.UB - y.LB + 1e-4
m.addConstr(x >= y + 1e-4 - M * (1 - b))      # if x>y then b=1
m.addConstr(x <= y + M * b)
```

**Indicator constraints** — cleanest and numerically robust; prefer them when bounds aren't known/finite, when the condition is an **equality**, or when you see large-coefficient warnings:
```python
m.addConstr((b == 1) >> (x + y <= 50))        # overloaded >> operator (recommended)
m.addGenConstrIndicator(b, 0, x, GRB.GREATER_EQUAL, 10)   # explicit form
```
Gurobi may still convert an indicator to Big-M in presolve, but it uses the tightest `M` it can derive — always at least as good as a hand-picked constant.

**SOS1** — at most one variable in the set is nonzero; ideal for discrete choice and PWL:
```python
m.addSOS(GRB.SOS_TYPE1, [x1, x2, x3], [1.0, 2.0, 3.0])   # weights = branching order
```
If you can't derive a tight `M`, model the logic with SOS/indicators and let presolve compute `M` via `PreSOS1BigM` / `PreSOS2BigM` (set to `0` to force SOS branching with no Big-M conversion).

**Decision tree:** tight `M` derivable from bounds → Big-M with that value · else "at most one nonzero" → SOS1 · else → indicator constraint (most general, safest). Conceptual cross-ref: `modeling-techniques.md` §2, §8, §9.

## 3. Linearizing Products of Variables

**Binary × binary** (`w = x·y`, both binary) — replace with binary `w` and three constraints, or the native AND:
```python
m.addConstr(w <= x); m.addConstr(w <= y); m.addConstr(w >= x + y - 1)
# or, preferred when it's genuinely an AND:
m.addGenConstrAnd(w, [x, y])
```

**Binary × continuous** (`z = b·x`, `x ∈ [lb, ub]` finite) — McCormick, four constraints:
```python
m.addConstr(z >= lb * b)
m.addConstr(z <= ub * b)
m.addConstr(z >= x - ub * (1 - b))
m.addConstr(z <= x - lb * (1 - b))     # z, declared with same [lb,ub] as x
```
`b=0 ⇒ z=0`; `b=1 ⇒ z=x`. **The bounds must be finite and tight** — loose bounds wreck the relaxation. If `x` has **no finite upper bound**, McCormick is invalid; use an indicator instead:
```python
m.addConstr((b == 0) >> (x == 0))      # b=0 forces x=0; b=1 leaves x free
```

**Decision tree:** `x` binary → 3-constraint or `addGenConstrAnd` · `x` continuous with finite tight bound → McCormick · unbounded → indicator. For absolute value, max, and min, prefer Gurobi's native general constraints — `addGenConstrAbs(y, x)`, `addGenConstrMax(y, [...])`, `addGenConstrMin(y, [...])` — which Gurobi linearizes internally with the tightest bounds it knows. Conceptual cross-ref: `modeling-techniques.md` §6.

## 4. Diagnosing & Fixing a Stalled MIP Gap

**Diagnose before tuning — read which side of the gap is stuck:**

| Log symptom | Root cause | Direction |
|---|---|---|
| Incumbent flat, BestBd moving | primal weak (can't find better solutions) | feasibility + heuristics |
| BestBd flat, incumbent exists | dual weak (LP relaxation too loose) | bound tightening + cuts |
| Both flat | weak formulation (e.g., loose Big-M) | **reformulate first**, then tune |
| Large `IntInf` per node | many fractional integers | aggressive cuts + better branching |

Check the **root-node gap** (first MIP line): `< 5%` strong formulation (search will close it); `> 20%` weak — tuning alone won't save it, reformulate. If you see a large-coefficient warning, fix the formulation before any tuning. Consider the **automated tuner** first: `m.setParam("TuneTimeLimit", 300); m.tune()`.

**Parameter priority order** (change one group, re-solve, then move on):

| Priority | Lever | When |
|---|---|---|
| 1 | `MIPFocus` (1 = find feasible, 2 = prove optimality, 3 = move the bound) | always the first lever; pick by which side is stuck |
| 2 | `Cuts` (→2/3), `MIRCuts`, `GomoryPasses`, `FlowCoverCuts`, `CoverCuts`, `CliqueCuts` | dual bound stalling / large `IntInf` |
| 3 | `Heuristics` (→0.2), `RINS`, `PumpPasses`, `SubMIPNodes` | incumbent stalling |
| 4 | `Presolve` (→2), `PrePasses`, `PreSparsify` | almost always worth trying |
| 5 | `ImproveStartTime` / `ImproveStartGap` / `ImproveStartNodes` | production runs with a time budget — switch to "find better solutions" mode after a trigger |
| 6 | `VarBranch` (3 = strong branching), `NodeMethod`, `Symmetry` (→2 for assignment/scheduling) | after the above |
| 7 | `MIPGap` / `MIPGapAbs` | accept a practical tolerance to stop chasing the last fraction |

`ImproveStartTime`/`ImproveStartGap` are especially useful in production: e.g. "after 300 s, stop proving optimality and just improve the incumbent."

**If parameters don't help, the formulation is weak.** Tells: root gap stays `>20%` despite aggressive cuts, persistent coefficient warnings, BestBd never moves even at `MIPFocus=3`. Fixes: tighten Big-M from bounds; replace unbounded Big-M with indicators; use SOS1 for discrete selection; add symmetry-breaking; tighten variable bounds / add valid inequalities. (This is the *feasible → good → fast* order — see Principle 10 and `method-selection.md` §6. For a real log, route to `solve-tuning`.)

## 5. Soft Constraints & Slack Variables

A **soft** constraint may be violated at a penalty; only physics/law/ethics/data-integrity should be **hard** (Principle 8). The standard device is a non-negative **slack** variable that absorbs the violation and is penalized in the objective.

**One-sided (don't exceed a target `b`):**
```python
s = m.addVar(lb=0, name="slack")          # how much we overshoot
m.addConstr(a_expr <= b + s, name="soft_ub")
# add  PENALTY * s  to a minimization objective
```

**Two-sided / equality target (over- and under-shoot tracked separately):**
```python
over  = m.addVar(lb=0, name="over")
under = m.addVar(lb=0, name="under")
m.addConstr(a_expr - over + under == target, name="soft_eq")
# penalize  w_over*over + w_under*under   (asymmetric weights if one direction is worse)
```
Keep slacks **continuous** even when the modeled quantity is integer unless integrality of the violation matters — integer slacks add branching for no benefit.

**Let Gurobi build the relaxation for you — `feasRelax`.** When a model is infeasible and you want the *minimal* violation rather than hand-adding slacks everywhere:
```python
# relaxobjtype: 0 = minimize sum of violations, 1 = sum of squares, 2 = count of violated constraints
# minrelax=False → minimize the weighted violation; vrelax/crelax → allow bound/constraint relaxation
m.feasRelaxS(relaxobjtype=0, minrelax=False, vrelax=False, crelax=True)
m.optimize()                               # solves the penalized (always-feasible) model
```
For per-constraint penalty weights, use the full `m.feasRelax(relaxobjtype, minrelax, vars, lbpen, ubpen, constrs, rhspen)`. This pairs naturally with the `iis-summarization` skill: run an IIS to see *which* constraints conflict, decide which are truly hard, then `feasRelax` the soft ones. (Cross-ref: `practice-wisdom.md` §1, `antipatterns.md` §17.)

## 6. Choosing Penalty Weights & Multi-Objective

Penalty weights turn priorities into numbers — get them wrong and you either ignore a real preference or wreck numerical conditioning.

**Normalize before weighting.** Terms in different units (dollars vs minutes vs counts) must be scaled to comparable magnitudes, or the largest-unit term silently dominates and you reintroduce the wide-coefficient problem from §1. Divide each term by a representative scale (e.g., its expected magnitude) before applying a preference weight.

**Three ways to combine objectives in Gurobi:**

- **Weighted (blended) sum** — one objective, `Σ wᵢ·fᵢ`. Simple, but only finds supported solutions and the weights are delicate:
  ```python
  m.setObjective(w1*cost + w2*service + w3*risk, GRB.MINIMIZE)
  ```
- **Hierarchical (lexicographic)** — strict priorities; optimize priority 1, then optimize priority 2 without worsening priority 1, etc. Use Gurobi's native multi-objective API:
  ```python
  m.ModelSense = GRB.MINIMIZE
  m.setObjectiveN(cost,    index=0, priority=2, name="cost")     # higher priority first
  m.setObjectiveN(service, index=1, priority=1, weight=1.0, name="service")
  m.setParam("ObjNumber", 0); m.setAttr("ObjNRelTol", 0.01)      # allow 1% slack on obj 0 when optimizing lower ones
  ```
  `priority` orders the lexicographic passes; within the same priority, `weight` blends; `ObjNRelTol`/`ObjNAbsTol` let a higher-priority objective degrade by a tolerance so lower ones can improve.
- **ε-constraint** — optimize one objective, push the others into constraints with bounds, and sweep the bounds to trace the Pareto front (finds non-supported points too).

**For soft-constraint weights specifically**, the robust pattern is a strict *hierarchy of violation classes* (hard-ish > strong preference > mild preference) implemented either as lexicographic objectives or as penalties separated by large enough multipliers that a higher class always dominates — the weighted-local-search "weight design" idea in `metaheuristics.md` §11 and `practice-wisdom.md` §5. Decision guide and the broader method menu: `method-selection.md` §8.

## 7. Built-in General Constraints: abs / max / min / and / or / if-then

Prefer Gurobi's **general constraints** over hand-rolled Big-M for these patterns — Gurobi linearizes them internally with the tightest bounds it knows, and the code stays readable:

```python
m.addGenConstrAbs(y, x)                 # y = |x|
m.addGenConstrMax(y, [x1, x2, x3], constant=0.0)   # y = max(x1, x2, x3, 0)
m.addGenConstrMin(y, [x1, x2, x3])      # y = min(...)
m.addGenConstrAnd(y, [b1, b2])          # y = b1 AND b2   (binaries)
m.addGenConstrOr(y, [b1, b2])           # y = b1 OR b2
m.addGenConstrIndicator(b, 1, expr, GRB.LESS_EQUAL, rhs)   # if b=1 then expr <= rhs
```

**When you must linearize by hand** (e.g., another solver, or you want full control):

- **Absolute value, when minimizing `|x|`**: split `x = x⁺ − x⁻` with `x⁺, x⁻ ≥ 0`, then `|x| = x⁺ + x⁻`. Valid only because minimization drives at most one of `x⁺, x⁻` positive — do **not** use this trick when `|x|` is unbounded-below in the objective or appears in a constraint without that pressure.
- **`y = max(x₁,…,xₙ)`**: `y ≥ xᵢ ∀i` lower-bounds it; if you need *exactly* the max (not just an upper-bounding `y`), add binaries `Σ zᵢ = 1`, `y ≤ xᵢ + M(1 − zᵢ)` — or just use `addGenConstrMax`.
- **`min`** is symmetric (`y ≤ xᵢ ∀i`, plus the selection binaries for exactness).
- **If-then** (`if A then B`): model with an indicator on the trigger binary, or Big-M — see §2.

**Caveat for CP-SAT users**: OR-Tools CP-SAT has analogous `AddAbsEquality`, `AddMaxEquality`, `AddMinEquality`, `AddBoolAnd/Or`, but it is **integer-only** — scale reals first (`antipatterns.md` §7, `solvers.md` §4). Conceptual cross-ref: `modeling-techniques.md` §3, §6.
