# Parameter Tuning and Performance Improvement Guide

Guidance for addressing inquiries: "The solver is slow," "LP gap is not shrinking," "Feasible solutions cannot be found."

> For copy-ready `gurobipy` code — a log-section walkthrough and a stalled-gap tuning workflow with the parameter priority order — see `gurobi-gurobipy-guide.md` §1, §4.

## Table of Contents

1. [Diagnostic Priority Order](#1-diagnostic-priority-order)
2. [How to Read Logs](#2-how-to-read-logs)
3. [Gurobi Parameters](#3-gurobi-parameters)
4. [CPLEX Parameters](#4-cplex-parameters)
5. [OR-Tools CP-SAT Parameters](#5-or-tools-cp-sat-parameters)
6. [SCIP Parameters](#6-scip-parameters)
7. [HiGHS Parameters](#7-highs-parameters)
8. [Numerical Stability](#8-numerical-stability)
9. [Symptom-Based Troubleshooting](#9-symptom-based-troubleshooting)

---

## 1. Diagnostic Priority Order

When told "it's slow," do **not** immediately change MIPFocus. Check in order.

### Step 1: Model Structure
- Is the formulation strong? (see `modeling-techniques.md`)
- Are Big-M values appropriate? Not too large?
- Is symmetry breaking included?
- Is scaling appropriate? (coefficients within 10⁻⁶~10⁶)

### Step 2: Log Analysis
- Is the model being reduced by Presolve?
- Gap between Root LP relaxation value and integer optimal
- Number of nodes, tree size
- Which cuts are effective?
- Primal/Dual bound convergence curve

### Step 3: Parameter Tuning
- MIPFocus (Gurobi) / MIPEmphasis (CPLEX) according to symptoms
- Strengthen Cuts and Heuristics
- Threads
- If needed, use `grbtune` (Gurobi tuner)

### Step 4: Model Modification
- Rewrite to stronger formulation
- Decomposition (Benders / column generation)
- Switch to CP-SAT (for scheduling-type problems)
- Metaheuristics (practical-size VRP / large-scale MIP)

### Step 5: Solver Switch
- Speed comparison: Gurobi → CPLEX / COPT
- Switch to CP-SAT if the problem structure suits it

---

## 2. How to Read Logs

### Gurobi Log Example
```
Presolve: 1234 rows, 5678 columns, 9876 nonzeros
Presolved: 234 rows, 567 columns, 890 nonzeros           ← presolve reduction
...
Root relaxation: objective 1.234567e+03, 50 iterations    ← root LP value
                                          
    Nodes    |    Current Node    |     Objective Bounds    |  Work
 Expl Unexpl |  Obj  Depth IntInf | Incumbent     BestBd Gap | It/Node Time

     0     0  1234.56    0   10          -  1234.56     -       -    0s
     0     0  1245.67    0    8          -  1245.67     -       -    0s    ← bound increase from cuts
     0     2  1250.00    0    8          -  1250.00     -       -    0s    ← branching starts
H   12    5                    1500.00   1250.00 16.7%    25.3    1s    ← first incumbent
*  100   20              5     1400.00   1280.00 8.6%    15.2    2s    ← incumbent improvement
...

Cutting planes:
  Gomory: 5
  MIR: 12
  Flow cover: 3
  Zero half: 2

Explored 1234 nodes (45678 simplex iterations) in 10.5 seconds
```

### Checkpoints
1. **Presolved matrix size** as a percentage of original. If ≤10%, presolve is powerful; if ≥90%, the model has a structure where presolve is ineffective.
2. **Root relaxation value** and best incumbent gap. Root gap exceeding 50% tends to create a large branch tree.
3. **Which cuts and how many** were generated. High MIR / Cover / Flow cover counts indicate "structure naturally emerges."
4. **Nodes Explored** vs Time. If node count increases without incumbent improvement, heuristics are weak.
5. **It/Node** large? One node LP is expensive (warm start not working or reoptimization is inefficient).

---

## 3. Gurobi Parameters

### 3.1 Parallelism and Threads
- `Threads`: Default all cores (max 32).
- For large problems, limit to `Threads=16` to avoid CPU contention.
- `ConcurrentMIP=2` runs multiple strategies in parallel (recommended for 8+ cores).

### 3.2 MIPFocus
| Value | Behavior |
|---|---|
| 0 | balanced (default) |
| 1 | feasibility-focused (find feasible solutions quickly) |
| 2 | best bound-focused (shrink gap) |
| 3 | Use when gap is stalled |

### 3.3 Cuts
- `Cuts`: -1/0/1/2/3 (default -1 = auto).
  - 0: cuts completely off
  - 1: normal
  - 2: aggressive
  - 3: very aggressive
- Individual: `CliqueCuts`, `CoverCuts`, `FlowCoverCuts`, `MIRCuts`, `ZeroHalfCuts`, `GomoryPasses`, etc.

### 3.4 Heuristics
- `Heuristics`: 0.0 ~ 1.0 (default 0.05).
- If no feasible solutions are found, increase to 0.2 ~ 0.5.
- Related: `MinRelNodes`, `PumpPasses`, `ZeroObjNodes`, `RINS`, `NoRelHeurTime`/`NoRelHeurWork` (large neighborhood heuristic before root LP).

### 3.5 Presolve
- `Presolve`: -1/0/1/2 (default -1).
- 2 = aggressive. If presolve takes time on large models, reduce to 1.

### 3.6 Numerical and Tolerances
- `IntFeasTol`: Integer feasibility tolerance (default 1e-5)
- `FeasibilityTol`: Constraint tolerance (default 1e-6)
- `OptimalityTol`: Dual tolerance (default 1e-6)
- `NumericFocus`: 0/1/2/3 (default 0). Value 3 is most stable (slower).

### 3.7 Termination Conditions
- `MIPGap`: Relative gap tolerance (default 1e-4 = 0.01%)
- `MIPGapAbs`: Absolute gap
- `TimeLimit`, `NodeLimit`, `SolutionLimit`
- `Cutoff`: Do not explore solutions worse than this (useful with warm start)
- `BestObjStop` / `BestBdStop`: Early termination at a certain value

### 3.8 Lazy Constraints / User Cut
```python
model.Params.LazyConstraints = 1
# Pass callback function to optimize
model.optimize(callback_func)
```
- Standard for TSP SEC, VRP RCI.
- Use `Model.cbLazy(constr)` for lazy constraints. Use `Model.cbCut(constr)` for user cuts.

### 3.9 MIP Start
```python
for v, val in zip(vars, start_values):
    v.Start = val
```
- Provide an existing good solution as warm start.
- Can dramatically improve root cut efficiency and pruning.

### 3.10 grbtune
```bash
grbtune TuneTimeLimit=3600 TuneTrials=3 model.lp
```
- Automatic parameter search. One tuning run takes approximately original solve time × trials × ~30.
- High ROI when solving many problems in the same class.

### 3.11 Official References
- Parameter Guidelines: https://docs.gurobi.com/projects/optimizer/en/current/concepts/parameters/guidelines.html
- Parameter Reference: https://docs.gurobi.com/projects/optimizer/en/current/reference/parameters.html
- Tuning Tool: https://docs.gurobi.com/projects/optimizer/en/current/features/tuning.html

---

## 4. CPLEX Parameters

### 4.1 MIPEmphasis
| Value | Behavior |
|---|---|
| 0 | balanced |
| 1 | feasibility |
| 2 | optimality |
| 3 | best bound |
| 4 | hidden feasible solutions (heuristic strengthened) |

### 4.2 Key Parameters
- `cuts`: cut generation
- `probe`: probing intensity
- `heurfreq`: heuristic frequency
- `parameters.tuning.tilim`: automatic tuner time limit
- `mip.strategy.branch`: branching strategy
- `mip.tolerances.mipgap` / `absmipgap`

---

## 5. OR-Tools CP-SAT Parameters

### 5.1 Parallelism and Portfolio
- `num_search_workers`: number of parallel workers (8, 16 recommended). Each worker uses a different strategy in the portfolio.
- `max_time_in_seconds`: time limit
- `log_search_progress`: True for detailed logging
- `cp_model_presolve`: True (default) enables presolve

### 5.2 Search Strategies
- `linearization_level`: 0/1/2, degree of LP relaxation usage (default 1)
- `optimize_with_core`: True utilizes unsat-core (effective on difficult instances)
- `enumerate_all_solutions`: True enumerates all solutions

### 5.3 Hint / Start
```python
model.AddHint(x, 5)   # hint value for variable x
```
- Provide a good initial solution.

### 5.4 Integer Coefficient Notes
- **All coefficients must be integers**. Scale reals by ×10⁴ or similar.
- Scale factor affects search precision. Use `solver.parameters.absolute_gap_limit` to control precision.

---

## 6. SCIP Parameters

### 6.1 Emphasis Settings
```
set heuristics emphasis aggressive
set separating emphasis aggressive
set presolving emphasis aggressive
set cuts emphasis aggressive
```

### 6.2 Branching
```
set branching priority
```

### 6.3 LP Solver
- Default is SoPlex (OSS)
- Can embed CPLEX / Gurobi as LP solver (license required)
- Using external commercial LP solver on large-scale LP can improve SCIP MIP performance

### 6.4 Python (PySCIPOpt)
```python
from pyscipopt import Model
model = Model()
model.setParam('limits/time', 3600)
model.setParam('limits/gap', 0.01)
model.setEmphasis(SCIP_PARAMEMPHASIS.OPTIMALITY)
```

---

## 7. HiGHS Parameters

### 7.1 Key Parameters
- `time_limit`: time limit
- `mip_rel_gap`: relative gap
- `mip_abs_gap`: absolute gap
- `presolve`: "on"/"off"
- `solver`: "simplex"/"ipm"/"choose"
- `parallel`: "on"/"off"
- `threads`

### 7.2 Python
```python
import highspy
h = highspy.Highs()
h.setOptionValue("time_limit", 3600)
h.setOptionValue("mip_rel_gap", 0.01)
h.passModel(...)
h.run()
```

---

## 8. Numerical Stability

### 8.1 Recommended Ranges
- Coefficients (A matrix) absolute value: 10⁻⁶ ~ 10⁶
- Objective coefficients: 10⁻³ ~ 10⁶
- Bounds: 10⁻⁶ ~ 10⁹ (large bounds make infeasibility detection difficult)

### 8.2 Scaling
- Row scaling: divide both sides of each constraint by the maximum coefficient
- Column scaling: align the scale of each variable
- Solver auto-scaling is powerful, but manual scaling in the initial stage is safer

### 8.3 Symptoms of ill-conditioning
- LP relaxation solution oscillates significantly
- Presolve reduces model minimally
- Warning: "Model contains large bounds"
- Gurobi `Kappa` (condition number estimate) exceeds 10¹⁰

### 8.4 Resolution
- Unify units (seconds vs hours, yen vs thousands of yen)
- Keep Big-M as small as possible
- Increase `NumericFocus` from 1 → 2 → 3
- Switch LP solver to `Method=2` (barrier)

---

## 9. Symptom-Based Troubleshooting

### 9.1 "Feasible solutions cannot be found at all"
1. Is the model infeasible? Check with `model.computeIIS()` (Gurobi)
2. Set `MIPFocus=1` (Gurobi) or `MIPEmphasis=1` (CPLEX)
3. Set `Heuristics=0.5`, `PumpPasses=20`, `MinRelNodes=10000`
4. Set `NoRelHeurTime=60` (run LNS heuristic for 60 seconds before root LP)
5. If still unsuccessful, construct a feasible solution using simpler heuristics and provide as MIP start

### 9.2 "Feasible solutions appear quickly but gap does not shrink"
1. Check root LP relaxation value in log → if weak, improve formulation
2. Set `MIPFocus=2` or `3` to emphasize best bound
3. Set `Cuts=2` or individual cuts (CliqueCuts, CoverCuts, MIRCuts) to aggressive
4. Add strong valid inequalities as user cuts
5. Improve lower bound using Lagrangian relaxation or column generation

### 9.3 "Node count explodes"
1. **Add symmetry breaking**
2. Rewrite to stronger formulation
3. Set branching priority (prioritize important variables)
4. Increase `Heuristics` to promote pruning

### 9.4 "Root LP itself is slow"
1. Set `Method=2` (barrier / IPM)
2. Increase `Threads` (barrier parallelizes easily)
3. Check model scaling and presolve

### 9.5 "OR-Tools seems faster than Gurobi"
- If the problem has strong scheduling (no-overlap, cumulative) or constraint satisfaction characteristics, try CP-SAT
- Use `num_search_workers=8` for portfolio parallelism
- Do not forget to convert to integer coefficients

### 9.6 "Out of memory and crashes"
1. Reduce `Threads`
2. Set `NodefileStart=0.5` (Gurobi): write tree to disk when memory exceeds 50%
3. Use decomposition (Benders / column generation)
4. Limit cuts (`CutAggPasses` etc.)
